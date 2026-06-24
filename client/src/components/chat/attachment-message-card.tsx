import { getPhotoSrc } from "@/lib/profile-utils";
import { getFileTypeMeta, formatFileSize } from "@/lib/file-type-icon";
import { FileTypeGlyph } from "./file-type-glyph";

/**
 * The single source of truth for rendering a sent attachment in a chat bubble.
 * Images render as a bare thumbnail (no filename, iMessage style); other files
 * render as a card with a recognizable colored file-type glyph, the filename,
 * and a "<kind> - <size>" subtitle. Shared by every chat surface so the three
 * (previously duplicated) renderers never drift again.
 */
export function AttachmentMessageCard({
  data,
  testId = "attachment-card",
}: {
  data: any;
  testId?: string;
}) {
  if (!data) return null;
  const { isImage, kind } = getFileTypeMeta(data.originalName, data.mimeType);
  const fileUrl = getPhotoSrc(data.url) || data.url;

  if (isImage) {
    return (
      <div className="mt-1" data-testid={testId}>
        <a href={fileUrl} target="_blank" rel="noopener noreferrer">
          <img
            src={fileUrl}
            alt={data.originalName || "Photo"}
            className="max-w-[240px] rounded-[var(--radius)] border"
          />
        </a>
      </div>
    );
  }

  const subtitle = [kind, formatFileSize(data.size)].filter(Boolean).join(" · ");
  return (
    <div className="mt-1" data-testid={testId}>
      <a
        href={fileUrl}
        download={data.originalName}
        className="flex items-center gap-3 p-3 rounded-[var(--radius)] border bg-background hover:bg-muted transition-colors max-w-[280px]"
      >
        <FileTypeGlyph name={data.originalName} mimeType={data.mimeType} className="w-10 h-12 shrink-0" />
        <div className="min-w-0">
          <div
            className="text-sm font-semibold leading-snug"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              wordBreak: "break-word",
            }}
          >
            {data.originalName || "File"}
          </div>
          {subtitle && <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>}
        </div>
      </a>
    </div>
  );
}
