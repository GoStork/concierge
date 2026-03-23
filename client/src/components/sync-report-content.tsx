import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, AlertTriangle, Loader2, BarChart3, Plus, Trash2, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export interface MissingFieldSummary {
  field: string;
  count: number;
  donorIds: string[];
  donorUrls: Record<string, string>;
}

export interface SyncReport {
  missingFields: MissingFieldSummary[];
  lastSyncErrors: string[];
  lastSyncStats: { succeeded: number; failed: number; total: number } | null;
  lastSyncAt: string | null;
  staleDonorsMarked: number;
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
  return `${minutes}m ${seconds}s`;
}

export function SyncReportContent({ data, liveProgress }: { data: SyncReport; liveProgress?: { total: number; processed: number; succeeded: number; failed: number } | null }) {
  const duration = formatDuration(data.lastSyncStartedAt, data.lastSyncEndedAt);

  return (
    <div className="space-y-4">
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
              <div className="text-2xl font-heading">{(data.staleDonorsMarked || 0).toLocaleString()}</div>
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

      {data.lastSyncErrors.length > 0 && (
        <div className="space-y-2" data-testid="sync-errors-section">
          <h4 className="text-sm font-ui text-error flex items-center gap-1">
            <XCircle className="w-4 h-4" />
            Sync Errors ({data.lastSyncErrors.length})
          </h4>
          <div className="bg-error/5 dark:bg-error/10 rounded-lg border border-error/20 dark:border-error/30 p-3">
            {data.lastSyncErrors.map((err, i) => (
              <div key={i} className="text-xs text-error dark:text-error/80 py-0.5" data-testid={`sync-error-${i}`}>
                {err}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.missingFields.length > 0 ? (
        <div className="space-y-2" data-testid="missing-fields-section">
          <h4 className="text-sm font-ui text-warning flex items-center gap-1">
            <AlertTriangle className="w-4 h-4" />
            Missing Mandatory Fields ({data.missingFields.length} fields incomplete)
          </h4>
          <Card className="rounded-lg">
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
        <div className="flex items-center gap-2 text-success bg-success/5 dark:bg-success/10 rounded-lg p-4 border border-success/20 dark:border-success/30" data-testid="no-missing-fields">
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
