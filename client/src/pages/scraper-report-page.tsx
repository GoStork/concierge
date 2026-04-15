import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, RotateCcw, Square, Trash2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminReportLayout } from "@/components/admin-report-layout";
import { SyncReportContent, type SyncReport } from "@/components/sync-report-content";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const TYPE_LABELS: Record<string, string> = {
  "egg-donor": "Egg Donor",
  surrogate: "Surrogate",
  "sperm-donor": "Sperm Donor",
};

interface SyncProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
}

interface ProviderSummary {
  providerId: string;
  type: string;
  syncStatus: string;
  syncProgress?: SyncProgress | null;
}

interface SummaryResponse {
  summaries: ProviderSummary[];
}

function SyncProgressBar({ progress }: { progress: SyncProgress }) {
  const percentage = progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  return (
    <div className="w-full" data-testid="report-sync-progress">
      <div className="flex items-center gap-2 mb-1.5">
        <Loader2 className="w-4 h-4 animate-spin text-primary" />
        <span className="text-sm font-ui text-primary">
          Syncing... {percentage}%
        </span>
      </div>
      <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
        <div
          className="bg-primary h-2.5 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${percentage}%` }}
          data-testid="report-progress-bar-fill"
        />
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        {progress.processed} / {progress.total} profiles
        {progress.failed > 0 && ` · ${progress.failed} failed`}
      </div>
    </div>
  );
}

export default function ScraperReportPage() {
  const { providerId, type } = useParams<{ providerId: string; type: string }>();
  const [searchParams] = useSearchParams();
  const providerName = searchParams.get("name") || "Provider";
  const typeLabel = TYPE_LABELS[type || ""] || type || "Scraper";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isRestarting, setIsRestarting] = useState(false);
  const [isTestSyncing, setIsTestSyncing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const { data, isLoading } = useQuery<SyncReport>({
    queryKey: ["/api/scrapers/report", providerId, type],
    queryFn: async () => {
      const res = await fetch(`/api/scrapers/report/${providerId}/${type}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
    enabled: !!providerId && !!type,
    refetchInterval: (query) => {
      const d = query.state.data as SyncReport | undefined;
      const isRunning = d?.lastSyncStartedAt && !d?.lastSyncEndedAt;
      // Fast refresh while running, slow background refresh otherwise so new
      // auto-resume or nightly syncs are detected without a manual page reload
      return isRunning ? 3000 : 15000;
    },
  });

  const { data: summaryData } = useQuery<SummaryResponse>({
    queryKey: ["/api/scrapers/summary"],
    refetchInterval: (query) => {
      const d = query.state.data as SummaryResponse | undefined;
      const thisProvider = d?.summaries?.find(
        (s) => s.providerId === providerId && s.type === type
      );
      return thisProvider?.syncProgress ? 2000 : 30000;
    },
  });

  const providerSummary = summaryData?.summaries?.find(
    (s) => s.providerId === providerId && s.type === type
  );
  const syncProgress = providerSummary?.syncProgress;
  const isSyncing = !!syncProgress;

  const handleRestart = async (limit?: number) => {
    if (!providerId || !type) return;
    const isTest = !!limit;
    if (isTest) setIsTestSyncing(true); else setIsRestarting(true);
    try {
      const url = limit
        ? `/api/scrapers/trigger-sync/${providerId}/${type}?limit=${limit}`
        : `/api/scrapers/trigger-sync/${providerId}/${type}`;
      await apiRequest("POST", url);
      toast({
        title: isTest ? "Test sync started" : "Sync started",
        description: isTest ? `Syncing ${limit} profiles for ${providerName}` : `Restarting sync for ${providerName}`,
        variant: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/report", providerId, type] });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/summary"] });
    } catch (err: any) {
      const msg = err?.message || "Failed to start sync";
      toast({ title: "Error", description: /already running/i.test(msg) ? "A sync is already running for this provider" : msg, variant: "destructive" });
    } finally {
      if (isTest) setIsTestSyncing(false); else setIsRestarting(false);
    }
  };

  const handleStop = async () => {
    if (!providerId || !type) return;
    setIsStopping(true);
    try {
      await apiRequest("POST", `/api/scrapers/stop-sync/${providerId}/${type}`);
      toast({ title: "Sync stopped", description: `Stopped sync for ${providerName}`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/report", providerId, type] });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/summary"] });
    } catch (err: any) {
      const msg = err?.message || "Failed to stop sync";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setIsStopping(false);
    }
  };

  const handleDelete = async () => {
    if (!providerId || !type) return;
    setIsDeleting(true);
    try {
      const res = await apiRequest("DELETE", `/api/scrapers/donors/${providerId}/${type}`);
      const result = await res.json();
      toast({ title: `${typeLabel}s deleted`, description: `Deleted ${result.count} ${typeLabel.toLowerCase()} profiles`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/report", providerId, type] });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/summary"] });
    } catch (err: any) {
      const msg = err?.message || "Failed to delete donors";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AdminReportLayout
      breadcrumbs={[
        { label: "Scrapers", href: "/admin/scrapers" },
        { label: providerName, href: "/admin/scrapers" },
        { label: `${typeLabel} Report` },
      ]}
      title={`${typeLabel} Sync Report`}
      subtitle={providerName}
    >
      <div className="flex items-center gap-2" data-testid="sync-report-actions">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => handleRestart()}
          disabled={isRestarting}
          data-testid="button-restart-sync-report"
        >
          {isRestarting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCcw className="w-3.5 h-3.5" />
          )}
          Restart
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => handleRestart(10)}
          disabled={isTestSyncing}
          data-testid="button-sync-10-report"
        >
          {isTestSyncing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          Sync 10 Profiles
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={handleStop}
          disabled={isStopping || !isSyncing}
          data-testid="button-stop-sync-report"
        >
          {isStopping ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Square className="w-3.5 h-3.5" />
          )}
          Stop
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
              disabled={isDeleting || isSyncing}
              data-testid="button-delete-donors"
            >
              {isDeleting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete all {typeLabel.toLowerCase()} profiles?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete all {typeLabel.toLowerCase()} profiles for {providerName} from the database. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="button-confirm-delete"
              >
                Delete All
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {isSyncing && syncProgress && (
        <SyncProgressBar progress={syncProgress} />
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : data ? (
        <SyncReportContent data={data} liveProgress={syncProgress} providerId={providerId} type={type} />
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="text-no-report">No report data available.</p>
      )}
    </AdminReportLayout>
  );
}
