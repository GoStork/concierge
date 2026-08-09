import { useEffect, useRef, useState } from "react";
import {
  Bold, Italic, Underline, RemoveFormatting, List, ListOrdered,
  Link as LinkIcon, Image as ImageIcon, Paperclip, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getPhotoSrc } from "@/lib/profile-utils";

/**
 * A small rich-text editor: bold / italic / underline, clear formatting,
 * lists, links, inline images and file attachments. Built for CRM notes,
 * generic enough for the next surface that needs one.
 *
 * DELIBERATELY not a library. The toolbar is seven commands over a
 * contenteditable, and everything it can produce must survive the server's
 * sanitizer allowlist (server/note-html.ts) - a full editor would mostly
 * generate markup the server strips. document.execCommand is legacy but
 * universally supported, and it is the entire implementation.
 *
 * SECURITY: this component trusts nothing about its own output. The server
 * sanitizes on write AND read; the HTML here is treated as a draft, not as
 * safe markup.
 *
 * Uncontrolled on purpose: pushing value through React state re-renders the
 * contenteditable and throws the caret to the start on every keystroke. The
 * parent gets the HTML via onChange and an imperative read at submit time.
 */
export function RichTextEditor({
  initialHtml = "",
  onChange,
  placeholder,
  testId = "rich-text-editor",
}: {
  initialHtml?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [empty, setEmpty] = useState(!initialHtml.replace(/<[^>]*>/g, "").trim());
  const { toast } = useToast();

  useEffect(() => {
    // Seed once. Re-seeding on every prop change would fight the caret.
    if (ref.current && ref.current.innerHTML !== initialHtml) {
      ref.current.innerHTML = initialHtml;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    const html = ref.current?.innerHTML ?? "";
    setEmpty(!html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim());
    onChange?.(html);
  };

  /** Toolbar buttons steal focus; keep the user's selection alive. */
  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && ref.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  };
  const restoreSelection = () => {
    ref.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };

  const exec = (command: string, value?: string) => {
    restoreSelection();
    document.execCommand(command, false, value);
    saveSelection();
    emit();
  };

  const upload = async (file: File): Promise<{ url: string; originalName: string; mimeType: string } | null> => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: fd });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.message || "Upload failed");
      }
      return await res.json();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
      return null;
    } finally {
      setUploading(false);
    }
  };

  const insertImage = async (file: File) => {
    const up = await upload(file);
    // getPhotoSrc, not the raw URL: the uploads bucket is private, so the
    // raw storage.googleapis.com URL 403s in an <img>. The proxied form is
    // also what gets STORED, so the note renders for every viewer through
    // their own auth. (The server rewrites too - note-html.ts - this just
    // makes the preview work while the note is still being written.)
    if (up) exec("insertImage", getPhotoSrc(up.url) || up.url);
  };

  const insertAttachment = async (file: File) => {
    const up = await upload(file);
    if (!up) return;
    // An anchor, not a custom card: it is the one shape that survives the
    // sanitizer and reads the same in every surface that shows the note.
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const href = getPhotoSrc(up.url) || up.url;   // private bucket - see insertImage
    exec("insertHTML", `<a href="${esc(href)}">\u{1F4CE} ${esc(up.originalName)}</a>&nbsp;`);
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url) return;
    const href = /^https?:\/\//i.test(url) || url.startsWith("/") ? url : `https://${url}`;
    restoreSelection();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      // Nothing selected: insert the URL as its own link text.
      document.execCommand("insertHTML", false, `<a href="${href}">${href}</a>&nbsp;`);
    } else {
      document.execCommand("createLink", false, href);
    }
    setLinkOpen(false);
    setLinkUrl("");
    emit();
  };

  const tool = (label: string, icon: React.ReactNode, onClick: () => void, tid: string) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      // mousedown, not click: click fires after the editor loses focus and
      // the selection collapses - the classic dead-bold-button bug.
      onMouseDown={(e) => { e.preventDefault(); saveSelection(); onClick(); }}
      className="p-1.5 rounded-[calc(var(--radius)/2)] hover:bg-secondary text-foreground/80 hover:text-foreground transition-colors"
      data-testid={`${testId}-${tid}`}
    >
      {icon}
    </button>
  );

  return (
    <div className="rounded-[var(--radius)] border bg-background focus-within:ring-1 focus-within:ring-ring" data-testid={testId}>
      <div className="relative">
        <div
          ref={ref}
          contentEditable
          role="textbox"
          aria-multiline="true"
          onInput={emit}
          onBlur={saveSelection}
          className="min-h-[84px] max-h-[320px] overflow-y-auto px-3 py-2 text-sm outline-none break-words [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_a]:text-primary [&_img]:max-w-full [&_img]:rounded-[var(--radius)] [&_img]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-3"
          data-testid={`${testId}-input`}
        />
        {empty && placeholder && (
          <p className="absolute top-2 left-3 text-sm text-muted-foreground pointer-events-none">{placeholder}</p>
        )}
      </div>

      {linkOpen && (
        <div className="flex items-center gap-2 px-2 pb-2">
          <Input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } }}
            placeholder="https://..."
            className="h-8 text-xs"
            autoFocus
            data-testid={`${testId}-link-url`}
          />
          <Button size="sm" className="h-8" onMouseDown={(e) => { e.preventDefault(); applyLink(); }} data-testid={`${testId}-link-apply`}>
            Add link
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setLinkOpen(false)}>Cancel</Button>
        </div>
      )}

      <div className="flex items-center gap-0.5 border-t px-1.5 py-1 flex-wrap">
        {tool("Bold", <Bold className="w-3.5 h-3.5" />, () => exec("bold"), "bold")}
        {tool("Italic", <Italic className="w-3.5 h-3.5" />, () => exec("italic"), "italic")}
        {tool("Underline", <Underline className="w-3.5 h-3.5" />, () => exec("underline"), "underline")}
        {tool("Clear formatting", <RemoveFormatting className="w-3.5 h-3.5" />, () => { exec("removeFormat"); exec("unlink"); }, "clear")}
        <span className="w-px h-4 bg-border mx-1" />
        {tool("Bulleted list", <List className="w-3.5 h-3.5" />, () => exec("insertUnorderedList"), "ul")}
        {tool("Numbered list", <ListOrdered className="w-3.5 h-3.5" />, () => exec("insertOrderedList"), "ol")}
        <span className="w-px h-4 bg-border mx-1" />
        {tool("Insert link", <LinkIcon className="w-3.5 h-3.5" />, () => setLinkOpen((v) => !v), "link")}
        {tool("Insert image", <ImageIcon className="w-3.5 h-3.5" />, () => imageInput.current?.click(), "image")}
        {tool("Attach file", <Paperclip className="w-3.5 h-3.5" />, () => fileInput.current?.click(), "attach")}
        {uploading && <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin text-muted-foreground" />}
      </div>

      <input
        ref={imageInput} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImage(f); e.target.value = ""; }}
      />
      <input
        ref={fileInput} type="file" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) insertAttachment(f); e.target.value = ""; }}
      />
    </div>
  );
}

/** True when a stored note body carries markup this editor produces. */
export function isRichNoteHtml(body: string): boolean {
  return /<(p|br|div|span|b|strong|i|em|u|ul|ol|li|blockquote|a|img)(\s|\/?>)/i.test(body);
}
