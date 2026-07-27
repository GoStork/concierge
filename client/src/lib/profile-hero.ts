/**
 * Which asset the desktop hero is currently showing.
 *
 * The hero holds an index into a photo array that can shrink underneath it -
 * a photo that 404s is dropped from the list after the user has already
 * selected a later one - and a "show the video" flag that can outlive the
 * video URL. Both produce the same visible failure: an empty hero on a profile
 * that has photos, which reads as "this donor has no pictures".
 *
 * Pure so the clamping can be tested without a DOM.
 */

export type HeroSelection = { isVideo: boolean; photoIdx: number };

export function resolveHeroSelection(
  hero: { video: boolean; idx: number },
  photoCount: number,
  videoUrl: string | null | undefined,
): HeroSelection {
  // A video hero without a URL falls back to photos rather than rendering blank.
  const isVideo = !!hero.video && !!videoUrl;
  const maxIdx = Math.max(photoCount - 1, 0);
  const photoIdx = Math.min(Math.max(Number.isFinite(hero.idx) ? hero.idx : 0, 0), maxIdx);
  return { isVideo, photoIdx };
}
