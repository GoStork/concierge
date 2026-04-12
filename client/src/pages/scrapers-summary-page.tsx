import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useNavigate } from "react-router-dom";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, CheckCircle2, XCircle, Clock, RefreshCw, RotateCcw, AlertTriangle, ExternalLink, Database, Trash2, Sparkles, Square } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";

interface SyncProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
}

interface ScraperSummary {
  providerId: string;
  providerName: string;
  type: "egg-donor" | "surrogate" | "sperm-donor";
  syncStatus: string;
  lastSyncAt: string | null;
  lastSyncStartedAt: string | null;
  lastSyncEndedAt: string | null;
  totalProfiles: number;
  totalErrors: number;
  latestDonorCreatedAt: string | null;
  syncProgress?: SyncProgress | null;
}

interface SummaryResponse {
  summaries: ScraperSummary[];
  lastNightlySyncAt: string | null;
  nightlySyncRunning: boolean;
}

interface CdcSyncJob {
  id: string;
  year: number;
  status: string;
  clinicsProcessed: number;
  recordsProcessed: number;
  estimatedTotalRecords: number | null;
  estimatedTotalClinics: number | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  enrichmentStatus: string | null;
  enrichmentProcessed: number;
  enrichmentTotal: number;
  enrichmentErrors: number;
  enrichmentErrorMessage: string | null;
}

