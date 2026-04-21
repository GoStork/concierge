import { Injectable, Inject, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";
import { getTwilioClient } from "./twilio-client";
import { parsePhoneIso, pickChannel, type VerificationChannel } from "./verification-channel";

const scryptAsync = promisify(scrypt);

const DEV_OTP_CODE = "000000";

export type OtpSendError =
  | "phone_invalid"
  | "phone_voip"
  | "phone_landline"
  | "phone_unreachable"
  | "verify_failed";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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

  async sendOtp(phone: string): Promise<{ sent: boolean; channel: VerificationChannel; devCode?: string }> {
    const normalized = phone.replace(/\s+/g, "").replace(/[^\d+]/g, "");
    if (!normalized.startsWith("+") || normalized.length < 10) {
      throw new Error("phone_invalid");
    }

    const isoCode = parsePhoneIso(normalized);
    const channel = pickChannel(isoCode);
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    const client = getTwilioClient();

    if (!verifyServiceSid || !client) {
      if (process.env.NODE_ENV === "production") {
        this.logger.error("TWILIO_VERIFY_SERVICE_SID not set in production");
        throw new Error("verify_failed");
      }
      this.logger.warn(`[OTP DEV] Verify SID missing — mock send to ${normalized} via ${channel}. Use code ${DEV_OTP_CODE}.`);
      return { sent: false, channel, devCode: DEV_OTP_CODE };
    }

    await this.assertPhoneIsReachable(client, normalized);

    try {
      const verification = await client.verify.v2
        .services(verifyServiceSid)
        .verifications.create({ to: normalized, channel });
      this.logger.log(`Verify sent to ${normalized.slice(0, -4)}**** via ${channel} (status=${verification.status})`);
      return { sent: true, channel };
    } catch (err: any) {
      this.logger.error(`Verify send failed: ${err?.code ?? "unknown"} ${err?.message ?? err}`);
      if (err?.code === 60200 || err?.code === 60205) throw new Error("phone_invalid");
      if (err?.code === 60203) throw new Error("phone_unreachable");
      throw new Error("verify_failed");
    }
  }

  private async assertPhoneIsReachable(client: ReturnType<typeof getTwilioClient>, e164: string): Promise<void> {
    if (!client) return;
    try {
      const lookup = await client.lookups.v2.phoneNumbers(e164).fetch({ fields: "line_type_intelligence" });
      if (lookup.valid === false) {
        throw new Error("phone_invalid");
      }
      const lineType: string | undefined = lookup.lineTypeIntelligence?.type;
      if (!lineType) return;
      const normalizedType = lineType.toLowerCase();
      if (normalizedType === "nonfixedvoip" || normalizedType === "fixedvoip" || normalizedType === "voip") {
        throw new Error("phone_voip");
      }
      if (normalizedType === "landline") {
        throw new Error("phone_landline");
      }
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (msg === "phone_invalid" || msg === "phone_voip" || msg === "phone_landline") {
        throw err;
      }
      this.logger.warn(`Lookup failed for ${e164.slice(0, -4)}**** — proceeding with Verify. Reason: ${msg || err?.code}`);
    }
  }

  async verifyOtp(phone: string, code: string): Promise<boolean> {
    const normalized = phone.replace(/\s+/g, "").replace(/[^\d+]/g, "");
    const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    const client = getTwilioClient();

    if (!verifyServiceSid || !client) {
      if (process.env.NODE_ENV === "production") {
        this.logger.error("TWILIO_VERIFY_SERVICE_SID not set in production");
        return false;
      }
      return code === DEV_OTP_CODE;
    }

    try {
      const check = await client.verify.v2
        .services(verifyServiceSid)
        .verificationChecks.create({ to: normalized, code });
      return check.status === "approved";
    } catch (err: any) {
      this.logger.warn(`VerificationCheck failed: ${err?.code ?? "unknown"} ${err?.message ?? err}`);
      return false;
    }
  }
}
