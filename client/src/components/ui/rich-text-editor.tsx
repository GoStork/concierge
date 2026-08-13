import { useEffect, useRef, useState } from "react";
import {
  Bold, Italic, Underline, RemoveFormatting, List, ListOrdered,
  Link as LinkIcon, Image as ImageIcon, Paperclip, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getPhotoSrc } from "@/lib/profile-utils";
import { cn } from "@/lib/utils";

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
  mentionSource,
}: {
  initialHtml?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  testId?: string;
  /** #7 @mentions: returns the people who can see this note. Typing @ filters them. */
  mentionSource?: () => Promise<{ id: string; name: string }[]>;
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

  // @mention typeahead state.
  const mentionPeople = useRef<{ id: string; name: string }[] | null>(null);
  const [mentionItems, setMentionItems] = useState<{ id: string; name: string }[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionActive, setMentionActive] = useState(0);
  const mentionAnchor = useRef<{ node: Node; start: number; end: number } | null>(null);

  const closeMention = () => { setMentionOpen(false); mentionAnchor.current = null; };

  const detectMention = async () => {
    if (!mentionSource) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return closeMention();
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return closeMention();
    // Never re-offer inside a chip that was already inserted. Without this the
    // caret sitting in the text after "@Eran Amir" keeps matching the name and
    // a second Enter wraps the chip in itself.
    if ((node.parentElement as HTMLElement | null)?.closest?.(".mention")) return closeMention();
    const text = node.textContent || "";
    const caret = range.startOffset;
    // A trailing "@name" immediately before the caret, not mid-word. At most
    // two words: a full name is searchable ("@Eran Am"), but the match STOPS
    // there rather than swallowing the rest of the sentence - which is what
    // kept the dropdown open after a mention was already chosen.
    const before = text.slice(0, caret);
    const m = before.match(/(^|\s)@([\p{L}0-9'.\-]{0,30}(?: [\p{L}0-9'.\-]{0,30})?)$/u);
    if (!m) return closeMention();
    const query = m[2].trim().toLowerCase();
    if (!mentionPeople.current) mentionPeople.current = await mentionSource().catch(() => []);
    const items = (mentionPeople.current || [])
      .filter((p) => p.name && p.name.toLowerCase().includes(query))
      .slice(0, 6);
    if (!items.length) return closeMention();
    mentionAnchor.current = { node, start: caret - (m[2].length + 1), end: caret };
    setMentionItems(items); setMentionActive(0); setMentionOpen(true);
  };

  const insertMention = (item?: { id: string; name: string }) => {
    const a = mentionAnchor.current;
    // A missing item (stale highlight index) must still close the list - it
    // used to throw here, which left the dropdown stuck open.
    if (!item || !a || !ref.current) return closeMention();
    // The list closes even if the DOM work below throws - a stuck-open
    // dropdown is worse than a missed chip, and that is the bug this hit.
    try {
      const range = document.createRange();
      range.setStart(a.node, a.start);
      range.setEnd(a.node, a.end);
      range.deleteContents();
      const span = document.createElement("span");
      span.setAttribute("data-mention-user-id", item.id);
      span.className = "mention";
      span.textContent = `@${item.name}`;
      const space = document.createTextNode(" ");
      range.insertNode(space);
      range.insertNode(span);
      // Caret after the inserted space.
      const sel = window.getSelection();
      const after = document.createRange();
      after.setStartAfter(space); after.collapse(true);
      sel?.removeAllRanges(); sel?.addRange(after);
      emit();
    } finally {
      closeMention();
    }
  };

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
    // bg-card, not bg-background: this is a field you type into, and it always
    // sits inside a white card. --background is the PAGE colour, so it painted
    // the composer sand while every other input beside it stayed white.
    <div className="rounded-[var(--radius)] border bg-card focus-within:ring-1 focus-within:ring-ring" data-testid={testId}>
      <div className="relative">
        <div
          ref={ref}
          contentEditable
          role="textbox"
          aria-multiline="true"
          onInput={() => { emit(); detectMention(); }}
          onKeyUp={(e) => { if (!["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) detectMention(); }}
          onKeyDown={(e) => {
            if (!mentionOpen) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setMentionActive((i) => Math.min(i + 1, mentionItems.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setMentionActive((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(mentionItems[mentionActive]); }
            else if (e.key === "Escape") { e.preventDefault(); closeMention(); }
          }}
          onBlur={() => { saveSelection(); setTimeout(closeMention, 150); }}
          className="min-h-[140px] max-h-[420px] overflow-y-auto px-3 py-2 text-sm outline-none break-words [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_a]:text-primary [&_img]:max-w-full [&_img]:rounded-[var(--radius)] [&_img]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_.mention]:text-primary [&_.mention]:font-medium"
          data-testid={`${testId}-input`}
        />
        {empty && placeholder && (
          <p className="absolute top-2 left-3 text-sm text-muted-foreground pointer-events-none">{placeholder}</p>
        )}
        {mentionOpen && mentionItems.length > 0 && (
          <div className="absolute z-30 left-3 top-8 w-52 rounded-[var(--radius)] border bg-card shadow-md py-1" data-testid="mention-dropdown">
            {mentionItems.map((it, i) => (
              <button
                key={it.id}
                type="button"
                className={cn("w-full text-left px-3 py-1.5 text-sm", i === mentionActive ? "bg-secondary" : "")}
                // The highlight follows the mouse: moving over an option makes
                // it the selected one, so hover and the keyboard cursor are
                // always the same row - not a stuck first item plus a second
                // hover colour.
                onMouseEnter={() => setMentionActive(i)}
                onMouseDown={(e) => { e.preventDefault(); insertMention(it); }}
                data-testid={`mention-option-${it.id}`}
              >
                @{it.name}
              </button>
            ))}
          </div>
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
