/**
 * Platform defaults for the billing/document automations, and the shared
 * resolution every gate-2 site uses. The cascade mirrors the silence signal:
 *
 *   provider override -> legacy per-provider flag -> platform default
 *
 * Every flow is a three-mode ladder: "off" | "approval" | "auto_send".
 *
 * Overrides live on the Provider row: agreementAutomation column (null =
 * inherit) and autoFeaturesEnabled JSON keys costSheetAutomation /
 * invoiceAutomation (absent = inherit). The pre-ladder LEGACY keys in that
 * JSON are still honored between override and default so orgs configured
 * before the ladder keep their behavior:
 *
 *   autoCostSheetDraft:  true -> "approval", false -> "off"
 *   autoInvoiceDraft:    true -> "approval", false -> "auto_send"
 *     (false/absent historically meant the caller ran the old DIRECT
 *      createInvoiceFromReadiness send - i.e. auto_send, not off)
 *   autoAgreementDraft:  true -> "approval" (agreements only)
 *
 * Takes the db handle as an argument so both the express routers (raw
 * client from server/db) and the Nest services (PrismaService wrapper) share
 * one implementation.
 */

export type AutomationMode = "off" | "approval" | "auto_send";
/** Back-compat alias; agreements were the first flow with the ladder. */
export type AgreementMode = AutomationMode;

export interface AutomationDefaultsShape {
  costSheetAutomation: AutomationMode;
  invoiceAutomation: AutomationMode;
  agreementAutomation: AutomationMode;
}

/** Invoice defaults to auto_send: that IS the historical base behavior. */
export const AUTOMATION_BUILTIN_DEFAULTS: AutomationDefaultsShape = {
  costSheetAutomation: "off",
  invoiceAutomation: "auto_send",
  agreementAutomation: "off",
};

export const isAutomationMode = (v: unknown): v is AutomationMode =>
  v === "off" || v === "approval" || v === "auto_send";

/** The platform defaults row; built-in values when never saved. */
export async function getAutomationDefaults(db: {
  automationDefaults: { findUnique(args: any): Promise<any> };
}): Promise<AutomationDefaultsShape> {
  const row = await db.automationDefaults.findUnique({ where: { id: "defaults" } }).catch(() => null);
  if (!row) return { ...AUTOMATION_BUILTIN_DEFAULTS };
  return {
    costSheetAutomation: isAutomationMode(row.costSheetAutomation) ? row.costSheetAutomation : AUTOMATION_BUILTIN_DEFAULTS.costSheetAutomation,
    invoiceAutomation: isAutomationMode(row.invoiceAutomation) ? row.invoiceAutomation : AUTOMATION_BUILTIN_DEFAULTS.invoiceAutomation,
    agreementAutomation: isAutomationMode(row.agreementAutomation) ? row.agreementAutomation : AUTOMATION_BUILTIN_DEFAULTS.agreementAutomation,
  };
}

const LEGACY_MAP: Record<"costSheet" | "invoice", { key: string; whenTrue: AutomationMode; whenFalse: AutomationMode }> = {
  costSheet: { key: "autoCostSheetDraft", whenTrue: "approval", whenFalse: "off" },
  invoice: { key: "autoInvoiceDraft", whenTrue: "approval", whenFalse: "auto_send" },
};

export const DOC_MODE_KEYS: Record<"costSheet" | "invoice", "costSheetAutomation" | "invoiceAutomation"> = {
  costSheet: "costSheetAutomation",
  invoice: "invoiceAutomation",
};

/**
 * The org's explicit choice for a flow, or null when it inherits. The legacy
 * boolean counts as an explicit choice - the org (or GoStork, on its behalf)
 * set it deliberately.
 */
export function docModeOverride(
  autoFeaturesEnabled: unknown,
  flow: "costSheet" | "invoice",
): AutomationMode | null {
  const flags = (autoFeaturesEnabled as Record<string, unknown> | null | undefined) || {};
  const mode = flags[DOC_MODE_KEYS[flow]];
  if (isAutomationMode(mode)) return mode;
  const legacy = LEGACY_MAP[flow];
  const v = flags[legacy.key];
  if (typeof v === "boolean") return v ? legacy.whenTrue : legacy.whenFalse;
  return null;
}

/** Effective mode for cost sheets / invoices on one org. */
export function resolveDocMode(
  autoFeaturesEnabled: unknown,
  flow: "costSheet" | "invoice",
  defaults: AutomationDefaultsShape,
): AutomationMode {
  return docModeOverride(autoFeaturesEnabled, flow) ?? defaults[DOC_MODE_KEYS[flow]];
}

/** Effective agreement mode for one org (override -> legacy flag -> default). */
export function resolveAgreementMode(
  provider: { agreementAutomation?: string | null; autoFeaturesEnabled?: unknown },
  defaults: AutomationDefaultsShape,
): AutomationMode {
  if (isAutomationMode(provider.agreementAutomation)) return provider.agreementAutomation;
  const legacy = (provider.autoFeaturesEnabled as { autoAgreementDraft?: boolean } | null | undefined)?.autoAgreementDraft;
  if (legacy === true) return "approval";
  return defaults.agreementAutomation;
}
