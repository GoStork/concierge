/**
 * Date/time formatters. Centralize so date strings stay consistent across
 * tables, cards, and emails - changing the format here changes it everywhere.
 */

/**
 * Short date + short time in the user's locale, e.g. "5/27/2026, 11:14 PM"
 * (en-US) or "27/05/2026 23:14" (en-GB). Used on payout/invoice tables
 * where the user needs to know which payout event happened when on a busy
 * day.
 */
export function formatDateTime(input: string | Date | null | undefined): string {
  if (!input) return "-";
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
