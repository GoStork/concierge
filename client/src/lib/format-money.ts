/**
 * Canonical money formatters - used everywhere money is rendered to the
 * user. Two rules baked in:
 *   1. Always include thousands separators (commas): 17000 -> "$17,000".
 *   2. Show decimals ONLY when there's a real fractional part. A whole
 *      dollar amount loses its ".00" tail so $17,000.00 reads as $17,000,
 *      while $17,000.50 still reads with both digits.
 *
 * Prefer these over inline Intl.NumberFormat / toFixed / toLocaleString
 * so the whole app stays visually consistent.
 */

function buildFormatter(dollars: number, currency: string): Intl.NumberFormat {
  // Round to the nearest cent before deciding whether the value is a whole
  // dollar - protects against floating-point dust (e.g. 17000.0000000001).
  const isWholeDollar = Math.round(dollars * 100) % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: isWholeDollar ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatMoneyDollars(dollars: number, currency = "USD"): string {
  const safe = Number.isFinite(dollars) ? dollars : 0;
  return buildFormatter(safe, currency).format(safe);
}

export function formatMoneyCents(cents: number, currency = "USD"): string {
  const dollars = (Number.isFinite(cents) ? cents : 0) / 100;
  return buildFormatter(dollars, currency).format(dollars);
}
