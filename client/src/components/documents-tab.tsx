import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useProvider } from "@/hooks/use-providers";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Upload, FileText, ExternalLink, RefreshCw, Check, Trash2, PenLine } from "lucide-react";

interface Agreement {
  id: string;
  status: string;
  documentType: string;
  pandaDocViewUrl: string | null;
  signedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  parentName: string;
  parentEmail: string;
}

function statusBadge(status: string) {
  switch (status) {
    case "SIGNED":
      return (
        <Badge className="bg-[hsl(var(--brand-success)/0.15)] text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success)/0.3)] border">
          Signed
        </Badge>
      );
    case "SENT":
      return (
        <Badge variant="outline" className="text-[hsl(var(--foreground)/0.7)]">
          Sent - Awaiting Signature
        </Badge>
      );
    case "REJECTED":
      return (
        <Badge className="bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)] border">
          Rejected
        </Badge>
      );
    case "EXPIRED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Expired
        </Badge>
      );
    case "CREATED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Created - Not Sent
        </Badge>
      );
    case "ERROR":
      return (
        <Badge className="bg-destructive/10 text-destructive border-destructive/30 border">
          Error
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}



export default function DocumentsTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const providerId = (user as any)?.providerId || "";
  const { data: provider, isLoading: providerLoading } = useProvider(providerId);

  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [editorEToken, setEditorEToken] = useState<string | null>(null);
  const [loadingEditor, setLoadingEditor] = useState(false);
  const editorInstanceRef = useRef<any>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorContainerId = "pandadoc-template-editor-container";

  const { data: agreements = [], isLoading: agreementsLoading, refetch } = useQuery<Agreement[]>({
    queryKey: ["/api/agreements"],
    enabled: !!providerId,
  });

  // Role name inputs - must be above early return to respect Rules of Hooks
  const savedRolesRaw: string | null = (provider as any)?.pandaDocRoles || null;
  const [roleInputs, setRoleInputs] = useState<string[]>(["", "", ""]);
  const [rolesSaved, setRolesSaved] = useState(false);

  useEffect(() => {
    if (!savedRolesRaw) return;
    try {
      const parsed: string[] = JSON.parse(savedRolesRaw);
      if (parsed.length >= 2) setRoleInputs(parsed);
    } catch { /* ignore */ }
  }, [savedRolesRaw]);

  const saveRolesMutation = useMutation({
    mutationFn: async (roles: string[]) => {
      await apiRequest("PUT", "/api/agreements/template-roles", { roles });
    },
    onSuccess: (_, _vars, ctx: any) => {
      setRolesSaved(true);
      setTimeout(() => setRolesSaved(false), 3000);
      queryClient.invalidateQueries({ queryKey: ['/api/providers/:id', providerId] });
      toast({
        title: "Role names saved",
        description: pandaDocTemplateId
          ? "Re-upload your document in Step 2 to apply the new roles to the editor."
          : "Now upload your document in Step 2.",
      });
    },
    onError: (e: any) => {
      toast({ title: "Failed to save roles", description: e.message, variant: "destructive" });
    },
  });

  const ALLOWED_TYPES = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

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

      await apiRequest("PUT", `/api/providers/${providerId}`, { agreementTemplateUrl: url, agreementTemplateOriginalName: file.name, pandaDocTemplateId: null });
      queryClient.invalidateQueries({ queryKey: ['/api/providers/:id', providerId] });

      toast({ title: "Agreement template uploaded", description: "Opening signature field editor..." });
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
  }, [providerId]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  async function deleteTemplate() {
    setDeleting(true);
    try {
      await apiRequest("PUT", `/api/providers/${providerId}`, { agreementTemplateUrl: null, agreementTemplateOriginalName: null, pandaDocTemplateId: null });
      queryClient.invalidateQueries({ queryKey: ['/api/providers/:id', providerId] });
      if (editorInstanceRef.current) { editorInstanceRef.current.destroy(); editorInstanceRef.current = null; }
      setEditorEToken(null);
      toast({ title: "Template removed" });
    } catch (err: any) {
      toast({ title: "Failed to remove template", description: err.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  // Mount PandaDoc editor SDK when eToken is set
  useEffect(() => {
    if (!editorEToken) return;
    let destroyed = false;
    (async () => {
      try {
        const { Editor } = await import("pandadoc-editor");
        // Small delay to ensure the container div is painted in DOM
        await new Promise(r => setTimeout(r, 100));
        if (destroyed) return;
        const el = editorContainerRef.current ?? document.getElementById(editorContainerId);
        if (!el) {
          toast({ title: "Failed to open editor", description: "Editor container not found", variant: "destructive" });
          return;
        }
        const editor = new Editor(editorContainerId, { token: editorEToken, debugMode: true }, { region: "com" });
        editorInstanceRef.current = editor;
        await editor.open();
      } catch (err: any) {
        if (!destroyed) {
          console.error("[PandaDoc Editor]", err);
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
    // Destroy any existing editor instance
    if (editorInstanceRef.current) {
      editorInstanceRef.current.destroy();
      editorInstanceRef.current = null;
    }
    setEditorEToken(null);
    setLoadingEditor(true);
    try {
      await fetch("/api/agreements/sync-template", { method: "POST", credentials: "include" });

      const res = await fetch("/api/agreements/template-editor-session", { credentials: "include" });
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

  if (providerLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-32 bg-muted rounded-[var(--radius)] animate-pulse" />
      </div>
    );
  }

  const templateUrl = (provider as any)?.agreementTemplateUrl || null;
  const pandaDocTemplateId = (provider as any)?.pandaDocTemplateId || null;
  const templateFilename = (provider as any)?.agreementTemplateOriginalName
    || (templateUrl ? decodeURIComponent(templateUrl.split("/").pop()?.split("?")[0] || "agreement-template") : null);

  const savedRoles: string[] = savedRolesRaw ? (() => { try { return JSON.parse(savedRolesRaw); } catch { return []; } })() : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading">Documents & Agreements</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload your agreement template and manage contracts sent to parents.
        </p>
      </div>

      {/* Step 1 - Signing Role Names (must be done before upload) */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Check className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading">Step 1 - Define Signing Roles</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Name the roles for your agreement. In the editor, your role goes first, then the parent(s). GoStork creates these roles automatically so you can assign signature fields to them.
        </p>
        <div className="space-y-2">
          {[
            { label: "Your role", placeholder: "e.g. Agency", index: 0 },
            { label: "Parent 1 role", placeholder: "e.g. Client 1", index: 1 },
            { label: "Parent 2 role", placeholder: "e.g. Client 2 (optional)", index: 2 },
          ].map(({ label, placeholder, index }) => (
            <div key={index} className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-28 shrink-0">{label}</span>
              <Input
                value={roleInputs[index] ?? ""}
                onChange={e => setRoleInputs(prev => {
                  const next = [...prev];
                  next[index] = e.target.value;
                  return next;
                })}
                placeholder={placeholder}
                className="flex-1"
              />
            </div>
          ))}
        </div>
        <Button
          size="sm"
          disabled={saveRolesMutation.isPending || !roleInputs[0]?.trim() || !roleInputs[1]?.trim()}
          onClick={() => saveRolesMutation.mutate(roleInputs.filter(r => r.trim()))}
        >
          {saveRolesMutation.isPending ? (
            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Saving...</>
          ) : rolesSaved ? (
            <><Check className="w-4 h-4 mr-2" />Saved</>
          ) : (
            "Save Role Names"
          )}
        </Button>
        {savedRoles.length >= 2 && (
          <p className="text-xs text-[hsl(var(--brand-success))]">
            <Check className="w-3 h-3 inline mr-1" />
            Configured: {savedRoles.join(" - ")}
          </p>
        )}
      </Card>

      {/* Step 2 - Template Upload */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading">Step 2 - Upload Agreement Template</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Upload your agreement document (PDF or Word). Your role names will be created automatically in the editor.
        </p>

        {/* Drag-and-drop zone */}
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
              {uploading ? (loadingEditor ? "Syncing to PandaDoc..." : "Uploading...") : dragging ? "Drop your file here" : "Drag & drop your file here"}
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
            <Button
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={deleteTemplate}
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
      </Card>

      {/* Step 3 - Configure Signature Fields */}
      {templateUrl && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <PenLine className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-heading">Step 3 - Assign Signature Fields</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Open the editor and drag signature, date, and text fields onto your document. Assign each field to one of your roles using the dropdown in the right panel.
          </p>

          <div className="flex items-center gap-3">
            {pandaDocTemplateId && !editorEToken && (
              <span className="flex items-center gap-1.5 text-sm text-[hsl(var(--brand-success))]">
                <Check className="w-4 h-4" />
                Fields configured
              </span>
            )}
            {!editorEToken && (
              <Button
                variant="outline"
                size="sm"
                disabled={loadingEditor}
                onClick={openFieldEditor}
              >
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
                  Editor open
                </span>
                <Button variant="ghost" size="sm" disabled={loadingEditor} onClick={openFieldEditor} className="text-xs text-muted-foreground h-7 px-2">
                  <RefreshCw className="w-3 h-3 mr-1" />
                  Reload
                </Button>
              </>
            )}
          </div>

          {/* PandaDoc editor - inline within the card */}
          {editorEToken && (
            <div className="rounded-[var(--radius)] border bg-[hsl(var(--brand-warning)/0.08)] border-[hsl(var(--brand-warning)/0.35)] p-4 text-sm">
              <p className="font-medium mb-1">Your roles should appear in the right panel dropdown.</p>
              <p className="text-muted-foreground">Drag signature, date, or text fields onto the document and assign each to a role. Order: 1st role = you (provider), 2nd = Parent 1, 3rd = Parent 2 (if applicable). Click Save when done.</p>
            </div>
          )}
          {editorEToken && (
            <div className="rounded-[var(--radius)] border overflow-hidden -mx-6" style={{ height: "800px" }}>
              <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/40">
                <p className="text-xs text-muted-foreground">Changes are saved automatically. When done, click Save.</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (editorInstanceRef.current) { editorInstanceRef.current.destroy(); editorInstanceRef.current = null; }
                    setEditorEToken(null);
                    queryClient.invalidateQueries({ queryKey: ['/api/providers/:id', providerId] });
                    toast({ title: "Signature fields saved", description: "Your field configuration has been saved." });
                  }}
                >
                  Save
                </Button>
              </div>
              <div
                ref={editorContainerRef}
                id={editorContainerId}
                style={{ width: "100%", height: "calc(100% - 41px)" }}
              />
            </div>
          )}
        </Card>
      )}

      {/* Section E - Sent Agreements */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-heading">Sent Agreements</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        {agreementsLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : agreements.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No agreements have been sent yet.
          </p>
        ) : (
          <div className="divide-y">
            {agreements.map(agreement => (
              <div key={agreement.id} className="flex items-center gap-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{agreement.parentName}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(agreement.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    {agreement.signedAt && ` - Signed ${new Date(agreement.signedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </p>
                </div>
                <div className="shrink-0">{statusBadge(agreement.status)}</div>
                {agreement.pandaDocViewUrl && (
                  <a href={agreement.pandaDocViewUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="ghost" size="sm" className="shrink-0">
                      <ExternalLink className="w-4 h-4" />
                    </Button>
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
