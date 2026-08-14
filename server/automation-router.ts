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
import { getAutomationDefaults, resolveAutoFlag, resolveAgreementMode, type AgreementMode } from "./automation-defaults";

export const automationRouter = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Not authenticated" });
  }
  next();
}

function who(req: Request, res: Response): { isAdmin: boolean; providerId: string | null } | null {
  const user = req.user as any;
  if (isGostorkStaff(user)) {
    // GoStork staff may act on behalf of a specific provider org (admin
    // provider edit page) by passing ?providerId=; without it they edit
    // platform defaults as before.
    const target = typeof req.query?.providerId === "string" ? req.query.providerId : "";
    if (target) return { isAdmin: false, providerId: target };
    return { isAdmin: true, providerId: null };
  }
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

/**
 * Provider self-service billing/document automation flags. autoCostSheetDraft
 * and autoInvoiceDraft live in Provider.autoFeaturesEnabled - the same JSON
 * the GoStork admin card writes, so either side's flip is visible to both.
 * Each flow still sits behind its global ConciergePromptSection kill switch
 * (gate 1); the response exposes those so the UI can say when a flow is
 * paused platform-wide regardless of the provider's own toggle.
 */
const FEATURE_GATES: Record<string, string> = {
  autoCostSheetDraft: "auto_cost_sheet_on_booking",
  autoInvoiceDraft: "auto_invoice_on_ready",
  agreementAutomation: "auto_agreement_on_paid",
};

/**
 * Whose billing automation is being edited. Mirrors the silence signal:
 * GoStork staff without ?providerId= edit the PLATFORM DEFAULTS every org
 * inherits; with ?providerId= (admin provider edit page) they act on that
 * org; provider staff always act on their own org.
 */
function featuresTarget(req: Request, res: Response): { defaults: true } | { defaults: false; providerId: string } | null {
  const user = req.user as any;
  if (isGostorkStaff(user)) {
    const target = typeof req.query?.providerId === "string" ? req.query.providerId : "";
    return target ? { defaults: false, providerId: target } : { defaults: true };
  }
  if (isProviderStaff(user) && user.providerId) {
    return { defaults: false, providerId: user.providerId as string };
  }
  res.status(403).json({ message: "Forbidden" });
  return null;
}

const isAgreementMode = (v: unknown): v is AgreementMode =>
  v === "off" || v === "approval" || v === "auto_send";

async function gateStates() {
  const rows = await prisma.conciergePromptSection.findMany({
    where: { key: { in: Object.values(FEATURE_GATES) } },
    select: { key: true, isActive: true },
  });
  const active = new Map(rows.map((g) => [g.key, g.isActive]));
  return Object.fromEntries(
    Object.entries(FEATURE_GATES).map(([field, key]) => [field, active.get(key) === true]),
  );
}

automationRouter.get("/api/automation/features", requireAuth, async (req, res) => {
  try {
    const t = featuresTarget(req, res);
    if (!t) return;
    const [defaults, gates] = await Promise.all([getAutomationDefaults(prisma), gateStates()]);
    if (t.defaults) {
      return res.json({ isAdminDefaults: true, defaults, effective: defaults, gates });
    }
    const provider = await prisma.provider.findUnique({
      where: { id: t.providerId },
      select: { agreementAutomation: true, autoFeaturesEnabled: true },
    });
    if (!provider) return res.status(404).json({ message: "Provider not found" });
    const flags = (provider.autoFeaturesEnabled as any) || {};
    res.json({
      isAdminDefaults: false,
      // Raw overrides; null = inherit the platform default.
      overrides: {
        autoCostSheetDraft: typeof flags.autoCostSheetDraft === "boolean" ? flags.autoCostSheetDraft : null,
        autoInvoiceDraft: typeof flags.autoInvoiceDraft === "boolean" ? flags.autoInvoiceDraft : null,
        agreementAutomation: isAgreementMode(provider.agreementAutomation) ? provider.agreementAutomation : null,
      },
      legacyAutoAgreementDraft: flags.autoAgreementDraft === true,
      defaults,
      effective: {
        autoCostSheetDraft: resolveAutoFlag(flags, "autoCostSheetDraft", defaults),
        autoInvoiceDraft: resolveAutoFlag(flags, "autoInvoiceDraft", defaults),
        agreementAutomation: resolveAgreementMode(provider, defaults),
      },
      gates,
    });
  } catch (e: any) {
    console.error("[automation] GET features:", e);
    res.status(500).json({ message: e?.message || "Server error" });
  }
});

automationRouter.put("/api/automation/features", requireAuth, async (req, res) => {
  try {
    const t = featuresTarget(req, res);
    if (!t) return;
    const body = req.body || {};
    for (const k of ["autoCostSheetDraft", "autoInvoiceDraft"] as const) {
      if (body[k] !== undefined && typeof body[k] !== "boolean" && body[k] !== null) {
        return res.status(400).json({ message: `${k} must be true, false, or null` });
      }
    }
    if (body.agreementAutomation !== undefined && body.agreementAutomation !== null && !isAgreementMode(body.agreementAutomation)) {
      return res.status(400).json({ message: "agreementAutomation must be off, approval, auto_send, or null" });
    }

    if (t.defaults) {
      // Platform defaults have no "inherit" - null resets to built-in off.
      const data = {
        ...(body.autoCostSheetDraft !== undefined ? { autoCostSheetDraft: body.autoCostSheetDraft === true } : {}),
        ...(body.autoInvoiceDraft !== undefined ? { autoInvoiceDraft: body.autoInvoiceDraft === true } : {}),
        ...(body.agreementAutomation !== undefined
          ? { agreementAutomation: isAgreementMode(body.agreementAutomation) ? body.agreementAutomation : "off" }
          : {}),
      };
      await prisma.automationDefaults.upsert({
        where: { id: "defaults" },
        create: { id: "defaults", ...data },
        update: data,
      });
      const defaults = await getAutomationDefaults(prisma);
      return res.json({ ok: true, isAdminDefaults: true, defaults });
    }

    const existing = await prisma.provider.findUnique({
      where: { id: t.providerId },
      select: { autoFeaturesEnabled: true },
    });
    if (!existing) return res.status(404).json({ message: "Provider not found" });
    const next = { ...((existing.autoFeaturesEnabled as any) || {}) };
    for (const k of ["autoCostSheetDraft", "autoInvoiceDraft"] as const) {
      if (body[k] === null) delete next[k]; // back to inheriting the default
      else if (typeof body[k] === "boolean") next[k] = body[k];
    }
    // Explicitly choosing "use the GoStork default" also clears the legacy
    // rollout flag, which would otherwise pin the org to "approval".
    if (body.agreementAutomation === null) delete next.autoAgreementDraft;
    await prisma.provider.update({
      where: { id: t.providerId },
      data: {
        autoFeaturesEnabled: next,
        ...(body.agreementAutomation !== undefined ? { agreementAutomation: body.agreementAutomation } : {}),
      },
    });
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[automation] PUT features:", e);
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
