import { getPhotoSrc } from "@/lib/profile-utils";
import { getFileTypeMeta, formatFileSize } from "@/lib/file-type-icon";
import { FileTypeGlyph } from "./file-type-glyph";
import { Download, ExternalLink } from "lucide-react";

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

  return (
    <FileCard
      name={data.originalName || "File"}
      mimeType={data.mimeType}
      subtitle={[kind, formatFileSize(data.size)]}
      href={fileUrl}
      download={{ url: fileUrl, name: data.originalName }}
      className="mt-1 max-w-[300px]"
      testId={testId}
    />
  );
}

/**
 * The document tile: colored file-type glyph, name, "<kind> · <detail>"
 * subtitle, and a download button that actually saves to disk.
 *
 * Extracted from AttachmentMessageCard so anything that IS a document -
 * a chat attachment, a PandaDoc agreement - draws as the same object
 * instead of each surface inventing its own row. Per CLAUDE.md this is the
 * one file renderer; add file features here rather than forking.
 *
 * `status` is the only thing an attachment does not have: paperwork carries
 * a state (SIGNED, AWAITING SIGNATURE) that belongs beside the name.
 */
export function FileCard({
  name,
  mimeType,
  subtitle,
  href,
  download,
  status,
  className,
  testId = "file-card",
}: {
  name: string;
  mimeType?: string | null;
  /**
   * Subtitle segments ("PDF Document", a timestamp, an org). Passed as PARTS,
   * not a joined string, because this card also renders in the ~280px chat
   * rail: each part wraps as a unit, so a narrow column breaks between
   * segments instead of stranding "PM" on a line of its own.
   */
  subtitle?: (string | null | undefined | false)[] | null;
  /** Where clicking the card goes. Omit for a card that is not yet openable. */
  href?: string | null;
  /** Present only when there is a real file to save; renders the save button. */
  download?: { url: string; name?: string | null } | null;
  status?: { label: string; color: string } | null;
  className?: string;
  testId?: string;
}) {
  const parts = (subtitle || []).filter(Boolean) as string[];
  const Shell: any = href ? "a" : "div";
  const shellProps = href
    ? { href, target: "_blank", rel: "noopener noreferrer", onClick: (e: any) => e.stopPropagation() }
    : {};
  return (
    <div className={className} data-testid={testId}>
      <Shell
        {...shellProps}
        className={`flex items-center gap-3 p-3 rounded-[var(--radius)] border bg-background transition-colors ${href ? "hover:bg-muted" : ""}`}
      >
        <FileTypeGlyph name={name} mimeType={mimeType} className="w-10 h-12 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div
              className="text-sm font-semibold leading-snug min-w-0"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
              }}
            >
              {name}
            </div>
            {/* Capped and allowed to wrap rather than shrink-0 + nowrap: in the
                ~280px chat rail a long status (AWAITING SIGNATURE) took so much
                of the line that the name broke mid-word into "Surrogac / y". */}
            {status && (
              <span
                className="text-[10px] uppercase tracking-wide font-medium leading-tight text-right max-w-[45%] mt-0.5"
                style={{ color: status.color }}
              >
                {status.label}
              </span>
            )}
          </div>
          {/* Each segment wraps as a unit, so a narrow column breaks between
              segments instead of stranding "PM" on a line of its own. */}
          {parts.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5">
              {parts.map((p, i) => (
                <span key={i} className="t-helper whitespace-nowrap">
                  {i > 0 ? `· ${p}` : p}
                </span>
              ))}
            </div>
          )}
        </div>
        {download ? (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); downloadFile(download.url, download.name); }}
            className="p-2 rounded-full border bg-background hover:bg-muted transition-colors shrink-0"
            aria-label="Download file"
            title="Download"
            data-testid={`${testId}-download`}
          >
            <Download className="w-4 h-4 text-foreground" />
          </button>
        ) : href ? (
          <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : null}
      </Shell>
    </div>
  );
}
