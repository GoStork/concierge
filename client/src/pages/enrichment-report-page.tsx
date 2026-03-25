import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, CheckCircle2, XCircle, Globe, Phone, FileText, Image, Users, Activity, RefreshCw, RotateCcw, StopCircle, SearchX, UserSearch, ImageOff, FileQuestion, PhoneOff } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminReportLayout } from "@/components/admin-report-layout";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface EnrichmentReportData {
  job: {
    year: number;
    enrichmentStatus: string | null;
    enrichmentProcessed: number;
    enrichmentTotal: number;
    enrichmentErrors: number;
    enrichmentSkipped: number;
    enrichmentErrorMessage: string | null;
    completedAt: string | null;
    startedAt: string | null;
  };
  coverage: {
    totalClinics: number;
    withWebsite: number;
    withPhone: number;
    withAbout: number;
    withLogo: number;
    withTeam: number;
  };
  missingWebsite: {
    id: string;
    name: string;
    city: string | null;
    state: string | null;
  }[];
  recentResults?: {
    name: string;
    foundWebsite: boolean;
    websiteUrl: string | null;
    hasPhone: boolean;
    hasAbout: boolean;
    hasLogo: boolean;
    teamCount: number;
    locationCount: number;
  }[];
}

function CoverageBar({ label, icon, count, total }: { label: string; icon: React.ReactNode; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;

  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-center gap-2 mb-2">
          {icon}
          <span className="text-sm font-ui">{label}</span>
        </div>
        <div className="flex items-end gap-2 mb-2">
          <span className="text-2xl font-heading">{count}</span>
          <span className="text-sm text-muted-foreground mb-0.5">/ {total} ({pct}%)</span>
        </div>
        <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
          <div
            className="h-2 rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${pct}%`,
              backgroundColor: pct >= 80 ? "hsl(var(--success))" : pct >= 50 ? "hsl(var(--warning))" : "hsl(var(--error))",
            }}
            data-testid={`coverage-bar-${label.toLowerCase().replace(/\s/g, "-")}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default function EnrichmentReportPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [isResuming, setIsResuming] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRestartingSkipped, setIsRestartingSkipped] = useState(false);
  const [isRestartingTeam, setIsRestartingTeam] = useState(false);
  const [isRestartingLogo, setIsRestartingLogo] = useState(false);
  const [isRestartingAbout, setIsRestartingAbout] = useState(false);
  const [isRestartingPhone, setIsRestartingPhone] = useState(false);

  const { data, isLoading } = useQuery<EnrichmentReportData>({
    queryKey: ["/api/scrapers/cdc-syncs", id, "enrichment-report"],
    queryFn: async () => {
      const res = await fetch(`/api/scrapers/cdc-syncs/${id}/enrichment-report`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load report");
      return res.json();
    },
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.job?.enrichmentStatus;
      return status === "PROCESSING" || status === "PENDING" ? 5000 : false;
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs", id, "enrichment-report"] });
    queryClient.invalidateQueries({ queryKey: ["/api/scrapers/cdc-syncs"] });
  };

  const handleResume = async () => {
    setIsResuming(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/enrich`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment resumed", variant: "success" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to resume", description: err.message, variant: "destructive" });
    } finally {
      setIsResuming(false);
    }
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/enrich?restart=true`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment restarted from scratch", variant: "success" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to restart", description: err.message, variant: "destructive" });
    } finally {
      setIsRestarting(false);
    }
  };

  const handleRestartSkipped = async () => {
    setIsRestartingSkipped(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/enrich?mode=skipped`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment started for skipped clinics", description: "Re-processing clinics without a website URL", variant: "success" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to start", description: err.message, variant: "destructive" });
    } finally {
      setIsRestartingSkipped(false);
    }
  };

  const handleRestartTeam = async () => {
    setIsRestartingTeam(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/enrich?mode=team`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment started for team members", description: "Re-processing clinics without team members", variant: "success" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to start", description: err.message, variant: "destructive" });
    } finally {
      setIsRestartingTeam(false);
    }
  };

  const handleRestartLogo = async () => {
    setIsRestartingLogo(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/enrich?mode=logo`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment started for logos", description: "Re-processing clinics without a logo", variant: "success" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to start", description: err.message, variant: "destructive" });
    } finally {
      setIsRestartingLogo(false);
    }
  };

  const handleRestartAbout = async () => {
    setIsRestartingAbout(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/enrich?mode=about`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment started for about text", description: "Re-processing clinics without about information", variant: "success" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to start", description: err.message, variant: "destructive" });
    } finally {
      setIsRestartingAbout(false);
    }
  };

  const handleRestartPhone = async () => {
    setIsRestartingPhone(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/enrich?mode=phone`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment started for phone numbers", description: "Re-processing clinics without a phone number", variant: "success" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to start", description: err.message, variant: "destructive" });
    } finally {
      setIsRestartingPhone(false);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      const res = await apiRequest("POST", `/api/scrapers/cdc-syncs/${id}/cancel-enrichment`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Unknown error" }));
        throw new Error(err.message);
      }
      toast({ title: "Enrichment cancelled", variant: "warning" });
      invalidate();
    } catch (err: any) {
      toast({ title: "Failed to cancel", description: err.message, variant: "destructive" });
    } finally {
      setIsCancelling(false);
    }
  };

  const isLive = data?.job?.enrichmentStatus === "PROCESSING" || data?.job?.enrichmentStatus === "PENDING";
  const pct = data?.job && data.job.enrichmentTotal > 0
    ? Math.round((data.job.enrichmentProcessed / data.job.enrichmentTotal) * 100)
    : 0;

  if (isLoading) {
    return (
      <AdminReportLayout
        breadcrumbs={[
          { label: "Scrapers", href: "/admin/scrapers" },
          { label: "Enrichment Report" },
        ]}
        title="Enrichment Report"
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
          { label: "Enrichment Report" },
        ]}
        title="Enrichment Report"
      >
        <p className="text-muted-foreground text-sm" data-testid="text-no-report">Report not found.</p>
      </AdminReportLayout>
    );
  }

  const { job, coverage, missingWebsite, recentResults } = data;
  const succeeded = job.enrichmentProcessed - job.enrichmentErrors - job.enrichmentSkipped;

  return (
    <AdminReportLayout
      breadcrumbs={[
        { label: "Scrapers", href: "/admin/scrapers" },
        { label: `Enrichment — ${job.year}` },
      ]}
      title={`Enrichment Report — ${job.year}`}
      subtitle={`Status: ${job.enrichmentStatus || "Not started"}`}
    >
      {!isLive && (job.enrichmentStatus === "COMPLETED" || job.enrichmentStatus === "FAILED" || !job.enrichmentStatus) && (
        <div className="flex flex-wrap items-center gap-2" data-testid="enrichment-actions">
          {job.enrichmentStatus === "FAILED" && job.enrichmentProcessed > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleResume}
              disabled={isResuming || isRestarting}
              data-testid="button-resume-enrichment"
            >
              {isResuming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Resume
            </Button>
          )}
          {(() => {
            const anyBusy = isResuming || isRestarting || isRestartingSkipped || isRestartingTeam || isRestartingLogo || isRestartingAbout || isRestartingPhone;
            return (
              <>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRestart} disabled={anyBusy} data-testid="button-restart-enrichment">
                  {isRestarting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  Restart
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRestartSkipped} disabled={anyBusy} data-testid="button-restart-skipped">
                  {isRestartingSkipped ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SearchX className="w-3.5 h-3.5" />}
                  Restart Skipped
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRestartTeam} disabled={anyBusy} data-testid="button-restart-team">
                  {isRestartingTeam ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserSearch className="w-3.5 h-3.5" />}
                  Restart Team Members
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRestartLogo} disabled={anyBusy} data-testid="button-restart-logo">
                  {isRestartingLogo ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageOff className="w-3.5 h-3.5" />}
                  Restart Logo
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRestartAbout} disabled={anyBusy} data-testid="button-restart-about">
                  {isRestartingAbout ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileQuestion className="w-3.5 h-3.5" />}
                  Restart About
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRestartPhone} disabled={anyBusy} data-testid="button-restart-phone">
                  {isRestartingPhone ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneOff className="w-3.5 h-3.5" />}
                  Restart Phone
                </Button>
              </>
            );
          })()}
        </div>
      )}

      {isLive && (
        <div className="flex items-center gap-2" data-testid="enrichment-actions-live">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={handleCancel}
            disabled={isCancelling}
            data-testid="button-cancel-enrichment"
          >
            {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
            Cancel
          </Button>
        </div>
      )}

      {isLive && (
        <div className="rounded-[var(--radius)] border border-primary/20 bg-primary/5 p-4 space-y-3" data-testid="enrichment-live-banner">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary animate-pulse" />
            <span className="text-sm font-heading text-primary">Live — Enrichment in Progress</span>
            <span className="ml-auto text-xs text-muted-foreground">Auto-refreshing every 5s</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {job.enrichmentProcessed} / {job.enrichmentTotal} clinics processed
              </span>
              <span className="font-ui">{pct}%</span>
            </div>
            <Progress value={pct} className="h-2" data-testid="enrichment-live-progress" />
            {(job.enrichmentErrors > 0 || job.enrichmentSkipped > 0) && (
              <div className="text-xs text-muted-foreground space-x-3">
                {job.enrichmentSkipped > 0 && (
                  <span className="text-warning">{job.enrichmentSkipped} skipped (no website found)</span>
                )}
                {job.enrichmentErrors > 0 && (
                  <span className="text-error">{job.enrichmentErrors} error{job.enrichmentErrors !== 1 ? "s" : ""}</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 md:gap-4" data-testid="enrichment-summary-stats">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading" data-testid="stat-processed">
              {job.enrichmentProcessed}
            </div>
            <div className="text-xs text-muted-foreground">Processed</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading text-[hsl(var(--brand-success))]" data-testid="stat-succeeded">
              {succeeded}
            </div>
            <div className="text-xs text-muted-foreground">Succeeded</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading text-warning" data-testid="stat-skipped">
              {job.enrichmentSkipped}
            </div>
            <div className="text-xs text-muted-foreground">Skipped</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="text-2xl font-heading text-destructive" data-testid="stat-errors">
              {job.enrichmentErrors}
            </div>
            <div className="text-xs text-muted-foreground">Errors</div>
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="text-lg font-heading mb-3">Field Coverage</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="coverage-grid">
          <CoverageBar
            label="Website"
            icon={<Globe className="w-4 h-4 text-primary" />}
            count={coverage.withWebsite}
            total={coverage.totalClinics}
          />
          <CoverageBar
            label="Phone"
            icon={<Phone className="w-4 h-4 text-primary" />}
            count={coverage.withPhone}
            total={coverage.totalClinics}
          />
          <CoverageBar
            label="About"
            icon={<FileText className="w-4 h-4 text-primary" />}
            count={coverage.withAbout}
            total={coverage.totalClinics}
          />
          <CoverageBar
            label="Logo"
            icon={<Image className="w-4 h-4 text-primary" />}
            count={coverage.withLogo}
            total={coverage.totalClinics}
          />
          <CoverageBar
            label="Team Members"
            icon={<Users className="w-4 h-4 text-primary" />}
            count={coverage.withTeam}
            total={coverage.totalClinics}
          />
        </div>
      </div>

      {recentResults && recentResults.length > 0 && (
        <div data-testid="recent-results-section">
          <h3 className="text-lg font-heading mb-3 flex items-center gap-2">
            {isLive && <Activity className="w-4 h-4 text-primary animate-pulse" />}
            Enrichment Results ({recentResults.length} clinics)
          </h3>
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Clinic</TableHead>
                  <TableHead className="text-center">Website</TableHead>
                  <TableHead className="text-center hidden sm:table-cell">Phone</TableHead>
                  <TableHead className="text-center hidden sm:table-cell">About</TableHead>
                  <TableHead className="text-center hidden md:table-cell">Logo</TableHead>
                  <TableHead className="text-center hidden md:table-cell">Team</TableHead>
                  <TableHead className="text-center hidden md:table-cell">Locations</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentResults.map((r, i) => (
                  <TableRow key={i} data-testid={`row-recent-${i}`}>
                    <TableCell className="text-sm">
                      <div className="font-ui">{r.name}</div>
                      {r.websiteUrl && (
                        <a
                          href={r.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline truncate block max-w-[200px]"
                          data-testid={`link-website-${i}`}
                        >
                          {r.websiteUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                        </a>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      {r.foundWebsite ? (
                        <CheckCircle2 className="w-4 h-4 text-success mx-auto" />
                      ) : (
                        <XCircle className="w-4 h-4 text-error mx-auto" />
                      )}
                    </TableCell>
                    <TableCell className="text-center hidden sm:table-cell">
                      {r.hasPhone ? (
                        <CheckCircle2 className="w-4 h-4 text-success mx-auto" />
                      ) : (
                        <XCircle className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                      )}
                    </TableCell>
                    <TableCell className="text-center hidden sm:table-cell">
                      {r.hasAbout ? (
                        <CheckCircle2 className="w-4 h-4 text-success mx-auto" />
                      ) : (
                        <XCircle className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                      )}
                    </TableCell>
                    <TableCell className="text-center hidden md:table-cell">
                      {r.hasLogo ? (
                        <CheckCircle2 className="w-4 h-4 text-success mx-auto" />
                      ) : (
                        <XCircle className="w-4 h-4 text-muted-foreground/40 mx-auto" />
                      )}
                    </TableCell>
                    <TableCell className="text-center hidden md:table-cell">
                      <span className={`text-xs font-ui ${r.teamCount > 0 ? "text-success" : "text-muted-foreground/40"}`}>
                        {r.teamCount}
                      </span>
                    </TableCell>
                    <TableCell className="text-center hidden md:table-cell">
                      <span className={`text-xs font-ui ${r.locationCount > 0 ? "text-success" : "text-muted-foreground/40"}`}>
                        {r.locationCount}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      {job.enrichmentErrorMessage && (
        <div className="space-y-2" data-testid="enrichment-error-section">
          <h3 className="text-sm font-ui text-error flex items-center gap-1">
            <XCircle className="w-4 h-4" />
            Enrichment Error
          </h3>
          <div className="bg-error/5 dark:bg-error/10 rounded-[var(--radius)] border border-error/20 dark:border-error/30 p-4">
            <p className="text-sm text-error dark:text-error/80">{job.enrichmentErrorMessage}</p>
          </div>
        </div>
      )}

      {missingWebsite.length > 0 && (
        <div data-testid="missing-website-section">
          <h3 className="text-lg font-heading mb-3">
            Clinics Missing Website ({missingWebsite.length})
          </h3>
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Clinic Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {missingWebsite.map((clinic) => (
                  <TableRow key={clinic.id} data-testid={`row-missing-${clinic.id}`}>
                    <TableCell className="font-ui text-sm">{clinic.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground hidden sm:table-cell">
                      {[clinic.city, clinic.state].filter(Boolean).join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      {missingWebsite.length === 0 && job.enrichmentStatus === "COMPLETED" && (
        <div className="flex items-center gap-2 text-success bg-success/5 dark:bg-success/10 rounded-[var(--radius)] p-4 border border-success/20 dark:border-success/30" data-testid="enrichment-complete-success">
          <CheckCircle2 className="w-5 h-5" />
          <span className="text-sm font-ui">All clinics have a website URL populated.</span>
        </div>
      )}
    </AdminReportLayout>
  );
}
