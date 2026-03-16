import { Injectable, Inject, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";

const scryptAsync = promisify(scrypt);

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RATE_LIMIT_MS = 30 * 1000;

type OtpEntry = { code: string; expiresAt: number; attempts: number };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private otpStore = new Map<string, OtpEntry>();
  private otpSentAt = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JwtService) private readonly jwtService: JwtService,
  ) {}

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(32).toString("hex");
    const buf = (await scryptAsync(password, salt, 64)) as Buffer;
    return `${buf.toString("hex")}.${salt}`;
  }

  async comparePasswords(supplied: string, stored: string): Promise<boolean> {
    const [hashed, salt] = stored.split(".");
    const hashedBuf = Buffer.from(hashed, "hex");
    const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
    return timingSafeEqual(hashedBuf, suppliedBuf);
  }

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) return null;
    if (user.isDisabled) return null;
    const isValid = await this.comparePasswords(password, user.password);
    return isValid ? user : null;
  }

  async getUserById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async getUserWithProvider(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        provider: {
          include: {
            services: {
              include: { providerType: true },
            },
          },
        },
        assignedLocations: {
          include: { location: true },
        },
      },
    });
  }

  generateToken(user: { id: string; email: string; roles: string[] }): string {
    return this.jwtService.sign({
      sub: user.id,
      email: user.email,
      roles: user.roles,
    });
  }

  async createPasswordResetToken(email: string): Promise<{ token: string; userName: string | null } | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return null;

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await this.prisma.passwordResetToken.create({
      data: {
        token,
        userId: user.id,
        expiresAt,
      },
    });

    return { token, userName: user.name };
  }

  async validatePasswordResetToken(token: string): Promise<{ userId: string } | null> {
    const resetToken = await this.prisma.passwordResetToken.findUnique({ where: { token } });
    if (!resetToken) return null;
    if (resetToken.usedAt) return null;
    if (resetToken.expiresAt < new Date()) return null;
    return { userId: resetToken.userId };
  }

  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    if (
      newPassword.length < 8 ||
      !/[A-Z]/.test(newPassword) ||
      !/[a-z]/.test(newPassword) ||
      !/[0-9]/.test(newPassword)
    ) {
      throw new Error("Password must be at least 8 characters and contain uppercase, lowercase, and a number.");
    }

    const valid = await this.validatePasswordResetToken(token);
    if (!valid) return false;

    const hashedPassword = await this.hashPassword(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: valid.userId },
        data: { password: hashedPassword },
      }),
      this.prisma.passwordResetToken.update({
        where: { token },
        data: { usedAt: new Date() },
      }),
    ]);

    return true;
  }

  async sendOtp(phone: string): Promise<{ sent: boolean; devCode?: string }> {
    const normalized = phone.replace(/\s+/g, "").replace(/[^\d+]/g, "");
    if (normalized.length < 10) throw new Error("Invalid phone number");

    const lastSent = this.otpSentAt.get(normalized);
    if (lastSent && Date.now() - lastSent < OTP_RATE_LIMIT_MS) {
      throw new Error("Please wait before requesting another code");
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.otpStore.set(normalized, { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
    this.otpSentAt.set(normalized, Date.now());

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

    if (!twilioSid || !twilioToken || !twilioFrom) {
      this.logger.warn(`[OTP DEV] Code for ${normalized}: ${code}`);
      return { sent: false, devCode: process.env.NODE_ENV !== "production" ? code : undefined };
    }

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
      const params = new URLSearchParams({
        To: normalized,
        From: twilioFrom,
        Body: `Your GoStork verification code is: ${code}. It expires in 5 minutes.`,
      });
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      if (!response.ok) {
        const text = await response.text();
        this.logger.error(`Twilio SMS error: ${response.status} - ${text}`);
        const isInvalidNumber = text.includes("21211") || text.includes("21614") || text.includes("21217");
        throw new Error(isInvalidNumber
          ? "This phone number appears to be invalid. Please check and try again."
          : "Failed to send verification code");
      }
      this.logger.log(`OTP sent to ${normalized.slice(0, -4)}****`);
      return { sent: true };
    } catch (err: any) {
      this.logger.error(`Failed to send OTP: ${err.message}`);
      if (err.message.includes("invalid") || err.message.includes("Failed to send verification code")) {
        throw err;
      }
      throw new Error("Failed to send verification code. Please try again.");
    }
  }

  verifyOtp(phone: string, code: string): boolean {
    const normalized = phone.replace(/\s+/g, "").replace(/[^\d+]/g, "");
    const entry = this.otpStore.get(normalized);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.otpStore.delete(normalized);
      return false;
    }
    if (entry.attempts >= 5) {
      this.otpStore.delete(normalized);
      return false;
    }
    entry.attempts++;
    if (entry.code === code) {
      this.otpStore.delete(normalized);
      return true;
    }
    return false;
  }
}
