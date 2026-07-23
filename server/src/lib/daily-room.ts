const DAILY_API_BASE = "https://api.daily.co/v1";

/**
 * Create a private Daily.co room. Used for PER-BOOKING rooms: every video
 * booking gets its own room so two parents of the same provider can never
 * land in the same live call (overrunning previous slot, early joiners,
 * stale links). Knocking stays on as a backstop for anyone opening the raw
 * daily.co URL without an in-app meeting token.
 */
export async function createDailyRoom(): Promise<{ url: string; name: string }> {
  const key = process.env.DAILY_API_KEY;
  if (!key) throw new Error("DAILY_API_KEY is not configured");

  const res = await fetch(`${DAILY_API_BASE}/rooms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      privacy: "private",
      properties: {
        enable_knocking: true,
        enable_prejoin_ui: false,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Daily.co create room failed: ${err}`);
  }

  const data = await res.json();
  return { url: data.url, name: data.name };
}

/**
 * An EXTERNAL meeting URL is one the provider runs outside GoStork (Zoom,
 * Google Meet...). Internal = a GoStork-managed Daily room (or our own
 * /room/:bookingId page, or nothing configured). Internal links must always
 * be surfaced to users as the in-app /room/:bookingId page - never the raw
 * daily.co URL, which bypasses tokens, consent, and join tracking.
 */
export function isExternalMeetingUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return !url.includes("daily.co") && !url.includes("/room/");
}
