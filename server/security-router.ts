import { Router, type Request, type Response } from "express";
import { getCountries, getCountryCallingCode } from "libphonenumber-js";
import { prisma } from "./db";
import { isGostorkStaff } from "./parent-crm";
import { cloudflareSyncStatus, syncBlockedCountriesToCloudflare } from "./cloudflare-sync";

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
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ countries });
  } catch (e: any) {
    res.status(500).json({ message: e?.message || "Failed to load countries" });
  }
});

securityRouter.put("/api/admin/security/countries/:iso", requireGostorkAdmin, async (req, res) => {
  try {
    const iso = String(req.params.iso || "").toUpperCase();
    if (!(getCountries() as string[]).includes(iso)) {
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
