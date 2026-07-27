/**
 * "Added <date>" - and who is allowed to see it.
 *
 * There is no parent-facing freshness label, deliberately. A synced profile is
 * re-checked by the nightly scraper, so any "last checked" date would read the
 * same on almost the whole catalogue - a value that never varies is not
 * information, it is decoration that looks like information. Worse, it sits
 * beside the claim that does matter: the status badge. AVAILABLE / PENDING is
 * what we assert about her, the same sync maintains it, and a parent should be
 * able to trust it without a timestamp reassuring them our system ran.
 *
 * Providers and GoStork admins DO see when a profile arrived - it is how they
 * spot a stale upload nobody has re-synced. The marketplace card already
 * settled both the wording and the audience (see swipe-deck-card's uploadedAt:
 * "parents never see upload dates"), so this matches it exactly rather than
 * inventing a second way to say the same thing.
 */
export function profileAddedLabel(profile: { createdAt?: string | Date | null } | null | undefined): string | null {
  const raw = profile?.createdAt;
  if (!raw) return null;
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime())) return null;
  return `Added ${at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}
