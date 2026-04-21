import { getCountries, getCountryCallingCode, getExampleNumber, type CountryCode } from "libphonenumber-js";
import examples from "libphonenumber-js/mobile/examples";

export interface PhoneCountry {
  isoCode: string;
  name: string;
  callingCode: string;
  flag: string;
  exampleFormat: string;
}

const POPULAR_ISO_CODES: CountryCode[] = ["US", "GB", "CA", "AU", "IL", "DE", "FR", "IN", "BR", "MX"];

function isoToFlag(isoCode: string): string {
  const upper = isoCode.toUpperCase();
  if (upper.length !== 2) return "";
  return String.fromCodePoint(127397 + upper.charCodeAt(0)) + String.fromCodePoint(127397 + upper.charCodeAt(1));
}

const displayNames = typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
  ? new Intl.DisplayNames(["en"], { type: "region" })
  : null;

function isoToName(isoCode: string): string {
  try {
    return displayNames?.of(isoCode) ?? isoCode;
  } catch {
    return isoCode;
  }
}

function isoToExample(isoCode: CountryCode): string {
  try {
    const ex = getExampleNumber(isoCode, examples);
    return ex?.formatNational() ?? "";
  } catch {
    return "";
  }
}

function buildCountry(isoCode: CountryCode): PhoneCountry {
  return {
    isoCode,
    name: isoToName(isoCode),
    callingCode: `+${getCountryCallingCode(isoCode)}`,
    flag: isoToFlag(isoCode),
    exampleFormat: isoToExample(isoCode),
  };
}

const ALL_ISO_CODES = getCountries();

export const POPULAR_COUNTRIES: PhoneCountry[] = POPULAR_ISO_CODES
  .filter(iso => ALL_ISO_CODES.includes(iso))
  .map(buildCountry);

export const ALL_COUNTRIES: PhoneCountry[] = ALL_ISO_CODES
  .map(buildCountry)
  .sort((a, b) => a.name.localeCompare(b.name, "en"));

const byIso = new Map<string, PhoneCountry>(ALL_COUNTRIES.map(c => [c.isoCode, c]));

export function getCountryByIso(isoCode: string): PhoneCountry | undefined {
  if (!isoCode) return undefined;
  return byIso.get(isoCode.toUpperCase());
}

export function getCountryByCallingCode(callingCode: string): PhoneCountry | undefined {
  if (!callingCode) return undefined;
  const normalized = callingCode.startsWith("+") ? callingCode : `+${callingCode}`;
  return ALL_COUNTRIES.find(c => c.callingCode === normalized);
}
