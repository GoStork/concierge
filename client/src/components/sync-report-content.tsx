import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Clock, History, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export interface MissingFieldSummary {
  field: string;
  count: number;
  donorIds: string[];
  donorUrls: Record<string, string>;
}

export interface SyncLogEntry {
  id: string;
  source: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  newProfiles: number;
  staleMarked: number;
  errors: string[] | null;
}

export interface SyncReport {
  missingFields: MissingFieldSummary[];
  lastSyncErrors: string[];
  lastSyncStats: { succeeded: number; failed: number; total: number } | null;
  lastSyncAt: string | null;
  staleProfilesMarked: number;
  newProfiles: number;
  totalProfiles: number;
  lastSyncStartedAt: string | null;
  lastSyncEndedAt: string | null;
}

function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return "N/A";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return "N/A";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function formatDateTimeShort(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const SOURCE_LABEL: Record<string, string> = {
  nightly: "Nightly (2 AM)",
  manual: "Manual",
  "auto-resume": "Auto-resumed",
};

function SyncLogHistory({ providerId, type }: { providerId: string; type: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data: logs, isLoading } = useQuery<SyncLogEntry[]>({
    queryKey: ["/api/scrapers/sync-logs", providerId, type],
    queryFn: async () => {
      const res = await fetch(`/api/scrapers/sync-logs/${providerId}/${type}?limit=10`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load sync logs");
      return res.json();
    },
    enabled: !!providerId && !!type,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading run history...
      </div>
    );
  }

  if (!logs || logs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">No run history yet - history is recorded from this point forward.</p>
    );
  }

  const visibleLogs = expanded ? logs : logs.slice(0, 3);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left px-3 py-2 font-ui text-muted-foreground text-xs">Started</th>
              <th className="text-left px-3 py-2 font-ui text-muted-foreground text-xs">Source</th>
              <th className="text-left px-3 py-2 font-ui text-muted-foreground text-xs">Result</th>
              <th className="text-right px-3 py-2 font-ui text-muted-foreground text-xs">Synced</th>
              <th className="text-right px-3 py-2 font-ui text-muted-foreground text-xs">Skipped</th>
              <th className="text-right px-3 py-2 font-ui text-muted-foreground text-xs">New</th>
              <th className="text-right px-3 py-2 font-ui text-muted-foreground text-xs">Inactive</th>
              <th className="text-right px-3 py-2 font-ui text-muted-foreground text-xs">Errors</th>
              <th className="text-right px-3 py-2 font-ui text-muted-foreground text-xs">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibleLogs.map((log) => {
              const isRunning = !log.completedAt;
              const hasFailed = log.failed > 0 || log.status === "failed";
              const errors = log.errors || [];
              return (
                <tr key={log.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                    {formatDateTimeShort(log.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-xs text-foreground/70">
                    {SOURCE_LABEL[log.source] || log.source}
                  </td>
                  <td className="px-3 py-2">
                    {isRunning ? (
                      <span className="inline-flex items-center gap-1 text-xs text-primary">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Running
                      </span>
                    ) : log.status === "completed" && !hasFailed ? (
                      <span className="inline-flex items-center gap-1 text-xs text-[hsl(var(--brand-success))]">
                        <CheckCircle2 className="w-3 h-3" />
                        Completed
                      </span>
                    ) : log.status === "completed" && hasFailed ? (
                      <span className="inline-flex items-center gap-1 text-xs text-[hsl(var(--brand-warning))]">
                        <AlertTriangle className="w-3 h-3" />
                        Partial
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-destructive">
                        <XCircle className="w-3 h-3" />
                        Failed
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-right font-heading">{log.succeeded || "-"}</td>
                  <td className="px-3 py-2 text-xs text-right text-muted-foreground">{log.skipped || "-"}</td>
                  <td className="px-3 py-2 text-xs text-right text-[hsl(var(--brand-success))]">{log.newProfiles > 0 ? `+${log.newProfiles}` : "-"}</td>
                  <td className="px-3 py-2 text-xs text-right text-muted-foreground">{log.staleMarked > 0 ? log.staleMarked : "-"}</td>
                  <td className="px-3 py-2 text-xs text-right">
                    {errors.length > 0 ? (
                      <span className="text-destructive font-heading" title={errors.join("\n")}>{errors.length}</span>
                    ) : "-"}
                  </td>
                  <td className="px-3 py-2 text-xs text-right text-muted-foreground whitespace-nowrap">
                    {formatDuration(log.startedAt, log.completedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Error details for failed runs */}
      {visibleLogs.some((l) => l.errors && l.errors.length > 0) && (
        <div className="space-y-1.5">
          {visibleLogs.filter((l) => l.errors && l.errors.length > 0).slice(0, 2).map((log) => (
            <div key={log.id} className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] px-3 py-2">
              <div className="text-xs font-ui text-destructive mb-1">{formatDateTimeShort(log.startedAt)} - {SOURCE_LABEL[log.source] || log.source} errors:</div>
              {(log.errors || []).map((err, i) => (
                <div key={i} className="text-xs text-destructive/80">{err}</div>
              ))}
            </div>
          ))}
        </div>
      )}

      {logs.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? "Show less" : `Show ${logs.length - 3} more runs`}
        </button>
      )}
    </div>
  );
}

export function SyncReportContent({
  data,
  liveProgress,
  providerId,
  type,
}: {
  data: SyncReport;
  liveProgress?: { total: number; processed: number; succeeded: number; failed: number } | null;
  providerId?: string;
  type?: string;
}) {
  const duration = formatDuration(data.lastSyncStartedAt, data.lastSyncEndedAt);
  const isCurrentlyRunning = !!(data.lastSyncStartedAt && !data.lastSyncEndedAt);

  // Build a human-readable status banner for the last completed run
  const buildStatusMessage = () => {
    if (isCurrentlyRunning && liveProgress) {
      const pct = liveProgress.total > 0 ? Math.round((liveProgress.processed / liveProgress.total) * 100) : 0;
      return {
        type: "running" as const,
        text: `Sync in progress - ${pct}% complete (${liveProgress.processed} / ${liveProgress.total} profiles)`,
      };
    }
    if (isCurrentlyRunning) {
      return { type: "running" as const, text: "Sync is in progress. This page will update automatically." };
    }
    if (!data.lastSyncEndedAt && !data.lastSyncAt) {
      return { type: "pending" as const, text: "No sync has completed yet for this provider." };
    }
    const errors = data.lastSyncErrors || [];
    const stats = data.lastSyncStats;
    if (errors.length > 0 && (!stats || stats.succeeded === 0)) {
      return { type: "failed" as const, text: `Last run failed: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}` };
    }
    if (errors.length > 0 || (stats && stats.failed > 0)) {
      const dur = duration !== "N/A" ? ` in ${duration}` : "";
      return {
        type: "partial" as const,
        text: `Last run completed with ${stats?.failed || errors.length} error(s)${dur}. ${stats?.succeeded ?? 0} profiles synced successfully.`,
      };
    }
    const dur = duration !== "N/A" ? ` in ${duration}` : "";
    const newNote = data.newProfiles > 0 ? ` ${data.newProfiles} new profiles added.` : "";
    const inactiveNote = data.staleProfilesMarked > 0 ? ` ${data.staleProfilesMarked} profiles marked inactive.` : "";
    return {
      type: "success" as const,
      text: `Last run completed successfully${dur}. ${stats?.succeeded ?? data.totalProfiles} profiles synced.${newNote}${inactiveNote}`,
    };
  };

  const statusMsg = buildStatusMessage();

  const statusStyles = {
    success: "bg-[hsl(var(--brand-success)/0.08)] border-[hsl(var(--brand-success)/0.25)] text-[hsl(var(--brand-success))]",
    partial: "bg-[hsl(var(--brand-warning)/0.08)] border-[hsl(var(--brand-warning)/0.25)] text-[hsl(var(--brand-warning))]",
    failed: "bg-destructive/5 border-destructive/25 text-destructive",
    running: "bg-primary/5 border-primary/25 text-primary",
    pending: "bg-muted border-border text-muted-foreground",
  };
  const StatusIcon = {
    success: CheckCircle2,
    partial: AlertTriangle,
    failed: XCircle,
    running: Loader2,
    pending: Clock,
  }[statusMsg.type];

  return (
    <div className="space-y-6">
      {/* Status banner */}
      <div className={`flex items-start gap-2.5 rounded-[var(--radius)] border px-4 py-3 ${statusStyles[statusMsg.type]}`} data-testid="sync-status-banner">
        <StatusIcon className={`w-4 h-4 mt-0.5 shrink-0 ${statusMsg.type === "running" ? "animate-spin" : ""}`} />
        <span className="text-sm font-ui">{statusMsg.text}</span>
      </div>

      {/* Stat cards */}
      {(data.lastSyncStats || liveProgress) && (
        <div className="grid gap-2 md:gap-4 grid-cols-5" data-testid="sync-stats">
          <Card data-testid="stat-total-profiles">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-heading">{(data.totalProfiles || 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Total Profiles</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-profiles-processed">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-heading">{(liveProgress?.succeeded ?? data.lastSyncStats?.succeeded ?? 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Profiles Synced</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-new-profiles">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-heading">{(data.newProfiles || 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">New Profiles</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-deleted-profiles">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-heading">{(data.staleProfilesMarked || 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground">Marked Inactive</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-duration">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="text-2xl font-heading">{duration}</div>
              <div className="text-xs text-muted-foreground">Duration</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Error details from last in-memory run */}
      {data.lastSyncErrors.length > 0 && (
        <div className="space-y-2" data-testid="sync-errors-section">
          <h4 className="text-sm font-ui text-destructive flex items-center gap-1">
            <XCircle className="w-4 h-4" />
            Sync Errors ({data.lastSyncErrors.length})
          </h4>
          <div className="bg-destructive/5 rounded-[var(--radius)] border border-destructive/20 p-3">
            {data.lastSyncErrors.map((err, i) => (
              <div key={i} className="text-xs text-destructive py-0.5" data-testid={`sync-error-${i}`}>
                {err}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run history from DB */}
      {providerId && type && (
        <div className="space-y-2" data-testid="sync-log-history">
          <h4 className="text-sm font-ui text-foreground flex items-center gap-1.5">
            <History className="w-4 h-4 text-muted-foreground" />
            Run History
          </h4>
          <Card>
            <CardContent className="pt-3 pb-3 px-0">
              <SyncLogHistory providerId={providerId} type={type} />
            </CardContent>
          </Card>
        </div>
      )}

      {data.missingFields.length > 0 ? (
        <div className="space-y-2" data-testid="missing-fields-section">
          <h4 className="text-sm font-ui text-warning flex items-center gap-1">
            <AlertTriangle className="w-4 h-4" />
            Missing Mandatory Fields ({data.missingFields.length} fields incomplete)
          </h4>
          <Card className="rounded-[var(--radius)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-warning/5 dark:bg-warning/10">
                <tr>
                  <th className="text-left px-3 py-2 font-ui text-warning dark:text-warning/80">Field</th>
                  <th className="text-right px-3 py-2 font-ui text-warning dark:text-warning/80 w-24">Missing</th>
                  <th className="text-left px-3 py-2 font-ui text-warning dark:text-warning/80 hidden sm:table-cell">Donor IDs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.missingFields.map((mf, i) => (
                  <tr key={i} className="hover:bg-muted/50" data-testid={`missing-field-row-${i}`}>
                    <td className="px-3 py-2 font-ui text-foreground/80">{mf.field}</td>
                    <td className="px-3 py-2 text-right">
                      <span className="inline-flex items-center justify-center min-w-[28px] px-2 py-0.5 rounded-full text-xs font-heading bg-warning/10 text-warning dark:bg-warning/20 dark:text-warning/80">
                        {mf.count}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">
                      {data.totalProfiles > 0 && mf.count >= data.totalProfiles ? (
                        <span className="text-sm italic" data-testid={`all-donors-${i}`}>All Donors</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {mf.donorIds.map((id, j) => {
                            const url = mf.donorUrls?.[id];
                            return url ? (
                              <a
                                key={j}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline text-primary hover:text-primary/80"
                                data-testid={`donor-link-${id}`}
                              >
                                {id}{j < mf.donorIds.length - 1 ? "," : ""}
                              </a>
                            ) : (
                              <span key={j} data-testid={`donor-id-${id}`}>
                                {id}{j < mf.donorIds.length - 1 ? "," : ""}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-success bg-success/5 dark:bg-success/10 rounded-[var(--radius)] p-4 border border-success/20 dark:border-success/30" data-testid="no-missing-fields">
          <CheckCircle2 className="w-5 h-5" />
          <span className="text-sm font-ui">All mandatory fields are complete across all profiles.</span>
        </div>
      )}
    </div>
  );
}

export function SyncReportFetcher({ providerId, type }: { providerId: string; type: string }) {
  const { data, isLoading } = useQuery<SyncReport>({
    queryKey: ["/api/scrapers/report", providerId, type],
    queryFn: async () => {
      const res = await fetch(`/api/scrapers/report/${providerId}/${type}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
      </div>
    );
  }

  if (!data) return null;

  return <SyncReportContent data={data} />;
}
