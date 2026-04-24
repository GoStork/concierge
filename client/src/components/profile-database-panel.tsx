import { useState, useEffect, useRef, useMemo } from "react";
import type { EggDonor } from "@shared/schema";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Loader2,
  Save,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Globe,
  User,
  Lock,
  Eye,
  EyeOff,
  RefreshCw,
  Pencil,
  ChevronDown,
  ChevronUp,
  Square,
  Trash2,
  FileUp,
  Upload,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { SyncReportFetcher } from "@/components/sync-report-content";
import { ProfileCard } from "@/components/profile-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { typeToUrlSlug } from "@/lib/profile-utils";
import type { ProfileType } from "@/lib/profile-utils";
import { MarketplaceFilterBar } from "@/components/marketplace/MarketplaceFilterBar";
import { useAppSelector, useAppDispatch } from "@/store";
import { clearFilters, setMarketplaceSearchQuery, setMarketplaceSortBy, setFilter } from "@/store/uiSlice";
import { matchesFilter, matchesSameSexCoupleRequirement, matchesInternationalRequirement, omniSearch, sortDonors } from "@/lib/marketplace-filters";

interface ProfileDatabasePanelProps {
  providerId: string;
  type: ProfileType;
}

interface MissingFieldSummary {
  field: string;
  count: number;
  donorIds: string[];
}

interface SyncJob {
  id: string;
  status: "running" | "completed" | "failed";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
  missingFields?: MissingFieldSummary[];
  startedAt: string;
  completedAt?: string;
  currentStep?: string;
  stepProgress?: number;
}

const TYPE_LABELS: Record<ProfileType, string> = {
  "egg-donor": "Egg Donor",
  surrogate: "Surrogate",
  "sperm-donor": "Sperm Donor",
};

const TYPE_ENDPOINTS: Record<ProfileType, string> = {
  "egg-donor": "egg-donors",
  surrogate: "surrogates",
  "sperm-donor": "sperm-donors",
};

const persistentJobState = new Map<string, { syncJobId: string | null; pdfJobId: string | null }>();
function getPersistentKey(providerId: string, type: string) { return `${providerId}:${type}`; }
function getPersistent(providerId: string, type: string) {
  return persistentJobState.get(getPersistentKey(providerId, type)) || { syncJobId: null, pdfJobId: null };
}
function setPersistentSync(providerId: string, type: string, jobId: string | null) {
  const key = getPersistentKey(providerId, type);
  const cur = persistentJobState.get(key) || { syncJobId: null, pdfJobId: null };
  persistentJobState.set(key, { ...cur, syncJobId: jobId });
}
function setPersistentPdf(providerId: string, type: string, jobId: string | null) {
  const key = getPersistentKey(providerId, type);
  const cur = persistentJobState.get(key) || { syncJobId: null, pdfJobId: null };
  persistentJobState.set(key, { ...cur, pdfJobId: jobId });
}

