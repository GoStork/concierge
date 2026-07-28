/**
 * One card face for a saved thing, whatever kind of thing it is.
 *
 * The Saved grid and the compare selection page show the same profiles, so they
 * must draw them the same way - a parent picking from a grid of faces and then
 * seeing a different face in the tray would not trust that they matched. This is
 * the single normaliser both call.
 *
 * Kinds fall back in their own way: a clinic has no face, so it shows a
 * physician's headshot and then its logo; a doctor without a headshot gets a
 * brand monogram rather than an empty tile.
 */

import { getPhotoSrc } from "@/lib/profile-utils";
import { dedupeProviderLocations } from "@/lib/format-location";
import { getPhotoList, buildTitle } from "@/components/marketplace/swipe-mappers";

export type SavedCardKind = "egg-donor" | "surrogate" | "sperm-donor" | "clinic" | "doctor";

export type SavedCardVisual = {
  photo: string | null;
  logo?: string | null;
  monogramName?: string | null;
  title: string;
  subtitle?: string | null;
};

/**
 * `item` is the display-ready entity for its kind: a mapped swipe profile for
 * donors and surrogates, the raw provider for clinics, the raw doctor row for
 * doctors. Callers that hold a database row map it first - that mapping is where
 * photo ordering and title rules live, and re-deriving them here would fork it.
 */
export function savedCardVisual(kind: SavedCardKind, item: any): SavedCardVisual {
  if (kind === "clinic") {
    const members = Array.isArray(item?.members)
      ? item.members.filter((m: any) => m?.isPublicProfile !== false)
      : [];
    const face = members.map((m: any) => getPhotoSrc(m?.photoUrl)).find(Boolean) || null;
    const loc = dedupeProviderLocations(item?.locations || [])[0];
    return {
      photo: face,
      logo: getPhotoSrc(item?.logoUrl) || null,
      title: item?.name || "",
      subtitle: loc ? [loc.city, loc.state].filter(Boolean).join(", ") : null,
    };
  }
  if (kind === "doctor") {
    return {
      photo: getPhotoSrc(item?.photoUrl) || null,
      monogramName: item?.name || null,
      title: item?.name || "",
      subtitle: item?.providerName || null,
    };
  }
  return {
    photo: getPhotoList(item)[0] || null,
    title: buildTitle(item),
    subtitle: item?.age ? `Age ${item.age}` : null,
  };
}
