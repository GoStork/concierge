// Single source of truth for the photo-less person avatar. When a doctor (or any
// person) has no headshot, we render their brand initials on the brand gradient
// instead of a blank box / generic icon, so they still read as a person. Used by
// the swipe deck card, booking selectors, match mini-cards, and staff tables.
import { useState, type CSSProperties } from "react";
import { getPhotoSrc } from "@/lib/profile-utils";

// First letter of the first + last real name tokens (titles + credentials
// stripped): "Dr. John A. Smith MD" -> "JS", "Donor 1234" -> "D".
export function initialsFromName(name: string | null | undefined): string {
  if (!name) return "";
  const tokens = name
    .replace(/\b(Dr|Mr|Mrs|Ms|Prof)\.?\b/gi, "")
    .replace(/,?\s*(MD|DO|PhD|MBA|FACOG|MSc|RN|NP|PA|FACS|HCLD|TS|ELD|Jr|Sr|III|II|IV)\b/gi, "")
    .trim()
    .split(/\s+/)
    .filter((t) => /[a-z]/i.test(t));
  if (tokens.length === 0) return "";
  const first = tokens[0][0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1][0] : "";
  return (first + last).toUpperCase();
}

interface DoctorMonogramProps {
  name: string | null | undefined;
  // Pixel diameter; the initials scale to ~40% of it.
  size?: number;
  // "full" (default, round avatar) or a CSS radius string for a rounded square.
  rounded?: "full" | string;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
}

export function DoctorMonogram({
  name,
  size = 40,
  rounded = "full",
  className = "",
  style,
  ...rest
}: DoctorMonogramProps) {
  const initials = initialsFromName(name);
  const fontSize = Math.max(11, Math.round(size * 0.4));
  return (
    <div
      className={`shrink-0 flex items-center justify-center bg-gradient-to-br from-[hsl(var(--primary))] to-[hsl(var(--accent))] ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: rounded === "full" ? "9999px" : rounded,
        ...style,
      }}
      data-testid={rest["data-testid"]}
    >
      <span className="font-heading text-white leading-none" style={{ fontSize }}>
        {initials || "·"}
      </span>
    </div>
  );
}

interface DoctorAvatarProps extends DoctorMonogramProps {
  /** Raw stored photo URL (external or GCS); resolved through getPhotoSrc. */
  photoUrl?: string | null;
}

/**
 * A doctor's headshot with the monogram as its fallback - use this instead of a
 * bare <img> anywhere a person's photo is shown.
 *
 * Photos scraped from clinic sites are hotlinked, and those URLs rot (a clinic
 * re-uploads the file, the CDN path changes) long after we stored them. A bare
 * <img> then renders the browser's broken-image icon on an otherwise finished
 * profile. The swipe deck already falls back on error; this makes every other
 * surface behave the same way, so a dead URL degrades to initials, never to a
 * broken image.
 */
export function DoctorAvatar({ name, photoUrl, ...monogramProps }: DoctorAvatarProps) {
  const [failed, setFailed] = useState(false);
  const src = getPhotoSrc(photoUrl);
  const { size = 40, rounded = "full", className = "", style } = monogramProps;

  if (!src || failed) return <DoctorMonogram name={name} {...monogramProps} />;

  return (
    <img
      src={src}
      alt={name || ""}
      className={`shrink-0 object-cover ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: rounded === "full" ? "9999px" : rounded,
        ...style,
      }}
      onError={() => setFailed(true)}
      data-testid={monogramProps["data-testid"]}
    />
  );
}
