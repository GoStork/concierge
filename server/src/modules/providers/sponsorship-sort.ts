/**
 * Marketplace sponsorship ordering: sponsored profiles float above non-sponsored,
 * but their order AMONG each other rotates per 30s cache window (soft rotating
 * boost) so no single provider permanently owns the top.
 *
 * The DB query already leads with `orderBy sponsoredUntil desc nulls last`; this
 * post-processor (run once, right before the result is cached) re-shuffles only
 * the sponsored slice and also neutralizes any expired-but-unswept timestamp by
 * comparing against `now`.
 */

const CACHE_TTL_MS = 30_000;

/** Deterministic Fisher-Yates shuffle (mulberry32 PRNG) so a given seed always
 *  yields the same order within a cache window but rotates across windows. */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface Boostable {
  sponsoredUntil?: Date | string | null;
  sponsorBoostSeed?: number | null;
}

/** Returns the list with currently-sponsored rows pinned on top (rotated), the
 *  rest preserved in their incoming order. */
export function applySponsoredOrdering<T extends Boostable>(data: T[], nowMs: number = Date.now()): T[] {
  const sponsored: T[] = [];
  const rest: T[] = [];
  for (const d of data) {
    const until = d.sponsoredUntil ? new Date(d.sponsoredUntil).getTime() : 0;
    if (until > nowMs) sponsored.push(d);
    else rest.push(d);
  }
  if (sponsored.length <= 1) return [...sponsored, ...rest];
  const rotationBucket = Math.floor(nowMs / CACHE_TTL_MS);
  const seed = sponsored.reduce((acc, s) => (acc + (s.sponsorBoostSeed || 0)) | 0, rotationBucket);
  return [...seededShuffle(sponsored, seed), ...rest];
}

/** Prisma orderBy fragment that leads with sponsored-first. Spread before the
 *  endpoint's existing ordering keys. */
export const SPONSORED_FIRST_ORDER = { sponsoredUntil: { sort: "desc", nulls: "last" } } as const;
