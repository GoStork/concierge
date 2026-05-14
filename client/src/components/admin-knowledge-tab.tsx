import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Brain, Globe, Loader2, Plus, Trash2, Pencil, ArrowUpDown, CheckCircle, AlertCircle, X } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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
          placeholder='e.g. "insurance coverage" or "success rates"'
          className="mt-1"
          data-testid="input-rule-condition"
        />
      </div>
      <div>
        <Label className="text-xs font-semibold">THEN guide with...</Label>
        <textarea
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="e.g. Mention that GoStork partners offer financing options through Prosper..."
          className="mt-1 w-full rounded-[var(--radius)] border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-y"
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
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="button-rule-cancel">
          Cancel
        </Button>
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

export default function AdminKnowledgeTab() {
  const { toast } = useToast();
  const [showNewRule, setShowNewRule] = useState(false);
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [bulkSyncJob, setBulkSyncJob] = useState<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rulesQuery = useQuery<any[]>({
    queryKey: ["/api/knowledge/rules"],
  });

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
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
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
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
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
    onError: (err: any) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => () => stopPolling(), []);

  const handleBulkSync = async () => {
    setBulkSyncJob({ status: "running", current: 0, total: 0, currentName: "", synced: 0, failed: 0, errors: [] });
    stopPolling();
    try {
      const res = await apiRequest("POST", "/api/knowledge/bulk-sync");
      const { jobId } = await res.json();

      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await apiRequest("GET", `/api/knowledge/bulk-sync/${jobId}`);
          const job = await statusRes.json();
          setBulkSyncJob(job);
          if (job.status === "done" || job.status === "error") {
            stopPolling();
            toast({
              title: job.status === "done" ? "Sync Complete" : "Sync Error",
              description: job.status === "done"
                ? `${job.synced} providers synced, ${job.failed} failed`
                : job.errors?.[0] || "Unknown error",
              variant: job.status === "done" ? "default" : "destructive",
            });
          }
        } catch { stopPolling(); }
      }, 2000);
    } catch (err: any) {
      setBulkSyncJob(null);
      toast({ title: "Failed to start sync", description: err.message, variant: "destructive" });
    }
  };

  const rules = rulesQuery.data || [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-display font-heading text-primary flex items-center gap-2" data-testid="text-admin-knowledge-title">
          <Brain className="w-5 h-5" />
          Knowledge Base Management
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage provider website syncing and configure expert guidance rules for the AI concierge.
        </p>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Globe className="w-4 h-4" />
              Bulk Provider Website Sync
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Crawl all provider websites and update the AI knowledge base. Rate-limited to 1 request/second.
            </p>
          </div>
          <Button
            onClick={handleBulkSync}
            disabled={bulkSyncJob?.status === "running"}
            data-testid="button-bulk-sync"
          >
            {bulkSyncJob?.status === "running" ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Syncing...</>
            ) : (
              <><Globe className="w-4 h-4 mr-2" /> Sync All Providers</>
            )}
          </Button>
        </div>
        {bulkSyncJob && (
          <div className="mt-3 p-3 rounded-[var(--radius)] bg-muted/50 text-sm space-y-1" data-testid="text-bulk-sync-result">
            {bulkSyncJob.status === "running" ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>
                  {bulkSyncJob.total > 0
                    ? `Syncing ${bulkSyncJob.current} / ${bulkSyncJob.total} - ${bulkSyncJob.currentName}`
                    : "Starting..."}
                </span>
              </div>
            ) : bulkSyncJob.status === "done" ? (
              <>
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-[hsl(var(--brand-success))]" />
                  <span>{bulkSyncJob.synced} providers synced successfully</span>
                </div>
                {bulkSyncJob.failed > 0 && (
                  <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-destructive" />
                    <span>{bulkSyncJob.failed} failed</span>
                  </div>
                )}
                {bulkSyncJob.errors?.length > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                    {bulkSyncJob.errors.map((e: string, i: number) => (
                      <p key={i}>- {e}</p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="w-4 h-4" />
                <span>{bulkSyncJob.errors?.[0] || "Sync failed"}</span>
              </div>
            )}
          </div>
        )}
      </Card>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ArrowUpDown className="w-4 h-4" />
            Expert Guidance Rules
          </h3>
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
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading rules...
          </div>
        ) : rules.length === 0 && !showNewRule ? (
          <Card className="p-6 text-center">
            <p className="text-sm text-muted-foreground">No expert guidance rules yet. Add rules to steer the AI concierge's responses.</p>
          </Card>
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
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setEditingRule(rule.id); setShowNewRule(false); }}
                          data-testid={`button-edit-rule-${rule.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
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
      </div>
    </div>
  );
}