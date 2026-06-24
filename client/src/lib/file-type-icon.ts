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
  /** lucide icon component that best represents the file type */
  Icon: LucideIcon;
  /** Short uppercase label shown next to the icon, e.g. "PDF", "DOC", "XLS". Empty for images. */
  label: string;
  /** True when the file is an image and should render as a thumbnail instead of an icon. */
  isImage: boolean;
}

/** Pull a lowercase extension out of a filename ("Report.PDF" -> "pdf"). */
function extOf(name?: string | null): string {
  if (!name) return "";
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/**
 * Map a file (by name and/or MIME type) to a type-specific lucide icon and a
 * short uppercase label - iMessage style. Images report `isImage: true` so the
 * caller can render a real thumbnail instead of an icon. Used by both the chat
 * composer staged-file chips and the sent-message attachment cards so the two
 * surfaces never drift.
 */
export function getFileTypeMeta(name?: string | null, mimeType?: string | null): FileTypeMeta {
  const mime = (mimeType || "").toLowerCase();
  const ext = extOf(name);

  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "heic", "svg", "bmp", "avif"].includes(ext)) {
    return { Icon: FileImage, label: "", isImage: true };
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return { Icon: FileText, label: "PDF", isImage: false };
  }
  if (mime.includes("word") || mime.includes("officedocument.wordprocessing") || ["doc", "docx", "rtf"].includes(ext)) {
    return { Icon: FileText, label: ext === "docx" ? "DOCX" : "DOC", isImage: false };
  }
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "text/csv" ||
    ["xls", "xlsx", "csv", "tsv", "numbers"].includes(ext)
  ) {
    return { Icon: FileSpreadsheet, label: ext ? ext.toUpperCase() : "XLS", isImage: false };
  }
  if (mime.includes("presentation") || mime.includes("powerpoint") || ["ppt", "pptx", "key"].includes(ext)) {
    return { Icon: FileText, label: ext === "pptx" ? "PPTX" : "PPT", isImage: false };
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) {
    return { Icon: FileAudio, label: ext ? ext.toUpperCase() : "AUDIO", isImage: false };
  }
  if (mime.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) {
    return { Icon: FileVideo, label: ext ? ext.toUpperCase() : "VIDEO", isImage: false };
  }
  if (mime.includes("zip") || mime.includes("compressed") || ["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
    return { Icon: FileArchive, label: ext ? ext.toUpperCase() : "ZIP", isImage: false };
  }
  if (["json", "xml", "html", "js", "ts", "css", "py", "java", "md"].includes(ext)) {
    return { Icon: FileCode, label: ext.toUpperCase(), isImage: false };
  }
  if (mime === "text/plain" || ext === "txt") {
    return { Icon: FileText, label: "TXT", isImage: false };
  }
  return { Icon: FileIcon, label: ext ? ext.toUpperCase() : "FILE", isImage: false };
}
