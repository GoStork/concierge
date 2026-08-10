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
  /**
   * Every label is set at the SAME font size, so COSTS and INVOICE read as
   * large as PDF - cap height is what the eye reads as "font size".
   *
   * Shrinking the size to fit (the old ladder) dropped INVOICE to nearly half
   * of PDF and made it look like a different, lesser thing. It cannot fit at
   * full width instead: 7 characters need ~45 units and the whole glyph is
   * only 40 wide. So the band widens for longer labels and `textLength` +
   * lengthAdjust condenses the glyphs horizontally to fill it exactly - same
   * height, narrower letters, like a condensed typeface.
   */
  const fontSize = 9;
  const bandWidth = label.length <= 3 ? 28 : 34;
  const bandX = 3;
  // Only condense when the label is too wide for the plain band; PDF and the
  // other 3-letter types keep their natural letterforms untouched.
  const textLength = label.length > 3 ? bandWidth - 5 : undefined;

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
      <rect x={bandX} y="25" width={bandWidth} height="13" rx="2.5" fill={accent} />
      {label && (
        <text
          x={bandX + bandWidth / 2}
          y="31.9"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#ffffff"
          fontSize={fontSize}
          fontWeight="700"
          fontFamily="system-ui, -apple-system, sans-serif"
          letterSpacing="0.3"
          textLength={textLength}
          lengthAdjust={textLength ? "spacingAndGlyphs" : undefined}
        >
          {label}
        </text>
      )}
    </svg>
  );
}