function CdcSyncProgressBar({ job }: { job: CdcSyncJob }) {
  const navigate = useNavigate();
  const totalRecords = job.estimatedTotalRecords || 0;
  const currentRecords = job.recordsProcessed || 0;
  const hasEstimate = totalRecords > 0;
  const percentage = hasEstimate
    ? Math.min(99, Math.round((currentRecords / totalRecords) * 100))
    : 0;

  return (
    <div className="w-full min-w-[140px]" data-testid={`cdc-progress-bar-${job.id}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
        <button
          type="button"
          onClick={() => navigate(`/admin/scrapers/cdc-sync/${job.id}/report`)}
          className="text-xs font-ui text-primary hover:underline cursor-pointer"
          data-testid={`link-cdc-live-report-${job.id}`}
        >
          {hasEstimate ? `Syncing... ${percentage}%` : "Starting..."} →
        </button>
      </div>
      <button
        type="button"
        onClick={() => navigate(`/admin/scrapers/cdc-sync/${job.id}/report`)}
        className="w-full cursor-pointer group"
        title="View live sync report"
        data-testid={`button-cdc-progress-bar-${job.id}`}
      >
        <div className="w-full bg-muted rounded-full h-2 overflow-hidden group-hover:ring-2 group-hover:ring-primary/20 transition-all">
          <div
            className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
            style={{ width: hasEstimate ? `${percentage}%` : "5%" }}
            data-testid={`cdc-progress-fill-${job.id}`}
          />
        </div>
      </button>
      <div className="text-[10px] text-muted-foreground mt-0.5">
        {hasEstimate
          ? `${currentRecords.toLocaleString()} / ${totalRecords.toLocaleString()} records`
          : "Estimating..."}
      </div>
    </div>
  );
}

function CdcSyncStatusCell({ job, onCancel, onResume, onRestart }: { job: CdcSyncJob; onCancel: (jobId: string) => Promise<void>; onResume: (jobId: string) => Promise<void>; onRestart: (jobId: string) => Promise<void> }) {
  const navigate = useNavigate();
  const [isCancelling, setIsCancelling] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCancel = async () => {
    setIsCancelling(true);
    setActionError(null);
    try {
      await onCancel(job.id);
    } catch (err: any) {
      setActionError("Could not cancel sync. Please try again.");
      setTimeout(() => setActionError(null), 5000);
    } finally {
      setIsCancelling(false);
    }
  };

  const handleResume = async () => {
    setIsResuming(true);
    setActionError(null);
    try {
      await onResume(job.id);
    } catch (err: any) {
      setActionError(friendlySyncError(err.message || ""));
      setTimeout(() => setActionError(null), 5000);
    } finally {
      setIsResuming(false);
    }
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    setActionError(null);
    try {
      await onRestart(job.id);
    } catch (err: any) {
      setActionError(friendlySyncError(err.message || ""));
      setTimeout(() => setActionError(null), 5000);
    } finally {
      setIsRestarting(false);
    }
  };

  if (job.status === "PROCESSING" || job.status === "PENDING") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-1">
          <div className="flex-1">
            <CdcSyncProgressBar job={job} />
          </div>
          <button
            onClick={handleCancel}
            disabled={isCancelling}
            className="mt-0.5 p-0.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors shrink-0"
            title="Cancel sync"
            data-testid={`button-cancel-cdc-sync-${job.id}`}
          >
            {isCancelling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
        {actionError && (
          <span className="text-[10px] text-destructive" data-testid={`text-sync-cancel-error-${job.id}`}>
            {actionError}
          </span>
        )}
      </div>
    );
  }
  if (job.status === "COMPLETED") {
    return (
      <button
        type="button"
        className="cursor-pointer"
        onClick={(e) => { e.stopPropagation(); navigate(`/admin/scrapers/cdc-sync/${job.id}/report`); }}
        data-testid={`link-cdc-report-${job.id}`}
      >
        <Badge className="bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success)/0.2)] gap-1 transition-colors" data-testid="badge-cdc-completed">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Completed
        </Badge>
      </button>
    );
  }
  if (job.status === "FAILED") {
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 shrink-0">
          <button
            type="button"
            className="cursor-pointer"
            onClick={(e) => { e.stopPropagation(); navigate(`/admin/scrapers/cdc-sync/${job.id}/report`); }}
            data-testid={`link-cdc-report-failed-${job.id}`}
          >
            <Badge className="bg-destructive/15 text-destructive hover:bg-destructive/20 gap-1 transition-colors" data-testid="badge-cdc-failed">
              <XCircle className="w-3.5 h-3.5" />
              Failed
            </Badge>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={handleResume}
            disabled={isResuming || isRestarting}
            data-testid={`button-resume-cdc-sync-${job.id}`}
          >
            {isResuming ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3 mr-1" />
            )}
            Resume
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={handleRestart}
            disabled={isResuming || isRestarting}
            data-testid={`button-restart-cdc-sync-${job.id}`}
          >
            {isRestarting ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <RotateCcw className="w-3 h-3 mr-1" />
            )}
            Restart
          </Button>
        </div>
        {job.errorMessage && (
          <span className="text-[10px] text-destructive line-clamp-1" data-testid={`text-cdc-error-${job.id}`}>
            {job.errorMessage}
          </span>
        )}
        {actionError && (
          <span className="text-[10px] text-destructive" data-testid={`text-sync-action-error-${job.id}`}>
            {actionError}
          </span>
        )}
      </div>
    );
  }
  return (
    <Badge className="bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] gap-1" data-testid="badge-cdc-pending">
      <Clock className="w-3.5 h-3.5" />
      {job.status}
    </Badge>
  );
}

function friendlyEnrichmentError(msg: string): string {
  if (/already running/i.test(msg)) return "Enrichment is already in progress";
  if (/not found/i.test(msg)) return "Sync job not found";
  return "Could not start enrichment. Please try again.";
}

function CdcEnrichmentCell({ job, onTrigger, onRestart, onCancel, compact }: { job: CdcSyncJob; onTrigger: (jobId: string) => Promise<void>; onRestart: (jobId: string) => Promise<void>; onCancel: (jobId: string) => Promise<void>; compact?: boolean }) {
  const navigate = useNavigate();
  const [isTriggering, setIsTriggering] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const handleTrigger = async () => {
    setTriggerError(null);
    setIsTriggering(true);
    try {
      await onTrigger(job.id);
    } catch (err: any) {
      setTriggerError(friendlyEnrichmentError(err.message || ""));
      setTimeout(() => setTriggerError(null), 5000);
    } finally {
      setIsTriggering(false);
    }
  };

  const handleRestart = async () => {
    setTriggerError(null);
    setIsRestarting(true);
    try {
      await onRestart(job.id);
    } catch (err: any) {
      setTriggerError(friendlyEnrichmentError(err.message || ""));
      setTimeout(() => setTriggerError(null), 5000);
    } finally {
      setIsRestarting(false);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      await onCancel(job.id);
    } catch (err: any) {
      setTriggerError("Could not cancel enrichment. Please try again.");
      setTimeout(() => setTriggerError(null), 5000);
    } finally {
      setIsCancelling(false);
    }
  };

  if (job.status !== "COMPLETED") {
    return compact ? null : <span className="text-muted-foreground text-xs">-</span>;
  }

  if (!job.enrichmentStatus) {
    if (compact) {
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[11px] gap-1 px-2"
          onClick={handleTrigger}
          disabled={isTriggering}
          data-testid={`button-enrich-compact-${job.id}`}
        >
          {isTriggering ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          Enrich
        </Button>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={handleTrigger}
          disabled={isTriggering}
          data-testid={`button-enrich-${job.id}`}
        >
          {isTriggering ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          Enrich Profiles
        </Button>
        {triggerError && (
          <span className="text-[10px] text-destructive" data-testid={`text-enrich-error-${job.id}`}>
            {triggerError}
          </span>
        )}
      </div>
    );
  }

  if (job.enrichmentStatus === "PENDING" || job.enrichmentStatus === "PROCESSING") {
    const pct = job.enrichmentTotal > 0
      ? Math.round((job.enrichmentProcessed / job.enrichmentTotal) * 100)
      : 0;
    if (compact) {
      return (
        <div className="flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin text-primary" />
          <span className="text-[11px] text-primary font-ui">{pct}%</span>
        </div>
      );
    }
    return (
      <div className="w-full min-w-[120px]" data-testid={`enrichment-progress-${job.id}`}>
        <div className="flex items-center gap-1.5 mb-1">
          <Loader2 className="w-3 h-3 animate-spin text-primary" />
          <button
            type="button"
            onClick={() => navigate(`/admin/scrapers/cdc-sync/${job.id}/enrichment-report`)}
            className="text-xs font-ui text-primary hover:underline cursor-pointer"
            data-testid={`link-live-report-${job.id}`}
          >
            {job.enrichmentTotal > 0 ? `Enriching... ${pct}%` : "Starting..."} →
          </button>
          <button
            onClick={handleCancel}
            disabled={isCancelling}
            className="ml-auto p-0.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors"
            title="Cancel enrichment"
            data-testid={`button-cancel-enrich-${job.id}`}
          >
            {isCancelling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={() => navigate(`/admin/scrapers/cdc-sync/${job.id}/enrichment-report`)}
          className="w-full cursor-pointer group"
          title="View live enrichment report"
          data-testid={`button-progress-bar-${job.id}`}
        >
          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden group-hover:ring-2 group-hover:ring-primary/20 transition-all">
            <div
              className="bg-primary h-1.5 rounded-full transition-all duration-500 ease-out"
              style={{ width: job.enrichmentTotal > 0 ? `${pct}%` : "5%" }}
            />
          </div>
        </button>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {job.enrichmentProcessed} / {job.enrichmentTotal} profiles
          {job.enrichmentErrors > 0 && ` (${job.enrichmentErrors} errors)`}
        </div>
        {triggerError && (
          <span className="text-[10px] text-destructive" data-testid={`text-cancel-error-${job.id}`}>
            {triggerError}
          </span>
        )}
      </div>
    );
  }

  if (job.enrichmentStatus === "COMPLETED") {
    return (
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="cursor-pointer shrink-0"
          onClick={() => navigate(`/admin/scrapers/cdc-sync/${job.id}/enrichment-report`)}
          data-testid={`link-enrichment-report-${job.id}`}
        >
          <Badge className="bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success)/0.2)] gap-0.5 transition-colors text-[11px] px-1.5 py-0.5" data-testid={`badge-enriched-${job.id}`}>
            <CheckCircle2 className="w-3 h-3" />
            Enriched
          </Badge>
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 text-[11px] px-1 gap-0.5 shrink-0"
          onClick={handleRestart}
          disabled={isRestarting || isTriggering}
          data-testid={`button-restart-enrich-${job.id}`}
          title="Restart enrichment from scratch for all clinics"
        >
          {isRestarting ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
          ) : (
            <RotateCcw className="w-2.5 h-2.5" />
          )}
          Restart
        </Button>
      </div>
    );
  }

  if (job.enrichmentStatus === "FAILED") {
    if (compact) {
      return (
        <button
          type="button"
          className="cursor-pointer"
          onClick={() => navigate(`/admin/scrapers/cdc-sync/${job.id}/enrichment-report`)}
          data-testid={`link-enrichment-report-failed-compact-${job.id}`}
        >
          <Badge className="bg-destructive/15 text-destructive hover:bg-destructive/20 gap-1 text-[11px] px-1.5 py-0.5 transition-colors">
            <XCircle className="w-3 h-3" />
            Failed
          </Badge>
        </button>
      );
    }
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
        <button
          type="button"
          className="cursor-pointer shrink-0"
          onClick={() => navigate(`/admin/scrapers/cdc-sync/${job.id}/enrichment-report`)}
          data-testid={`link-enrichment-report-failed-${job.id}`}
        >
          <Badge className="bg-destructive/15 text-destructive hover:bg-destructive/20 gap-1 transition-colors" data-testid={`badge-enrichment-failed-${job.id}`}>
            <XCircle className="w-3 h-3" />
            Failed
          </Badge>
        </button>
        {job.enrichmentErrorMessage && (
          <span className="text-[10px] text-destructive line-clamp-1" data-testid={`text-enrichment-error-${job.id}`}>
            {job.enrichmentErrorMessage}
          </span>
        )}
      </div>
    );
  }

  return <span className="text-muted-foreground text-xs">-</span>;
}

function friendlyDeleteError(msg: string): string {
  if (/active sync/i.test(msg)) return "Can't delete while sync is running";
  if (/enrichment is running/i.test(msg)) return "Can't delete while enrichment is running";
  return "Something went wrong. Please try again.";
}

function friendlySyncError(msg: string): string {
  if (/no cdc dataset/i.test(msg) || /not found/i.test(msg)) return "No CDC dataset is available for this year yet";
  if (/already running/i.test(msg) || /conflict/i.test(msg)) return "A sync is already running for this year";
  return "Something went wrong. Please try again.";
}

function CdcSyncSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [syncError, setSyncError] = useState<string | null>(null);

  const { data: cdcJobs, isLoading: cdcLoading } = useQuery<CdcSyncJob[]>({
    queryKey: ["/api/scrapers/cdc-syncs"],
    refetchInterval: (query) => {
      const jobs = query.state.data as CdcSyncJob[] | undefined;
      const hasActive = jobs?.some(j =>
        j.status === "PROCESSING" || j.status === "PENDING" ||
        j.enrichmentStatus === "PROCESSING" || j.enrichmentStatus === "PENDING"
      );
      return hasActive ? 3000 : 30000;
    },
  });

  const handleDeleteJob = async (jobId: string) => {
    setDeleteErrors((prev) => { const next = { ...prev }; delete next[jobId]; return next; });
    try {
      const res = await apiRequest("DELETE", `/api/scrapers/cdc-syncs/${jobId}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(errorData.message || "Failed to delete job");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
    } catch (err: any) {
      const friendly = friendlyDeleteError(err.message || "");
      setDeleteErrors((prev) => ({ ...prev, [jobId]: friendly }));
      setTimeout(() => {
        setDeleteErrors((prev) => { const next = { ...prev }; delete next[jobId]; return next; });
      }, 5000);
    }
  };

  const handleTriggerEnrichment = async (jobId: string) => {
    const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${jobId}/enrich`);
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(errorData.message || "Failed to start enrichment");
    }
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleRestartEnrichment = async (jobId: string) => {
    const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${jobId}/enrich?restart=true`);
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(errorData.message || "Failed to restart enrichment");
    }
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleCancelEnrichment = async (jobId: string) => {
    const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${jobId}/cancel-enrichment`);
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(errorData.message || "Failed to cancel enrichment");
    }
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleCancelSync = async (jobId: string) => {
    const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${jobId}/cancel`);
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(errorData.message || "Failed to cancel sync");
    }
    toast({
      title: "Sync cancelled",
      description: "The CDC data sync has been stopped.",
      variant: "default",
    });
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleResumeSync = async (jobId: string) => {
    const job = cdcJobs?.find(j => j.id === jobId);
    if (!job) return;
    const res = await apiRequest("POST", "/api/scrapers/cdc-syncs/trigger", { year: job.year });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(errorData.message || "Failed to resume sync");
    }
    toast({
      title: "Sync resumed",
      description: `Resuming CDC data sync for ${job.year}.`,
      variant: "success",
    });
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleRestartSync = async (jobId: string) => {
    const job = cdcJobs?.find(j => j.id === jobId);
    if (!job) return;
    try {
      await apiRequest("DELETE", `/api/scrapers/cdc-syncs/${jobId}`);
    } catch {}
    const res = await apiRequest("POST", "/api/scrapers/cdc-syncs/trigger", { year: job.year });
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
      throw new Error(errorData.message || "Failed to restart sync");
    }
    toast({
      title: "Sync restarted",
      description: `Restarting CDC data sync for ${job.year} from scratch.`,
      variant: "success",
    });
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleSyncLatest = async () => {
    setSyncError(null);
    setIsSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/scrapers/cdc-syncs/sync-latest");
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(errorData.message || `Request failed with status ${res.status}`);
      }
      const data = await res.json();
      toast({
        title: "Sync started",
        description: `Syncing CDC data for ${data.latestYear || "latest year"}.`,
        variant: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
    } catch (err: any) {
      setSyncError(friendlySyncError(err.message || ""));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mb-8" data-testid="section-cdc-sync">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading" data-testid="heading-cdc-sync">CDC API Sync</h2>
        </div>
        <Button
          onClick={handleSyncLatest}
          disabled={isSubmitting}
          data-testid="button-sync-cdc-latest"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Database className="w-4 h-4 mr-1" />
          )}
          Sync CDC Data
        </Button>
      </div>

      <Card className="overflow-hidden">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap w-[18%] px-2 sm:px-4">Year</TableHead>
              <TableHead className="whitespace-nowrap w-[10%] hidden sm:table-cell">Clinics</TableHead>
              <TableHead className="whitespace-nowrap w-[22%] hidden md:table-cell">Started</TableHead>
              <TableHead className="whitespace-nowrap w-[22%] hidden md:table-cell">Completed</TableHead>
              <TableHead className="whitespace-nowrap w-[28%] px-2 sm:px-4">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cdcLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
                </TableCell>
              </TableRow>
            ) : !cdcJobs || cdcJobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground" data-testid="text-cdc-no-jobs">
                  No CDC sync jobs yet. Click "Sync CDC Data" to fetch the latest data from the CDC.
                </TableCell>
              </TableRow>
            ) : (
              cdcJobs.map((job) => (
                <TableRow key={job.id} data-testid={`row-cdc-job-${job.id}`}>
                  <TableCell className="font-ui px-2 sm:px-4" data-testid={`text-cdc-year-${job.id}`}>{job.year}</TableCell>
                  <TableCell className="hidden sm:table-cell" data-testid={`text-cdc-clinics-${job.id}`}>
                    {job.clinicsProcessed.toLocaleString()}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {formatDateTime(job.startedAt)}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {formatDateTime(job.completedAt)}
                  </TableCell>
                  <TableCell className="min-w-0 px-2 sm:px-4">
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <CdcSyncStatusCell job={job} onCancel={handleCancelSync} onResume={handleResumeSync} onRestart={handleRestartSync} />
                      </div>
                      {(job.status === "FAILED" || job.status === "COMPLETED") && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                          onClick={() => handleDeleteJob(job.id)}
                          data-testid={`button-delete-cdc-job-${job.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                    {deleteErrors[job.id] && (
                      <span className="text-[10px] text-destructive" data-testid={`text-delete-error-${job.id}`}>
                        {deleteErrors[job.id]}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
      {syncError && (
        <p className="text-xs text-destructive mt-2" data-testid="text-sync-error">
          {syncError}
        </p>
      )}

      {cdcJobs && cdcJobs.some(j => j.status === "COMPLETED") && (
        <>
          <div className="flex items-center justify-between mt-8 mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-lg font-heading font-semibold" data-testid="heading-clinic-enrichment">Clinic Enrichment</h2>
            </div>
            {cdcJobs.some(j => j.status === "COMPLETED" && (!j.enrichmentStatus || j.enrichmentStatus === "FAILED")) && (
              <Button
                onClick={() => {
                  const job = cdcJobs.find(j => j.status === "COMPLETED" && (!j.enrichmentStatus || j.enrichmentStatus === "FAILED"));
                  if (job) {
                    if (!job.enrichmentStatus) {
                      handleTriggerEnrichment(job.id);
                    } else {
                      handleRestartEnrichment(job.id);
                    }
                  }
                }}
                data-testid="button-start-enrichment"
              >
                <Sparkles className="w-4 h-4 mr-1" />
                Start Enrichment
              </Button>
            )}
          </div>
          <Card className="overflow-hidden">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap w-[18%] px-2 sm:px-4">Year</TableHead>
                  <TableHead className="whitespace-nowrap w-[10%] hidden sm:table-cell">Clinics</TableHead>
                  <TableHead className="whitespace-nowrap w-[22%] hidden md:table-cell">Started</TableHead>
                  <TableHead className="whitespace-nowrap w-[22%] hidden md:table-cell">Completed</TableHead>
                  <TableHead className="whitespace-nowrap w-[28%] px-2 sm:px-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cdcJobs.filter(j => j.status === "COMPLETED").map((job) => (
                  <TableRow key={`enrich-${job.id}`} data-testid={`row-enrichment-${job.id}`}>
                    <TableCell className="font-ui px-2 sm:px-4">{job.year}</TableCell>
                    <TableCell className="hidden sm:table-cell text-sm" data-testid={`text-enrichment-clinics-${job.id}`}>
                      {job.enrichmentTotal > 0 ? (
                        <span>{job.enrichmentProcessed} / {job.enrichmentTotal}</span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                      {job.enrichmentStatus && job.enrichmentStatus !== "PENDING" ? formatDateTime(job.startedAt) : "-"}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                      {job.enrichmentStatus === "COMPLETED" ? formatDateTime(job.completedAt) : "-"}
                    </TableCell>
                    <TableCell className="min-w-0 px-2 sm:px-4" data-testid={`cell-enrichment-status-${job.id}`}>
                      <div className="hidden sm:block">
                        <CdcEnrichmentCell job={job} onTrigger={handleTriggerEnrichment} onRestart={handleRestartEnrichment} onCancel={handleCancelEnrichment} />
                      </div>
                      <div className="sm:hidden">
                        <CdcEnrichmentCell job={job} onTrigger={handleTriggerEnrichment} onRestart={handleRestartEnrichment} onCancel={handleCancelEnrichment} compact />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

const TYPE_LABELS: Record<string, string> = {
  "egg-donor": "Egg Donation Agencies",
  surrogate: "Surrogacy Agencies",
  "sperm-donor": "Sperm Banks",
};

const TYPE_ORDER = ["egg-donor", "surrogate", "sperm-donor"];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function SyncProgressBar({ progress }: { progress: SyncProgress }) {
  const percentage = progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  return (
    <div className="w-full min-w-[140px]" data-testid="sync-progress-bar">
      <div className="flex items-center gap-2 mb-1">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
        <span className="text-xs font-ui text-primary">
          Syncing... {percentage}%
        </span>
      </div>
      <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
        <div
          className="bg-primary h-2 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${percentage}%` }}
          data-testid="progress-bar-fill"
        />
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">
        {progress.processed} / {progress.total} profiles
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  progress,
  lastSyncStartedAt,
  lastSyncEndedAt,
}: {
  status: string;
  progress?: SyncProgress | null;
  lastSyncStartedAt?: string | null;
  lastSyncEndedAt?: string | null;
}) {
  if (progress) {
    return <SyncProgressBar progress={progress} />;
  }

  // Running: started but not ended (and no live progress in memory)
  const isStuck = lastSyncStartedAt && !lastSyncEndedAt;
  if (isStuck) {
    return (
      <Badge className="bg-primary/10 text-primary hover:bg-primary/15 gap-1 cursor-pointer transition-colors" data-testid="badge-status-running">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Running
      </Badge>
    );
  }

  if (status === "SUCCESS") {
    return (
      <Badge className="bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success)/0.2)] gap-1 cursor-pointer transition-colors" data-testid="badge-status-success">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Successful
      </Badge>
    );
  }
  if (status === "PARTIAL") {
    return (
      <Badge className="bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] hover:bg-[hsl(var(--brand-warning)/0.2)] gap-1 cursor-pointer transition-colors" data-testid="badge-status-partial">
        <AlertTriangle className="w-3.5 h-3.5" />
        Partial
      </Badge>
    );
  }
  if (status === "FAILED") {
    return (
      <Badge className="bg-destructive/15 text-destructive hover:bg-destructive/20 gap-1 cursor-pointer transition-colors" data-testid="badge-status-failed">
        <XCircle className="w-3.5 h-3.5" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge className="bg-muted text-foreground hover:bg-muted gap-1 cursor-pointer transition-colors" data-testid="badge-status-pending">
      <Clock className="w-3.5 h-3.5" />
      {status}
    </Badge>
  );
}

function getValue(item: ScraperSummary, key: string): string | number | null {
  switch (key) {
    case "providerName": return item.providerName;
    case "syncStatus": return item.syncStatus;
    case "totalProfiles": return item.totalProfiles;
    case "totalErrors": return item.totalErrors;
    case "lastSyncAt": return item.lastSyncAt || null;
    case "latestDonorCreatedAt": return item.latestDonorCreatedAt || null;
    default: return null;
  }
}

function RestartSyncButton({ item }: { item: ScraperSummary }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isRestarting, setIsRestarting] = useState(false);

  const handleRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRestarting(true);
    try {
      await apiRequest("POST", `/api/scrapers/trigger-sync/${item.providerId}/${item.type}`);
      toast({ title: "Sync started", description: `Restarting sync for ${item.providerName}`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/summary"] });
    } catch (err: any) {
      const msg = err?.message || "Failed to start sync";
      toast({ title: "Error", description: /already running/i.test(msg) ? "A sync is already running for this provider" : msg, variant: "destructive" });
    } finally {
      setIsRestarting(false);
    }
  };

  if (item.syncProgress) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-5 text-[11px] px-1 gap-0.5 shrink-0"
      onClick={handleRestart}
      disabled={isRestarting}
      data-testid={`button-restart-sync-${item.providerId}`}
      title={`Restart sync for ${item.providerName}`}
    >
      {isRestarting ? (
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
      ) : (
        <RotateCcw className="w-2.5 h-2.5" />
      )}
      Restart
    </Button>
  );
}

function ScraperTypeSection({
  type,
  items,
  onRowClick,
  headerAction,
}: {
  type: string;
  items: ScraperSummary[];
  onRowClick: (item: ScraperSummary) => void;
  headerAction?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { sortConfig, handleSort, sortData } = useTableSort("providerName", "asc");
  const sorted = sortData(items, getValue);

  return (
    <div className="mb-8" data-testid={`section-${type}`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-heading" data-testid={`heading-${type}`}>{TYPE_LABELS[type] || type}</h2>
        {headerAction}
      </div>
      <Card className="overflow-hidden">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <SortableTableHead
                label="Agency"
                sortKey="providerName"
                currentSort={sortConfig}
                onSort={handleSort}
                className="whitespace-nowrap w-[18%]"
              />
              <SortableTableHead
                label="Profiles"
                sortKey="totalProfiles"
                currentSort={sortConfig}
                onSort={handleSort}
                className="whitespace-nowrap w-[10%] hidden sm:table-cell"
              />
              <SortableTableHead
                label="Started"
                sortKey="lastSyncStartedAt"
                currentSort={sortConfig}
                onSort={handleSort}
                className="whitespace-nowrap w-[22%] hidden md:table-cell"
              />
              <SortableTableHead
                label="Completed"
                sortKey="lastSyncEndedAt"
                currentSort={sortConfig}
                onSort={handleSort}
                className="whitespace-nowrap w-[22%] hidden md:table-cell"
              />
              <SortableTableHead
                label="Status"
                sortKey="syncStatus"
                currentSort={sortConfig}
                onSort={handleSort}
                className="whitespace-nowrap w-[28%]"
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  No sync configurations found
                </TableCell>
              </TableRow>
            ) : (
              sorted.map((item) => {
                const key = `${item.providerId}-${item.type}`;
                return (
                  <TableRow
                    key={key}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => onRowClick(item)}
                    data-testid={`row-scraper-${item.providerId}`}
                  >
                    <TableCell className="font-ui whitespace-nowrap" data-testid={`text-provider-name-${item.providerId}`}>
                      <div className="flex items-center gap-2">
                        {item.providerName}
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell" data-testid={`text-total-profiles-${item.providerId}`}>
                      {item.totalProfiles}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground" data-testid={`text-started-${item.providerId}`}>
                      {formatDateTime(item.lastSyncStartedAt)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground" data-testid={`text-completed-${item.providerId}`}>
                      {/* Show lastSyncAt (actual last success), falling back to lastSyncEndedAt if completed recently */}
                      {formatDateTime(item.lastSyncAt || item.lastSyncEndedAt)}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1">
                          <div
                            className="inline-block"
                            onClick={() => navigate(`/admin/scrapers/report/${item.providerId}/${item.type}?name=${encodeURIComponent(item.providerName)}`)}
                            data-testid={`status-click-${item.providerId}`}
                          >
                            <StatusBadge
                              status={item.syncStatus}
                              progress={item.syncProgress}
                              lastSyncStartedAt={item.lastSyncStartedAt}
                              lastSyncEndedAt={item.lastSyncEndedAt}
                            />
                          </div>
                          <RestartSyncButton item={item} />
                        </div>
                        {(() => {
                          const errorCount = item.totalErrors || item.syncProgress?.failed || 0;
                          return errorCount > 0 ? (
                            <span className="text-[10px] text-destructive" data-testid={`text-total-errors-${item.providerId}`}>
                              {errorCount} {errorCount === 1 ? "error" : "errors"}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

export default function ScrapersSummaryPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [nightlyError, setNightlyError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<SummaryResponse>({
    queryKey: ["/api/scrapers/summary"],
    refetchInterval: (query) => {
      const d = query.state.data as SummaryResponse | undefined;
      const hasActiveSync = d?.nightlySyncRunning || d?.summaries?.some(s => s.syncProgress);
      return hasActiveSync ? 3000 : 30000;
    },
  });

  const triggerNightlyMut = useMutation({
    mutationFn: async () => {
      setNightlyError(null);
      const res = await apiRequest("POST", "/api/scrapers/trigger-nightly");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Nightly sync started", description: "All providers will be synced sequentially.", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/summary"] });
    },
    onError: () => {
      setNightlyError("Could not start sync. Please try again.");
      setTimeout(() => setNightlyError(null), 5000);
    },
  });

  const handleRowClick = (item: ScraperSummary) => {
    navigate(`/admin/providers/${item.providerId}?tab=egg-donors`);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const summaries = data?.summaries || [];
  const grouped: Record<string, ScraperSummary[]> = {};
  for (const type of TYPE_ORDER) {
    const items = summaries.filter((s) => s.type === type);
    if (items.length > 0) {
      grouped[type] = items;
    }
  }

  const totalProviders = summaries.length;
  const totalProfiles = summaries.reduce((a, b) => a + b.totalProfiles, 0);
  const successCount = summaries.filter((s) => s.syncStatus === "SUCCESS").length;
  const failedCount = summaries.filter((s) => s.syncStatus === "FAILED" || s.syncStatus === "PARTIAL").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-3xl font-heading text-primary" data-testid="heading-scrapers-summary">Scrapers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Nightly sync runs at 2:00 AM ET
            {data?.lastNightlySyncAt && (
              <> · Last run: {formatDateTime(data.lastNightlySyncAt)}</>
            )}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 md:gap-4 mb-6">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading" data-testid="text-total-providers">{totalProviders}</div>
            <div className="text-xs text-muted-foreground">Scrapers Configured</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading" data-testid="text-total-profiles">{totalProfiles.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">Total Profiles</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading text-[hsl(var(--brand-success))]" data-testid="text-successful-count">{successCount}</div>
            <div className="text-xs text-muted-foreground">Successful</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading text-destructive" data-testid="text-failed-count">{failedCount}</div>
            <div className="text-xs text-muted-foreground">Failed / Partial</div>
          </CardContent>
        </Card>
      </div>

      <CdcSyncSection />

      {Object.keys(grouped).length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No scraper configurations found. Configure sync on individual provider pages.
          </CardContent>
        </Card>
      ) : (
        Object.entries(grouped).map(([type, items]) => (
          <ScraperTypeSection
            key={type}
            type={type}
            items={items}
            onRowClick={handleRowClick}
            headerAction={type === "egg-donor" ? (
              <div className="flex flex-col items-end gap-1">
                <Button
                  onClick={() => triggerNightlyMut.mutate()}
                  disabled={triggerNightlyMut.isPending || data?.nightlySyncRunning}
                  data-testid="button-trigger-nightly"
                >
                  {triggerNightlyMut.isPending || data?.nightlySyncRunning ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-2" />
                  )}
                  {data?.nightlySyncRunning ? "Sync Running..." : "Run All Egg Donor Scrapers"}
                </Button>
                {nightlyError && (
                  <span className="text-xs text-destructive" data-testid="text-nightly-error">
                    {nightlyError}
                  </span>
                )}
              </div>
            ) : undefined}
          />
        ))
      )}
    </div>
  );
}
