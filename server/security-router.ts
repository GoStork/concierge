import { Router, type Request, type Response } from "express";
import { getCountries, getCountryCallingCode } from "libphonenumber-js";
import { prisma } from "./db";
import { isGostorkStaff } from "./parent-crm";
import { cloudflareSyncStatus, syncBlockedCountriesToCloudflare } from "./cloudflare-sync";
import { normalizeEmail } from "./email-security";

/**
 * /admin/security - the cyber-security settings surface.
 *
 * Born from a production incident: thousands of scripted signups
 * (gostork.<random>@gmail.com) triggering verification SMS to premium ranges
 * in Ethiopia, Azerbaijan, Serbia, Pakistan, Kyrgyzstan and Tajikistan - SMS
 * toll fraud, billed to GoStork.
 *
 * The policy model is deliberately open-by-default: families come to GoStork
 * from 125 countries, so there is no allowlist to fall off. A row in
 * SecurityCountryPolicy is an EXCEPTION for one country:
 *
 *   WHATSAPP_ONLY  verification runs over WhatsApp, never SMS. WhatsApp has
 *                  no carrier revenue share, so there is nothing to farm -
 *                  and a real parent in that country can still sign up.
 *   BLOCKED        no verification message of any kind, which means no
 *                  account: signup cannot complete without a verified phone.
 *                  Deliberate - these are countries GoStork does not serve.
 *   ALLOWED        an explicit exception the other way - stored so an admin
 *                  can pin a country as trusted and leave a note saying why.
 *
 * Enforcement lives in OtpGuardService, which reads this table (cached 60s)
 * in front of every send. This router is only the management surface.
 */
export const securityRouter = Router();

function requireGostorkAdmin(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  if (!isGostorkStaff(req.user)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
}

const POLICIES = new Set(["ALLOWED", "WHATSAPP_ONLY", "BLOCKED"]);

/** Country display names, resolved once - libphonenumber has the codes. */
const countryName = new Intl.DisplayNames(["en"], { type: "region" });

securityRouter.get("/api/admin/security/countries", requireGostorkAdmin, async (_req, res) => {
  try {
    const [rows, recent] = await Promise.all([
      prisma.securityCountryPolicy.findMany(),
      // Activity per country over the last 7 days, so the list shows where
      // verification traffic is actually coming from.
      prisma.otpAttempt.groupBy({
        by: ["isoCode", "outcome"],
        where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        _count: { _all: true },
      }),
    ]);
    const policyOf = new Map(rows.map((r) => [r.isoCode, r]));
    const activity = new Map<string, { sent: number; blocked: number }>();
    for (const g of recent as any[]) {
      if (!g.isoCode) continue;
      const a = activity.get(g.isoCode) || { sent: 0, blocked: 0 };
      if (g.outcome === "sent") a.sent += g._count._all;
      else a.blocked += g._count._all;
      activity.set(g.isoCode, a);
    }

    const phoneCodes = new Set<string>(getCountries());
    const countries = getCountries().map((iso) => {
      const row = policyOf.get(iso);
      const act = activity.get(iso);
      return {
        isoCode: iso,
        name: countryName.of(iso) || iso,
        callingCode: `+${getCountryCallingCode(iso)}`,
        policy: row?.policy ?? "ALLOWED",
        // Only an explicit row carries a reason - the default needs none.
        reason: row?.reason ?? null,
        isException: !!row,
        sent7d: act?.sent ?? 0,
        blocked7d: act?.blocked ?? 0,
      };
    });
    // Policy rows libphonenumber has no phone plan for - today that is "XX",
    // Cloudflare's unknown-geolocation bucket, imported with the rest of the
    // edge rule. They still belong on the page so an admin can see and change
    // them, they just carry no calling code.
    for (const row of rows) {
      if (phoneCodes.has(row.isoCode as any)) continue;
      countries.push({
        isoCode: row.isoCode,
        name: row.isoCode === "XX" ? "Unknown location (edge only)" : row.isoCode,
        callingCode: "",
        policy: row.policy,
        reason: row.reason ?? null,
        isException: true,
        sent7d: 0,
        blocked7d: 0,
      });
    }
    countries.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ countries });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to load countries" });
  }
});

