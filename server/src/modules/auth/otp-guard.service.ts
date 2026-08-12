import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The gate in front of every verification send.
 *
 * Production (the old platform) was hit by SMS toll fraud: scripted signups
 * with numbers in premium ranges - Ethiopia, Azerbaijan, Serbia, Pakistan,
 * Kyrgyzstan, Tajikistan - each one billing GoStork for the verification it
 * triggered. This platform already refuses VoIP and landlines and sends
 * WhatsApp outside the US and Canada, which closes most of the revenue-share
 * hole; what it lacked was a country policy, rate limits, and any record of
 * the attempts. This service is those three things.
 *
 * POLICY. The world is open by default - GoStork's families come from 125
 * countries, and an allowlist would turn real parents away. A row in
 * SecurityCountryPolicy says something exceptional about one country:
 *
 *   ALLOWED        explicit trust (overrides nothing today; exists so an
 *                  admin can whitelist a country the risk list would catch)
 *   WHATSAPP_ONLY  never SMS - WhatsApp verification carries no carrier
 *                  revenue to farm, so it is safe even where SMS is not
 *   BLOCKED        no verification message of any kind, which means no
 *                  account - signup cannot complete without a verified phone
 *
 * The list is managed at /admin/security and cached here for a minute so the
 * gate adds no measurable latency to signup.
 *
 * RATE LIMITS. Counted from OtpAttempt, the same table the admin page reads,
 * so what limits the endpoint and what the admin sees are one record:
 *
 *   per phone   3 sends / hour, 5 / day
 *   per IP      5 sends / hour
 *   per country 30 sends / hour platform-wide - a burst from one prefix is
 *               the fraud signature, and no legitimate hour looks like that
 *
 * Every attempt is logged with the number MASKED (+251****5566) and hashed -
 * this is an abuse log, not a contact list.
 */
@Injectable()
export class OtpGuardService {
  private readonly logger = new Logger(OtpGuardService.name);

  /** policy cache: isoCode -> policy, refreshed every 60s */
  private policyCache = new Map<string, string>();
  private policyLoadedAt = 0;

  // Explicit @Inject: esbuild drops decorator metadata, so type-based
  // injection silently passes undefined - the same rule every service in
  // this codebase follows.
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  private async policies(): Promise<Map<string, string>> {
    if (Date.now() - this.policyLoadedAt > 60_000) {
      const rows = await this.db.securityCountryPolicy.findMany({
        select: { isoCode: true, policy: true },
      });
      this.policyCache = new Map(rows.map((r: any) => [r.isoCode, r.policy]));
      this.policyLoadedAt = Date.now();
    }
    return this.policyCache;
  }

  static maskPhone(e164: string): string {
    // Keep the calling-code side readable and the subscriber side hidden.
    return e164.length > 6 ? `${e164.slice(0, 4)}****${e164.slice(-4)}` : "****";
  }

  static hashPhone(e164: string): string {
    return createHash("sha256").update(e164).digest("hex");
  }

  /**
   * Decide whether this send may happen, and how.
   *
   * Returns `{ ok: true, forceWhatsapp }` or `{ ok: false, reason }` where
   * reason is one of country_blocked | rate_limited. The caller logs the
   * attempt either way via record().
   */
  async check(e164: string, isoCode: string | null, ip: string | null): Promise<
    { ok: true; forceWhatsapp: boolean } | { ok: false; reason: "country_blocked" | "rate_limited" }
  > {
    const policies = await this.policies();
    const policy = isoCode ? policies.get(isoCode.toUpperCase()) : undefined;
    if (policy === "BLOCKED") return { ok: false, reason: "country_blocked" };

    // A number libphonenumber cannot place is not sent SMS. Before this,
    // unparseable numbers fell through to the SMS default - exactly the gap a
    // premium-range number walks through.
    const forceWhatsapp = policy === "WHATSAPP_ONLY" || !isoCode;

    const hourAgo = new Date(Date.now() - 3_600_000);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const phoneHash = OtpGuardService.hashPhone(e164);

    const sent = { outcome: "sent" as const };
    const [phoneHour, phoneDay, ipHour, countryHour] = await Promise.all([
      this.db.otpAttempt.count({ where: { phoneHash, createdAt: { gte: hourAgo }, ...sent } }),
      this.db.otpAttempt.count({ where: { phoneHash, createdAt: { gte: dayAgo }, ...sent } }),
      ip ? this.db.otpAttempt.count({ where: { ip, createdAt: { gte: hourAgo }, ...sent } }) : 0,
      isoCode
        ? this.db.otpAttempt.count({ where: { isoCode, createdAt: { gte: hourAgo }, ...sent } })
        : 0,
    ]);

    if (phoneHour >= 3 || phoneDay >= 5 || (ip !== null && ipHour >= 5)) {
      return { ok: false, reason: "rate_limited" };
    }
    // The platform-wide brake. US and CA carry real volume; everywhere else,
    // thirty sends to one country in one hour is a script, not a cohort.
    if (isoCode && !["US", "CA"].includes(isoCode.toUpperCase()) && countryHour >= 30) {
      this.logger.warn(`[otp-guard] Country ${isoCode} hit the hourly platform cap - blocking further sends`);
      return { ok: false, reason: "rate_limited" };
    }

    return { ok: true, forceWhatsapp };
  }

  /** Append to the abuse log. Never throws - logging must not break signup. */
  async record(
    e164: string,
    isoCode: string | null,
    ip: string | null,
    userAgent: string | null,
    outcome: string,
    channel?: string,
  ): Promise<void> {
    try {
      await this.db.otpAttempt.create({
        data: {
          phoneMasked: OtpGuardService.maskPhone(e164),
          phoneHash: OtpGuardService.hashPhone(e164),
          isoCode: isoCode?.toUpperCase() ?? null,
          ip,
          userAgent: userAgent ? userAgent.slice(0, 250) : null,
          outcome,
          channel: channel ?? null,
        },
      });
    } catch (e: any) {
      this.logger.error(`[otp-guard] failed to record attempt: ${e?.message}`);
    }
  }
}
