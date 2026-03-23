import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type ProfileType = "egg-donor" | "surrogate" | "sperm-donor";

interface SyncConfigData {
  syncStatus: string;
  lastSyncAt: string | null;
}

interface ProviderScraperStatsProps {
  providerId: string;
  types: ProfileType[];
  showRunButton?: boolean;
}

const TYPE_ENDPOINTS: Record<ProfileType, string> = {
  "egg-donor": "egg-donors",
  surrogate: "surrogates",
  "sperm-donor": "sperm-donors",
};

const TYPE_LABELS: Record<ProfileType, string> = {
  "egg-donor": "Egg Donors",
  surrogate: "Surrogates",
  "sperm-donor": "Sperm Donors",
};

function StatusBadge({ status }: { status: string }) {
  if (status === "SUCCESS") {
    return (
      <Badge className="bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] hover:bg-[hsl(var(--brand-success)/0.12)] gap-1">
        <CheckCircle2 className="w-3 h-3" /> Successful
      </Badge>
    );
  }
  if (status === "PARTIAL") {
    return (
      <Badge className="bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] hover:bg-[hsl(var(--brand-warning)/0.12)] gap-1">
        <AlertTriangle className="w-3 h-3" /> Partial
      </Badge>
    );
  }
  if (status === "FAILED") {
    return (
      <Badge className="bg-destructive/15 text-destructive hover:bg-destructive/15 gap-1">
        <XCircle className="w-3 h-3" /> Failed
      </Badge>
    );
  }
  return (
    <Badge className="bg-muted text-foreground hover:bg-muted gap-1">
      <Clock className="w-3 h-3" /> {status}
    </Badge>
  );
}

export default function ProviderScraperStats({ providerId, types, showRunButton = false }: ProviderScraperStatsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const statsQueries = types.map((type) => {
    const configQ = useQuery<SyncConfigData | null>({
      queryKey: [`/api/providers/${providerId}/sync-config/${type}`],
      queryFn: async () => {
        const res = await fetch(`/api/providers/${providerId}/sync-config/${type}`, { credentials: "include" });
        if (!res.ok) return null;
        return res.json();
      },
    });
    const donorsQ = useQuery<any[]>({
      queryKey: [`/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`],
      queryFn: async () => {
        const res = await fetch(`/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`, { credentials: "include" });
        if (!res.ok) return [];
        return res.json();
      },
    });
    return { type, configQ, donorsQ };
  });

  const configured = statsQueries.filter((q) => q.configQ.data);
  const totalProfiles = statsQueries.reduce((sum, q) => sum + (q.donorsQ.data?.length || 0), 0);
  const syncedProfiles = statsQueries.reduce((sum, q) => sum + (q.donorsQ.data?.filter((d: any) => d.externalId && !d.externalId.startsWith("pdf-")).length || 0), 0);
  const successCount = configured.filter((q) => q.configQ.data?.syncStatus === "SUCCESS").length;
  const failedCount = configured.filter((q) => q.configQ.data?.syncStatus === "FAILED" || q.configQ.data?.syncStatus === "PARTIAL").length;
  const isLoading = statsQueries.some((q) => q.configQ.isLoading);

  const syncAllMut = useMutation({
    mutationFn: async () => {
      const results: string[] = [];
      for (const q of configured) {
        const res = await apiRequest("POST", `/api/providers/${providerId}/sync/${q.type}`);
        const data = await res.json();
        results.push(data.jobId);
      }
      return results;
    },
    onSuccess: () => {
      toast({ title: "Sync started", description: "All configured scrapers are running.", variant: "success" });
      setTimeout(() => {
        for (const type of types) {
          queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/sync-config/${type}`] });
          queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`] });
        }
      }, 5000);
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (configured.length === 0) return null;

  const lastSyncDates = configured
    .map((q) => q.configQ.data?.lastSyncAt)
    .filter(Boolean) as string[];
  const latestSync = lastSyncDates.length > 0
    ? new Date(Math.max(...lastSyncDates.map((d) => new Date(d).getTime())))
    : null;

  return (
    <div className="space-y-3 mb-6" data-testid="provider-scraper-stats">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-heading" data-testid="heading-scraper-stats">Scraper Overview</h3>
          {latestSync && (
            <p className="text-xs text-muted-foreground">
              Last sync: {latestSync.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {" at "}
              {latestSync.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
            </p>
          )}
        </div>
        {showRunButton && (
          <Button
            size="sm"
            onClick={() => syncAllMut.mutate()}
            disabled={syncAllMut.isPending}
            data-testid="button-run-provider-sync"
          >
            {syncAllMut.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-1.5" />
            )}
            Run Sync
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="pt-3 pb-2.5 px-3">
            <div className="text-xl font-heading" data-testid="text-stat-configured">{configured.length}</div>
            <div className="text-[11px] text-muted-foreground">Databases Configured</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2.5 px-3">
            <div className="text-xl font-heading" data-testid="text-stat-profiles">{totalProfiles.toLocaleString()}</div>
            <div className="text-[11px] text-muted-foreground">Total Profiles</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2.5 px-3">
            <div className="text-xl font-heading" data-testid="text-stat-synced">{syncedProfiles.toLocaleString()}</div>
            <div className="text-[11px] text-muted-foreground">Synced Profiles</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2.5 px-3">
            <div className="text-xl font-heading text-[hsl(var(--brand-success))]" data-testid="text-stat-successful">{successCount}</div>
            <div className="text-[11px] text-muted-foreground">Successful</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-2.5 px-3">
            <div className="text-xl font-heading text-destructive" data-testid="text-stat-failed">{failedCount}</div>
            <div className="text-[11px] text-muted-foreground">Failed / Partial</div>
          </CardContent>
        </Card>
      </div>

      {configured.length > 1 && (
        <div className="flex flex-wrap gap-3">
          {configured.map((q) => (
            <div key={q.type} className="flex items-center gap-2 text-xs">
              <span className="font-ui text-muted-foreground">{TYPE_LABELS[q.type]}:</span>
              <StatusBadge status={q.configQ.data?.syncStatus || "PENDING"} />
              <span className="text-muted-foreground">({q.donorsQ.data?.length || 0} profiles)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
