import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { AdminReportLayout } from "@/components/admin-report-layout";
import { SyncReportContent, type SyncReport } from "@/components/sync-report-content";
import ProfileDatabasePanel from "@/components/profile-database-panel";
import type { ProfileType } from "@/lib/profile-utils";

const TYPE_LABELS: Record<string, string> = {
  "egg-donor": "Egg Donor",
  surrogate: "Surrogate",
  "sperm-donor": "Sperm Donor",
};

const VALID_TYPES = new Set<ProfileType>(["egg-donor", "surrogate", "sperm-donor"]);

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

export default function ScraperReportPage() {
  const { providerId, type } = useParams<{ providerId: string; type: string }>();
  const [searchParams] = useSearchParams();
  const providerName = searchParams.get("name") || "Provider";
  const typeLabel = TYPE_LABELS[type || ""] || type || "Scraper";
  const isValidType = !!type && VALID_TYPES.has(type as ProfileType);

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
      {providerId && isValidType && (
        <div data-testid="scraper-report-sync-config">
          <ProfileDatabasePanel providerId={providerId} type={type as ProfileType} mode="config" />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : data ? (
        <SyncReportContent data={data} liveProgress={syncProgress} providerId={providerId} type={type} hideMissingFields />
      ) : (
        <p className="t-helper" data-testid="text-no-report">No report data available.</p>
      )}

      {providerId && isValidType && (
        <div data-testid="scraper-report-records">
          <ProfileDatabasePanel providerId={providerId} type={type as ProfileType} mode="records" />
        </div>
      )}
    </AdminReportLayout>
  );
}
