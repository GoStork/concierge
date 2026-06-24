import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getFileTypeMeta } from "@/lib/file-type-icon";
import { FileTypeGlyph } from "./file-type-glyph";

/**
 * A single staged-file tile in a chat composer - iMessage style. Images render
 * as a tall square thumbnail with no filename; other files render as a tall
 * card with a recognizable colored file-type glyph and the filename beneath.
 * Owns its object-URL lifecycle so image previews never leak. Shared by every
 * composer so the surfaces never drift.
 */
export function StagedFileChip({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const { isImage } = getFileTypeMeta(file.name, file.type);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  const removeBtn = (
    <button
      onClick={onRemove}
      aria-label="Remove attachment"
      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-foreground/80 text-background flex items-center justify-center shadow-sm hover:bg-foreground transition-colors"
    >
      <X className="w-3 h-3" />
    </button>
  );

  if (isImage) {
    return (
      <div className="relative w-[72px] h-[72px] shrink-0">
        {previewUrl && (
          <img
            src={previewUrl}
            alt={file.name}
            className="w-full h-full object-cover rounded-[var(--radius)] border"
          />
        )}
        {removeBtn}
      </div>
    );
  }

  return (
    <div className="relative w-[88px] h-[72px] shrink-0 flex flex-col items-center justify-center gap-1.5 px-2 rounded-[var(--radius)] border bg-muted/40">
      <FileTypeGlyph name={file.name} mimeType={file.type} className="w-8 h-10" />
      <span className="w-full text-[11px] leading-tight text-center truncate">{file.name}</span>
      {removeBtn}
    </div>
  );
}