export default function ProfileDatabasePanel({
  providerId,
  type,
}: ProfileDatabasePanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const dispatch = useAppDispatch();
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const searchQuery = useAppSelector((state) => state.ui.marketplaceSearchQuery);
  const sortBy = useAppSelector((state) => state.ui.marketplaceSortBy);
  const roles: string[] = (user as any)?.roles || [];
  const isAdmin = roles.includes("GOSTORK_ADMIN");
  const isProvider = !!((user as any)?.providerId);
  const isAdminOrProvider = isAdmin || isProvider;
  const label = TYPE_LABELS[type];

  const filterProviderType = type === "egg-donor" ? "egg-donor" : type === "surrogate" ? "surrogate" : "sperm-donor";

  useEffect(() => {
    dispatch(clearFilters());
    dispatch(setMarketplaceSearchQuery(""));
    dispatch(setMarketplaceSortBy("newest"));
    setLocationValue("");
  }, [type, dispatch]);

  const [locationValue, setLocationValue] = useState("");
  const handleLocationChange = (v: string) => {
    setLocationValue(v);
    dispatch(setFilter({ key: "location", values: v ? [v] : [] }));
  };

  const [configUrl, setConfigUrl] = useState("");
  const [configUsername, setConfigUsername] = useState("");
  const [configPassword, setConfigPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const persistedState = getPersistent(providerId, type);
  const [activeJobId, setActiveJobId] = useState<string | null>(persistedState.syncJobId);
  const [activePdfJobId, setActivePdfJobId] = useState<string | null>(persistedState.pdfJobId);
  const [lastReport, setLastReport] = useState<SyncJob | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [isPdfUploading, setIsPdfUploading] = useState(false);
  const [isDeletingPdfs, setIsDeletingPdfs] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pdfPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const configQuery = useQuery({
    queryKey: [`/api/providers/${providerId}/sync-config/${type}`],
    queryFn: async () => {
      const res = await fetch(
        `/api/providers/${providerId}/sync-config/${type}`,
        { credentials: "include" },
      );
      if (!res.ok) return null;
      return res.json();
    },
  });

  const profilesQuery = useQuery({
    queryKey: [
      `/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`,
    ],
    queryFn: async () => {
      const res = await fetch(
        `/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`,
        { credentials: "include" },
      );
      if (!res.ok) return [];
      return res.json();
    },
  });

  useEffect(() => {
    if (configQuery.data) {
      setConfigUrl(configQuery.data.databaseUrl || "");
      setConfigUsername(configQuery.data.username || "");
    }
  }, [configQuery.data]);

  useEffect(() => {
    let cancelled = false;
    async function checkActiveJob() {
      try {
        const res = await fetch(
          `/api/providers/${providerId}/sync/active/${type}`,
          { credentials: "include" },
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (data.job && data.job.status === "running" && !cancelled) {
          setActiveJobId(data.job.id);
          setPersistentSync(providerId, type, data.job.id);
          setJobProgress(data.job);
          startPolling(data.job.id);
        }
      } catch {}
    }
    async function checkActivePdfJob() {
      try {
        const res = await fetch(
          `/api/providers/${providerId}/sync/active/${type}?kind=pdf`,
          { credentials: "include" },
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (data.job && data.job.status === "running" && !cancelled) {
          setActivePdfJobId(data.job.id);
          setPersistentPdf(providerId, type, data.job.id);
          setPdfJobProgress(data.job);
          startPdfPolling(data.job.id);
        }
      } catch {}
    }
    if (!activeJobId) checkActiveJob();
    const saved = getPersistent(providerId, type);
    if (saved.pdfJobId) {
      setActivePdfJobId(saved.pdfJobId);
      startPdfPolling(saved.pdfJobId);
    } else {
      checkActivePdfJob();
    }
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      if (pdfPollRef.current) clearInterval(pdfPollRef.current);
    };
  }, [providerId, type]);

  const saveConfigMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PUT",
        `/api/providers/${providerId}/sync-config/${type}`,
        {
          databaseUrl: configUrl,
          username: configUsername || undefined,
          password: configPassword || undefined,
        },
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Configuration saved", variant: "success" });
      queryClient.invalidateQueries({
        queryKey: [`/api/providers/${providerId}/sync-config/${type}`],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to save configuration",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const startSyncMutation = useMutation({
    mutationFn: async (limit?: number) => {
      const url = limit
        ? `/api/providers/${providerId}/sync/${type}?limit=${limit}`
        : `/api/providers/${providerId}/sync/${type}`;
      const res = await apiRequest("POST", url);
      return res.json();
    },
    onSuccess: (data: { jobId: string }) => {
      setActiveJobId(data.jobId);
      setPersistentSync(providerId, type, data.jobId);
      setLastReport(null);
      startPolling(data.jobId);
    },
    onError: (err: any) => {
      toast({
        title: "Failed to start sync",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleStopSync = async () => {
    setIsStopping(true);
    try {
      await apiRequest("POST", `/api/providers/${providerId}/sync/stop`, { type });
      toast({ title: "Sync stopped", description: `Stopped sync for ${label}`, variant: "success" });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setActiveJobId(null);
      setPersistentSync(providerId, type, null);
      if (pdfPollRef.current) clearInterval(pdfPollRef.current);
      pdfPollRef.current = null;
      setActivePdfJobId(null);
      setPersistentPdf(providerId, type, null);
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/sync-config/${type}`] });
    } catch (err: any) {
      toast({ title: "Error", description: err?.message || "Failed to stop sync", variant: "destructive" });
    } finally {
      setIsStopping(false);
    }
  };

  const handleDeleteAll = async () => {
    if (!confirm(`Are you sure you want to delete ALL ${label} profiles for this provider? This cannot be undone.`)) return;
    setIsDeleting(true);
    try {
      const res = await apiRequest("DELETE", `/api/scrapers/donors/${providerId}/${type}`);
      const result = await res.json();
      toast({ title: `${label}s deleted`, description: `Deleted ${result.count} ${label.toLowerCase()} profiles`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/sync-config/${type}`] });
    } catch (err: any) {
      toast({ title: "Error", description: err?.message || "Failed to delete donors", variant: "destructive" });
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePdfUpload = async () => {
    if (pdfFiles.length === 0) return;
    setIsPdfUploading(true);
    try {
      const formData = new FormData();
      pdfFiles.forEach((f) => formData.append("files", f));
      const res = await fetch(`/api/providers/${providerId}/sync/pdf`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Upload failed");
      }
      const { jobId } = await res.json();
      toast({ title: "PDF upload started", description: `Processing ${pdfFiles.length} PDF file(s)...`, variant: "success" });
      setPdfFiles([]);
      if (pdfInputRef.current) pdfInputRef.current.value = "";
      setActivePdfJobId(jobId);
      setPersistentPdf(providerId, type, jobId);
      startPdfPolling(jobId);
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message || "Failed to upload PDFs", variant: "destructive" });
    } finally {
      setIsPdfUploading(false);
    }
  };

  const handleDeletePdfProfiles = async () => {
    if (!confirm("Delete ALL surrogate profiles that were imported from PDFs? This cannot be undone.")) return;
    setIsDeletingPdfs(true);
    try {
      const res = await apiRequest("DELETE", `/api/providers/${providerId}/surrogates/pdfs`);
      const result = await res.json();
      toast({ title: "PDF profiles deleted", description: result.message, variant: "success" });
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`] });
    } catch (err: any) {
      toast({ title: "Error", description: err?.message || "Failed to delete PDF profiles", variant: "destructive" });
    } finally {
      setIsDeletingPdfs(false);
    }
  };

  const [jobProgress, setJobProgress] = useState<SyncJob | null>(null);
  const [pdfJobProgress, setPdfJobProgress] = useState<SyncJob | null>(null);

  const donorRefreshCountRef = useRef(0);

  function startPolling(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    donorRefreshCountRef.current = 0;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/providers/${providerId}/sync/status/${jobId}`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const job: SyncJob = await res.json();
        setJobProgress(job);

        donorRefreshCountRef.current++;
        if (donorRefreshCountRef.current % 3 === 0) {
          queryClient.invalidateQueries({
            queryKey: [
              `/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`,
            ],
          });
        }

        if (job.status === "completed" || job.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setActiveJobId(null);
          setPersistentSync(providerId, type, null);
          setLastReport(job);
          queryClient.invalidateQueries({
            queryKey: [
              `/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`,
            ],
          });
          queryClient.invalidateQueries({
            queryKey: [
              `/api/providers/${providerId}/sync-config/${type}`,
            ],
          });
        }
      } catch {}
    }, 2000);
  }

  function startPdfPolling(jobId: string) {
    if (pdfPollRef.current) clearInterval(pdfPollRef.current);
    pdfPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/providers/${providerId}/sync/status/${jobId}`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const job: SyncJob = await res.json();
        setPdfJobProgress(job);

        // Refresh profiles list as each PDF is processed
        if (job.succeeded > 0) {
          queryClient.invalidateQueries({
            queryKey: [`/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`],
          });
        }

        if (job.status === "completed" || job.status === "failed") {
          if (pdfPollRef.current) clearInterval(pdfPollRef.current);
          pdfPollRef.current = null;
          setActivePdfJobId(null);
          setPersistentPdf(providerId, type, null);
          setLastReport(job);
          queryClient.invalidateQueries({
            queryKey: [
              `/api/providers/${providerId}/${TYPE_ENDPOINTS[type]}`,
            ],
          });
        }
      } catch {}
    }, 2000);
  }

  const isSyncRunning = activeJobId !== null;
  const isPdfRunning = activePdfJobId !== null;
  const isRunning = isSyncRunning || isPdfRunning;
  const profiles: EggDonor[] = profilesQuery.data || [];

  const showExperiencedOnly = useAppSelector((state) => state.ui.showExperiencedOnly);

  const userCountry = (user as any)?.country || null;
  const userIdentification = (user as any)?.identification || null;

  const filteredProfiles = useMemo(() => {
    let result = profiles.filter((d) => {
      if (!omniSearch(d, searchQuery)) return false;
      if (showExperiencedOnly && !(d as any).isExperienced) return false;
      if (!matchesInternationalRequirement(d, userCountry)) return false;
      if (!matchesSameSexCoupleRequirement(d, userIdentification)) return false;
      for (const [key, values] of Object.entries(activeFilters)) {
        if (!matchesFilter(d, key, values)) return false;
      }
      return true;
    });
    return sortDonors(result, sortBy);
  }, [profiles, searchQuery, activeFilters, sortBy, showExperiencedOnly, userCountry, userIdentification]);

  const lastSyncedProfileLabel = useMemo(() => {
    if (profiles.length === 0) return "N/A";
    const sorted = [...profiles].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    const d = new Date(sorted[0].updatedAt);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`;
  }, [profiles]);
  const progressPct =
    jobProgress && jobProgress.total > 0
      ? Math.round((jobProgress.processed / jobProgress.total) * 100)
      : 0;
  const pdfProgressPct =
    pdfJobProgress && pdfJobProgress.total > 0
      ? pdfJobProgress.stepProgress ?? Math.round((pdfJobProgress.processed / pdfJobProgress.total) * 100)
      : 0;

  const syncStatus = configQuery.data?.syncStatus || "PENDING";
  const lastSyncAt = configQuery.data?.lastSyncAt
    ? new Date(configQuery.data.lastSyncAt)
    : null;
  const hasConfig = !!configQuery.data;

  return (
    <div className="space-y-6" data-testid={`donor-panel-${type}`}>
      {!isAdminOrProvider && (
        <div className="text-center text-muted-foreground py-8">You don't have access to this section.</div>
      )}
      {isAdminOrProvider && hasConfig && (
        <div className="space-y-3" data-testid={`scraper-stats-${type}`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-heading">Scraper Overview</h3>
              {lastSyncAt && (
                <p className="text-xs text-muted-foreground">
                  Last sync: {lastSyncAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  {" at "}
                  {lastSyncAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                </p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <button
              type="button"
              className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3 text-left w-full hover:bg-muted/50 transition-colors cursor-pointer"
              onClick={() => setShowReport(!showReport)}
              data-testid={`btn-toggle-report-${type}`}
            >
              <div className="text-xl font-heading flex items-center gap-1.5">
                {syncStatus === "SUCCESS" ? (
                  <><CheckCircle2 className="w-5 h-5 text-[hsl(var(--brand-success))]" /><span className="text-[hsl(var(--brand-success))]">Successful</span></>
                ) : syncStatus === "PARTIAL" ? (
                  <><AlertTriangle className="w-5 h-5 text-[hsl(var(--brand-warning))]" /><span className="text-[hsl(var(--brand-warning))]">Partial</span></>
                ) : syncStatus === "FAILED" ? (
                  <><XCircle className="w-5 h-5 text-destructive" /><span className="text-destructive">Failed</span></>
                ) : (
                  <span className="text-muted-foreground text-base">{syncStatus}</span>
                )}
                {showReport ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground ml-auto" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground ml-auto" />
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">Sync Status</div>
            </button>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3">
              <div className="text-xl font-heading" data-testid={`text-stat-profiles-${type}`}>{profiles.length.toLocaleString()}</div>
              <div className="text-[11px] text-muted-foreground">Total Profiles</div>
            </div>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3">
              <div className="text-xl font-heading" data-testid={`text-stat-latest-${type}`}>
                {profiles.length > 0
                  ? (() => { const d = new Date(Math.max(...profiles.map((p) => new Date(p.createdAt).getTime()))); return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`; })()
                  : "N/A"}
              </div>
              <div className="text-[11px] text-muted-foreground">Latest Profile Added</div>
            </div>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3">
              <div className="text-xl font-heading" data-testid={`text-stat-last-synced-donor-${type}`}>
                {lastSyncedProfileLabel}
              </div>
              <div className="text-[11px] text-muted-foreground">Last Synced At</div>
            </div>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3">
              <div className="text-xl font-heading text-muted-foreground" data-testid={`text-stat-errors-${type}`}>
                {lastReport?.failed || 0}
              </div>
              <div className="text-[11px] text-muted-foreground">Last Sync Errors</div>
            </div>
          </div>
          {showReport && (
            <div className="bg-muted/30 border rounded-[var(--radius)] px-5 py-4" data-testid={`expanded-report-${type}`}>
              <SyncReportFetcher providerId={providerId} type={type} />
            </div>
          )}
        </div>
      )}

      {isAdminOrProvider && <div className={`border rounded-[var(--radius)] p-4 space-y-4 ${!isAdmin ? "opacity-60" : ""}`}>
        <h4
          className="font-heading text-sm flex items-center gap-2"
          data-testid="sync-config-title"
        >
          <Globe className="w-4 h-4" />
          Sync Configuration
          {!isAdmin && <span className="text-xs font-normal text-muted-foreground ml-1">(managed by GoStork)</span>}
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label htmlFor={`url-${type}`} className="text-xs">
              Source URL
            </Label>
            <Input
              id={`url-${type}`}
              data-testid={`input-sync-url-${type}`}
              placeholder="https://provider.com/donors"
              value={configUrl}
              onChange={(e) => setConfigUrl(e.target.value)}
              disabled={!isAdmin || isRunning}
            />
          </div>
          <div>
            <Label htmlFor={`user-${type}`} className="text-xs">
              Username (optional)
            </Label>
            <div className="relative">
              <User className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input
                id={`user-${type}`}
                data-testid={`input-sync-username-${type}`}
                placeholder="username"
                value={configUsername}
                onChange={(e) => setConfigUsername(e.target.value)}
                className="pl-8"
                disabled={!isAdmin || isRunning}
              />
            </div>
          </div>
          <div>
            <Label htmlFor={`pass-${type}`} className="text-xs">
              Password (optional)
            </Label>
            <div className="relative">
              <Lock className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input
                id={`pass-${type}`}
                data-testid={`input-sync-password-${type}`}
                type={showPassword ? "text" : "password"}
                placeholder="••••••••"
                value={configPassword}
                onChange={(e) => setConfigPassword(e.target.value)}
                className="pl-8 pr-8"
                disabled={!isAdmin || isRunning}
              />
              <button
                type="button"
                className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword(!showPassword)}
                data-testid={`toggle-password-${type}`}
                disabled={!isAdmin}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveConfigMutation.mutate()}
                disabled={!configUrl || saveConfigMutation.isPending || isSyncRunning}
                data-testid={`btn-save-config-${type}`}
              >
                {saveConfigMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-1" />
                )}
                Save Config
              </Button>
              <Button
                size="sm"
                onClick={() => startSyncMutation.mutate(undefined)}
                disabled={
                  !configUrl || startSyncMutation.isPending || isSyncRunning
                }
                data-testid={`btn-start-sync-${type}`}
              >
                {isSyncRunning || startSyncMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-1" />
                )}
                {isSyncRunning ? "Syncing..." : `Start ${label} Sync`}
              </Button>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => startSyncMutation.mutate(10)}
                  disabled={
                    !configUrl || startSyncMutation.isPending || isSyncRunning
                  }
                  data-testid={`btn-sync-10-${type}`}
                >
                  {startSyncMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4 mr-1" />
                  )}
                  Sync 10 Profiles
                </Button>
              )}
              {isSyncRunning && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={handleStopSync}
                  disabled={isStopping}
                  data-testid={`btn-stop-sync-${type}`}
                >
                  {isStopping ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                  Stop
                </Button>
              )}
              {!isSyncRunning && profiles.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={handleDeleteAll}
                  disabled={isDeleting}
                  data-testid={`btn-delete-all-${type}`}
                >
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 mr-1" />
                  )}
                  Delete All Synced Profiles
                </Button>
              )}
            </>
          )}
          {configQuery.data?.lastSyncAt && !isSyncRunning && (
            <span className="text-xs text-muted-foreground ml-2">
              Last synced:{" "}
              {new Date(configQuery.data.lastSyncAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>}

      {isSyncRunning && jobProgress && (
        <div
          className="border rounded-[var(--radius)] p-4 space-y-3"
          data-testid={`sync-progress-${type}`}
        >
          <div className="flex items-center justify-between">
            <h4 className="font-heading text-sm flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Sync in Progress
            </h4>
            <span className="text-sm text-muted-foreground">
              {jobProgress.processed} / {jobProgress.total || "?"}
            </span>
          </div>
          <div className="w-full bg-secondary rounded-full h-3 overflow-hidden">
            <div
              className="bg-primary h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${jobProgress.total > 0 ? progressPct : 10}%`,
              }}
            />
          </div>
          {jobProgress.currentStep && (
            <p className="text-xs text-muted-foreground italic" data-testid="sync-current-step">
              {jobProgress.currentStep}
            </p>
          )}
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span className="text-[hsl(var(--brand-success))]">
              {jobProgress.succeeded} succeeded
            </span>
            {jobProgress.failed > 0 && (
              <span className="text-destructive">
                {jobProgress.failed} failed
              </span>
            )}
          </div>
          {jobProgress.errors.length > 0 && (
            <div className="text-xs text-destructive space-y-1">
              {jobProgress.errors.slice(-3).map((err, i) => (
                <div key={i} className="flex items-start gap-1">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>{err}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {lastReport && (
        <div
          className={`border rounded-[var(--radius)] p-4 space-y-3 ${
            lastReport.status === "completed"
              ? "border-[hsl(var(--brand-success)/0.3)] bg-[hsl(var(--brand-success)/0.08)]"
              : "border-destructive/30 bg-destructive/10"
          }`}
          data-testid={`sync-report-${type}`}
        >
          <div className="flex items-center justify-between">
            <h4 className="font-heading text-sm flex items-center gap-2">
              {lastReport.status === "completed" ? (
                <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))]" />
              ) : (
                <XCircle className="w-4 h-4 text-destructive" />
              )}
              Sync{" "}
              {lastReport.status === "completed" ? "Complete" : "Failed"}
            </h4>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLastReport(null)}
              data-testid={`dismiss-report-${type}`}
            >
              Dismiss
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <Card className="p-2 rounded-[var(--radius)] text-center">
              <div className="text-lg font-heading">{lastReport.total}</div>
              <div className="text-xs text-muted-foreground">
                Total Found
              </div>
            </Card>
            <Card className="p-2 rounded-[var(--radius)] text-center">
              <div className="text-lg font-heading text-[hsl(var(--brand-success))]">
                {lastReport.succeeded}
              </div>
              <div className="text-xs text-muted-foreground">
                Imported
              </div>
            </Card>
            <Card className="p-2 rounded-[var(--radius)] text-center">
              <div className="text-lg font-heading text-destructive">
                {lastReport.failed}
              </div>
              <div className="text-xs text-muted-foreground">Failed</div>
            </Card>
            <Card className="p-2 rounded-[var(--radius)] text-center">
              <div className="text-lg font-heading">
                {lastReport.completedAt
                  ? (() => {
                      const secs = Math.round(
                        (new Date(lastReport.completedAt).getTime() -
                          new Date(lastReport.startedAt).getTime()) /
                          1000,
                      );
                      if (secs < 60) return `${secs}s`;
                      const mins = Math.floor(secs / 60);
                      const rem = secs % 60;
                      if (mins < 60) return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
                      const hrs = Math.floor(mins / 60);
                      const remM = mins % 60;
                      return remM > 0 ? `${hrs}h ${remM}m` : `${hrs}h`;
                    })()
                  : "-"}
              </div>
              <div className="text-xs text-muted-foreground">
                Duration
              </div>
            </Card>
          </div>
          {lastReport.errors.length > 0 && (
            <div className="space-y-1">
              <h5 className="text-xs font-ui text-destructive">
                Errors ({lastReport.errors.length}):
              </h5>
              <Card className="text-xs text-destructive space-y-1 p-2 rounded-[var(--radius)]">
                {lastReport.errors.map((err, i) => (
                  <div key={i} className="flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{err}</span>
                  </div>
                ))}
              </Card>
            </div>
          )}
          {lastReport.missingFields && lastReport.missingFields.length > 0 && (
            <div className="space-y-2" data-testid={`missing-fields-report-${type}`}>
              <h5 className="text-xs font-ui text-[hsl(var(--brand-warning))] flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                Missing Mandatory Fields ({lastReport.missingFields.length} fields incomplete)
              </h5>
              <Card className="rounded-[var(--radius)]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[hsl(var(--brand-warning)/0.08)]">
                    <tr>
                      <th className="text-left px-3 py-1.5 font-ui text-[hsl(var(--brand-warning))]">Field</th>
                      <th className="text-right px-3 py-1.5 font-ui text-[hsl(var(--brand-warning))] w-20">Missing</th>
                      <th className="text-left px-3 py-1.5 font-ui text-[hsl(var(--brand-warning))] hidden sm:table-cell">Donor IDs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {lastReport.missingFields.map((mf, i) => (
                      <tr key={i} className="hover:bg-muted/50" data-testid={`missing-field-row-${i}`}>
                        <td className="px-3 py-1.5 font-ui text-foreground">{mf.field}</td>
                        <td className="px-3 py-1.5 text-right">
                          <span className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 rounded-full text-[10px] font-heading bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]">
                            {mf.count}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[200px] hidden sm:table-cell">
                          {mf.donorIds.join(", ")}
                          {mf.count > mf.donorIds.length && ` +${mf.count - mf.donorIds.length} more`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          )}
        </div>
      )}

      {type === "surrogate" && (isAdmin || roles.includes("PROVIDER_ADMIN")) && (
        <div className="border rounded-[var(--radius)] p-4 space-y-4" data-testid="pdf-upload-card">
          <h4 className="font-heading text-sm flex items-center gap-2">
            <FileUp className="w-4 h-4" />
            Bulk PDF Upload
          </h4>
          <p className="text-xs text-muted-foreground">
            Upload surrogate profile PDFs to extract and import profiles automatically using AI.
          </p>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                ref={pdfInputRef}
                type="file"
                accept=".pdf,application/pdf"
                multiple
                className="hidden"
                data-testid="input-pdf-files"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  setPdfFiles((prev) => [...prev, ...files]);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => pdfInputRef.current?.click()}
                disabled={isPdfRunning || isPdfUploading}
                data-testid="btn-select-pdfs"
              >
                <Upload className="w-4 h-4 mr-1" />
                Select PDFs
              </Button>
              {pdfFiles.length > 0 && !isPdfRunning && (
                <>
                  <Button
                    size="sm"
                    onClick={handlePdfUpload}
                    disabled={isPdfRunning || isPdfUploading}
                    data-testid="btn-upload-pdfs"
                  >
                    {isPdfUploading ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Play className="w-4 h-4 mr-1" />
                    )}
                    {isPdfUploading ? "Processing..." : `Upload ${pdfFiles.length} PDF${pdfFiles.length > 1 ? "s" : ""}`}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPdfFiles([]);
                      if (pdfInputRef.current) pdfInputRef.current.value = "";
                    }}
                    data-testid="btn-clear-pdfs"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </>
              )}
              {isPdfRunning && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={handleStopSync}
                  disabled={isStopping}
                  data-testid="btn-stop-pdf-sync"
                >
                  {isStopping ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                  Stop Processing
                </Button>
              )}
              {profiles.some((d: any) => d.externalId?.startsWith("pdf-")) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={handleDeletePdfProfiles}
                  disabled={isDeletingPdfs || isPdfRunning}
                  data-testid="btn-delete-pdf-profiles"
                >
                  {isDeletingPdfs ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4 mr-1" />
                  )}
                  Delete All PDF-Imported Profiles
                </Button>
              )}
            </div>
            {pdfFiles.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-1" data-testid="pdf-file-list">
                {pdfFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <FileUp className="w-3 h-3 shrink-0" />
                    <span className="truncate">{f.name}</span>
                    <span className="text-muted-foreground/60">({(f.size / 1024).toFixed(0)} KB)</span>
                  </div>
                ))}
              </div>
            )}
            {isPdfRunning && pdfJobProgress && (
              <div className="border rounded-[var(--radius)] p-4 space-y-3" data-testid="pdf-progress">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Uploading PDFs in Progress
                  </span>
                  <span className="text-muted-foreground">
                    {pdfJobProgress.processed} / {pdfJobProgress.total || "?"}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{
                      width: `${pdfJobProgress.total > 0 ? pdfProgressPct : 10}%`,
                    }}
                  />
                </div>
                {pdfJobProgress.currentStep && (
                  <div className="text-xs text-muted-foreground">
                    {pdfJobProgress.currentStep}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {pdfJobProgress.succeeded} succeeded
                  {pdfJobProgress.failed > 0 && (
                    <span className="text-destructive ml-2">
                      {pdfJobProgress.failed} failed
                    </span>
                  )}
                </div>
                {pdfJobProgress.errors.length > 0 && (
                  <div className="text-xs text-destructive space-y-1">
                    {pdfJobProgress.errors.slice(-3).map((err, i) => (
                      <div key={i}>{err}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-3">
          <h4
            className="font-heading text-sm"
            data-testid={`profiles-table-title-${type}`}
          >
            {label} Records ({profiles.length})
            {filteredProfiles.length !== profiles.length && (
              <span className="text-muted-foreground font-normal ml-1">
                - showing {filteredProfiles.length}
              </span>
            )}
          </h4>
          {profiles.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                profilesQuery.refetch()
              }
              disabled={profilesQuery.isFetching}
              data-testid={`btn-refresh-profiles-${type}`}
            >
              <RefreshCw
                className={`w-4 h-4 mr-1 ${profilesQuery.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          )}
        </div>

        {profiles.length > 0 && (
          <div className="mb-4" data-testid={`filter-bar-${type}`}>
            <MarketplaceFilterBar
              providerType={filterProviderType}
              hideFavorites
              location={locationValue}
              onLocationChange={handleLocationChange}
              hasLocation={!!locationValue}
            />
          </div>
        )}

        {profilesQuery.isLoading ? (
          <div className="py-8 text-center">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
          </div>
        ) : profiles.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">
            No {label.toLowerCase()} records yet. Configure a source URL
            and start syncing to import profiles.
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">
            No {label.toLowerCase()} records match your filters.
          </div>
        ) : (
          <ProfileCardGrid profiles={filteredProfiles} providerId={providerId} type={type} />
        )}
      </div>
    </div>
  );
}


function formatFieldLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const HIDDEN_PROFILE_KEYS = new Set([
  "photoUrl", "profileUrl", "externalId", "status",
]);

const IMAGE_KEYS = new Set([
  "All Photos", "Genetic Report Images",
]);

const LONG_TEXT_KEYS = new Set([
  "Donor Overview",
]);

function isImageArray(key: string, value: any): boolean {
  return IMAGE_KEYS.has(key) || (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v: any) => typeof v === "string" && /\.(jpg|jpeg|png|gif|webp|heic|svg)/i.test(v))
  );
}

function ProfileDetailSection({ sectionName, sectionData }: { sectionName: string; sectionData: Record<string, any> }) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(sectionData);
  if (entries.length === 0) return null;

  return (
    <Card className="overflow-hidden" data-testid={`profile-section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
      <button
        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/50 hover:bg-muted transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
        data-testid={`toggle-section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span className="text-sm font-ui">{sectionName}</span>
        <span className="text-xs text-muted-foreground">{expanded ? "▲" : "▼"} {entries.length} fields</span>
      </button>
      {expanded && (
        <div className="px-4 py-3 space-y-2">
          {entries.map(([question, answer]) => {
            if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
              const subEntries = Object.entries(answer);
              return (
                <div key={question} className="py-2 px-3 rounded-[var(--radius)] bg-accent/10 border border-accent/20">
                  <p className="text-xs font-ui text-accent-foreground mb-1">{question}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {subEntries.map(([subKey, subVal]) => (
                      <div key={subKey} className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{subKey}</span>
                        <span className="font-ui">{Array.isArray(subVal) ? subVal.join(", ") : String(subVal)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }

            const answerStr = Array.isArray(answer) ? answer.join(", ") : String(answer);
            const isLong = answerStr.length > 100;

            return (
              <div key={question} className={`py-2 px-3 rounded-[var(--radius)] bg-muted/50 border border-border/50 ${isLong ? "col-span-2" : ""}`}>
                <p className="text-xs text-muted-foreground">{question}</p>
                <p className={`text-sm ${isLong ? "leading-body mt-1" : "font-ui"} break-words`}>{answerStr}</p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function ProfileDataSection({ data }: { data: Record<string, any> }) {
  const allEntries = Object.entries(data).filter(([key]) => !HIDDEN_PROFILE_KEYS.has(key) && key !== "Profile Details");
  const profileDetails = data["Profile Details"] as Record<string, Record<string, any>> | undefined;

  const longTextEntries = allEntries.filter(([key, value]) =>
    LONG_TEXT_KEYS.has(key) || (typeof value === "string" && value.length > 120)
  );
  const imageEntries = allEntries.filter(([key, value]) => isImageArray(key, value));
  const fieldEntries = allEntries.filter(
    ([key, value]) =>
      !LONG_TEXT_KEYS.has(key) &&
      !(typeof value === "string" && value.length > 120) &&
      !isImageArray(key, value) &&
      value !== null &&
      value !== undefined &&
      value !== "" &&
      typeof value !== "object",
  );

  const hasContent = longTextEntries.length > 0 || imageEntries.length > 0 || fieldEntries.length > 0 || profileDetails;
  if (!hasContent) return null;

  return (
    <div data-testid="section-all-scraped-data" className="space-y-4">
      <h4 className="text-sm font-ui text-muted-foreground">Full Provider Profile</h4>

      {longTextEntries.map(([key, value]) => (
        <div
          key={key}
          className="py-3 px-4 rounded-[var(--radius)] bg-muted/50 border border-border/50"
          data-testid={`scraped-field-${key.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <p className="text-xs text-muted-foreground mb-1">{formatFieldLabel(key)}</p>
          <p className="text-sm leading-body">{String(value)}</p>
        </div>
      ))}

      {fieldEntries.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {fieldEntries.map(([key, value]) => {
            let display: string;
            if (typeof value === "boolean") display = value ? "Yes" : "No";
            else if (Array.isArray(value)) display = value.filter(Boolean).join(", ");
            else display = String(value);

            return (
              <div
                key={key}
                className="py-2 px-3 rounded-[var(--radius)] bg-muted/50 border border-border/50"
                data-testid={`scraped-field-${key.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <p className="text-xs text-muted-foreground">{formatFieldLabel(key)}</p>
                <p className="text-sm font-ui break-words">{display}</p>
              </div>
            );
          })}
        </div>
      )}

      {imageEntries.map(([key, value]) => (
        <div key={key} data-testid={`scraped-field-${key.toLowerCase().replace(/\s+/g, "-")}`}>
          <p className="text-xs text-muted-foreground mb-2">{formatFieldLabel(key)}</p>
          <div className="grid grid-cols-3 gap-2">
            {(value as string[]).map((url: string, idx: number) => (
              <a key={idx} href={`/api/uploads/proxy?url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">
                <img
                  src={`/api/uploads/proxy?url=${encodeURIComponent(url)}`}
                  alt={`${formatFieldLabel(key)} ${idx + 1}`}
                  className="w-full h-auto rounded-[var(--radius)] border border-border object-cover hover:opacity-80 transition-opacity"
                  loading="lazy"
                  data-testid={`img-${key.toLowerCase().replace(/\s+/g, "-")}-${idx}`}
                />
              </a>
            ))}
          </div>
        </div>
      ))}

      {profileDetails && Object.keys(profileDetails).length > 0 && (
        <div className="space-y-2">
          <h5 className="text-xs font-ui text-muted-foreground mt-4">Detailed Profile Questionnaire</h5>
          {Object.entries(profileDetails).map(([sectionName, sectionData]) => (
            <ProfileDetailSection key={sectionName} sectionName={sectionName} sectionData={sectionData as Record<string, any>} />
          ))}
        </div>
      )}
    </div>
  );
}


function ProfileCardGrid({ profiles, providerId, type }: { profiles: any[]; providerId: string; type: ProfileType }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = (user as any)?.roles?.includes("GOSTORK_ADMIN");
  const isProvider = !!((user as any)?.providerId);
  const canManageProfiles = isAdmin || isProvider;
  const endpoint = TYPE_ENDPOINTS[type];
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const toggleVisibilityMutation = useMutation({
    mutationFn: async ({ profileId, hidden }: { profileId: string; hidden: boolean }) => {
      const res = await apiRequest(
        "PATCH",
        `/api/providers/${providerId}/donors/${type}/${profileId}`,
        { hiddenFromSearch: hidden },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/providers/${providerId}/${endpoint}`],
      });
      const typeLabel = type === "egg-donor" ? "Donor" : type === "surrogate" ? "Surrogate" : "Sperm Donor";
      toast({ title: `${typeLabel} visibility updated`, variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update visibility", description: err.message, variant: "destructive" });
    },
  });

  const deleteProfileMutation = useMutation({
    mutationFn: async (profileId: string) => {
      const res = await apiRequest("DELETE", `/api/providers/${providerId}/sync/${endpoint}/${profileId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${endpoint}`] });
      const typeLabel = type === "egg-donor" ? "Donor" : type === "surrogate" ? "Surrogate" : "Sperm Donor";
      toast({ title: `${typeLabel} profile deleted`, variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to delete profile", description: err.message, variant: "destructive" });
    },
  });

  const togglePremiumMutation = useMutation({
    mutationFn: async ({ profileId, premium }: { profileId: string; premium: boolean }) => {
      const res = await apiRequest(
        "PATCH",
        `/api/providers/${providerId}/donors/${type}/${profileId}`,
        { isPremium: premium },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/providers/${providerId}/${endpoint}`],
      });
      toast({ title: "Premium status updated", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update premium status", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
      {profiles.map((d: any) => (
        <ProfileCard
          key={d.id}
          profile={d}
          type={type}
          variant="admin"
          showNewBadge={d.status === "AVAILABLE"}
          onNavigate={isAdmin
            ? () => navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type)}/${d.id}`)
            : () => navigate(`/${typeToUrlSlug(type)}/${providerId}/${d.id}`)}
          adminControls={canManageProfiles ? {
            isHidden: !!d.hiddenFromSearch,
            isPremium: !!d.isPremium,
            onEdit: isAdmin ? (profileId) => navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type)}/${profileId}/edit`) : undefined,
            onDelete: d.externalId?.startsWith("pdf-") ? (profileId) => setDeleteTargetId(profileId) : undefined,
            onToggleVisibility: (profileId, hidden) => toggleVisibilityMutation.mutate({ profileId, hidden }),
            onTogglePremium: (profileId, premium) => togglePremiumMutation.mutate({ profileId, premium }),
          } : undefined}
        />
      ))}

      <AlertDialog open={!!deleteTargetId} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this profile?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The profile will be permanently removed from your database.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="btn-confirm-delete"
              onClick={() => {
                if (deleteTargetId) {
                  deleteProfileMutation.mutate(deleteTargetId);
                  setDeleteTargetId(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    AVAILABLE: "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success)/0.3)]",
    MATCHED: "bg-accent/15 text-accent-foreground border-accent/30",
    ON_HOLD: "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)]",
    INACTIVE: "bg-muted text-foreground border-border",
    SOLD_OUT: "bg-destructive/15 text-destructive border-destructive/30",
  };
  return (
    <Badge
      variant="outline"
      className={`text-xs ${styles[status] || ""}`}
      data-testid={`status-badge-${status}`}
    >
      {status}
    </Badge>
  );
}
