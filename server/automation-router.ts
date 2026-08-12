/**
 * /account/automation settings API (CRM Phase 9 §5): the silence signal's
 * per-stage day counts, per-service-line on/off, and whether Eva's check-in
 * step runs at all.
 *
 * A provider edits their own org's row; GoStork admin edits the platform
 * defaults row (id "defaults") that every org without overrides inherits.
 * shadowSince is never editable - the 7-day shadow window has no switch for
 * anyone to remember to flip.
 */
import { Router, Request, Response } from "express";
import { prisma } from "./db";
import { isGostorkStaff, isProviderStaff } from "./parent-crm";
import { JOURNEY_STAGE_ORDER } from "../shared/journey-ladder";
import { SILENCE_DEFAULT_THRESHOLDS, resolveSilenceConfig } from "./silence-sweep";
import { SERVICE_LINES } from "./service-lines";

export const automationRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

function who(req: Request, res: Response): { isAdmin: boolean; providerId: string | null } | null {
  const user = req.user as any;
  if (isGostorkStaff(user)) return { isAdmin: true, providerId: null };
  if (isProviderStaff(user)) return { isAdmin: false, providerId: user.providerId };
  res.status(403).json({ message: "Forbidden" });
  return null;
}

automationRouter.get("/api/automation/silence", requireAuth, async (req, res) => {
  try {
    const w = who(req, res);
    if (!w) return;
    const defaultsRow = await prisma.silenceConfig.findUnique({ where: { id: "defaults" } });
    const orgRow = w.providerId
      ? await prisma.silenceConfig.findUnique({ where: { providerId: w.providerId } })
      : null;
    const view = resolveSilenceConfig(w.isAdmin ? defaultsRow : orgRow, defaultsRow);
    const shadowActive = !w.isAdmin && (!view.shadowSince
      || Date.now() - view.shadowSince.getTime() < 7 * 86_400_000);
    res.json({
      isAdmin: w.isAdmin,
      enabled: view.enabled,
      evaEnabled: view.evaEnabled,
      shadowSince: view.shadowSince,
      shadowActive,
      // Effective values per stage, so the form shows what actually applies.
      thresholds: Object.fromEntries(
        (JOURNEY_STAGE_ORDER as readonly string[]).map((s) => [s, view.thresholdFor(s)]),
      ),
      lineEnabled: Object.fromEntries(
        (SERVICE_LINES as readonly string[]).map((l) => [l, view.lineOn(l)]),
      ),
      builtinDefaults: SILENCE_DEFAULT_THRESHOLDS,
    });
  } catch (e: any) {
    console.error("[automation] GET silence:", e);
    res.status(500).json({ message: e?.message || "Server error" });
  }
});

automationRouter.put("/api/automation/silence", requireAuth, async (req, res) => {
  try {
    const w = who(req, res);
    if (!w) return;
    const body = req.body || {};

    const thresholds: Record<string, number | null> = {};
    for (const stage of JOURNEY_STAGE_ORDER as readonly string[]) {
      const v = body.thresholds?.[stage];
      if (v === undefined) continue;
      thresholds[stage] = v === null || v === "" ? null : Math.max(1, Math.min(365, Math.round(Number(v) || 0)));
    }
    const lineEnabled: Record<string, boolean> = {};
    for (const line of SERVICE_LINES as readonly string[]) {
      const v = body.lineEnabled?.[line];
      if (v !== undefined) lineEnabled[line] = !!v;
    }
    const data = {
      enabled: body.enabled === undefined ? true : !!body.enabled,
      evaEnabled: body.evaEnabled === undefined ? true : !!body.evaEnabled,
      thresholds,
      lineEnabled,
    };

    const row = w.isAdmin
      ? await prisma.silenceConfig.upsert({
          where: { id: "defaults" },
          create: { id: "defaults", providerId: null, ...data },
          update: data,
        })
      : await prisma.silenceConfig.upsert({
          where: { providerId: w.providerId! },
          create: { providerId: w.providerId, ...data },
          update: data,
        });
    res.json({ ok: true, updatedAt: row.updatedAt });
  } catch (e: any) {
    console.error("[automation] PUT silence:", e);
    res.status(500).json({ message: e?.message || "Server error" });
  }
});
