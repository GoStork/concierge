/**
 * Shared PandaDoc template editor.
 *
 * Used by:
 *  - DocumentsTab (agency uploads their agreement template)
 *  - W9TemplateConfig wrapper (GoStork admin uploads the global W-9 template)
 *
 * Both flows have identical UX: drag/drop file -> POST /api/uploads -> persist
 * the resulting URL to the right entity (provider record vs siteSettings) ->
 * sync to PandaDoc -> open the embedded field editor inline -> click Save to
 * persist roles. The differences are just the persistence endpoints, so we
 * inject them via props. This component owns the file validation, drag/drop,
 * PandaDoc SDK lifecycle, and the editor-open layout (which has to break out
 * of the surrounding form column because PandaDoc needs ~1024px+).
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, RefreshCw, Check, Trash2, PenLine } from "lucide-react";

const ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export interface PandaDocTemplateEditorProps {
  /** e.g. "Agreement Template" or "W-9 Template" */
  templateLabel: string;
  /** Instructional copy shown under the upload card heading. */
  description: string;
  /** Instructional copy shown under the field-editor card heading. */
  fieldInstructions: string;
  /** Unique DOM id for the PandaDoc editor mount point. Must differ between
   *  concurrent instances on the same page. */
  containerId: string;
  /** Show "Step 1 - Upload" / "Step 2 - Assign Signature Fields" labels.
   *  Defaults to true. Set false for embedded contexts that need a tighter UI. */
  showStepHeadings?: boolean;
  /** Label override for Step 1 heading (default "Step 1 - Upload {templateLabel}"). */
  uploadHeading?: string;
  /** Label override for Step 2 heading (default "Step 2 - Assign Signature Fields"). */
  fieldsHeading?: string;

  // ── Loaded state (parent owns the load) ──
  templateUrl: string | null;
  pandaDocTemplateId: string | null;
  templateFilename: string | null;
  isLoading?: boolean;

  // ── Persistence hooks ──
  /** Save the uploaded file URL + filename to wherever the parent stores it. */
  saveTemplate: (params: { url: string; originalName: string }) => Promise<void>;
  /** Remove the stored template + clear the synced PandaDoc record. */
  deleteTemplate: () => Promise<void>;
  /** POST endpoint that syncs the uploaded file to PandaDoc and returns/saves
   *  the resulting template id. */
  syncEndpoint: string;
  /** GET endpoint returning `{ eToken }` for the PandaDoc editing session. */
  editorSessionEndpoint: string;
  /** POST endpoint that refreshes/saves the signer-role metadata after the
   *  admin clicks Save in the editor. */
  refreshRolesEndpoint: string;

  /** Called after any successful mutation (upload, delete, fields saved) so
   *  the parent can invalidate dependent queries. */
  onAfterChange?: () => void;
}

