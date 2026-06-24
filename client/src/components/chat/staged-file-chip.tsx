import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getFileTypeMeta } from "@/lib/file-type-icon";

/**
 * A single staged-file chip in a chat composer. Shows a real thumbnail for
 * images and a type-specific icon + extension label (PDF / DOCX / XLSX ...)
 * for everything else - iMessage style. Owns its object-URL lifecycle so
 * image previews never leak.
 *
 * Shared by every composer (ChatInputBar and the inline concierge composer)
 * so the two surfaces never drift.
 */
export function StagedFileChip({
  file,
  brandColor,
  onRemove,
}: {
  file: File;
  brandColor: string;
  onRemove: () => void;
}) {
  const { Icon, label, isImage } = getFileTypeMeta(file.name, file.type);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-[var(--radius)] border bg-muted/50 text-xs">
      {isImage && previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="w-8 h-8 rounded-[calc(var(--radius)-2px)] object-cover shrink-0"
        />
      ) : (
        <span
          className="flex items-center gap-1 px-1.5 py-1 rounded-[calc(var(--radius)-2px)] bg-background shrink-0"
          style={{ color: brandColor }}
        >
          <Icon className="w-3.5 h-3.5 shrink-0" />
          {label && <span className="font-semibold tracking-wide text-[10px]">{label}</span>}
        </span>
      )}
      <span className="truncate max-w-[140px]">{file.name}</span>
      <button onClick={onRemove} className="ml-0.5 hover:text-destructive">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
