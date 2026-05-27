/**
 * PandaDoc W-9 field extractor. Fetches a completed W-9 document from
 * PandaDoc and maps its form-field values to ProviderLegalIdentity
 * fields.
 *
 * Field mapping (from the GoStork W-9 PandaDoc template):
 *   Full_Name           -> legalName            (Line 1)
 *   Company_Name        -> businessName         (Line 2)
 *   RadioButtons1       -> taxClassification    (Line 3a, 1-5)
 *   Address             -> businessAddressLine1 (Line 5)
 *   City_State_zipcode  -> city + state + ZIP   (Line 6, best-effort parse)
 *   SSN                 -> taxId (taxIdType=ssn)
 *   EIN                 -> taxId (taxIdType=ein)
 */

import type { LegalIdentityFormData } from "./legal-identity.service";

// Maps the W-9 Line 3a radio-button option (1-5) to our enum value.
// Order matches the W-9 form's printed boxes.
const RADIO_TO_CLASSIFICATION: Record<string, string> = {
  "1": "INDIVIDUAL_SOLE_PROPRIETOR",
  "2": "C_CORPORATION",
  "3": "S_CORPORATION",
  "4": "PARTNERSHIP",
  "5": "TRUST_ESTATE",
  // PandaDoc may return the option label rather than its index - support both.
  "individual/sole proprietor": "INDIVIDUAL_SOLE_PROPRIETOR",
  "individual": "INDIVIDUAL_SOLE_PROPRIETOR",
  "c corporation": "C_CORPORATION",
  "s corporation": "S_CORPORATION",
  "partnership": "PARTNERSHIP",
  "trust/estate": "TRUST_ESTATE",
  "trust estate": "TRUST_ESTATE",
  "trust": "TRUST_ESTATE",
  "llc": "LLC",
};

function mapRadioToClassification(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return RADIO_TO_CLASSIFICATION[key] ?? null;
}

/**
 * Splits a single-line address into street + apt/suite components.
 * W-9 Line 5 is one free-text field ("Address (number, street, and apt.
 * or suite no.)") so providers type "60 W 60 St Apt 31A" into a single
 * box. We pull the trailing unit marker out so our line2 field holds it
 * separately for Stripe Connect / display.
 *
 * Recognises: Apt, Apartment, Suite, Ste, Unit, #, Fl, Floor.
 * Returns { line1, line2 } where line2 is null if no marker found.
 */