export function PandaDocTemplateEditor(props: PandaDocTemplateEditorProps) {
  const {
    templateLabel,
    description,
    fieldInstructions,
    containerId,
    showStepHeadings = true,
    uploadHeading,
    fieldsHeading,
    templateUrl,
    pandaDocTemplateId,
    templateFilename,
    isLoading,
    saveTemplate,
    deleteTemplate,
    syncEndpoint,
    editorSessionEndpoint,
    refreshRolesEndpoint,
    onAfterChange,
  } = props;

  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editorEToken, setEditorEToken] = useState<string | null>(null);
  const [loadingEditor, setLoadingEditor] = useState(false);
  const editorInstanceRef = useRef<any>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  async function uploadFile(file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: "Invalid file type", description: "Please upload a PDF or Word document.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const { url } = await uploadRes.json();

      await saveTemplate({ url, originalName: file.name });
      onAfterChange?.();

      toast({ title: `${templateLabel} uploaded`, description: "Opening signature field editor..." });
      await openFieldEditor();
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    await uploadFile(file);
  }

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await uploadFile(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteTemplate();
      if (editorInstanceRef.current) {
        editorInstanceRef.current.destroy();
        editorInstanceRef.current = null;
      }
      setEditorEToken(null);
      onAfterChange?.();
      toast({ title: `${templateLabel} removed` });
    } catch (err: any) {
      toast({ title: "Failed to remove template", description: err.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  // Mount PandaDoc editor SDK when eToken is set.
  //
  // The editor iframe measures its container on mount and picks a responsive
  // layout (mobile/compact vs full). When this component is rendered inside
  // a settings form column that hasn't finished laying out yet (or whose
  // viewport-width breakout hasn't applied), the iframe locks in the narrow
  // layout and never re-measures. Two safeguards:
  //   1) Wait for the next animation frame before mounting so the breakout
  //      CSS has settled and the container has its final width.
  //   2) After mount, dispatch window resize events at a few intervals AND
  //      observe the container with ResizeObserver to fire resize whenever
  //      the container size changes. PandaDoc's editor listens to window
  //      resize and re-lays out its panels.
  useEffect(() => {
    if (!editorEToken) return;
    let destroyed = false;
    let resizeObserver: ResizeObserver | null = null;
    const resizeTimers: number[] = [];

    const kickResize = () => {
      // Fire a real window resize so PandaDoc re-measures.
      try {
        window.dispatchEvent(new Event("resize"));
      } catch {
        /* no-op */
      }
    };

    (async () => {
      try {
        const { Editor } = await import("pandadoc-editor");
        // Wait two animation frames so the wrapper's viewport-width breakout
        // has fully applied before the iframe measures itself.
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (destroyed) return;
        const el = editorContainerRef.current ?? document.getElementById(containerId);
        if (!el) {
          toast({ title: "Failed to open editor", description: "Editor container not found", variant: "destructive" });
          return;
        }
        const editor = new Editor(containerId, { token: editorEToken, debugMode: true }, { region: "com" });
        editorInstanceRef.current = editor;
        await editor.open();
        if (destroyed) return;

        // Kick PandaDoc to re-measure now that the iframe is fully loaded.
        // Multiple intervals because we don't know exactly when their internal
        // layout finishes - early kicks catch fast loads, later ones catch slow.
        [100, 350, 800, 1500].forEach(ms => {
          const id = window.setTimeout(kickResize, ms);
          resizeTimers.push(id);
        });

        // Also re-kick whenever the container's own size changes (e.g. user
        // resizes the browser window or rotates a tablet).
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => kickResize());
          resizeObserver.observe(el);
        }
      } catch (err: any) {
        if (!destroyed) {
          console.error("[PandaDoc Editor]", err);
          toast({ title: "Failed to open editor", description: err.message || String(err), variant: "destructive" });
        }
      }
    })();
    return () => {
      destroyed = true;
      resizeTimers.forEach(id => window.clearTimeout(id));
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (editorInstanceRef.current) {
        editorInstanceRef.current.destroy();
        editorInstanceRef.current = null;
      }
    };
  }, [editorEToken, containerId, toast]);

  async function openFieldEditor() {
    if (editorInstanceRef.current) {
      editorInstanceRef.current.destroy();
      editorInstanceRef.current = null;
    }
    setEditorEToken(null);
    setLoadingEditor(true);
    try {
      await fetch(syncEndpoint, { method: "POST", credentials: "include" });
      const res = await fetch(editorSessionEndpoint, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to open editor" }));
        throw new Error(err.message);
      }
      const { eToken } = await res.json();
      setEditorEToken(eToken);
    } catch (err: any) {
      toast({ title: "Failed to open editor", description: err.message, variant: "destructive" });
    } finally {
      setLoadingEditor(false);
    }
  }

  async function handleSaveFields() {
    if (editorInstanceRef.current) {
      editorInstanceRef.current.destroy();
      editorInstanceRef.current = null;
    }
    setEditorEToken(null);
    try {
      await fetch(refreshRolesEndpoint, { method: "POST", credentials: "include" });
    } catch (e) {
      console.warn("[PandaDoc] Role refresh failed:", e);
    }
    onAfterChange?.();
    toast({ title: "Signature fields saved", description: "Your field configuration has been saved." });
  }

  if (isLoading) {
    return <div className="h-32 bg-muted rounded-[var(--radius)] animate-pulse" />;
  }

  // ── Step 1 - Upload ──
  const stepOneInner = (
    <>
      {showStepHeadings && (
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading">{uploadHeading || `Step 1 - Upload ${templateLabel}`}</h2>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{description}</p>

      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-3 rounded-[var(--radius)] border-2 border-dashed p-8 transition-colors cursor-pointer select-none
          ${dragging ? "border-primary bg-[hsl(var(--primary)/0.06)]" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30"}
          ${uploading ? "pointer-events-none opacity-60" : ""}`}
      >
        {uploading ? (
          <RefreshCw className="w-8 h-8 text-muted-foreground animate-spin" />
        ) : (
          <Upload className={`w-8 h-8 transition-colors ${dragging ? "text-primary" : "text-muted-foreground"}`} />
        )}
        <div className="text-center">
          <p className="text-sm font-medium">
            {uploading
              ? (loadingEditor ? "Syncing to PandaDoc..." : "Uploading...")
              : dragging ? "Drop your file here" : "Drag & drop your file here"}
          </p>
          {!uploading && (
            <p className="text-xs text-muted-foreground mt-1">
              or <span className="text-primary underline underline-offset-2">click to browse</span>
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">PDF, DOC, DOCX - max 16MB</p>
      </div>

      {templateUrl && (
        <div className="flex items-center gap-3 p-3 rounded-[var(--radius)] border bg-muted/40">
          <FileText className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-medium truncate flex-1">{templateFilename}</span>
          <span className="text-xs text-muted-foreground shrink-0">Current file</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={handleDelete}
            className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {deleting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </Button>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.doc,.docx"
        onChange={handleFileChange}
      />
    </>
  );

  // ── Step 2 - Assign Signature Fields (Card content - heading + open button) ──
  const stepTwoControls = templateUrl ? (
    <>
      {showStepHeadings && (
        <div className="flex items-center gap-2">
          <PenLine className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading">{fieldsHeading || "Step 2 - Assign Signature Fields"}</h2>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{fieldInstructions}</p>

      <div className="flex items-center gap-3">
        {pandaDocTemplateId && !editorEToken && (
          <span className="flex items-center gap-1.5 text-sm text-[hsl(var(--brand-success))]">
            <Check className="w-4 h-4" />
            Fields configured
          </span>
        )}
        {!editorEToken && (
          <Button variant="outline" size="sm" disabled={loadingEditor} onClick={openFieldEditor}>
            {loadingEditor ? (
              <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Opening editor...</>
            ) : pandaDocTemplateId ? (
              <><PenLine className="w-4 h-4 mr-2" />Edit Signature Fields</>
            ) : (
              <><PenLine className="w-4 h-4 mr-2" />Open Field Editor</>
            )}
          </Button>
        )}
        {editorEToken && (
          <>
            <span className="flex items-center gap-1.5 text-sm text-[hsl(var(--brand-success))]">
              <Check className="w-4 h-4" />
              Editor open below
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingEditor}
              onClick={openFieldEditor}
              className="text-xs text-muted-foreground h-7 px-2"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Reload
            </Button>
          </>
        )}
      </div>
    </>
  ) : null;

  // PandaDoc's editor needs ~1024px+ width to render properly. We render it as
  // a SIBLING of the Step 2 Card (not inside it) so the surrounding Card's
  // overflow-hidden doesn't clip our breakout. The breakout uses negative
  // viewport-relative margins so the editor escapes any deeply-nested settings
  // form column and spans almost the entire viewport - still inline in the
  // document flow, no modal overlay.
  const editorBlock = editorEToken ? (
    <>
      <div className="rounded-[var(--radius)] border bg-[hsl(var(--brand-warning)/0.08)] border-[hsl(var(--brand-warning)/0.35)] p-4 text-sm">
        <p className="font-medium mb-1">Drag fields from the right panel onto your document.</p>
        <p className="text-muted-foreground">
          Use the role dropdown on each field to assign it to the correct signer. Click Save when done.
        </p>
      </div>
      <div
        className="rounded-[var(--radius)] border overflow-hidden bg-background"
        style={{
          height: "800px",
          width: "calc(100vw - 2rem)",
          marginLeft: "calc(-50vw + 50% + 1rem)",
          marginRight: "calc(-50vw + 50% + 1rem)",
        }}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/40">
          <p className="text-xs text-muted-foreground">Changes are saved automatically. When done, click Save.</p>
          <Button variant="outline" size="sm" onClick={handleSaveFields}>
            Save
          </Button>
        </div>
        <div
          ref={editorContainerRef}
          id={containerId}
          style={{ width: "100%", height: "calc(100% - 41px)" }}
        />
      </div>
    </>
  ) : null;

  return (
    <div className="space-y-6">
      <Card className="p-6 space-y-4">{stepOneInner}</Card>
      {stepTwoControls && <Card className="p-6 space-y-4">{stepTwoControls}</Card>}
      {editorBlock}
    </div>
  );
}
