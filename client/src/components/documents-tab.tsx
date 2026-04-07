import { useState, useRef, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useProvider } from "@/hooks/use-providers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, Download, ExternalLink, RefreshCw, Copy, Check, Trash2 } from "lucide-react";

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

function isPdf(url: string) {
  return url.toLowerCase().includes(".pdf");
}

function isWord(url: string) {
  const lower = url.toLowerCase();
  return lower.includes(".docx") || lower.includes(".doc");
}

const TOKENS = [
  { token: "{{CLIENT1_NAME}}", description: "First client's full name" },
  { token: "{{CLIENT1_EMAIL}}", description: "First client's email" },
  { token: "{{CLIENT1_DOB}}", description: "First client's date of birth" },
  { token: "{{CLIENT1_ADDRESS}}", description: "First client's full address" },
  { token: "{{CLIENT1_SSN}}", description: "First client's SSN" },
  { token: "{{CLIENT1_PASSPORT}}", description: "First client's passport number" },
  { token: "{{CLIENT1_PASSPORT_COUNTRY}}", description: "First client's passport country of issue" },
  { token: "{{CLIENT1_NATIONALITY}}", description: "First client's nationality" },
  { token: "{{CLIENT2_NAME}}", description: "Second client's full name" },
  { token: "{{CLIENT2_EMAIL}}", description: "Second client's email" },
  { token: "{{CLIENT2_DOB}}", description: "Second client's date of birth" },
  { token: "{{CLIENT2_ADDRESS}}", description: "Second client's full address" },
  { token: "{{CLIENT2_SSN}}", description: "Second client's SSN" },
  { token: "{{CLIENT2_PASSPORT}}", description: "Second client's passport number" },
  { token: "{{CLIENT2_PASSPORT_COUNTRY}}", description: "Second client's passport country of issue" },
  { token: "{{CLIENT2_NATIONALITY}}", description: "Second client's nationality" },
  { token: "{{PROVIDER_NAME}}", description: "Your agency name" },
  { token: "{{PROVIDER_EMAIL}}", description: "Your agency email" },
  { token: "{{DATE}}", description: "Today's date" },
];

function TokenChip({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius)] border bg-muted/50 hover:bg-muted text-xs font-mono transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-[hsl(var(--brand-success))]" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
      {token}
    </button>
  );
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

  const { data: agreements = [], isLoading: agreementsLoading, refetch } = useQuery<Agreement[]>({
    queryKey: ["/api/agreements"],
    enabled: !!providerId,
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

      await apiRequest("PUT", `/api/providers/${providerId}`, { agreementTemplateUrl: url });
      queryClient.invalidateQueries({ queryKey: ['/api/providers/:id', providerId] });

      toast({ title: "Agreement template uploaded", description: "Your document has been saved." });
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
      await apiRequest("PUT", `/api/providers/${providerId}`, { agreementTemplateUrl: null });
      queryClient.invalidateQueries({ queryKey: ['/api/providers/:id', providerId] });
      toast({ title: "Template removed" });
    } catch (err: any) {
      toast({ title: "Failed to remove template", description: err.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  if (providerLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-32 bg-muted rounded-[var(--radius)] animate-pulse" />
      </div>
    );
  }

  const templateUrl = (provider as any)?.agreementTemplateUrl || null;
  const templateFilename = templateUrl ? decodeURIComponent(templateUrl.split("/").pop()?.split("?")[0] || "agreement-template") : null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading">Documents & Agreements</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload your agreement template and manage contracts sent to parents.
        </p>
      </div>

      {/* Section A - Template Upload */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading">Agreement Template</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Upload your agreement document (PDF or Word). This will be used when generating contracts for parents.
        </p>
        <p className="text-sm text-muted-foreground">
          Add placeholders to your document where parent and agency information should appear. When a contract is sent, GoStork fills them in automatically.
        </p>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Available placeholders - click to copy</p>
          <div className="flex flex-wrap gap-2">
            {TOKENS.map(t => (
              <div key={t.token} className="flex items-center gap-1.5">
                <TokenChip token={t.token} />
                <span className="text-xs text-muted-foreground">{t.description}</span>
              </div>
            ))}
          </div>
        </div>

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
              {uploading ? "Uploading..." : dragging ? "Drop your file here" : "Drag & drop your file here"}
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

      {/* Section B - Preview */}
      {templateUrl && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-heading">Preview</h2>
            <a href="/api/documents/download" download>
              <Button variant="ghost" size="sm">
                <Download className="w-4 h-4 mr-1" /> Download
              </Button>
            </a>
          </div>

          {isPdf(templateUrl) || isWord(templateUrl) ? (
            <iframe
              src="/api/documents/preview"
              className="w-full h-[600px] rounded-[var(--radius)] border bg-[#e8e8e8]"
              title="Agreement Preview"
            />
          ) : (
            <div className="flex items-center gap-3 p-4 rounded-[var(--radius)] bg-muted/40 text-sm text-muted-foreground">
              <FileText className="w-5 h-5 shrink-0" />
              <span>This file type cannot be previewed inline. Download to review.</span>
            </div>
          )}
        </Card>
      )}

      {/* Section C - Sent Agreements */}
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
