import { useState, useEffect, useRef, useMemo } from "react";
import { formatFieldLabel } from "@/lib/format-label";
import type { EggDonor } from "@shared/schema";
import { useNavigate, useSearchParams } from "react-router-dom";
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
  Sparkles,
  ShieldCheck,
  KeyRound,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useConfirm } from "@/components/ui/confirm-bar";
import { useAuth } from "@/hooks/use-auth";
import { SyncReportFetcher } from "@/components/sync-report-content";
import { ProfileCard } from "@/components/profile-card";
import { BoostProfilesCard } from "@/components/sponsorship/sponsorship-wizard";
import { typeToUrlSlug } from "@/lib/profile-utils";
import type { ProfileType } from "@/lib/profile-utils";
import { MarketplaceFilterBar } from "@/components/marketplace/MarketplaceFilterBar";
import { useAppSelector, useAppDispatch } from "@/store";
import { clearFilters, setMarketplaceSearchQuery, setMarketplaceSortBy, setFilter } from "@/store/uiSlice";
import { matchesFilter, matchesSameSexCoupleRequirement, matchesInternationalRequirement, omniSearch, sortDonors } from "@/lib/marketplace-filters";

interface ProfileDatabasePanelProps {
  providerId: string;
  type: ProfileType;
  /**
   * Which sections to render. Defaults to "full".
   * - "full": everything (scraper overview + sync config + sync progress + last report + pdf upload + records)
   * - "config": sync configuration card + live sync progress + last report + pdf upload (no scraper overview, no records)
   * - "records": only the profile records grid + filter bar
   * Used by the admin scraper report page to mount the sync config at the top and
   * the records grid at the bottom while keeping the existing report between them.
   */
  mode?: "full" | "config" | "records";
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
  mode = "full",
}: ProfileDatabasePanelProps) {
  const showOverview = mode === "full";
  const showConfig = mode === "full" || mode === "config";
  const showRecords = mode === "full" || mode === "records";
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const dispatch = useAppDispatch();
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const searchQuery = useAppSelector((state) => state.ui.marketplaceSearchQuery);
  const sortBy = useAppSelector((state) => state.ui.marketplaceSortBy);
  const roles: string[] = (user as any)?.roles || [];
  const navigate = useNavigate();
  const isAdmin = roles.includes("GOSTORK_ADMIN");
  const isProvider = !!((user as any)?.providerId);
  const isAdminOrProvider = isAdmin || isProvider;
  const label = TYPE_LABELS[type];

  // Provider self-serve only: offer the Start Sponsorship wizard from this tab,
  // pre-targeting this profile type. Hidden in admin and while already picking
  // profiles for a campaign (?sponsor=).
  const [panelSearchParams] = useSearchParams();
  const inCampaignMode = !!panelSearchParams.get("sponsor");
  const sponsorEntityType = type === "egg-donor" ? "EGG_DONOR" : type === "surrogate" ? "SURROGATE" : "SPERM_DONOR";
  const showStartSponsorship = isProvider && !isAdmin && !inCampaignMode;

  const filterProviderType = type === "egg-donor" ? "egg-donor" : type === "surrogate" ? "surrogate" : "sperm-donor";

  // Reset when the TYPE changes, not on mount. This panel shares
  // `activeFilters` with the parent marketplace, so clearing on every mount
  // meant that opening any Providers page silently wiped the filters a parent
  // had set on /marketplace - filters should survive navigation and only be
  // cleared by the person who set them.
  const lastResetType = useRef<string | null>(null);
  useEffect(() => {
    if (lastResetType.current === type) return;
    const isFirstMount = lastResetType.current === null;
    lastResetType.current = type;
    if (isFirstMount) return;
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
  // Admin-selected sync method: scrape the provider's site (SOURCE_URL) or
  // pull JSON from the provider's API with a key/secret they hand us (API).
  const [configSyncMethod, setConfigSyncMethod] = useState<"SOURCE_URL" | "API">("SOURCE_URL");
  const [configApiKey, setConfigApiKey] = useState("");
  const [configApiSecret, setConfigApiSecret] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [showApiSecret, setShowApiSecret] = useState(false);
  // First-time setup gate: require the admin to acknowledge the scraper playbook
  // before the FIRST sync of a brand-new config (one that has never synced).
  const [setupAck, setSetupAck] = useState(false);
  const persistedState = getPersistent(providerId, type);
  const [activeJobId, setActiveJobId] = useState<string | null>(persistedState.syncJobId);
  const [activePdfJobId, setActivePdfJobId] = useState<string | null>(persistedState.pdfJobId);
  const [lastReport, setLastReport] = useState<SyncJob | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const [pdfDropError, setPdfDropError] = useState<string | null>(null);
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

  // Platform-wide ASRM surrogate minimums (from the GoStork house provider) -
  // shown as a constant banner above the surrogate records.
  const asrmQuery = useQuery({
    queryKey: ["/api/providers/asrm/surrogate-requirements"],
    queryFn: async () => {
      const res = await fetch("/api/providers/asrm/surrogate-requirements", { credentials: "include" });
      if (!res.ok) return { requirements: null, lines: [] };
      return res.json();
    },
    enabled: type === "surrogate",
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (configQuery.data) {
      setConfigUrl(configQuery.data.databaseUrl || "");
      setConfigUsername(configQuery.data.username || "");
      setConfigSyncMethod(configQuery.data.syncMethod === "API" ? "API" : "SOURCE_URL");
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
        } else if (!cancelled && activeJobId) {
          // The job we remembered from before this panel unmounted finished
          // while we were away - clear the stale id so the Syncing... button
          // doesn't stay stuck.
          setActiveJobId(null);
          setPersistentSync(providerId, type, null);
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
    // ALWAYS re-check with the server on mount, even when a jobId was restored
    // from the persistent map: the restored id alone gives us no job data, so
    // the progress card stayed hidden (jobProgress null, no polling) after
    // navigating away and back - only a hard refresh (which wipes the map and
    // took the checkActiveJob path) brought it back. The server response both
    // rehydrates the progress card immediately and restarts polling.
    checkActiveJob();
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

  const buildConfigPayload = () => ({
    databaseUrl: configUrl,
    username: configUsername || undefined,
    password: configPassword || undefined,
    syncMethod: configSyncMethod,
    apiKey: configApiKey || undefined,
    apiSecret: configApiSecret || undefined,
  });

  const saveConfigMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PUT",
        `/api/providers/${providerId}/sync-config/${type}`,
        buildConfigPayload(),
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
      // Save the on-screen config first so "Start Sync" never fails with
      // "configuration not found" when the admin skipped Save Config.
      if (configUrl) {
        await apiRequest(
          "PUT",
          `/api/providers/${providerId}/sync-config/${type}`,
          buildConfigPayload(),
        );
        queryClient.invalidateQueries({
          queryKey: [`/api/providers/${providerId}/sync-config/${type}`],
        });
      }
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
    const ok = await confirm({
      title: `Delete all ${label.toLowerCase()} profiles`,
      message: `Delete ALL ${label} profiles for this provider? This cannot be undone.`,
      confirmLabel: "Delete all",
      tone: "destructive",
    });
    if (!ok) return;
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

  // Shared by the file picker and the drop zone: keep only PDFs, drop duplicates
  // (same name + size) so dragging the same batch twice does not queue it twice.
  const addPdfFiles = (incoming: File[]) => {
    const pdfs = incoming.filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    const rejected = incoming.length - pdfs.length;
    setPdfDropError(
      rejected > 0
        ? `${rejected} file${rejected > 1 ? "s were" : " was"} skipped - only PDF files can be uploaded.`
        : null,
    );
    if (pdfs.length === 0) return;
    setPdfFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...pdfs.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  };

  const handlePdfDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setPdfDragOver(false);
    if (activePdfJobId !== null || isPdfUploading) return;
    addPdfFiles(Array.from(e.dataTransfer.files || []));
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
    const ok = await confirm({
      title: "Delete PDF-imported profiles",
      message: "Delete ALL surrogate profiles that were imported from PDFs? This cannot be undone.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
    if (!ok) return;
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
  // The scraper-playbook acknowledgment gate is scraper-specific - an API pull
  // has no login page, captcha, or list-page pitfalls, so it skips the gate but
  // instead requires an API key (typed now or already saved) before starting.
  const setupGateBlocks = configSyncMethod === "SOURCE_URL" && !configQuery.data?.lastSyncAt && !setupAck;
  const apiKeyMissing = configSyncMethod === "API" && !configApiKey && !configQuery.data?.hasApiKey;

  return (
    <div className="space-y-6" data-testid={`donor-panel-${type}`}>
      {!isAdminOrProvider && (
        <div className="text-center text-muted-foreground py-8">You don't have access to this section.</div>
      )}
      {showOverview && isAdminOrProvider && hasConfig && (
        <div className="space-y-3" data-testid={`scraper-stats-${type}`}>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-heading">Scraper Overview</h3>
              {lastSyncAt && (
                <p className="t-helper">
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
              className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3 text-left w-full hover:bg-muted/50 transition-colors cursor-pointer bg-card"
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
                  <span className="t-helper">{syncStatus}</span>
                )}
                {showReport ? (
                  <ChevronUp className="w-4 h-4 text-muted-foreground ml-auto" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-muted-foreground ml-auto" />
                )}
              </div>
              <div className="t-helper">Sync Status</div>
            </button>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3 bg-card">
              <div className="text-xl font-heading" data-testid={`text-stat-profiles-${type}`}>{profiles.length.toLocaleString()}</div>
              <div className="t-helper">Total Profiles</div>
            </div>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3 bg-card">
              <div className="text-xl font-heading" data-testid={`text-stat-latest-${type}`}>
                {profiles.length > 0
                  ? (() => { const d = new Date(Math.max(...profiles.map((p) => new Date(p.createdAt).getTime()))); return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`; })()
                  : "N/A"}
              </div>
              <div className="t-helper">Latest Profile Added</div>
            </div>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3 bg-card">
              <div className="text-xl font-heading" data-testid={`text-stat-last-synced-donor-${type}`}>
                {lastSyncedProfileLabel}
              </div>
              <div className="t-helper">Last Synced At</div>
            </div>
            <div className="border rounded-[var(--radius)] pt-3 pb-2.5 px-3 bg-card">
              <div className="text-xl font-heading text-muted-foreground" data-testid={`text-stat-errors-${type}`}>
                {lastReport?.failed || 0}
              </div>
              <div className="t-helper">Last Sync Errors</div>
            </div>
          </div>
          {showReport && (
            <div className="bg-muted/30 border rounded-[var(--radius)] px-5 py-4" data-testid={`expanded-report-${type}`}>
              <SyncReportFetcher providerId={providerId} type={type} />
            </div>
          )}
        </div>
      )}

      {showConfig && isAdminOrProvider && <div className={`border rounded-[var(--radius)] p-4 space-y-4 ${!isAdmin ? "opacity-60" : ""}`}>
        <h4
          className="font-heading text-sm flex items-center gap-2"
          data-testid="sync-config-title"
        >
          <Globe className="w-4 h-4" />
          Sync Configuration
          {!isAdmin && <span className="t-helper ml-1">(managed by GoStork)</span>}
        </h4>
        <div className="max-w-xs">
          <Label htmlFor={`method-${type}`} className="t-form-label-sm">
            Sync Method
          </Label>
          <Select
            value={configSyncMethod}
            onValueChange={(v) => setConfigSyncMethod(v === "API" ? "API" : "SOURCE_URL")}
            disabled={!isAdmin || isRunning}
          >
            <SelectTrigger id={`method-${type}`} data-testid={`select-sync-method-${type}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SOURCE_URL">Source URL (scrape the provider's site)</SelectItem>
              <SelectItem value="API">Provider API (API Key + Secret)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label htmlFor={`url-${type}`} className="t-form-label-sm">
              {configSyncMethod === "API" ? "API Endpoint URL" : "Source URL"}
            </Label>
            <Input
              id={`url-${type}`}
              data-testid={`input-sync-url-${type}`}
              placeholder={configSyncMethod === "API" ? "https://api.provider.com/v1/donors" : "https://provider.com/donors"}
              value={configUrl}
              onChange={(e) => setConfigUrl(e.target.value)}
              disabled={!isAdmin || isRunning}
            />
          </div>
          {configSyncMethod === "API" && (
            <>
              <div>
                <Label htmlFor={`api-key-${type}`} className="t-form-label-sm">
                  API Key
                </Label>
                <div className="relative">
                  <KeyRound className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
                  <Input
                    id={`api-key-${type}`}
                    data-testid={`input-sync-api-key-${type}`}
                    type={showApiKey ? "text" : "password"}
                    placeholder={configQuery.data?.hasApiKey ? "•••••••• (saved)" : "provider API key"}
                    value={configApiKey}
                    onChange={(e) => setConfigApiKey(e.target.value)}
                    className="pl-8 pr-8"
                    disabled={!isAdmin || isRunning}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowApiKey(!showApiKey)}
                    data-testid={`toggle-api-key-${type}`}
                    disabled={!isAdmin}
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div>
                <Label htmlFor={`api-secret-${type}`} className="t-form-label-sm">
                  API Secret (optional)
                </Label>
                <div className="relative">
                  <Lock className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
                  <Input
                    id={`api-secret-${type}`}
                    data-testid={`input-sync-api-secret-${type}`}
                    type={showApiSecret ? "text" : "password"}
                    placeholder={configQuery.data?.hasApiSecret ? "•••••••• (saved)" : "provider API secret"}
                    value={configApiSecret}
                    onChange={(e) => setConfigApiSecret(e.target.value)}
                    className="pl-8 pr-8"
                    disabled={!isAdmin || isRunning}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowApiSecret(!showApiSecret)}
                    data-testid={`toggle-api-secret-${type}`}
                    disabled={!isAdmin}
                  >
                    {showApiSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </>
          )}
          <div>
            <Label htmlFor={`user-${type}`} className="t-form-label-sm">
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
                autoComplete="off"
              />
            </div>
          </div>
          <div>
            <Label htmlFor={`pass-${type}`} className="t-form-label-sm">
              Password (optional)
            </Label>
            <div className="relative">
              <Lock className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
              {/* new-password stops the browser autofilling the ADMIN's own GoStork
                  login here - these are credentials for the provider's external
                  site, and an autofilled wrong password gets silently saved by
                  the sync auto-save. */}
              <Input
                id={`pass-${type}`}
                data-testid={`input-sync-password-${type}`}
                type={showPassword ? "text" : "password"}
                placeholder="••••••••"
                value={configPassword}
                onChange={(e) => setConfigPassword(e.target.value)}
                className="pl-8 pr-8"
                disabled={!isAdmin || isRunning}
                autoComplete="new-password"
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
        {isAdmin && configSyncMethod === "API" && (
          <p className="t-helper" data-testid={`api-method-note-${type}`}>
            GoStork calls the provider's API directly with the key/secret above (standard auth conventions are auto-detected).
            The endpoint must return the {label.toLowerCase()} profiles as JSON. Username/password are only needed if the API also
            requires a login.
          </p>
        )}
        {isAdmin && configSyncMethod === "SOURCE_URL" && !configQuery.data?.lastSyncAt && (
          <div className="rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.3)] bg-[hsl(var(--brand-warning)/0.08)] p-3 space-y-2" data-testid="scraper-setup-gate">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--brand-warning))]" />
              <div className="space-y-1.5 text-xs">
                <p className="font-heading text-foreground">First-time setup - review the scraper guide before the first run</p>
                <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                  <li><strong>Source URL</strong> = the donor/surrogate <strong>list page after login</strong> (for WordPress sites, NOT the <code>wp-login.php</code> page).</li>
                  <li>Sites that present a <strong>reCAPTCHA</strong> need <code>TWOCAPTCHA_API_KEY</code> set in the server environment.</li>
                  <li>Run <strong>"Sync 10 Profiles"</strong> first and watch the run history before kicking a full sync.</li>
                </ul>
                <a
                  href="https://github.com/GoStork/concierge/blob/main/docs/scraper-playbook.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[hsl(var(--primary))] font-ui underline"
                  data-testid="scraper-playbook-link"
                >
                  Open the full Scraper Playbook
                </a>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-foreground font-ui cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={setupAck}
                onChange={(e) => setSetupAck(e.target.checked)}
                className="w-4 h-4 accent-[hsl(var(--primary))]"
                data-testid="scraper-setup-ack"
              />
              I've reviewed the scraper setup guide
            </label>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
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
                  !configUrl || startSyncMutation.isPending || isSyncRunning || setupGateBlocks || apiKeyMissing
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
                    !configUrl || startSyncMutation.isPending || isSyncRunning || setupGateBlocks || apiKeyMissing
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
            <span className="t-helper ml-2">
              Last synced:{" "}
              {new Date(configQuery.data.lastSyncAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>}

      {showConfig && isSyncRunning && jobProgress && (
        <div
          className="border rounded-[var(--radius)] p-4 space-y-3 bg-card"
          data-testid={`sync-progress-${type}`}
        >
          <div className="flex items-center justify-between">
            <h4 className="font-heading text-sm flex items-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Sync in Progress
            </h4>
            <span className="t-helper">
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
            <p className="t-helper italic" data-testid="sync-current-step">
              {jobProgress.currentStep}
            </p>
          )}
          <div className="t-helper flex gap-4">
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

      {showConfig && lastReport && (
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
              <div className="t-helper">
                Total Found
              </div>
            </Card>
            <Card className="p-2 rounded-[var(--radius)] text-center">
              <div className="text-lg font-heading text-[hsl(var(--brand-success))]">
                {lastReport.succeeded}
              </div>
              <div className="t-helper">
                Imported
              </div>
            </Card>
            <Card className="p-2 rounded-[var(--radius)] text-center">
              <div className="text-lg font-heading text-destructive">
                {lastReport.failed}
              </div>
              <div className="t-helper">Failed</div>
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
              <div className="t-helper">
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

      {showConfig && type === "surrogate" && (isAdmin || roles.includes("PROVIDER_ADMIN")) && (
        <div className="border rounded-[var(--radius)] p-4 space-y-4 bg-card" data-testid="pdf-upload-card">
          <h4 className="font-heading text-sm flex items-center gap-2">
            <FileUp className="w-4 h-4" />
            Bulk PDF Upload
          </h4>
          <p className="t-helper">
            Upload surrogate profile PDFs to extract and import profiles automatically using AI.
          </p>
          <div className="space-y-3">
            <input
              ref={pdfInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              className="hidden"
              data-testid="input-pdf-files"
              onChange={(e) => {
                addPdfFiles(Array.from(e.target.files || []));
                e.target.value = "";
              }}
            />
            <div
              role="button"
              tabIndex={0}
              aria-disabled={isPdfRunning || isPdfUploading}
              className={`rounded-[var(--radius)] border-2 border-dashed p-5 sm:p-6 text-center transition-colors ${
                isPdfRunning || isPdfUploading
                  ? "border-border/60 opacity-60 cursor-not-allowed"
                  : pdfDragOver
                    ? "border-primary bg-primary/5 cursor-pointer"
                    : "border-border/60 bg-secondary/40 hover:border-primary/40 cursor-pointer"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                if (isPdfRunning || isPdfUploading) return;
                setPdfDragOver(true);
              }}
              onDragLeave={() => setPdfDragOver(false)}
              onDrop={handlePdfDrop}
              onClick={() => {
                if (isPdfRunning || isPdfUploading) return;
                pdfInputRef.current?.click();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                if (isPdfRunning || isPdfUploading) return;
                pdfInputRef.current?.click();
              }}
              data-testid="dropzone-pdf-files"
            >
              <div className="flex flex-col items-center gap-2">
                <Upload className="w-7 h-7 text-muted-foreground" />
                <p className="text-sm font-ui text-foreground">
                  Drop PDFs here or click to browse
                </p>
                <p className="t-helper">PDF files only - you can select several at once</p>
              </div>
            </div>
            {pdfDropError && (
              <p className="t-helper text-[hsl(var(--brand-warning))]" data-testid="pdf-drop-error">
                {pdfDropError}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
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
                      setPdfDropError(null);
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
              <div className="t-helper space-y-1" data-testid="pdf-file-list">
                {pdfFiles.map((f, i) => (
                  <div key={`${f.name}:${f.size}:${i}`} className="flex items-center gap-1.5">
                    <FileUp className="w-3 h-3 shrink-0" />
                    <span className="truncate">{f.name}</span>
                    <span className="text-muted-foreground/60 shrink-0">({(f.size / 1024).toFixed(0)} KB)</span>
                    {!isPdfRunning && !isPdfUploading && (
                      <button
                        type="button"
                        className="ml-auto shrink-0 p-1 rounded-full text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setPdfFiles((prev) => prev.filter((_, idx) => idx !== i))}
                        aria-label={`Remove ${f.name}`}
                        data-testid={`btn-remove-pdf-${i}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {isPdfRunning && pdfJobProgress && (
              <div className="border rounded-[var(--radius)] p-4 space-y-3 bg-card" data-testid="pdf-progress">
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
                  <div className="t-helper">
                    {pdfJobProgress.currentStep}
                  </div>
                )}
                <div className="t-helper">
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

      {showRecords && <div data-onb-anchor="profile-records">
        {showStartSponsorship && (
          <BoostProfilesCard
            initialEntityType={sponsorEntityType as any}
            onChanged={() => profilesQuery.refetch()}
            className="mb-4"
          />
        )}
        {type === "surrogate" && asrmQuery.data?.lines?.length > 0 && (
          <div className="mb-4 rounded-[var(--radius)] border border-primary/20 bg-secondary p-4" data-testid="asrm-requirements-banner">
            <div className="flex items-center gap-2 mb-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              <h4 className="font-heading text-sm text-foreground">ASRM Minimum Requirements (GoStork)</h4>
            </div>
            <p className="t-helper mb-2">
              Every surrogate profile is automatically checked against these ASRM-based minimums when it is uploaded, synced, or edited.
              Profiles that do not meet them are still saved, but are hidden from parents and labeled "Below ASRM minimum". This cannot be overridden.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {asrmQuery.data.lines.map((line: string) => (
                <span key={line} className="inline-flex items-center gap-1 text-xs text-foreground">
                  <CheckCircle2 className="w-3 h-3 text-[hsl(var(--brand-success))]" />
                  {line}
                </span>
              ))}
            </div>
            {(() => {
              const reasonsOf = (p: any) => Array.isArray(p.asrmFailReasons)
                ? { failures: p.asrmFailReasons as string[], missing: [] as string[] }
                : { failures: (p.asrmFailReasons?.failures ?? []) as string[], missing: (p.asrmFailReasons?.missing ?? []) as string[] };
              const displayIdOf = (p: any) => {
                const raw = p.externalId || p.id.slice(0, 8);
                return raw.startsWith("pdf-") ? raw.replace(/^pdf-/, "") : raw;
              };
              const hiddenProfiles = (profiles as any[]).filter((p) => p.asrmHidden);
              const missingInfo = hiddenProfiles.map((p) => ({ p, ...reasonsOf(p) })).filter((x) => x.missing.length > 0);
              const belowMin = hiddenProfiles.map((p) => ({ p, ...reasonsOf(p) })).filter((x) => x.failures.length > 0);
              if (hiddenProfiles.length === 0) return null;
              return (
                <div className="mt-3 space-y-2 border-t border-primary/10 pt-3" data-testid="asrm-warnings">
                  {missingInfo.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-heading text-[hsl(var(--brand-warning))] flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Action needed - {missingInfo.length} {missingInfo.length === 1 ? "profile is" : "profiles are"} hidden because required ASRM info is missing. Edit each profile and add the missing fields:
                      </p>
                      {missingInfo.map(({ p, missing }) => (
                        <div key={p.id} className="flex items-center justify-between gap-2 rounded-[var(--radius)] bg-[hsl(var(--brand-warning)/0.08)] px-3 py-1.5" data-testid={`asrm-warning-missing-${p.id}`}>
                          <span className="text-xs text-foreground">
                            <span className="font-heading">Surrogate #{displayIdOf(p)}</span>
                            <span className="text-muted-foreground"> - missing: </span>
                            <span className="font-ui">{missing.join(", ")}</span>
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs shrink-0"
                            onClick={() => navigate(isAdmin
                              ? `/admin/providers/${providerId}/${typeToUrlSlug(type)}/${p.id}/edit`
                              : `/${typeToUrlSlug(type)}/${providerId}/${p.id}`)}
                            data-testid={`btn-asrm-fix-${p.id}`}
                          >
                            <Pencil className="w-3 h-3 mr-1" /> Add info
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {belowMin.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs font-heading text-destructive flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {belowMin.length} {belowMin.length === 1 ? "profile is" : "profiles are"} hidden for not meeting the minimums:
                      </p>
                      {belowMin.map(({ p, failures }) => (
                        <div key={p.id} className="rounded-[var(--radius)] bg-destructive/5 px-3 py-1.5 text-xs text-foreground" data-testid={`asrm-warning-below-${p.id}`}>
                          <span className="font-heading">Surrogate #{displayIdOf(p)}</span>
                          <span className="text-muted-foreground"> - {failures.join("; ")}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
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
          <div className="t-helper py-8 text-center">
            No {label.toLowerCase()} records yet. Configure a source URL
            and start syncing to import profiles.
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="t-helper py-8 text-center">
            No {label.toLowerCase()} records match your filters.
          </div>
        ) : (
          <ProfileCardGrid profiles={filteredProfiles} providerId={providerId} type={type} />
        )}
      </div>}
    </div>
  );
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
        <span className="t-helper">{expanded ? "▲" : "▼"} {entries.length} fields</span>
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
                <p className="t-helper">{question}</p>
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
      <h4 className="t-helper font-ui">Full Provider Profile</h4>

      {longTextEntries.map(([key, value]) => (
        <div
          key={key}
          className="py-3 px-4 rounded-[var(--radius)] bg-muted/50 border border-border/50"
          data-testid={`scraped-field-${key.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <p className="t-helper mb-1">{formatFieldLabel(key)}</p>
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
                <p className="t-helper">{formatFieldLabel(key)}</p>
                <p className="text-sm font-ui break-words">{display}</p>
              </div>
            );
          })}
        </div>
      )}

      {imageEntries.map(([key, value]) => (
        <div key={key} data-testid={`scraped-field-${key.toLowerCase().replace(/\s+/g, "-")}`}>
          <p className="t-helper mb-2">{formatFieldLabel(key)}</p>
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
          <h5 className="t-helper font-ui mt-4">Detailed Profile Questionnaire</h5>
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
  // Without this, `confirm` below resolves to window.confirm, which shows a
  // native "[object Object]" dialog instead of the branded confirm bar.
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = (user as any)?.roles?.includes("GOSTORK_ADMIN");
  const isProvider = !!((user as any)?.providerId);
  const canManageProfiles = isAdmin || isProvider;
  const endpoint = TYPE_ENDPOINTS[type];

  const sponsorEntityType = type === "egg-donor" ? "EGG_DONOR" : type === "surrogate" ? "SURROGATE" : "SPERM_DONOR";
  const sponsorshipTabUrl = isAdmin ? `/admin/providers/${providerId}?tab=sponsorship` : `/account/sponsorship`;

  // Campaign mode (Option B): when the provider arrives from a sponsorship via
  // ?sponsor=<id>, every card's Sponsor button adds/removes that profile to THAT
  // specific campaign, with a sticky banner + slot counter.
  const [searchParams] = useSearchParams();
  const campaignId = !isAdmin ? searchParams.get("sponsor") : null;
  const campaignQ = useQuery<any>({
    queryKey: [`/api/sponsorship/campaign/${campaignId}`],
    queryFn: async () => (await apiRequest("GET", `/api/sponsorship/campaign/${campaignId}`)).json(),
    enabled: !!campaignId,
    retry: false,
  });
  const campaign = campaignQ.data && campaignQ.data.slotEntityType === sponsorEntityType ? campaignQ.data : null;
  const campaignItemByEntity = new Map<string, string>((campaign?.items || []).map((it: any) => [it.entityId, it.id]));
  const campaignFull = campaign ? (campaign.slotsUsed ?? 0) >= (campaign.slotsTotal ?? 0) : false;
  const refetchCampaign = () => { campaignQ.refetch(); queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${endpoint}`] }); };

  const handleSponsor = async (profileId: string) => {
    // Campaign mode: toggle this profile in the specific campaign.
    if (campaign) {
      const existingItemId = campaignItemByEntity.get(profileId);
      try {
        if (existingItemId) {
          await apiRequest("DELETE", `/api/sponsorship/${campaign.id}/items/${existingItemId}`);
          toast({ title: "Removed from sponsorship" });
        } else {
          // Slots full: the sticky banner already explains this - don't fire a toast.
          if (campaignFull) return;
          await apiRequest("POST", `/api/sponsorship/${campaign.id}/items`, { entityType: sponsorEntityType, entityId: profileId });
          toast({ title: "Added to sponsorship", variant: "success" });
        }
        refetchCampaign();
      } catch (err: any) {
        toast({ title: "Could not update sponsorship", description: err.message, variant: "destructive" });
      }
      return;
    }
    // No campaign context: add to the first active bundle with a free slot.
    try {
      const listUrl = isAdmin ? `/api/admin/sponsorship?providerId=${providerId}` : `/api/sponsorship/mine`;
      const list = await (await apiRequest("GET", listUrl)).json();
      const bundle = (list || []).find((s: any) => s.status === "ACTIVE" && s.productType === "SLOT_BUNDLE" && s.plan?.slotEntityType === sponsorEntityType && (s.slotsUsed ?? 0) < (s.slotsTotal ?? 0));
      if (!bundle) {
        toast({ title: "No open sponsorship slot", description: "Opening the Sponsorship tab to start or manage a plan." });
        navigate(sponsorshipTabUrl);
        return;
      }
      const body = isAdmin ? { providerId, entityType: sponsorEntityType, entityId: profileId } : { entityType: sponsorEntityType, entityId: profileId };
      const itemsUrl = isAdmin ? `/api/admin/sponsorship/${bundle.id}/items` : `/api/sponsorship/${bundle.id}/items`;
      await apiRequest("POST", itemsUrl, body);
      queryClient.invalidateQueries({ queryKey: [`/api/providers/${providerId}/${endpoint}`] });
      toast({ title: "Profile sponsored", description: `Added to ${bundle.plan?.displayName || "your plan"}.`, variant: "success" });
    } catch (err: any) {
      toast({ title: "Could not sponsor profile", description: err.message, variant: "destructive" });
    }
  };

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

  const updateStatusMutation = useMutation({
    mutationFn: async ({ profileId, status }: { profileId: string; status: string }) => {
      const res = await apiRequest(
        "PATCH",
        `/api/providers/${providerId}/donors/${type}/${profileId}`,
        { status },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/providers/${providerId}/${endpoint}`],
      });
      toast({ title: "Status updated", variant: "success" });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update status", description: err.message, variant: "destructive" });
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
    <>
      {campaign && (
        <div className="sticky top-0 md:top-16 z-40 -mx-1 mb-4 relative overflow-hidden rounded-lg border border-accent/40 bg-card shadow-md">
          {/* Opaque card base + accent tint overlay = readable light-purple bar
              that the scrolling cards underneath can't bleed through. */}
          <div className="pointer-events-none absolute inset-0 bg-accent/10" />
          <div className="relative flex items-center justify-between gap-3 flex-wrap px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm">
              <Sparkles className="w-4 h-4 text-accent" />
              <span className="text-foreground">Selecting profiles for <strong>{campaign.planName}</strong></span>
              <Badge variant="secondary">{campaign.slotsUsed}/{campaign.slotsTotal} slots</Badge>
            </div>
            <p className="text-sm hidden md:block">
              {campaignFull
                ? <span className="text-[hsl(var(--brand-warning))]">All slots filled - remove a profile to add another, or upgrade your tier.</span>
                : <span className="text-foreground inline-flex items-center gap-1.5">
                    Tap the
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius)] border border-primary/30 bg-primary/10 text-primary"><Sparkles className="w-3 h-3" /></span>
                    on a card to add or remove it.
                  </span>}
            </p>
            <Button size="sm" onClick={() => navigate("/account/sponsorship")} data-testid="button-done-selecting">Done</Button>
          </div>
        </div>
      )}
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
      {profiles.map((d: any) => (
        <ProfileCard
          key={d.id}
          profile={d}
          type={type}
          variant="admin"
          showNewBadge={d.status === "AVAILABLE"}
          onNavigate={campaign
            ? () => handleSponsor(d.id)
            : isAdmin
            ? () => navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type)}/${d.id}`)
            : () => navigate(`/${typeToUrlSlug(type)}/${providerId}/${d.id}`)}
          adminControls={canManageProfiles ? {
            isHidden: !!d.hiddenFromSearch,
            isPremium: !!d.isPremium,
            onEdit: isAdmin ? (profileId) => navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type)}/${profileId}/edit`) : undefined,
            onDelete: d.externalId?.startsWith("pdf-")
              ? async (profileId) => {
                  const ok = await confirm({
                    title: "Delete this profile?",
                    message: "This action cannot be undone. The profile will be permanently removed from your database.",
                    confirmLabel: "Delete",
                    tone: "destructive",
                  });
                  if (ok) deleteProfileMutation.mutate(profileId);
                }
              : undefined,
            onToggleVisibility: (profileId, hidden) => toggleVisibilityMutation.mutate({ profileId, hidden }),
            onTogglePremium: (profileId, premium) => togglePremiumMutation.mutate({ profileId, premium }),
            status: d.status,
            onSetStatus: (profileId, status) => updateStatusMutation.mutate({ profileId, status }),
            statusUpdating: updateStatusMutation.isPending && updateStatusMutation.variables?.profileId === d.id,
            onSponsor: handleSponsor,
            sponsored: campaign ? campaignItemByEntity.has(d.id) : (!!d.sponsoredUntil && new Date(d.sponsoredUntil).getTime() > Date.now()),
          } : undefined}
        />
      ))}

    </div>
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    AVAILABLE: "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success)/0.3)]",
    PENDING: "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)]",
    MATCHED: "bg-accent/15 text-accent-foreground border-accent/30",
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
