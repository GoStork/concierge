/**
 * Shared chat utility functions used by conversations-page,
 * admin-concierge-monitor, and extracted chat sub-components.
 */

/**
 * Converts a date string to a human-friendly day label.
 * Returns "Today", "Yesterday", a weekday name (if within 7 days),
 * or a full date string.
 */
export function chatDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

/**
 * Returns a compact relative-time string like "now", "5m", "3h", "2d",
 * or a full date for older timestamps.
 */
export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(dateStr).toLocaleDateString();
}

/**
 * Strips [[tag]] markers and newlines, then truncates to maxLen characters.
 */
export function truncateMessage(msg: string, maxLen = 60): string {
  const cleaned = msg.replace(/\[\[.*?\]\]/g, "").replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen) + "...";
}

/**
 * Returns the URL slug prefix for a profile type
 * (surrogate, eggdonor, spermdonor).
 */
export function getProfileUrlSlug(type: string): string {
  const t = type.toLowerCase();
  if (t === "surrogate") return "surrogate";
  if (t === "egg donor") return "eggdonor";
  if (t === "sperm donor") return "spermdonor";
  return "surrogate";
}
