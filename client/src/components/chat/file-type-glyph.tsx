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
  className,
}: {
  name?: string | null;
  mimeType?: string | null;
  className?: string;
}) {
  const { label, accent, kind } = getFileTypeMeta(name, mimeType);
  // Shrink the badge font for longer labels (DOCX, PPTX) so they stay inside the band.
  const fontSize = label.length <= 3 ? 9 : label.length === 4 ? 7.2 : 6.2;

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
