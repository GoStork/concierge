/**
 * Canonical money formatters - mirrors client/src/lib/format-money.ts so
 * receipts, emails, SMS messages, and chat strings render dollars exactly
 * the way the UI does. Two rules:
 *   1. Always include thousands separators (commas): 17000 -> "$17,000".
 *   2. Show decimals ONLY when there's a real fractional part. Whole
 *      dollars lose the ".00" tail.
 *
 * Prefer these over inline `$${x.toFixed(2)}` or Intl.NumberFormat calls.
 */

function buildFormatter(dollars: number, currency: string): Intl.NumberFormat {
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