export function splitAddressApt(raw: string | null | undefined): { line1: string | null; line2: string | null } {
  if (!raw) return { line1: null, line2: null };
  const s = raw.trim();
  // Match a trailing unit segment: <street> (Apt|Suite|...|#) <value>
  const m = s.match(/^(.+?)[,\s]+((?:Apt(?:\.|artment)?|Suite|Ste\.?|Unit|Fl(?:\.|oor)?|#)[\s.]*\S.*)$/i);
  if (m) {
    return { line1: m[1].trim().replace(/[,\s]+$/, ""), line2: m[2].trim() };
  }
  return { line1: s, line2: null };
}

/**
 * Parses a single-line "City, ST 12345" or "City ST 12345" into parts.
 * Best-effort - returns whatever it can identify. Admins can correct in
 * the Legal Identity tab if parsing misses.
 */
export function parseCityStateZip(raw: string | null | undefined): {
  city: string | null;
  state: string | null;
  postalCode: string | null;
} {
  if (!raw) return { city: null, state: null, postalCode: null };
  const s = raw.trim();
  // Match "City, ST 12345" or "City, ST 12345-6789".
  const m = s.match(/^(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  if (m) {
    return {
      city: m[1].trim().replace(/,$/, ""),
      state: m[2].toUpperCase(),
      postalCode: m[3],
    };
  }
  // Fallback: just a ZIP at the end?
  const zipMatch = s.match(/(\d{5}(?:-\d{4})?)$/);
  if (zipMatch) {
    const beforeZip = s.slice(0, zipMatch.index).trim().replace(/,$/, "");
    const stateMatch = beforeZip.match(/([A-Z]{2})$/i);
    if (stateMatch) {
      return {
        city: beforeZip.slice(0, stateMatch.index).trim().replace(/,$/, ""),
        state: stateMatch[1].toUpperCase(),
        postalCode: zipMatch[1],
      };
    }
    return { city: beforeZip, state: null, postalCode: zipMatch[1] };
  }
  return { city: s, state: null, postalCode: null };
}

/**
 * Fetches the completed W-9 from PandaDoc and returns a
 * LegalIdentityFormData shape ready to pass to
 * LegalIdentityService.applyFromW9. Returns null on transient failures
 * (PandaDoc 5xx, network) so the caller can retry later.
 *
 * Throws on misconfiguration (missing env var) or invalid doc id - those
 * are bugs, not transient.
 */
export async function extractW9Fields(pandaDocDocumentId: string): Promise<LegalIdentityFormData | null> {
  const apiKey = process.env.PANDADOC_API_KEY;
  if (!apiKey) throw new Error("PANDADOC_API_KEY not set");

  const url = `https://api.pandadoc.com/public/v1/documents/${encodeURIComponent(pandaDocDocumentId)}/details`;
  const res = await fetch(url, {
    headers: { Authorization: `API-Key ${apiKey}` },
  });
  if (res.status >= 500) {
    // Transient; caller can retry.
    return null;
  }
  if (!res.ok) {
    throw new Error(`PandaDoc details API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { fields?: Array<{ uuid?: string; field_id?: string; merge_field?: string; name?: string; value?: any; field_value?: any }> };

  const fields = data.fields || [];
  // PandaDoc surfaces fields differently across API versions; we look up
  // by `name`, `merge_field`, AND `field_id` to be robust to whichever
  // identifier the template owner set in PandaDoc's template editor.
  const get = (...candidates: string[]): string | null => {
    for (const c of candidates) {
      const key = c.toLowerCase();
      const f = fields.find(
        x =>
          (x.name && x.name.toLowerCase() === key) ||
          (x.merge_field && x.merge_field.toLowerCase() === key) ||
          (x.field_id && x.field_id.toLowerCase() === key),
      );
      if (f) {
        // Field value can live under `value` or `field_value` depending on
        // the field type. Both checked.
        const v = (f.value ?? f.field_value);
        if (v == null) continue;
        if (typeof v === "string") return v;
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        // Radio buttons: object like { value: "1" } or { selected: "..." }.
        if (typeof v === "object") {
          if (typeof v.value === "string" || typeof v.value === "number") return String(v.value);
          if (typeof v.selected === "string") return v.selected;
        }
      }
    }
    return null;
  };

  const legalName = get("Full_Name") || null;
  // W-9 Line 2 ("Business name / disregarded entity name, if different
  // from above") is empty when Line 1 IS the business name (typical for
  // LLCs / corps where the entity name lives on Line 1). For our
  // downstream uses (receipt PDFs, Stripe Connect KYC) we always want a
  // non-null business name, so we fall back to legalName when Line 2 is
  // blank.
  const businessName = get("Company_Name") || legalName || null;
  const taxClassification = mapRadioToClassification(get("RadioButtons1"));
  const rawAddressLine = get("Address") || null;
  const { line1: addressLine, line2: addressLine2 } = splitAddressApt(rawAddressLine);
  const cityStateZip = get("City_State_zipcode") || null;
  const ssn = get("SSN") || null;
  const ein = get("EIN") || null;

  // Prefer EIN over SSN when both are present (entity W-9). Strip
  // formatting so what we store matches what Stripe expects.
  const taxIdType: "ssn" | "ein" | null = ein ? "ein" : ssn ? "ssn" : null;
  const taxId = (ein || ssn || null)?.replace(/[^\d-]/g, "") || null;

  const parsed = parseCityStateZip(cityStateZip);

  // If the radio gave us an individual classification but the form had
  // an EIN, that's likely an LLC reporting as an individual - leave
  // taxClassification alone (manual override can fix).

  return {
    legalName,
    businessName,
    taxClassification,
    taxId,
    taxIdType,
    businessAddressLine1: addressLine,
    businessAddressLine2: addressLine2,
    businessAddressCity: parsed.city,
    businessAddressState: parsed.state,
    businessAddressPostalCode: parsed.postalCode,
  };
}
