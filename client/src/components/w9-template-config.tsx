/**
 * GoStork admin W-9 template management. Mirrors the provider agreement template
 * flow (upload + PandaDoc field editor), but the template is global - every
 * provider signs their own copy of it. Lives in the admin Billing page.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, RefreshCw, Check, Trash2, PenLine } from "lucide-react";

interface W9Template {
  w9TemplateUrl: string | null;
  w9TemplateOriginalName: string | null;
  w9PandaDocTemplateId: string | null;
  w9PandaDocRoles: string | null;
}

const ALLOWED_TYPES = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
const EDITOR_CONTAINER_ID = "pandadoc-w9-editor-container";

interface W9TemplateConfigProps {
  /** Called whenever the template state changes (upload, delete, role refresh). Lets parent screens refresh dependent W-9 status queries. */
  onChange?: () => void;
}

export function W9TemplateConfig({ onChange }: W9TemplateConfigProps = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editorEToken, setEditorEToken] = useState<string | null>(null);
  const [loadingEditor, setLoadingEditor] = useState(false);
  const editorInstanceRef = useRef<any>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  const { data: template, isLoading } = useQuery<W9Template>({
    queryKey: ["/api/admin/w9/template"],
    queryFn: async () => {
      const res = await fetch("/api/admin/w9/template", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load W-9 template");
      return res.json();
    },
  });

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

      const saveRes = await fetch("/api/admin/w9/template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url, originalName: file.name }),
      });
      if (!saveRes.ok) throw new Error("Failed to save template");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/w9/template"] });
      onChange?.();

      toast({ title: "W-9 template uploaded", description: "Opening field editor..." });
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
  }, []);

  async function deleteTemplate() {
    setDeleting(true);
    try {
      await fetch("/api/admin/w9/template", { method: "DELETE", credentials: "include" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/w9/template"] });
      onChange?.();
      if (editorInstanceRef.current) { editorInstanceRef.current.destroy(); editorInstanceRef.current = null; }
      setEditorEToken(null);
      toast({ title: "W-9 template removed" });
    } catch (err: any) {
      toast({ title: "Failed to remove template", description: err.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!editorEToken) return;
    let destroyed = false;
    (async () => {
      try {
        const { Editor } = await import("pandadoc-editor");
        await new Promise(r => setTimeout(r, 100));
        if (destroyed) return;
        const el = editorContainerRef.current ?? document.getElementById(EDITOR_CONTAINER_ID);
        if (!el) {
          toast({ title: "Failed to open editor", description: "Editor container not found", variant: "destructive" });
          return;
        }
        const editor = new Editor(EDITOR_CONTAINER_ID, { token: editorEToken, debugMode: true }, { region: "com" });
        editorInstanceRef.current = editor;
        await editor.open();
      } catch (err: any) {
        if (!destroyed) {
          console.error("[PandaDoc W-9 Editor]", err);
          toast({ title: "Failed to open editor", description: err.message || String(err), variant: "destructive" });
        }
      }
    })();
    return () => {
      destroyed = true;
      if (editorInstanceRef.current) {
        editorInstanceRef.current.destroy();
        editorInstanceRef.current = null;
      }
    };
  }, [editorEToken]);

  async function openFieldEditor() {
    if (editorInstanceRef.current) {
      editorInstanceRef.current.destroy();
      editorInstanceRef.current = null;
    }
    setEditorEToken(null);
    setLoadingEditor(true);
    try {
      await fetch("/api/admin/w9/sync-template", { method: "POST", credentials: "include" });
      const res = await fetch("/api/admin/w9/template-editor-session", { credentials: "include" });
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

  if (isLoading) {
    return <div className="h-32 bg-muted rounded-[var(--radius)] animate-pulse" />;
  }

  const templateUrl = template?.w9TemplateUrl || null;
  const pandaDocTemplateId = template?.w9PandaDocTemplateId || null;
  const templateFilename = template?.w9TemplateOriginalName
    || (templateUrl ? decodeURIComponent(templateUrl.split("/").pop()?.split("?")[0] || "w9-template") : null);

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-heading">W-9 Template</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Upload the W-9 form (PDF or Word) and assign the signature field. Every provider signs their own copy from their Billing tab.
      </p>

      {/* Drag-and-drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-3 rounded-[var(--radius)] border-2 border-dashed p-8 transition-colors cursor-pointer select-none
          ${dragging ? "border-primary bg-[hsl(var(--primary)/0.06)]" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30"}
          ${uploading ? "pointer-events-none opacity-60" : ""}`}
      >
        {uploading ? <RefreshCw className="w-8 h-8 text-muted-foreground animate-spin" /> : <Upload className={`w-8 h-8 transition-colors ${dragging ? "text-primary" : "text-muted-foreground"}`} />}
        <div className="text-center">
          <p className="text-sm font-medium">
            {uploading ? (loadingEditor ? "Syncing to PandaDoc..." : "Uploading...") : dragging ? "Drop your file here" : "Drag & drop the W-9 here"}
          </p>
          {!uploading && (
            <p className="text-xs text-muted-foreground mt-1">
              or <span className="text-primary underline underline-offset-2">click to browse</span>
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">PDF, DOC, DOCX - max 16MB</p>
      </div>

      {/* Current file strip */}
      {templateUrl && (
        <div className="flex items-center gap-3 p-3 rounded-[var(--radius)] border bg-muted/40">
          <FileText className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-medium truncate flex-1">{templateFilename}</span>
          <span className="text-xs text-muted-foreground shrink-0">Current file</span>
          <Button variant="ghost" size="sm" disabled={deleting} onClick={deleteTemplate} className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10">
            {deleting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </Button>
        </div>
      )}

      <input ref={fileInputRef} type="file" className="hidden" accept=".pdf,.doc,.docx" onChange={handleFileChange} />

      {/* Field editor */}
      {templateUrl && (
        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center gap-2">
            <PenLine className="w-5 h-5 text-primary" />
            <h3 className="text-sm font-medium">Assign Signature Field</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Open the editor and drag a signature field onto the form, assigning it to the signer role. Click Save when done.
          </p>

          <div className="flex items-center gap-3">
            {pandaDocTemplateId && !editorEToken && (
              <span className="flex items-center gap-1.5 text-sm text-[hsl(var(--brand-success))]">
                <Check className="w-4 h-4" /> Fields configured
              </span>
            )}
            {!editorEToken && (
              <Button variant="outline" size="sm" disabled={loadingEditor} onClick={openFieldEditor}>
                {loadingEditor ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Opening editor...</>
                  : pandaDocTemplateId ? <><PenLine className="w-4 h-4 mr-2" />Edit Signature Field</>
                  : <><PenLine className="w-4 h-4 mr-2" />Open Field Editor</>}
              </Button>
            )}
          </div>

          {editorEToken && (
            <div className="rounded-[var(--radius)] border overflow-hidden -mx-6" style={{ height: "800px" }}>
              <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/40">
                <p className="text-xs text-muted-foreground">Changes are saved automatically. When done, click Save.</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    if (editorInstanceRef.current) { editorInstanceRef.current.destroy(); editorInstanceRef.current = null; }
                    setEditorEToken(null);
                    try {
                      await fetch("/api/admin/w9/refresh-roles", { method: "POST", credentials: "include" });
                    } catch (e) {
                      console.warn("[W-9] Role refresh failed:", e);
                    }
                    queryClient.invalidateQueries({ queryKey: ["/api/admin/w9/template"] });
                    onChange?.();
                    toast({ title: "Signature field saved", description: "Your W-9 template is ready." });
                  }}
                >
                  Save
                </Button>
              </div>
              <div ref={editorContainerRef} id={EDITOR_CONTAINER_ID} style={{ width: "100%", height: "calc(100% - 41px)" }} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
