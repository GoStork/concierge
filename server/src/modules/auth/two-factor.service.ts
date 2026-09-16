import { Inject, Injectable, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { encrypt, decrypt } from "../../lib/encrypt";
import {
  generateSecret,
  verifyCode,
  generateRecoveryCodes,
  consumeRecoveryCode,
  roleRequiresTwoFactor,
  twoFactorEnforcedNow,
} from "../../lib/totp";
import { recordAuthEvent } from "../../lib/auth-audit";

/**
 * Staff two-factor authentication (OWASP A07).
 *
 * Enrollment is two steps on purpose: /setup mints a secret and stores it
 * encrypted but INACTIVE, and /enable turns it on only once the user proves a
 * working code. Without that split, a failed QR scan would lock someone out of
 * their own account.
 */
@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** What the UI needs to decide between "enrol now" and "you must enrol". */
  async status(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, roles: true, totpEnabledAt: true, totpRecoveryCodes: true },
    });
    if (!user) throw new BadRequestException("User not found");
    const required = roleRequiresTwoFactor(user.roles);
    return {
      enabled: !!user.totpEnabledAt,
      enabledAt: user.totpEnabledAt,
      required,
      // True once the grace period is over: an unenrolled covered account can
      // no longer log in.
      enforced: required && twoFactorEnforcedNow(),
      enforceAt: process.env.TWO_FACTOR_ENFORCE_AT || null,
      recoveryCodesRemaining: (user.totpRecoveryCodes || []).length,
    };
  }

  /** Step 1: mint a secret. Stored encrypted, not yet active. */
  async beginEnrollment(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totpEnabledAt: true },
    });
    if (!user) throw new BadRequestException("User not found");
    if (user.totpEnabledAt) {
      throw new BadRequestException(
        "Two-factor authentication is already on. Turn it off first if you want to re-enrol a new device.",
      );
    }
    const { secretBase32, uri } = generateSecret(user.email);
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encrypt(secretBase32), totpLastStep: null },
    });
    const QRCode = (await import("qrcode")).default;
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    // secretBase32 is returned so the user can type it in if the camera fails.
    // It is only useful to someone who is already authenticated as this user.
    return { qrDataUrl, secret: secretBase32, uri };
  }

  /** Step 2: prove one code, then switch it on and hand over recovery codes. */
  async completeEnrollment(userId: string, code: string, meta: { ip?: string | null; userAgent?: string | null }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totpSecret: true, totpEnabledAt: true, totpLastStep: true },
    });
    if (!user?.totpSecret) {
      throw new BadRequestException("Start the setup first - no pending enrollment for this account.");
    }
    if (user.totpEnabledAt) throw new BadRequestException("Two-factor authentication is already on.");

    const result = verifyCode(decrypt(user.totpSecret), code, user.email, user.totpLastStep);
    if (!result.ok) {
      await recordAuthEvent(this.prisma, {
        event: "TWO_FACTOR_FAILURE", userId: user.id, email: user.email,
        ip: meta.ip, userAgent: meta.userAgent, detail: `enrollment:${result.reason}`,
      });
      throw new BadRequestException("That code is not right. Check the clock on your phone and try the next one.");
    }

    const { plain, hashed } = generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totpEnabledAt: new Date(),
        totpLastStep: result.step!,
        totpRecoveryCodes: hashed,
      },
    });
    await recordAuthEvent(this.prisma, {
      event: "TWO_FACTOR_ENABLED", userId: user.id, email: user.email,
      ip: meta.ip, userAgent: meta.userAgent,
    });
    // The only time the plaintext recovery codes ever leave the server.
    return { enabled: true, recoveryCodes: plain };
  }

  async disable(userId: string, code: string, meta: { ip?: string | null; userAgent?: string | null }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, roles: true, totpSecret: true, totpEnabledAt: true, totpLastStep: true, totpRecoveryCodes: true },
    });
    if (!user?.totpEnabledAt || !user.totpSecret) {
      throw new BadRequestException("Two-factor authentication is not on for this account.");
    }
    // Turning it off is itself a sensitive action, so it needs a live code -
    // a stolen session alone must not be enough to strip the second factor.
    const verified = this.verifyAny(user, code);
    if (!verified.ok) {
      await recordAuthEvent(this.prisma, {
        event: "TWO_FACTOR_FAILURE", userId: user.id, email: user.email,
        ip: meta.ip, userAgent: meta.userAgent, detail: "disable:bad_code",
      });
      throw new BadRequestException("That code is not right.");
    }
    if (roleRequiresTwoFactor(user.roles) && twoFactorEnforcedNow()) {
      throw new BadRequestException(
        "Two-factor authentication is required for GoStork staff accounts and cannot be turned off.",
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabledAt: null, totpSecret: null, totpLastStep: null, totpRecoveryCodes: [] },
    });
    await recordAuthEvent(this.prisma, {
      event: "TWO_FACTOR_DISABLED", userId: user.id, email: user.email,
      ip: meta.ip, userAgent: meta.userAgent,
    });
    return { enabled: false };
  }

  /** Accepts either a 6-digit TOTP code or one single-use recovery code. */
  private verifyAny(
    user: { email: string; totpSecret: string | null; totpLastStep: number | null; totpRecoveryCodes: string[] },
    code: string,
  ): { ok: boolean; step?: number; usedRecovery?: boolean; remaining?: string[]; reason?: string } {
    if (user.totpSecret) {
      const r = verifyCode(decrypt(user.totpSecret), code, user.email, user.totpLastStep);
      if (r.ok) return { ok: true, step: r.step };
      // Only fall through to recovery codes for a well-formed non-match; a
      // replayed TOTP code must stay a hard no.
      if (r.reason === "replayed") return { ok: false, reason: "replayed" };
    }
    const rec = consumeRecoveryCode(code, user.totpRecoveryCodes || []);
    if (rec.ok) return { ok: true, usedRecovery: true, remaining: rec.remaining };
    return { ok: false, reason: "invalid" };
  }

  /**
   * The login-time check. Returns true only when the code is good, and records
   * the outcome either way.
   */
  async verifyForLogin(userId: string, code: string, meta: { ip?: string | null; userAgent?: string | null }): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totpSecret: true, totpEnabledAt: true, totpLastStep: true, totpRecoveryCodes: true },
    });
    if (!user?.totpEnabledAt) return false;

    const verified = this.verifyAny(user, code);
    if (!verified.ok) {
      await recordAuthEvent(this.prisma, {
        event: "TWO_FACTOR_FAILURE", userId: user.id, email: user.email,
        ip: meta.ip, userAgent: meta.userAgent, detail: `login:${verified.reason}`,
      });
      return false;
    }

    if (verified.usedRecovery) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { totpRecoveryCodes: verified.remaining! },
      });
      await recordAuthEvent(this.prisma, {
        event: "RECOVERY_CODE_USED", userId: user.id, email: user.email,
        ip: meta.ip, userAgent: meta.userAgent,
        detail: `${verified.remaining!.length} left`,
      });
    } else {
      await this.prisma.user.update({
        where: { id: userId },
        data: { totpLastStep: verified.step! },
      });
      await recordAuthEvent(this.prisma, {
        event: "TWO_FACTOR_SUCCESS", userId: user.id, email: user.email,
        ip: meta.ip, userAgent: meta.userAgent,
      });
    }
    return true;
  }
}
