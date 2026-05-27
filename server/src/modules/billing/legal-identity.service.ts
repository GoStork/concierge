import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { prisma as prismaClient } from "../../../db";
import { extractW9Fields } from "./w9-extractor";

/**
 * Source of truth for a provider's legal identity (legal name, tax ID,
 * federal tax classification, business address, derived Stripe-friendly
 * business_type). Replaces the legalName + taxId fields that previously
 * lived on ProviderBrandSettings, and consolidates the Business Identity
 * fields that the Custom Payouts form used to collect inline.
 *
 * Three write paths:
 *  - Provider manually edits at /account/legal-identity (source=MANUAL)
 *  - PandaDoc document.completed webhook auto-fills from the signed W-9
 *    (source=W9_AUTO_FILL). Never overwrites a manually-set field.
 *  - Admin edits at /admin/providers/:id?tab=legal-identity (same as
 *    provider, but admin-side).
 */

export type TaxClassification =
  | "INDIVIDUAL_SOLE_PROPRIETOR"
  | "C_CORPORATION"
  | "S_CORPORATION"
  | "PARTNERSHIP"
  | "TRUST_ESTATE"
  | "LLC"
  | "OTHER";

export type BusinessType = "individual" | "company";

/**
 * Maps a W-9 federal-tax-classification value to Stripe Connect's binary
 * business_type field. Sole proprietor + individual => "individual";
 * everything else (corps, partnerships, LLCs, trusts) => "company".
 */
export function classificationToBusinessType(c: TaxClassification | string | null | undefined): BusinessType {
  if (c === "INDIVIDUAL_SOLE_PROPRIETOR") return "individual";
  return "company";
}

export interface LegalIdentityFormData {
  legalName?: string | null;
  businessName?: string | null;
  taxClassification?: TaxClassification | string | null;
  // businessType is auto-derived from taxClassification, so the form
  // doesn't accept it directly - we recompute on every save.
  taxId?: string | null;
  taxIdType?: "ssn" | "ein" | null;
  businessAddressLine1?: string | null;
  businessAddressLine2?: string | null;
  businessAddressCity?: string | null;
  businessAddressState?: string | null;
  businessAddressPostalCode?: string | null;
  businessAddressCountry?: string | null;
}

@Injectable()
export class LegalIdentityService {
  private readonly logger = new Logger(LegalIdentityService.name);
  private readonly prisma = prismaClient;

  /**
   * Returns the row, creating an empty one on first read so the rest of
   * the code doesn't have to handle the "no row yet" case.
   */
  async getOrCreate(providerId: string) {
    const existing = await this.prisma.providerLegalIdentity.findUnique({
      where: { providerId },
    });
    if (existing) return existing;
    return await this.prisma.providerLegalIdentity.create({
      data: { providerId },
    });
  }

  /** Full row for the UI. */
  async get(providerId: string) {
    return await this.getOrCreate(providerId);
  }

  /**
   * Manual save from the Legal Identity tab. Flips source to MANUAL on
   * any edit so subsequent W-9 webhooks don't overwrite the change.
   */
  async update(providerId: string, form: LegalIdentityFormData) {
    const existing = await this.getOrCreate(providerId);

    // Auto-derive businessType from taxClassification so the rest of the
    // app has one canonical "company vs individual" answer.
    const taxClassification = form.taxClassification ?? existing.taxClassification;
    const businessType = taxClassification
      ? classificationToBusinessType(taxClassification as TaxClassification)
      : existing.businessType;

    return await this.prisma.providerLegalIdentity.update({
      where: { providerId },
      data: {
        legalName: form.legalName ?? existing.legalName,
        businessName: form.businessName ?? existing.businessName,
        taxClassification: form.taxClassification ?? existing.taxClassification,
        businessType,
        taxId: form.taxId ?? existing.taxId,
        taxIdType: form.taxIdType ?? existing.taxIdType,
        businessAddressLine1: form.businessAddressLine1 ?? existing.businessAddressLine1,
        businessAddressLine2: form.businessAddressLine2 ?? existing.businessAddressLine2,
        businessAddressCity: form.businessAddressCity ?? existing.businessAddressCity,
        businessAddressState: form.businessAddressState ?? existing.businessAddressState,
        businessAddressPostalCode: form.businessAddressPostalCode ?? existing.businessAddressPostalCode,
        businessAddressCountry: form.businessAddressCountry ?? existing.businessAddressCountry,
        source: "MANUAL",
      },
    });
  }