securityRouter.put("/api/admin/security/countries/:iso", requireGostorkAdmin, async (req, res) => {
  try {
    const iso = String(req.params.iso || "").toUpperCase();
    // "XX" is Cloudflare's unknown-geolocation bucket - not a phone country,
    // but a valid edge policy target.
    if (!(getCountries() as string[]).includes(iso) && iso !== "XX") {
      return res.status(400).json({ message: "Unknown country code" });
    }
    const policy = String(req.body?.policy || "");
    if (!POLICIES.has(policy)) {
      return res.status(400).json({ message: "policy must be ALLOWED, WHATSAPP_ONLY or BLOCKED" });
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() || null : null;
    const userId = (req.user as any)?.id ?? null;

    // "Allowed" with no note is the default state - drop the row rather than
    // keeping an exception that says nothing.
    if (policy === "ALLOWED" && !reason) {
      await prisma.securityCountryPolicy.deleteMany({ where: { isoCode: iso } });
      syncBlockedCountriesToCloudflare().catch(() => {});
      return res.json({ isoCode: iso, policy: "ALLOWED", reason: null, isException: false });
    }

    const row = await prisma.securityCountryPolicy.upsert({
      where: { isoCode: iso },
      create: { isoCode: iso, policy, reason, updatedByUserId: userId },
      update: { policy, reason, updatedByUserId: userId },
    });
    // Push the change to the edge without holding up the response - the
    // in-app gate is already updated, and the card on the page shows the
    // edge's own status.
    syncBlockedCountriesToCloudflare().catch(() => {});
    res.json({ ...row, isException: true });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to save policy" });
  }
});

securityRouter.get("/api/admin/security/attempts", requireGostorkAdmin, async (_req, res) => {
  try {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [rows, outcomes] = await Promise.all([
      prisma.otpAttempt.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true, phoneMasked: true, isoCode: true, ip: true,
          outcome: true, channel: true, createdAt: true,
        },
      }),
      prisma.otpAttempt.groupBy({
        by: ["outcome"],
        where: { createdAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
    ]);
    const last24h: Record<string, number> = {};
    for (const g of outcomes as any[]) last24h[g.outcome] = g._count._all;
    res.json({ attempts: rows, last24h });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to load attempts" });
  }
});

securityRouter.get("/api/admin/security/cloudflare", requireGostorkAdmin, async (_req, res) => {
  res.json(await cloudflareSyncStatus());
});

securityRouter.post("/api/admin/security/cloudflare/sync", requireGostorkAdmin, async (_req, res) => {
  res.json(await syncBlockedCountriesToCloudflare());
});

/**
 * Email allowlist - canonical addresses exempt from the alias/dedup cap, so a
 * staff test inbox can create unlimited `+tag` accounts. Everyone else is one
 * account per canonical mailbox.
 */
securityRouter.get("/api/admin/security/email-allowlist", requireGostorkAdmin, async (_req, res) => {
  try {
    const rows = await prisma.securityEmailAllow.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ allowlist: rows });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to load allowlist" });
  }
});

securityRouter.post("/api/admin/security/email-allowlist", requireGostorkAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email.includes("@")) return res.status(400).json({ message: "A valid email is required" });
    // Store the CANONICAL form so any alias of it matches at signup.
    const { canonical } = normalizeEmail(email);
    const note = typeof req.body?.note === "string" ? req.body.note.trim() || null : null;
    const row = await prisma.securityEmailAllow.upsert({
      where: { canonicalEmail: canonical },
      create: { canonicalEmail: canonical, note, createdByUserId: (req.user as any)?.id ?? null },
      update: { note },
    });
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to add to allowlist" });
  }
});

