import {
  FileText,
  FileSpreadsheet,
  FileImage,
  FileArchive,
  FileAudio,
  FileVideo,
  FileCode,
  File as FileIcon,
  type LucideIcon,
} from "lucide-react";

export interface FileTypeMeta {
  /** lucide icon component (kept for any non-glyph consumers) */
  Icon: LucideIcon;
  /** Short uppercase badge shown on the glyph, e.g. "PDF", "DOC", "XLS". Empty for images. */
  label: string;
  /** Human-readable file kind for the card subtitle, e.g. "PDF Document", "Spreadsheet". */
  kind: string;
  /**
   * Accent color for the file-type glyph's label band. These are deliberate,
   * conventional file-type indicator colors (PDF red, Word blue, Excel green,
   * iMessage / Finder style) per explicit product request - NOT themeable brand
   * UI, so they live here rather than coming from brand CSS variables.
   */
  accent: string;
  /** True when the file is an image and should render as a thumbnail instead of a glyph. */
  isImage: boolean;
}

/** Pull a lowercase extension out of a filename ("Report.PDF" -> "pdf"). */
function extOf(name?: string | null): string {
  if (!name) return "";
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * Map a file (by name and/or MIME type) to a type-specific glyph spec - iMessage
 * style. Images report `isImage: true` so the caller renders a real thumbnail
 * instead of a glyph. Used by the chat composer staged-file tiles, the file-type
 * glyph, and the sent-message attachment card so every surface stays in sync.
 */
export function getFileTypeMeta(name?: string | null, mimeType?: string | null): FileTypeMeta {
  const mime = (mimeType || "").toLowerCase();
  const ext = extOf(name);

  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "heic", "svg", "bmp", "avif"].includes(ext)) {
    return { Icon: FileImage, label: "", kind: "Image", accent: "#8C97A2", isImage: true };
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return { Icon: FileText, label: "PDF", kind: "PDF Document", accent: "#E2574C", isImage: false };
  }
  if (mime.includes("word") || mime.includes("officedocument.wordprocessing") || ["doc", "docx", "rtf"].includes(ext)) {
    return { Icon: FileText, label: ext === "docx" ? "DOCX" : "DOC", kind: "Word Document", accent: "#2B7CD3", isImage: false };
  }
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "text/csv" ||
    ["xls", "xlsx", "csv", "tsv", "numbers"].includes(ext)
  ) {
    return { Icon: FileSpreadsheet, label: ext ? ext.toUpperCase() : "XLS", kind: "Spreadsheet", accent: "#1F7244", isImage: false };
  }
  if (mime.includes("presentation") || mime.includes("powerpoint") || ["ppt", "pptx", "key"].includes(ext)) {
    return { Icon: FileText, label: ext === "pptx" ? "PPTX" : "PPT", kind: "Presentation", accent: "#D24726", isImage: false };
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) {
    return { Icon: FileAudio, label: ext ? ext.toUpperCase() : "AUDIO", kind: "Audio", accent: "#7E57C2", isImage: false };
  }
  if (mime.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) {
    return { Icon: FileVideo, label: ext ? ext.toUpperCase() : "VIDEO", kind: "Video", accent: "#5C6BC0", isImage: false };
  }
  if (mime.includes("zip") || mime.includes("compressed") || ["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
    return { Icon: FileArchive, label: ext ? ext.toUpperCase() : "ZIP", kind: "Archive", accent: "#E0A032", isImage: false };
  }
  if (["json", "xml", "html", "js", "ts", "css", "py", "java", "md"].includes(ext)) {
    return { Icon: FileCode, label: ext.toUpperCase(), kind: "Code", accent: "#455A64", isImage: false };
  }
  if (mime === "text/plain" || ext === "txt") {
    return { Icon: FileText, label: "TXT", kind: "Text Document", accent: "#7A8590", isImage: false };
  }
  return { Icon: FileIcon, label: ext ? ext.toUpperCase() : "FILE", kind: "File", accent: "#7A8590", isImage: false };
}

/** Format a byte count the iMessage way: "3 MB", "512 KB". Empty string when unknown. */
export function formatFileSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const rounded = i === 0 || n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded} ${units[i]}`;
}
