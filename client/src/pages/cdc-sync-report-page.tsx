import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, CheckCircle2, XCircle, Database, Clock, BarChart3, Activity, RefreshCw, RotateCcw, StopCircle, Plus, MinusCircle, Pencil, Check, X, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminReportLayout } from "@/components/admin-report-layout";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface CdcSyncReportData {
  job: {
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
  };
  stats: {
    totalSuccessRates: number;
    profileBreakdown: { profileType: string; count: number }[];
  };
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "In progress";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

interface ClinicEntry {
  providerId: string;
  name: string;
  city: string | null;
  state: string | null;
  totalRecords: number;
  totalCycles: number;
  hasOwnEggs: boolean;
  hasDonor: boolean;
}

interface DisappearedClinic {
  providerId: string;
  name: string;
  city: string | null;
  state: string | null;
  websiteUrl: string | null;
}

interface CdcClinicResultsData {
  year: number;
  totalClinics: number;
  withOwnEggs: number;
  withDonorEggs: number;
  totalSuccessRateRecords: number;
  clinics: ClinicEntry[];
  newClinics: ClinicEntry[];
  disappearedClinics: DisappearedClinic[];
}

function DisappearedClinicsSection({ clinics, syncId, navigate }: { clinics: DisappearedClinic[]; syncId: string; navigate: (path: string) => void }) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const updateWebsite = useMutation({
    mutationFn: async ({ providerId, websiteUrl }: { providerId: string; websiteUrl: string }) => {
      const res = await apiRequest("PATCH", `/api/scrapers/cdc-syncs/${syncId}/clinic/${providerId}/website`, { websiteUrl });
      if (!res.ok) throw new Error("Failed to update website");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Website URL updated", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs", syncId, "clinic-results"] });
      setEditingId(null);
    },
    onError: (err: any) => {
      toast({ title: "Failed to update", description: err.message, variant: "destructive" });
    },
  });

  if (clinics.length === 0) {
    return (
      <div data-testid="cdc-disappeared-clinics-empty">
        <h3 className="text-lg font-heading mb-2 flex items-center gap-2">
          <MinusCircle className="w-5 h-5 text-warning" />
          Clinics No Longer in CDC Data
        </h3>
        <p className="text-sm text-muted-foreground italic">None - all previous clinics are still present.</p>
      </div>
    );
  }

  return (
    <div data-testid="cdc-disappeared-clinics-section">
      <h3 className="text-lg font-heading mb-3 flex items-center gap-2">
        <MinusCircle className="w-5 h-5 text-warning" />
        Clinics No Longer in CDC Data
        <span className="text-sm font-normal text-muted-foreground">({clinics.length})</span>
      </h3>
      <Card className="overflow-hidden border-warning/30">
        <Table>
          <TableHeader>
            <TableRow className="bg-warning/5">
              <TableHead>Clinic</TableHead>
              <TableHead>Website</TableHead>
              <TableHead className="w-[80px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clinics.map((clinic, i) => (
              <TableRow
                key={clinic.providerId}
                className="cursor-pointer hover:bg-muted/50"
                data-testid={`row-disappeared-clinic-${i}`}
              >
                <TableCell
                  className="text-sm"
                  onClick={() => navigate(`/admin/scrapers/cdc-sync/${syncId}/clinic/${clinic.providerId}`)}
                >
                  <div className="font-ui">{clinic.name}</div>
                  {(clinic.city || clinic.state) && (
                    <div className="text-xs text-muted-foreground">
                      {[clinic.city, clinic.state].filter(Boolean).join(", ")}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-sm" onClick={(e) => e.stopPropagation()}>
                  {editingId === clinic.providerId ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="url"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        placeholder="https://..."
                        className="flex-1 px-2 py-1 text-sm border rounded bg-background min-w-[200px]"
                        autoFocus
                        data-testid={`input-website-${i}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-success"
                        onClick={() => updateWebsite.mutate({ providerId: clinic.providerId, websiteUrl: editValue })}
                        disabled={updateWebsite.isPending}
                        data-testid={`button-save-website-${i}`}
                      >
                        {updateWebsite.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground"
                        onClick={() => setEditingId(null)}
                        data-testid={`button-cancel-website-${i}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {clinic.websiteUrl ? (
                        <a
                          href={clinic.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline flex items-center gap-1 truncate max-w-[250px]"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`link-website-${i}`}
                        >
                          {clinic.websiteUrl.replace(/^https?:\/\//, "")}
                          <ExternalLink className="w-3 h-3 flex-shrink-0" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground italic text-xs">No website</span>
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  {editingId !== clinic.providerId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 text-xs"
                      onClick={() => {
                        setEditingId(clinic.providerId);
                        setEditValue(clinic.websiteUrl || "");
                      }}
                      data-testid={`button-edit-website-${i}`}
                    >
                      <Pencil className="w-3 h-3" />
                      Edit
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

export default function CdcSyncReportPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isResuming, setIsResuming] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const { data, isLoading } = useQuery<CdcSyncReportData>({
    queryKey: ["/api/scrapers/cdc-syncs", id, "report"],
    queryFn: async () => {
      const res = await fetch(`/api/scrapers/cdc-syncs/${id}/report`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.job?.status;
      return status === "PROCESSING" || status === "PENDING" ? 5000 : false;
    },
  });

  const { data: clinicResults } = useQuery<CdcClinicResultsData>({
    queryKey: ["/api/scrapers/cdc-syncs", id, "clinic-results"],
    queryFn: async () => {
      const res = await fetch(`/api/scrapers/cdc-syncs/${id}/clinic-results`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load clinic results");
      return res.json();
    },
    enabled: !!id && data?.job?.status === "COMPLETED",
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs", id, "report"] });
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs", id, "clinic-results"] });
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleResume = async () => {
    if (!data?.job) return;
    setIsResuming(true);
    try {
      const res = await apiRequest("POST", "/api/scrapers/cdc-syncs/trigger", { year: data.job.year });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      const newJob = await res.json();
      toast({ title: "CDC sync resumed", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
      navigate(`/admin/scrapers/cdc-sync/${newJob.id}/report`, { replace: true });
    } catch (err: any) {
      toast({ title: "Failed to resume", description: err.message, variant: "destructive" });
    } finally {
      setIsResuming(false);
    }
  };

  const handleRestart = async () => {
    if (!data?.job) return;
    setIsRestarting(true);
    try {
      const res = await apiRequest("POST", "/api/scrapers/cdc-syncs/trigger", { year: data.job.year });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      const newJob = await res.json();
      toast({ title: "CDC sync restarted", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
      navigate(`/admin/scrapers/cdc-sync/${newJob.id}/report`, { replace: true });
    } catch (err: any) {
      toast({ title: "Failed to restart", description: err.message, variant: "destructive" });
    } finally {
      setIsRestarting(false);
    }
  };

  const handleCancel = async () => {
    if (!data?.job) return;
    setIsCancelling(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/cancel`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "CDC sync cancelled", variant: "warning" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to cancel", description: err.message, variant: "destructive" });
    } finally {
      setIsCancelling(false);
    }
  };

  const isLive = data?.job?.status === "PROCESSING" || data?.job?.status === "PENDING";
  const pct = data?.job && data.job.estimatedTotalRecords && data.job.estimatedTotalRecords > 0
    ? Math.min(99, Math.round((data.job.recordsProcessed / data.job.estimatedTotalRecords) * 100))
    : 0;

  if (isLoading) {
    return (
      <AdminReportLayout
        breadcrumbs={[
          { label: "Scrapers", href: "/admin/scrapers" },
          { label: "CDC Sync Report" },
        ]}
        title="CDC Sync Report"
      >
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </AdminReportLayout>
    );
  }

  if (!data) {
    return (
      <AdminReportLayout
        breadcrumbs={[
          { label: "Scrapers", href: "/admin/scrapers" },
          { label: "CDC Sync Report" },
        ]}
        title="CDC Sync Report"
      >
        <p className="text-muted-foreground text-sm" data-testid="text-no-report">Report not found.</p>
      </AdminReportLayout>
    );
  }

  const { job, stats } = data;

  return (
    <AdminReportLayout
      breadcrumbs={[
        { label: "Scrapers", href: "/admin/scrapers" },
        { label: `CDC Sync - ${job.year}` },
      ]}
      title={`CDC Sync Report - ${job.year}`}
      subtitle={`Status: ${job.status}`}
    >
      {!isLive && (job.status === "COMPLETED" || job.status === "FAILED") && (
        <div className="flex items-center gap-2" data-testid="cdc-sync-actions">
          {job.status === "FAILED" && job.clinicsProcessed > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleResume}
              disabled={isResuming || isRestarting}
              data-testid="button-resume-cdc-sync"
            >
              {isResuming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Resume
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleRestart}
            disabled={isResuming || isRestarting}
            data-testid="button-restart-cdc-sync"
          >
            {isRestarting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Restart
          </Button>
        </div>
      )}

      {isLive && (
        <div className="flex items-center gap-2" data-testid="cdc-sync-actions-live">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive border-destructive/30"
            onClick={handleCancel}
            disabled={isCancelling}
            data-testid="button-cancel-cdc-sync"
          >
            {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
            Cancel
          </Button>
        </div>
      )}

      {isLive && (
        <div className="rounded-[var(--radius)] border border-primary/20 bg-primary/5 p-4 space-y-3" data-testid="cdc-sync-live-banner">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary animate-pulse" />
            <span className="text-sm font-heading text-primary">Live - CDC Sync in Progress</span>
            <span className="ml-auto text-xs text-muted-foreground">Auto-refreshing every 5s</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {job.recordsProcessed.toLocaleString()} / {(job.estimatedTotalRecords || 0).toLocaleString()} records processed
              </span>
              <span className="font-ui">{pct}%</span>
            </div>
            <Progress value={pct} className="h-2" data-testid="cdc-sync-live-progress" />
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 md:gap-4" data-testid="cdc-report-stats">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading" data-testid="stat-clinics-processed">
              {job.clinicsProcessed.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">Clinics Processed</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading" data-testid="stat-records-processed">
              {job.recordsProcessed.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">Records Processed</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading" data-testid="stat-success-rates">
              {stats.totalSuccessRates.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">Success Rates</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading" data-testid="stat-duration">
              {formatDuration(job.startedAt, job.completedAt)}
            </div>
            <div className="text-xs text-muted-foreground">Duration</div>
          </CardContent>
        </Card>
      </div>

      {job.errorMessage && (
        <div className="space-y-2" data-testid="cdc-report-error">
          <h3 className="text-sm font-ui text-error flex items-center gap-1">
            <XCircle className="w-4 h-4" />
            Sync Error
          </h3>
          <div className="bg-error/5 dark:bg-error/10 rounded-[var(--radius)] border border-error/20 dark:border-error/30 p-4">
            <p className="text-sm text-error dark:text-error/80">{job.errorMessage}</p>
          </div>
        </div>
      )}

      {!job.errorMessage && job.status === "COMPLETED" && (
        <div className="flex items-center gap-2 text-success bg-success/5 dark:bg-success/10 rounded-[var(--radius)] p-4 border border-success/20 dark:border-success/30" data-testid="cdc-report-success">
          <CheckCircle2 className="w-5 h-5" />
          <span className="text-sm font-ui">Sync completed successfully with {job.clinicsProcessed.toLocaleString()} clinics and {stats.totalSuccessRates.toLocaleString()} success rate records.</span>
        </div>
      )}

      {clinicResults && clinicResults.clinics.length > 0 && (
        <>
          <div data-testid="cdc-clinic-results-section">
            <h3 className="text-lg font-heading mb-3">
              Clinic Results ({clinicResults.clinics.length} clinics)
            </h3>
            <Card className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Clinic</TableHead>
                    <TableHead className="text-center">Records</TableHead>
                    <TableHead className="text-center">Cycles</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clinicResults.clinics.map((clinic, i) => (
                    <TableRow
                      key={clinic.providerId}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate(`/admin/scrapers/cdc-sync/${id}/clinic/${clinic.providerId}`)}
                      data-testid={`row-clinic-${i}`}
                    >
                      <TableCell className="text-sm">
                        <div className="font-ui">{clinic.name}</div>
                        {(clinic.city || clinic.state) && (
                          <div className="text-xs text-muted-foreground">
                            {[clinic.city, clinic.state].filter(Boolean).join(", ")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {clinic.totalRecords.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {clinic.totalCycles.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>

          {clinicResults.newClinics && clinicResults.newClinics.length > 0 && (
            <div data-testid="cdc-new-clinics-section">
              <h3 className="text-lg font-heading mb-3 flex items-center gap-2">
                <Plus className="w-5 h-5 text-success" />
                New Clinics for This Year
                <span className="text-sm font-normal text-muted-foreground">({clinicResults.newClinics.length})</span>
              </h3>
              <Card className="overflow-hidden border-success/30">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-success/5">
                      <TableHead>Clinic</TableHead>
                      <TableHead className="text-center">Records</TableHead>
                      <TableHead className="text-center">Cycles</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {clinicResults.newClinics.map((clinic, i) => (
                      <TableRow
                        key={clinic.providerId}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => navigate(`/admin/scrapers/cdc-sync/${id}/clinic/${clinic.providerId}`)}
                        data-testid={`row-new-clinic-${i}`}
                      >
                        <TableCell className="text-sm">
                          <div className="font-ui">{clinic.name}</div>
                          {(clinic.city || clinic.state) && (
                            <div className="text-xs text-muted-foreground">
                              {[clinic.city, clinic.state].filter(Boolean).join(", ")}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-center text-sm">
                          {clinic.totalRecords.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-center text-sm">
                          {clinic.totalCycles.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </div>
          )}

          {clinicResults.newClinics && clinicResults.newClinics.length === 0 && (
            <div data-testid="cdc-new-clinics-empty">
              <h3 className="text-lg font-heading mb-2 flex items-center gap-2">
                <Plus className="w-5 h-5 text-success" />
                New Clinics for This Year
              </h3>
              <p className="text-sm text-muted-foreground italic">None - all clinics were present in previous years.</p>
            </div>
          )}

          <DisappearedClinicsSection
            clinics={clinicResults.disappearedClinics || []}
            syncId={id!}
            navigate={navigate}
          />
        </>
      )}
    </AdminReportLayout>
  );
}
