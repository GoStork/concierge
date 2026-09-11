/**
 * PandaDoc tax-form field extractors. Fetch a completed W-9 or W-8BEN-E
 * document from PandaDoc and map its form-field values to
 * ProviderLegalIdentity fields.
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
import { countryNameToIso } from "../../../../shared/payout-countries";

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
type PandaDocField = { uuid?: string; field_id?: string; merge_field?: string; name?: string; type?: string; value?: any; field_value?: any };
type FieldGetter = (...candidates: string[]) => string | null;

/**
 * Fetches a completed document's fields from PandaDoc and returns a getter
 * that resolves a field by `name`, `merge_field`, or `field_id`. Returns
 * null on transient failures (PandaDoc 5xx) so the caller can retry;
 * throws on misconfiguration or an invalid doc id.
 */
async function fetchPandaDocFields(pandaDocDocumentId: string): Promise<FieldGetter | null> {
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
  const data = (await res.json()) as { fields?: PandaDocField[] };

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
  return get;
}

export async function extractW9Fields(pandaDocDocumentId: string): Promise<LegalIdentityFormData | null> {
  const get = await fetchPandaDocFields(pandaDocDocumentId);
  if (!get) return null;

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

/**
 * W-8BEN-E (Rev. 10-2021) field map. The PandaDoc template was built from
 * the IRS PDF, so fields keep the PDF's own widget names
 * ("topmostSubform[0].Page1[0].f1_4[0]"). Page 1 lines we use:
 *   f1_1        -> Line 1  Name of organization      -> legalName + businessName
 *   f1_3        -> Line 3  Disregarded entity name   -> businessName (when set)
 *   c1_1[0..12] -> Line 4  Chapter 3 status boxes    -> taxClassification
 *   f1_4        -> Line 6  Permanent residence street
 *   f1_5        -> Line 6  City / state or province / postal code
 *   f1_6        -> Line 6  Country                   -> businessAddressCountry
 *   f1_10       -> Line 8  U.S. TIN (if any)
 *   f1_12       -> Line 9b Foreign TIN               -> taxId (taxIdType=foreign)
 * Line 2 (country of incorporation, f1_2) is not the address country and
 * is deliberately not mapped. Lines 7 (mailing address) and 9a (GIIN) are
 * not needed for payouts.
 */
const W8_PAGE1 = "topmostSubform[0].Page1[0].";
// Printed order of the Line 4 boxes on the 2021 form.
const W8_CHAPTER3_STATUS: Array<string | null> = [
  "C_CORPORATION",    // Corporation
  "LLC",              // Disregarded entity
  "PARTNERSHIP",      // Partnership
  "TRUST_ESTATE",     // Simple trust
  "TRUST_ESTATE",     // Grantor trust
  "TRUST_ESTATE",     // Complex trust
  "TRUST_ESTATE",     // Estate
  null,               // Government
  null,               // Central Bank of Issue
  null,               // Tax-exempt organization
  null,               // Private foundation
  null,               // International organization
  null,               // (last box on the row)
];

/**
 * Foreign "City, Province, Postal" line: no 2-letter-state assumption.
 * Split on commas; a trailing token that carries digits is the postal
 * code, the first token is the city, anything between is the region.
 */
export function parseForeignCityLine(raw: string | null | undefined): {
  city: string | null;
  state: string | null;
  postalCode: string | null;
} {
  if (!raw) return { city: null, state: null, postalCode: null };
  const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return { city: null, state: null, postalCode: null };
  let postalCode: string | null = null;
  if (parts.length > 1 && /\d/.test(parts[parts.length - 1])) postalCode = parts.pop()!;
  const city = parts.shift() || null;
  const state = parts.length ? parts.join(", ") : null;
  return { city, state, postalCode };
}

export async function extractW8BeneFields(pandaDocDocumentId: string): Promise<LegalIdentityFormData | null> {
  const get = await fetchPandaDocFields(pandaDocDocumentId);
  if (!get) return null;
  const line = (id: string) => get(`${W8_PAGE1}${id}[0]`)?.trim() || null;

  const legalName = line("f1_1");
  const businessName = line("f1_3") || legalName;

  let taxClassification: string | null = null;
  for (let i = 0; i < W8_CHAPTER3_STATUS.length; i++) {
    const v = get(`${W8_PAGE1}c1_1[${i}]`);
    if (v === "true" || v === "1") { taxClassification = W8_CHAPTER3_STATUS[i]; break; }
  }
  // W-8BEN-E is the entity form (an individual signs a W-8BEN), so an
  // unticked or unmapped Line 4 still means "company" on the Legal tab.
  taxClassification ??= "C_CORPORATION";

  // No apt/suite split for foreign streets: "#" is part of the street
  // number in Latin American addresses ("Carrera 5 #9-26 Sur"), not a unit.
  const line1 = line("f1_4");
  const parsed = parseForeignCityLine(line("f1_5"));
  const businessAddressCountry = countryNameToIso(line("f1_6"));

  const usTin = line("f1_10");
  const foreignTin = line("f1_12");
  const taxIdType: "ein" | "foreign" | null = usTin ? "ein" : foreignTin ? "foreign" : null;
  const taxId = usTin ? usTin.replace(/[^\d-]/g, "") : foreignTin;

  return {
    legalName,
    businessName,
    taxClassification,
    taxId,
    taxIdType,
    businessAddressLine1: line1,
    businessAddressLine2: null,
    businessAddressCity: parsed.city,
    businessAddressState: parsed.state,
    businessAddressPostalCode: parsed.postalCode,
    businessAddressCountry,
  };
}
