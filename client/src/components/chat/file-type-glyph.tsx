import { getFileTypeMeta } from "@/lib/file-type-icon";

/**
 * A recognizable document glyph - a light-gray page with a folded top-right
 * corner and a colored type band (PDF / DOC / XLS ...), Finder / iMessage style.
 * Scales cleanly at any size since it's pure SVG, so every file type is covered
 * without managing per-type image assets. Images don't use this (they render a
 * real thumbnail instead).
 */
export function FileTypeGlyph({
  name,
  mimeType,
  label: labelOverride,
  accent: accentOverride,
  className,
}: {
  name?: string | null;
  mimeType?: string | null;
  /**
   * Override the band text and color for documents that are not a file type
   * but a KIND of paperwork - INVOICE, COSTS. They are generated PDFs, so
   * "PDF" would say nothing that the row's amount and status do not; naming
   * the paperwork is what makes the rail scannable at a glance.
   */
  label?: string;
  accent?: string;
  className?: string;
}) {
  const meta = getFileTypeMeta(name, mimeType);
  const label = labelOverride ?? meta.label;
  const accent = accentOverride ?? meta.accent;
  const kind = labelOverride ?? meta.kind;
  // Shrink the badge font for longer labels so they stay inside the band -
  // the ladder ran out at 5 characters, so INVOICE (7) overflowed and lost
  // its first and last letters to the band edges.
  const fontSize = label.length <= 3 ? 9
    : label.length === 4 ? 7.2
    : label.length === 5 ? 6.2
    : label.length === 6 ? 5.5
    : 4.8;

  return (
    <svg
      viewBox="0 0 40 48"
      className={className}
      role="img"
      aria-label={`${kind} file`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M9 1.5H26L34.5 10V42.5A4 4 0 0 1 30.5 46.5H9A4 4 0 0 1 5 42.5V5.5A4 4 0 0 1 9 1.5Z"
        fill="#EAEDF0"
        stroke="#D6DBE0"
        strokeWidth="1"
      />
      <path d="M26 1.5L34.5 10H28A2 2 0 0 1 26 8Z" fill="#C7CED6" />
      <rect x="3" y="25" width="28" height="13" rx="2.5" fill={accent} />
      {label && (
        <text
          x="17"
          y="31.9"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#ffffff"
          fontSize={fontSize}
          fontWeight="700"
          fontFamily="system-ui, -apple-system, sans-serif"
          letterSpacing="0.3"
        >
          {label}
        </text>
      )}
    </svg>
  );
}
