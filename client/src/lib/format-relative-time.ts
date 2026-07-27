/**
 * Short, honest relative time for freshness labels.
 *
 * Availability is the most perishable fact in this marketplace: "AVAILABLE"
 * reads with identical confidence whether it was synced this morning or in
 * February. Showing when a record was last refreshed is what separates a live
 * inventory from a directory.
 *
 * Deliberately says "updated", not "confirmed available" - the nightly sync
 * refreshed the record from the agency, which is not the same as someone
 * verifying the person is still free. Claiming the stronger thing would be the
 * exact kind of over-promise this label exists to avoid.
 */
export function formatRelativeTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const then = value instanceof Date ? value : new Date(value);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return null;

  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 0) return null;            // clock skew - say nothing
  if (seconds < 60 * 60) return "today";
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return "today";
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "over a year ago" : `${years} years ago`;
}

/**
 * True once a record is old enough that a parent should weigh it - roughly a
 * month without a refresh. Callers can de-emphasise or caveat availability.
 */
export function isStale(value: string | Date | null | undefined, days = 30): boolean {
  if (!value) return false;
  const then = value instanceof Date ? value : new Date(value);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms > days * 24 * 60 * 60 * 1000;
}
