import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Upload, FileText, Globe, Trash2, Loader2, CheckCircle, Brain, MessageCircleQuestion, Send } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function ProviderKnowledgeTab() {
  const { toast } = useToast();
  const [dragOver, setDragOver] = useState(false);
  const [answerInputs, setAnswerInputs] = useState<Record<string, string>>({});

  const documentsQuery = useQuery<any[]>({
    queryKey: ["/api/knowledge/documents"],
  });

  const whispersQuery = useQuery<any[]>({
    queryKey: ["/api/knowledge/whispers"],
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/knowledge/upload", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Document Uploaded", description: `${data.fileName} processed into ${data.chunks} knowledge chunks.` });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/documents"] });
    },
    onError: (err: any) => {
      toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/knowledge/sync-website");
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Website Synced", description: `Processed ${data.chunks} knowledge chunks from ${data.url}` });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/documents"] });
    },
    onError: (err: any) => {
      toast({ title: "Sync Failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (fileName: string) => {
      const res = await apiRequest("DELETE", `/api/knowledge/documents/${encodeURIComponent(fileName)}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document Removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/documents"] });
    },
    onError: (err: any) => {
      toast({ title: "Delete Failed", description: err.message, variant: "destructive" });
    },
  });

  const answerMutation = useMutation({
    mutationFn: async ({ id, answer }: { id: string; answer: string }) => {
      const res = await apiRequest("POST", `/api/knowledge/whispers/${id}/answer`, { answer });
      return res.json();
    },
    onSuccess: (_data: any, variables: { id: string }) => {
      toast({ title: "Answer Sent", description: "Your answer has been sent to the AI and the parent has been notified." });
      setAnswerInputs((prev) => {
        const next = { ...prev };
        delete next[variables.id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/whispers"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      uploadMutation.mutate(files[0]);
    }
  }, [uploadMutation]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadMutation.mutate(files[0]);
    }
    e.target.value = "";
  }, [uploadMutation]);

  const docs = documentsQuery.data || [];
  const whispers = whispersQuery.data || [];
  const pendingWhispers = whispers.filter((w: any) => w.status === "PENDING");
  const answeredWhispers = whispers.filter((w: any) => w.status === "ANSWERED");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-display font-heading text-primary flex items-center gap-2" data-testid="text-knowledge-title">
          <Brain className="w-5 h-5" />
          AI Knowledge Base
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Upload documents and sync your website so the AI concierge can answer questions about your practice accurately.
        </p>
      </div>

      {pendingWhispers.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <MessageCircleQuestion className="w-4 h-4 text-[hsl(var(--brand-warning))]" />
            Unanswered AI Questions
            <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]">
              {pendingWhispers.length}
            </span>
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            A prospective parent asked the AI concierge a question it couldn't answer. Your response will be sent to the parent and taught to the AI for future reference.
          </p>
          <div className="space-y-3">
            {pendingWhispers.map((w: any) => (
              <Card key={w.id} className="p-4 border-[hsl(var(--brand-warning))]/30" data-testid={`card-whisper-${w.id}`}>
                <p className="text-sm font-medium mb-2">"{w.questionText}"</p>
                <p className="text-xs text-muted-foreground mb-3">
                  {new Date(w.createdAt).toLocaleDateString()} · Anonymous prospective parent
                </p>
                <div className="flex gap-2">
                  <textarea
                    value={answerInputs[w.id] || ""}
                    onChange={(e) =>
                      setAnswerInputs((prev) => ({ ...prev, [w.id]: e.target.value }))
                    }
                    placeholder="Type your answer..."
                    className="flex-1 rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-y"
                    data-testid={`input-whisper-answer-${w.id}`}
                  />
                </div>
                <div className="flex justify-end mt-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      answerMutation.mutate({
                        id: w.id,
                        answer: answerInputs[w.id] || "",
                      })
                    }
                    disabled={
                      !answerInputs[w.id]?.trim() || answerMutation.isPending
                    }
                    data-testid={`button-send-whisper-${w.id}`}
                  >
                    {answerMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    ) : (
                      <Send className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Send to AI
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {answeredWhispers.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-[hsl(var(--brand-success))]" />
            Answered Questions
          </h3>
          <div className="space-y-2">
            {answeredWhispers.slice(0, 5).map((w: any) => (
              <Card key={w.id} className="p-3 opacity-70" data-testid={`card-answered-${w.id}`}>
                <p className="text-xs font-medium">Q: {w.questionText}</p>
                <p className="text-xs text-muted-foreground mt-1">A: {w.answerText}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Answered {new Date(w.updatedAt).toLocaleDateString()}
                </p>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Card
        className={`p-8 border-2 border-dashed transition-colors cursor-pointer ${
          dragOver ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/40"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById("knowledge-file-input")?.click()}
        data-testid="dropzone-document-upload"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          {uploadMutation.isPending ? (
            <>
              <Loader2 className="w-10 h-10 text-primary animate-spin" />
              <p className="text-sm font-medium">Processing document...</p>
              <p className="text-xs text-muted-foreground">Extracting text, generating embeddings</p>
            </>
          ) : (
            <>
              <Upload className="w-10 h-10 text-muted-foreground" />
              <p className="text-sm font-medium">Drop a file here or click to upload</p>
              <p className="text-xs text-muted-foreground">Supported: PDF, CSV, TXT, DOCX (max 20MB)</p>
            </>
          )}
        </div>
        <input
          id="knowledge-file-input"
          type="file"
          accept=".pdf,.csv,.txt,.docx"
          className="hidden"
          onChange={handleFileSelect}
          data-testid="input-file-upload"
        />
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Globe className="w-4 h-4" />
            Website Sync
          </h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            data-testid="button-sync-website"
          >
            {syncMutation.isPending ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Syncing...</>
            ) : (
              <><Globe className="w-3.5 h-3.5 mr-1.5" /> Sync AI Memory</>
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Crawl your website and feed its content to the AI concierge. Re-sync anytime you update your site.
        </p>
      </Card>

      <div>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4" />
          Uploaded Documents
        </h3>
        {documentsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading...
          </div>
        ) : docs.length === 0 ? (
          <Card className="p-6 text-center">
            <p className="text-sm text-muted-foreground">No documents uploaded yet. Upload files above to teach the AI about your practice.</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {docs.map((doc: any, i: number) => (
              <Card key={i} className="p-3 flex items-center justify-between" data-testid={`card-document-${i}`}>
                <div className="flex items-center gap-3">
                  {doc.sourceType === "WEBSITE" ? (
                    <Globe className="w-4 h-4 text-[hsl(var(--accent))] shrink-0" />
                  ) : (
                    <FileText className="w-4 h-4 text-primary shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium">
                      {doc.sourceFileName || doc.sourceUrl || "Website Content"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {doc.chunk_count} chunks · {doc.sourceType}
                      {doc.createdAt ? ` · ${new Date(doc.createdAt).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                </div>
                {doc.sourceFileName && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate(doc.sourceFileName);
                    }}
                    disabled={deleteMutation.isPending}
                    data-testid={`button-delete-doc-${i}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