securityRouter.delete("/api/admin/security/email-allowlist/:canonical", requireGostorkAdmin, async (req, res) => {
  try {
    const canonical = String(req.params.canonical || "").trim().toLowerCase();
    await prisma.securityEmailAllow.deleteMany({ where: { canonicalEmail: canonical } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to remove from allowlist" });
  }
});

/**
 * Approve or quarantine a flagged signup from the /parents review queue.
 * TRUSTED clears the flag (and its reasons); QUARANTINED re-flags manually.
 */
securityRouter.post("/api/admin/security/trust-state", requireGostorkAdmin, async (req, res) => {
  try {
    const userId = String(req.body?.userId || "");
    const trustState = String(req.body?.trustState || "");
    if (!userId || !["TRUSTED", "QUARANTINED"].includes(trustState)) {
      return res.status(400).json({ message: "userId and trustState (TRUSTED|QUARANTINED) required" });
    }
    const row = await prisma.user.update({
      where: { id: userId },
      data: { trustState, ...(trustState === "TRUSTED" ? { trustReasons: [] } : {}) },
      select: { id: true, trustState: true, trustReasons: true },
    });
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to update trust state" });
  }
});

/** Editable knobs. Today: the per-IP signup cap that flips a signup to review. */
securityRouter.get("/api/admin/security/settings", requireGostorkAdmin, async (_req, res) => {
  try {
    const row = await prisma.securitySetting.findUnique({ where: { key: "ip_signup_cap_per_day" } });
    res.json({ ipSignupCapPerDay: row ? parseInt(row.value, 10) || 5 : 5 });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to load settings" });
  }
});

securityRouter.put("/api/admin/security/settings", requireGostorkAdmin, async (req, res) => {
  try {
    const cap = Math.max(1, Math.min(1000, parseInt(String(req.body?.ipSignupCapPerDay), 10) || 5));
    await prisma.securitySetting.upsert({
      where: { key: "ip_signup_cap_per_day" },
      create: { key: "ip_signup_cap_per_day", value: String(cap) },
      update: { value: String(cap) },
    });
    res.json({ ipSignupCapPerDay: cap });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to save settings" });
  }
});

/**
 * GET /api/admin/security/auth-log - the authentication audit trail.
 *
 * OWASP A09. Until this existed, a failed login, a password reset, a role
 * change and an admin minting another admin all left zero trace, so after an
 * incident there was nothing to read. Rows are written by
 * server/src/lib/auth-audit.ts and never contain credential material.
 *
 * Filters: ?event=LOGIN_FAILURE&email=x&userId=y&days=7&limit=200
 */
securityRouter.get("/api/admin/security/auth-log", requireGostorkAdmin, async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days || "7"), 10) || 7, 1), 90);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "200"), 10) || 200, 1), 1000);
    const event = typeof req.query.event === "string" && req.query.event ? req.query.event : undefined;
    const email = typeof req.query.email === "string" && req.query.email ? req.query.email.trim().toLowerCase() : undefined;
    const userId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined;

    const where: any = { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } };
    if (event) where.event = event;
    if (userId) where.userId = userId;
    if (email) where.email = { contains: email, mode: "insensitive" };

    const [rows, byEvent] = await Promise.all([
      prisma.authAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
      prisma.authAuditLog.groupBy({
        by: ["event"],
        where: { createdAt: { gte: new Date(Date.now() - days * 86_400_000) } },
        _count: { _all: true },
      }),
    ]);

    // Repeated failures from one address are the signal worth surfacing, so
    // the page can lead with them instead of making someone scan the list.
    const failureCounts = new Map<string, number>();
    for (const r of rows) {
      if (r.event !== "LOGIN_FAILURE" && r.event !== "TWO_FACTOR_FAILURE") continue;
      const key = r.ip || "unknown";
      failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
    }
    const topFailureIps = Array.from(failureCounts.entries())
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      days,
      rows,
      summary: byEvent.map((b: any) => ({ event: b.event, count: b._count._all })).sort((a: any, b: any) => b.count - a.count),
      topFailureIps,
    });
  } catch (e: any) {
    console.error("[security] auth-log failed:", e?.message);
    res.status(500).json({ message: "Failed to load the authentication log" });
  }
});

/**
 * GET /api/admin/security/two-factor - enrollment state for every staff
 * account that is required to have a second factor, so an admin can see at a
 * glance who is still exposed during the grace period.
 */
securityRouter.get("/api/admin/security/two-factor", requireGostorkAdmin, async (_req: Request, res: Response) => {
  try {
    const { TWO_FACTOR_REQUIRED_ROLES, twoFactorEnforcedNow } = await import("./src/lib/totp");
    const staff = await prisma.user.findMany({
      where: { roles: { hasSome: TWO_FACTOR_REQUIRED_ROLES as any } },
      select: { id: true, email: true, name: true, roles: true, totpEnabledAt: true, isDisabled: true, lastLoginAt: true },
      orderBy: { email: "asc" },
    });
    res.json({
      enforced: twoFactorEnforcedNow(),
      enforceAt: process.env.TWO_FACTOR_ENFORCE_AT || null,
      requiredRoles: TWO_FACTOR_REQUIRED_ROLES,
      staff: staff.map((u: any) => ({ ...u, twoFactorEnabled: !!u.totpEnabledAt, totpEnabledAt: undefined })),
      enrolled: staff.filter((u: any) => u.totpEnabledAt).length,
      total: staff.length,
    });
  } catch (e: any) {
    console.error("[security] two-factor overview failed:", e?.message);
    res.status(500).json({ message: "Failed to load two-factor status" });
  }
});
