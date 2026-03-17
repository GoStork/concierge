import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sparkles,
  Plus,
  Pencil,
  Trash2,
  Upload,
  X,
  Loader2,
  GripVertical,
  MessageSquare,
  MessageCircleQuestion,
  Bot,
  ChevronDown,
  ChevronUp,
  Settings,
  Brain,
  Globe,
  FileText,
  Send,
  CheckCircle,
  AlertCircle,
} from "lucide-react";

function SystemSettingsCard() {
  const { toast } = useToast();
  const { data: brandSettings } = useBrandSettings();
  const [parentExperienceMode, setParentExperienceMode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const currentMode = parentExperienceMode ?? brandSettings?.parentExperienceMode ?? "MARKETPLACE_ONLY";
  const hasChanges = parentExperienceMode !== null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, any> = {
        parentExperienceMode: parentExperienceMode,
        enableAiConcierge: parentExperienceMode !== "MARKETPLACE_ONLY",
      };
      await apiRequest("PUT", "/api/brand/settings", body);
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setParentExperienceMode(null);
      toast({ title: "System settings saved" });
    } catch {
      toast({ title: "Failed to save settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="rounded-xl p-6" data-testid="card-system-settings">
      <div className="flex items-center gap-2.5 mb-1">
        <Settings className="w-5 h-5 text-primary" />
        <h3 className="font-display text-base font-semibold">Parent Experience Mode</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Controls what parents see after onboarding.
      </p>

      <div className="space-y-5">
        <div className="space-y-3">
          <RadioGroup
            value={currentMode}
            onValueChange={(val) => setParentExperienceMode(val)}
            className="space-y-2"
            data-testid="radio-parent-mode"
          >
            <label className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/30 transition-colors">
              <RadioGroupItem value="CONCIERGE_FIRST" className="mt-0.5" data-testid="radio-concierge-first" />
              <div>
                <span className="text-sm font-medium">AI First</span>
                <p className="text-xs text-muted-foreground">Direct parents to Eva after onboarding</p>
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/30 transition-colors">
              <RadioGroupItem value="MARKETPLACE_ONLY" className="mt-0.5" data-testid="radio-marketplace-only" />
              <div>
                <span className="text-sm font-medium">Marketplace Only</span>
                <p className="text-xs text-muted-foreground">Skip Eva, direct parents to search</p>
              </div>
            </label>
          </RadioGroup>
        </div>

        {hasChanges && (
          <div className="flex justify-end pt-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              data-testid="btn-save-system-settings"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Save Settings
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function RuleForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: { id?: string; condition: string; guidance: string; isActive: boolean; sortOrder: number };
  onSave: (data: any) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [condition, setCondition] = useState(initial?.condition || "");
  const [guidance, setGuidance] = useState(initial?.guidance || "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);

  return (
    <Card className="p-4 space-y-3 border-primary/30">
      <div>
        <Label className="text-xs font-semibold">IF the user mentions...</Label>
        <Input
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          placeholder='"insurance coverage" or "success rates"'
          className="mt-1"
          data-testid="input-rule-condition"
        />
      </div>
      <div>
        <Label className="text-xs font-semibold">THEN guide with...</Label>
        <textarea
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="Mention that GoStork partners offer financing options through Prosper..."
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-y"
          data-testid="input-rule-guidance"
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch checked={isActive} onCheckedChange={setIsActive} data-testid="switch-rule-active" />
          <span className="text-xs text-muted-foreground">Active</span>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs">Priority</Label>
          <Input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value) || 0)}
            className="w-16 h-8 text-xs"
            data-testid="input-rule-sort"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="button-rule-cancel">Cancel</Button>
        <Button
          size="sm"
          onClick={() => onSave({ condition, guidance, isActive, sortOrder })}
          disabled={!condition.trim() || !guidance.trim() || saving}
          data-testid="button-rule-save"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
          Save Rule
        </Button>
      </div>
    </Card>
  );
}

function IntelligenceRulesCard() {
  const { toast } = useToast();
  const [showNewRule, setShowNewRule] = useState(false);
  const [editingRule, setEditingRule] = useState<string | null>(null);

  const rulesQuery = useQuery<any[]>({ queryKey: ["/api/knowledge/rules"] });

  const createRuleMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/knowledge/rules", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule Created" });
      setShowNewRule(false);
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/rules"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const updateRuleMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const res = await apiRequest("PUT", `/api/knowledge/rules/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule Updated" });
      setEditingRule(null);
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/rules"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/knowledge/rules/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rule Deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/rules"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const rules = rulesQuery.data || [];

  return (
    <Card className="rounded-xl p-6" data-testid="card-intelligence-rules">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <Brain className="w-5 h-5 text-primary" />
          <h3 className="font-display text-base font-semibold">Intelligence & Rules</h3>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { setShowNewRule(true); setEditingRule(null); }}
          data-testid="button-add-rule"
        >
          <Plus className="w-3.5 h-3.5 mr-1" /> Add Rule
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        If/Then rules injected into the AI's system prompt. When a user mentions the condition, the AI follows the guidance.
      </p>

      {showNewRule && (
        <div className="mb-4">
          <RuleForm
            onSave={(data) => createRuleMutation.mutate(data)}
            onCancel={() => setShowNewRule(false)}
            saving={createRuleMutation.isPending}
          />
        </div>
      )}

      {rulesQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading rules...
        </div>
      ) : rules.length === 0 && !showNewRule ? (
        <div className="p-6 text-center border rounded-lg">
          <p className="text-sm text-muted-foreground">No expert guidance rules yet. Add rules to steer the AI concierge's responses.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((rule: any) => (
            <div key={rule.id}>
              {editingRule === rule.id ? (
                <RuleForm
                  initial={rule}
                  onSave={(data) => updateRuleMutation.mutate({ id: rule.id, data })}
                  onCancel={() => setEditingRule(null)}
                  saving={updateRuleMutation.isPending}
                />
              ) : (
                <Card className={`p-3 ${!rule.isActive ? "opacity-50" : ""}`} data-testid={`card-rule-${rule.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-semibold text-primary">IF</span>{" "}
                        <span className="text-foreground">"{rule.condition}"</span>
                      </p>
                      <p className="text-sm mt-1">
                        <span className="font-semibold text-primary">THEN</span>{" "}
                        <span className="text-muted-foreground">{rule.guidance}</span>
                      </p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span>Priority: {rule.sortOrder}</span>
                        <span>{rule.isActive ? "Active" : "Inactive"}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => { setEditingRule(rule.id); setShowNewRule(false); }} data-testid={`button-edit-rule-${rule.id}`}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => deleteRuleMutation.mutate(rule.id)}
                        disabled={deleteRuleMutation.isPending}
                        data-testid={`button-delete-rule-${rule.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function KnowledgeBaseCard() {
  const { toast } = useToast();
  const [bulkSyncRunning, setBulkSyncRunning] = useState(false);
  const [bulkSyncResult, setBulkSyncResult] = useState<any>(null);
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

  const handleBulkSync = async () => {
    setBulkSyncRunning(true);
    setBulkSyncResult(null);
    try {
      const res = await apiRequest("POST", "/api/knowledge/bulk-sync");
      const data = await res.json();
      setBulkSyncResult(data);
      toast({ title: "Bulk Sync Complete", description: `${data.synced} synced, ${data.failed} failed` });
    } catch (err: any) {
      toast({ title: "Bulk Sync Failed", description: err.message, variant: "destructive" });
    } finally {
      setBulkSyncRunning(false);
    }
  };

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
    <Card className="rounded-xl p-6" data-testid="card-knowledge-base">
      <div className="flex items-center gap-2.5 mb-1">
        <Brain className="w-5 h-5 text-primary" />
        <h3 className="font-display text-base font-semibold">Knowledge Base</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-5">
        Upload documents and sync provider websites so the AI concierge can answer questions accurately.
      </p>

      <div className="space-y-4">
        <div className="rounded-lg border p-4" data-testid="section-unanswered-questions">
          <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <MessageCircleQuestion className="w-4 h-4 text-[hsl(var(--brand-warning))]" />
            Unanswered AI Questions
            {pendingWhispers.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]">
                {pendingWhispers.length}
              </span>
            )}
          </h4>
          <p className="text-xs text-muted-foreground mb-3">
            When the AI concierge can't answer a parent's question, it appears here. Your response will be sent to the parent and taught to the AI.
          </p>
          {pendingWhispers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unanswered questions right now.</p>
          ) : (
            <div className="space-y-3">
              {pendingWhispers.map((w: any) => (
                <div key={w.id} className="p-3 rounded-lg border border-[hsl(var(--brand-warning))]/30 bg-[hsl(var(--brand-warning))]/5" data-testid={`card-whisper-${w.id}`}>
                  <p className="text-sm font-medium mb-1">"{w.questionText}"</p>
                  <p className="text-xs text-muted-foreground mb-2">
                    {new Date(w.createdAt).toLocaleDateString()} · Anonymous prospective parent
                  </p>
                  <textarea
                    value={answerInputs[w.id] || ""}
                    onChange={(e) => setAnswerInputs((prev) => ({ ...prev, [w.id]: e.target.value }))}
                    placeholder="Type your answer..."
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[60px] resize-y"
                    data-testid={`input-whisper-answer-${w.id}`}
                  />
                  <div className="flex justify-end mt-2">
                    <Button
                      size="sm"
                      onClick={() => answerMutation.mutate({ id: w.id, answer: answerInputs[w.id] || "" })}
                      disabled={!answerInputs[w.id]?.trim() || answerMutation.isPending}
                      data-testid={`button-send-whisper-${w.id}`}
                    >
                      {answerMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
                      Send to AI
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border p-4" data-testid="section-answered-questions">
          <h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-[hsl(var(--brand-success))]" />
            Answered Questions
          </h4>
          {answeredWhispers.length === 0 ? (
            <p className="text-sm text-muted-foreground mt-2">No answered questions yet. Answers you provide above will appear here.</p>
          ) : (
            <div className="space-y-2 mt-3">
              {answeredWhispers.slice(0, 5).map((w: any) => (
                <div key={w.id} className="p-3 rounded-lg border opacity-70" data-testid={`card-answered-${w.id}`}>
                  <p className="text-xs font-medium">Q: {w.questionText}</p>
                  <p className="text-xs text-muted-foreground mt-1">A: {w.answerText}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Answered {new Date(w.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border p-4" data-testid="section-documents">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Documents
          </h4>
          <div
            className={`p-6 border-2 border-dashed rounded-lg transition-colors cursor-pointer ${
              dragOver ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/40"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById("admin-knowledge-file-input")?.click()}
            data-testid="dropzone-document-upload"
          >
            <div className="flex flex-col items-center gap-2 text-center">
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
                  <p className="text-sm font-medium">Processing document...</p>
                  <p className="text-xs text-muted-foreground">Extracting text, generating embeddings</p>
                </>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-muted-foreground" />
                  <p className="text-sm font-medium">Drop a file here or click to upload</p>
                  <p className="text-xs text-muted-foreground">Supported: PDF, CSV, TXT, DOCX (max 20MB)</p>
                </>
              )}
            </div>
            <input
              id="admin-knowledge-file-input"
              type="file"
              accept=".pdf,.csv,.txt,.docx"
              className="hidden"
              onChange={handleFileSelect}
              data-testid="input-file-upload"
            />
          </div>

          <div className="mt-4">
            {documentsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </div>
            ) : docs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No documents uploaded yet. Upload files above to teach the AI about your practice.</p>
            ) : (
              <div className="space-y-2">
                {docs.map((doc: any, i: number) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-lg border" data-testid={`card-document-${i}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      {doc.sourceType === "WEBSITE" ? (
                        <Globe className="w-4 h-4 text-[hsl(var(--accent))] shrink-0" />
                      ) : (
                        <FileText className="w-4 h-4 text-primary shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
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
                        className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                        onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(doc.sourceFileName); }}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-doc-${i}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border p-4" data-testid="section-bulk-sync">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Bulk Provider Website Sync</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Crawl all provider websites and update the AI knowledge base. Rate-limited to 1 request/second.
              </p>
            </div>
            <Button
              onClick={handleBulkSync}
              disabled={bulkSyncRunning}
              data-testid="button-bulk-sync"
            >
              {bulkSyncRunning ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Syncing...</>
              ) : (
                <><Globe className="w-4 h-4 mr-2" /> Sync All Providers</>
              )}
            </Button>
          </div>

          {bulkSyncResult && (
            <div className="mt-4 p-3 rounded-md bg-muted/50 text-sm space-y-1" data-testid="text-bulk-sync-result">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-[hsl(var(--brand-success))]" />
                <span>{bulkSyncResult.synced} providers synced successfully</span>
              </div>
              {bulkSyncResult.failed > 0 && (
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-destructive" />
                  <span>{bulkSyncResult.failed} failed</span>
                </div>
              )}
              {bulkSyncResult.errors?.length > 0 && (
                <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                  {bulkSyncResult.errors.map((e: string, i: number) => (
                    <p key={i}>• {e}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function AdminConciergePage() {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Matchmaker>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const matchmakersQuery = useQuery<Matchmaker[]>({
    queryKey: ["/api/brand/matchmakers"],
    queryFn: async () => {
      const res = await fetch("/api/brand/matchmakers", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: Partial<Matchmaker>) => {
      const res = await apiRequest("POST", "/api/brand/matchmakers", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setShowAddForm(false);
      setEditForm({});
      toast({ title: "Matchmaker created", variant: "success" });
    },
    onError: () => toast({ title: "Failed to create matchmaker", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: Partial<Matchmaker> & { id: string }) => {
      const res = await apiRequest("PUT", `/api/brand/matchmakers/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      setEditingId(null);
      setEditForm({});
      toast({ title: "Matchmaker updated", variant: "success" });
    },
    onError: () => toast({ title: "Failed to update matchmaker", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/brand/matchmakers/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
      toast({ title: "Matchmaker deleted", variant: "success" });
    },
    onError: () => toast({ title: "Failed to delete matchmaker", variant: "destructive" }),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiRequest("PUT", `/api/brand/matchmakers/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/brand/matchmakers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/brand/settings"] });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const handleAvatarUpload = async (file: File, callback: (url: string) => void) => {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/uploads", { method: "POST", body: formData, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json();
      callback(data.url);
    } catch {
      toast({ title: "Failed to upload image", variant: "destructive" });
    }
  };

  const matchmakers = matchmakersQuery.data || [];
  const activeCount = matchmakers.filter(m => m.isActive).length;

  const renderForm = (isNew: boolean) => {
    const onSave = () => {
      if (!editForm.name || !editForm.title || !editForm.description || !editForm.personalityPrompt) {
        toast({ title: "Name, title, description, and personality prompt are required", variant: "destructive" });
        return;
      }
      if (isNew) {
        createMutation.mutate({ ...editForm, isActive: editForm.isActive !== false });
      } else if (editingId) {
        updateMutation.mutate({ id: editingId, ...editForm });
      }
    };

    return (
      <Card className="rounded-xl p-5 space-y-4 border-primary/20 border-2" data-testid={isNew ? "matchmaker-add-form" : `matchmaker-edit-form-${editingId}`}>
        <div className="flex items-center gap-2 pb-2 border-b">
          <Bot className="w-4 h-4 text-primary" />
          <span className="font-medium text-sm">{isNew ? "New Matchmaker" : "Edit Matchmaker"}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Name *</Label>
            <Input placeholder="e.g. Ariel" value={editForm.name || ""} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} data-testid="input-matchmaker-name" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Title *</Label>
            <Input placeholder="e.g. The Warm Guide" value={editForm.title || ""} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} data-testid="input-matchmaker-title" />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Description *</Label>
          <Textarea placeholder="Brief description of this matchmaker's personality..." value={editForm.description || ""} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={2} data-testid="input-matchmaker-description" />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Personality Prompt *</Label>
          <Textarea placeholder="System prompt that defines the AI's personality and behavior..." value={editForm.personalityPrompt || ""} onChange={(e) => setEditForm({ ...editForm, personalityPrompt: e.target.value })} rows={4} className="font-mono text-xs" data-testid="input-matchmaker-prompt" />
          <p className="text-xs text-muted-foreground">This prompt shapes how the AI persona communicates. It is never visible to parents.</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Initial Greeting</Label>
          <Textarea placeholder="The first message parents see when they select this matchmaker..." value={editForm.initialGreeting || ""} onChange={(e) => setEditForm({ ...editForm, initialGreeting: e.target.value })} rows={2} data-testid="input-matchmaker-greeting" />
          <p className="text-xs text-muted-foreground">Optional. Displayed as the opening message when a parent selects this persona.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Avatar</Label>
            <div className="flex items-center gap-3">
              {editForm.avatarUrl && (
                <img src={editForm.avatarUrl} alt={editForm.name || "Avatar"} className="w-10 h-10 rounded-full object-cover border" data-testid="img-matchmaker-avatar-preview" />
              )}
              <label className="cursor-pointer">
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleAvatarUpload(file, (url) => setEditForm({ ...editForm, avatarUrl: url })); }} data-testid="input-matchmaker-avatar-upload" />
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md hover:bg-muted transition-colors">
                  <Upload className="w-3.5 h-3.5" />
                  {editForm.avatarUrl ? "Change" : "Upload"}
                </span>
              </label>
              {editForm.avatarUrl && (
                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setEditForm({ ...editForm, avatarUrl: null })} data-testid="btn-clear-matchmaker-avatar">
                  <X className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Status</Label>
            <div className="flex items-center gap-2 pt-1">
              <Switch checked={editForm.isActive !== false} onCheckedChange={(checked) => setEditForm({ ...editForm, isActive: checked })} data-testid="switch-matchmaker-active" />
              <span className="text-sm text-muted-foreground">{editForm.isActive !== false ? "Active — visible to parents" : "Inactive — hidden from parents"}</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t">
          <Button variant="outline" size="sm" onClick={() => { setEditingId(null); setShowAddForm(false); setEditForm({}); }} data-testid="btn-matchmaker-cancel">Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={createMutation.isPending || updateMutation.isPending} data-testid="btn-matchmaker-save">
            {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
            {isNew ? "Create Matchmaker" : "Save Changes"}
          </Button>
        </div>
      </Card>
    );
  };

  return (
    <div className="space-y-6" data-testid="admin-concierge-page">
      <SystemSettingsCard />

      <Card className="rounded-xl p-6" data-testid="card-personas">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <Bot className="w-5 h-5 text-primary" />
            <h3 className="font-display text-base font-semibold">Personas</h3>
          </div>
          {!showAddForm && !editingId && (
            <Button size="sm" onClick={() => { setShowAddForm(true); setEditForm({ isActive: true }); }} data-testid="btn-add-matchmaker">
              <Plus className="w-4 h-4 mr-1.5" /> Add Persona
            </Button>
          )}
        </div>

        {matchmakers.length > 0 && (
          <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4" data-testid="matchmaker-stats">
            <span>{matchmakers.length} persona{matchmakers.length !== 1 ? "s" : ""} total</span>
            <span className="text-[hsl(var(--brand-success))]">{activeCount} active</span>
            {matchmakers.length - activeCount > 0 && (
              <span className="text-[hsl(var(--brand-warning))]">{matchmakers.length - activeCount} inactive</span>
            )}
          </div>
        )}

        {matchmakersQuery.isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-primary" data-testid="matchmakers-loading" />
          </div>
        )}

        {showAddForm && <div className="mb-4">{renderForm(true)}</div>}

        <div className="space-y-3">
          {matchmakers.map((m) => (
            editingId === m.id ? (
              <div key={m.id}>{renderForm(false)}</div>
            ) : (
              <Card key={m.id} className={`rounded-xl overflow-hidden transition-all ${!m.isActive ? "opacity-60" : ""}`} data-testid={`matchmaker-card-${m.id}`}>
                <div className="flex items-center gap-3 p-4">
                  <div className="flex-shrink-0 text-muted-foreground/40"><GripVertical className="w-4 h-4" /></div>
                  <div className="flex-shrink-0">
                    {m.avatarUrl ? (
                      <img src={m.avatarUrl} alt={m.name} className="w-11 h-11 rounded-full object-cover border" />
                    ) : (
                      <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-sm">{m.name.charAt(0)}</div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{m.name}</span>
                      <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-muted rounded">{m.title}</span>
                      {!m.isActive && (
                        <span className="text-xs text-[hsl(var(--brand-warning))] px-1.5 py-0.5 bg-[hsl(var(--brand-warning))]/10 rounded" data-testid={`badge-inactive-${m.id}`}>Inactive</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{m.description}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Switch checked={m.isActive} onCheckedChange={(checked) => toggleActiveMutation.mutate({ id: m.id, isActive: checked })} data-testid={`switch-active-${m.id}`} />
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setExpandedId(expandedId === m.id ? null : m.id)} data-testid={`btn-expand-matchmaker-${m.id}`}>
                      {expandedId === m.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => { setEditingId(m.id); setEditForm(m); setShowAddForm(false); setExpandedId(null); }} data-testid={`btn-edit-matchmaker-${m.id}`}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => { if (confirm(`Delete matchmaker "${m.name}"?`)) deleteMutation.mutate(m.id); }} disabled={deleteMutation.isPending} data-testid={`btn-delete-matchmaker-${m.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {expandedId === m.id && (
                  <div className="px-4 pb-4 pt-0 border-t space-y-3" data-testid={`matchmaker-details-${m.id}`}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          <Bot className="w-3.5 h-3.5" /> Personality Prompt
                        </div>
                        <p className="text-sm bg-muted/50 rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{m.personalityPrompt}</p>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          <MessageSquare className="w-3.5 h-3.5" /> Initial Greeting
                        </div>
                        {m.initialGreeting ? (
                          <p className="text-sm bg-muted/50 rounded-lg p-3 leading-relaxed">{m.initialGreeting}</p>
                        ) : (
                          <p className="text-sm text-muted-foreground italic p-3">No custom greeting set</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            )
          ))}
        </div>

        {!matchmakersQuery.isLoading && matchmakers.length === 0 && !showAddForm && (
          <div className="rounded-xl p-12 text-center border" data-testid="matchmakers-empty">
            <Sparkles className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No matchmaker personas configured yet.</p>
            <Button size="sm" className="mt-4" onClick={() => { setShowAddForm(true); setEditForm({ isActive: true }); }} data-testid="btn-add-first-matchmaker">
              <Plus className="w-4 h-4 mr-1.5" /> Create Your First Persona
            </Button>
          </div>
        )}
      </Card>

      <IntelligenceRulesCard />

      <KnowledgeBaseCard />
    </div>
  );
}