  /**
   * Auto-fill from a parsed W-9. Only sets fields that are currently
   * null/empty - never overwrites a manually-set value. Stamps
   * lastW9SyncAt regardless of whether anything actually changed so the
   * UI can show "Last synced from W-9 on X".
   *
   * Returns { applied: string[] } with the list of fields that were
   * actually filled, so the caller can log a useful audit line.
   */
  async applyFromW9(providerId: string, w9: LegalIdentityFormData): Promise<{ applied: string[] }> {
    const existing = await this.getOrCreate(providerId);
    const applied: string[] = [];

    const data: Record<string, any> = { lastW9SyncAt: new Date() };
    const maybeFill = (key: keyof LegalIdentityFormData, dbKey: string) => {
      const currentValue = (existing as any)[dbKey];
      const newValue = w9[key];
      // Skip if (a) we have no new value or (b) the row already has a value
      // - manual edits win over W-9 auto-fill.
      if (newValue == null || newValue === "") return;
      if (currentValue != null && currentValue !== "") return;
      data[dbKey] = newValue;
      applied.push(dbKey);
    };

    maybeFill("legalName", "legalName");
    maybeFill("businessName", "businessName");
    maybeFill("taxClassification", "taxClassification");
    maybeFill("taxId", "taxId");
    maybeFill("taxIdType", "taxIdType");
    maybeFill("businessAddressLine1", "businessAddressLine1");
    maybeFill("businessAddressCity", "businessAddressCity");
    maybeFill("businessAddressState", "businessAddressState");
    maybeFill("businessAddressPostalCode", "businessAddressPostalCode");

    // Re-derive businessType only if taxClassification was just applied
    // and businessType isn't already manually set.
    if (applied.includes("taxClassification") && !existing.businessType) {
      data.businessType = classificationToBusinessType(w9.taxClassification as TaxClassification);
      applied.push("businessType");
    }

    // Source: only flip to W9_AUTO_FILL if this is the first time we're
    // populating real data. If the row is already MANUAL, leave it
    // MANUAL even after a W-9 sync (we honored the manual values; the
    // sync just filled in missing ones).
    if (existing.source === "MIGRATED_FROM_BRAND_SETTINGS" || (existing.source === "MANUAL" && !existing.legalName && !existing.taxId)) {
      data.source = "W9_AUTO_FILL";
    }

    await this.prisma.providerLegalIdentity.update({
      where: { providerId },
      data,
    });

    if (applied.length > 0) {
      this.logger.log(`W-9 auto-fill for provider ${providerId} applied ${applied.length} fields: ${applied.join(", ")}`);
    } else {
      this.logger.log(`W-9 auto-fill for provider ${providerId} applied 0 fields (all fields already populated)`);
    }

    return { applied };
  }

  /**
   * Sync from the provider's signed W-9. Looks up the PandaDoc document
   * id, fetches form-field values via the extractor, applies them via
   * applyFromW9. Idempotent: skips if the W-9 has been synced after the
   * row was last manually edited.
   *
   * Returns:
   *   - { status: "applied", appliedFields }   - data was pulled in
   *   - { status: "noop", reason }             - skipped (already synced, no W-9, etc.)
   *   - { status: "failed", reason }           - transient failure; caller can retry
   */
  async syncFromW9(providerId: string): Promise<
    | { status: "applied"; appliedFields: string[] }
    | { status: "noop"; reason: string }
    | { status: "failed"; reason: string }
  > {
    const w9 = await this.prisma.providerW9.findUnique({
      where: { providerId },
      select: { status: true, pandaDocDocumentId: true, completedAt: true },
    });
    if (!w9) return { status: "noop", reason: "Provider has no W-9 record yet" };
    if (w9.status !== "COMPLETED") return { status: "noop", reason: `W-9 status is ${w9.status}, not COMPLETED` };
    if (!w9.pandaDocDocumentId) return { status: "noop", reason: "W-9 has no PandaDoc document id" };

    // Skip if we've already synced from this completion.
    const existing = await this.prisma.providerLegalIdentity.findUnique({
      where: { providerId },
      select: { lastW9SyncAt: true },
    });
    if (existing?.lastW9SyncAt && w9.completedAt && existing.lastW9SyncAt >= w9.completedAt) {
      return { status: "noop", reason: "Already synced from this W-9 completion" };
    }

    let extracted: LegalIdentityFormData | null;
    try {
      extracted = await extractW9Fields(w9.pandaDocDocumentId);
    } catch (e: any) {
      this.logger.error(`W-9 extract failed for provider ${providerId}: ${e?.message}`);
      return { status: "failed", reason: e?.message || "Extract failed" };
    }
    if (!extracted) {
      return { status: "failed", reason: "PandaDoc transient error - retry later" };
    }

    const { applied } = await this.applyFromW9(providerId, extracted);
    return { status: "applied", appliedFields: applied };
  }

  /**
   * Returns true when the legal identity is complete enough that
   * GoStork can issue invoices for this provider. Mirrors the old
   * billing-identity completeness rule but reads from the new model.
   */
  async isComplete(providerId: string): Promise<{ complete: boolean; missing: string[] }> {
    const row = await this.prisma.providerLegalIdentity.findUnique({
      where: { providerId },
    });
    const missing: string[] = [];
    if (!row?.legalName?.trim()) missing.push("Legal Name");
    if (!row?.taxId?.trim()) missing.push("Tax ID");
    return { complete: missing.length === 0, missing };
  }
}
