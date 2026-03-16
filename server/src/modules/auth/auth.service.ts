import { Injectable, Inject } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";

const scryptAsync = promisify(scrypt);

@Injectable()
export class AuthService {
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
}
