import { getPhotoSrc } from "@/lib/profile-utils";
import { getFileTypeMeta, formatFileSize } from "@/lib/file-type-icon";
import { FileTypeGlyph } from "./file-type-glyph";
import { Download } from "lucide-react";

// Forces a to-disk download even when the browser would rather preview the
// file (or when the URL 302s to signed storage, where the `download`
// attribute is ignored cross-origin): fetch -> blob -> object-URL anchor.
async function downloadFile(url: string, fileName?: string | null) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("fetch failed");
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName || url.split("/").pop() || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    // Fallback: let the browser handle it directly.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

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
      <div className="mt-1 relative inline-block group" data-testid={testId}>
        <a href={fileUrl} target="_blank" rel="noopener noreferrer">
          <img
            src={fileUrl}
            alt={data.originalName || "Photo"}
            className="max-w-[240px] rounded-[var(--radius)] border"
          />
        </a>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); downloadFile(fileUrl, data.originalName); }}
          className="absolute bottom-2 right-2 p-1.5 rounded-full bg-background/85 border shadow-sm hover:bg-background transition-colors"
          aria-label="Download image"
          title="Download"
          data-testid={`${testId}-download`}
        >
          <Download className="w-3.5 h-3.5 text-foreground" />
        </button>
      </div>
    );
  }

  const subtitle = [kind, formatFileSize(data.size)].filter(Boolean).join(" · ");
  return (
    <div className="mt-1" data-testid={testId}>
      <a
        href={fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 p-3 rounded-[var(--radius)] border bg-background hover:bg-muted transition-colors max-w-[300px]"
      >
        <FileTypeGlyph name={data.originalName} mimeType={data.mimeType} className="w-10 h-12 shrink-0" />
        <div className="min-w-0 flex-1">
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
          {subtitle && <div className="t-helper mt-0.5">{subtitle}</div>}
        </div>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); downloadFile(fileUrl, data.originalName); }}
          className="p-2 rounded-full border bg-background hover:bg-muted transition-colors shrink-0"
          aria-label="Download file"
          title="Download"
          data-testid={`${testId}-download`}
        >
          <Download className="w-4 h-4 text-foreground" />
        </button>
      </a>
    </div>
  );
}
