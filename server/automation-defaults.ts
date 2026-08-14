/**
 * Platform defaults for the billing/document automations, and the shared
 * resolution every gate-2 site uses. The cascade mirrors the silence signal:
 *
 *   provider override -> platform default (AutomationDefaults row) -> off
 *
 * A provider's override is autoFeaturesEnabled.autoCostSheetDraft /
 * autoInvoiceDraft (a MISSING key means "inherit"; an explicit true/false is
 * an override, so an org can lock a flow off even when the platform default
 * is on). Agreement mode overrides via Provider.agreementAutomation (null =
 * inherit), with the legacy per-provider rollout flag
 * autoFeaturesEnabled.autoAgreementDraft === true still honored as
 * "approval" between the override and the default, so orgs GoStork enabled
 * before defaults existed keep their behavior.
 *
 * Takes the db handle as an argument so both the express routers (raw
 * client from server/db) and the Nest services (PrismaService wrapper) share
 * one implementation.
 */

export type AgreementMode = "off" | "approval" | "auto_send";

export interface AutomationDefaultsShape {
  autoCostSheetDraft: boolean;
  autoInvoiceDraft: boolean;
  agreementAutomation: AgreementMode;
}

export const AUTOMATION_BUILTIN_DEFAULTS: AutomationDefaultsShape = {
  autoCostSheetDraft: false,
  autoInvoiceDraft: false,
  agreementAutomation: "off",
};

const isMode = (v: unknown): v is AgreementMode =>
  v === "off" || v === "approval" || v === "auto_send";

/** The platform defaults row; built-in (all off) when never saved. */
export async function getAutomationDefaults(db: {
  automationDefaults: { findUnique(args: any): Promise<any> };
}): Promise<AutomationDefaultsShape> {
  const row = await db.automationDefaults.findUnique({ where: { id: "defaults" } }).catch(() => null);
  if (!row) return { ...AUTOMATION_BUILTIN_DEFAULTS };
  return {
    autoCostSheetDraft: row.autoCostSheetDraft === true,
    autoInvoiceDraft: row.autoInvoiceDraft === true,
    agreementAutomation: isMode(row.agreementAutomation) ? row.agreementAutomation : "off",
  };
}

/** Effective boolean for autoCostSheetDraft / autoInvoiceDraft on one org. */
export function resolveAutoFlag(
  autoFeaturesEnabled: unknown,
  key: "autoCostSheetDraft" | "autoInvoiceDraft",
  defaults: AutomationDefaultsShape,
): boolean {
  const v = (autoFeaturesEnabled as Record<string, unknown> | null | undefined)?.[key];
  if (typeof v === "boolean") return v;
  return defaults[key];
}

/** Effective agreement mode for one org (override -> legacy flag -> default). */
export function resolveAgreementMode(
  provider: { agreementAutomation?: string | null; autoFeaturesEnabled?: unknown },
  defaults: AutomationDefaultsShape,
): AgreementMode {
  if (isMode(provider.agreementAutomation)) return provider.agreementAutomation;
  const legacy = (provider.autoFeaturesEnabled as { autoAgreementDraft?: boolean } | null | undefined)?.autoAgreementDraft;
  if (legacy === true) return "approval";
  return defaults.agreementAutomation;
}
