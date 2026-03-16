import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Inject,
  UseGuards,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import {
  getScrapersSummary,
  runNightlySync,
  getNightlySyncStatus,
  analyzeMissingFields,
  getSyncJob,
  getActiveSyncJob,
  getLatestCompletedSyncJob,
  startSync,
  cancelSync,
  deleteAllDonors,
  type DonorType,
} from "./profile-sync.service";
import { CdcSyncService } from "./cdc-sync.service";
import { ClinicEnrichmentService } from "./clinic-enrichment.service";

function requireAdmin(req: any) {
  const user = req.user;
  if (!user?.roles?.includes("GOSTORK_ADMIN")) {
    throw new ForbiddenException("Only GoStork admins can access scrapers");
  }
}

@ApiTags("Scrapers")
@Controller("api/scrapers")
@UseGuards(SessionOrJwtGuard)
export class ScrapersController {
  private cdcSyncService: CdcSyncService;
  private clinicEnrichmentService: ClinicEnrichmentService;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storageService: StorageService,
  ) {
    this.cdcSyncService = new CdcSyncService(prisma);
    this.clinicEnrichmentService = new ClinicEnrichmentService(prisma);
    this.resumeInterruptedProcesses();
  }

  private async resumeInterruptedProcesses() {
    await this.resumeInterruptedEnrichments();
    await this.resumeInterruptedDonorSyncs();
  }

  private async resumeInterruptedEnrichments() {
    try {
      const staleJobs = await this.prisma.cdcSyncJob.findMany({
        where: { enrichmentStatus: { in: ["PROCESSING", "PENDING"] } },
        select: { id: true, year: true, enrichmentProcessed: true, enrichmentTotal: true, enrichmentSkipped: true },
      });

      for (const job of staleJobs) {
        console.log(`[CDC Sync] Auto-resuming enrichment for job ${job.id} (year ${job.year}) — was at ${job.enrichmentProcessed}/${job.enrichmentTotal}`);
        this.clinicEnrichmentService.runEnrichment(job.id);
      }
    } catch (err) {
      console.error("[CDC Sync] Failed to auto-resume enrichments:", err);
    }
  }

  private async resumeInterruptedDonorSyncs() {
    try {
      const syncTypes: { table: "eggDonorSyncConfig" | "surrogateSyncConfig" | "spermDonorSyncConfig"; type: DonorType }[] = [
        { table: "eggDonorSyncConfig", type: "egg-donor" },
        { table: "surrogateSyncConfig", type: "surrogate" },
        { table: "spermDonorSyncConfig", type: "sperm-donor" },
      ];

      const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

      for (const { table, type } of syncTypes) {
        const interrupted = await (this.prisma[table] as any).findMany({
          where: {
            lastSyncStartedAt: { gt: staleThreshold },
            lastSyncEndedAt: null,
          },
          select: { providerId: true, provider: { select: { name: true } } },
        });

        for (const config of interrupted) {
          console.log(`[Donor Sync] Auto-resuming ${type} sync for "${config.provider?.name || config.providerId}"`);
          startSync(this.prisma, config.providerId, type, undefined, this.storageService).catch((err: any) => {
            console.error(`[Donor Sync] Failed to auto-resume ${type} sync for ${config.providerId}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error("[Donor Sync] Failed to auto-resume donor syncs:", err);
    }
  }

  @Get("summary")
  @ApiOperation({ summary: "Get scrapers summary for all providers (admin only)" })
  async getSummary(@Req() req: any) {
    requireAdmin(req);
    return getScrapersSummary(this.prisma);
  }

  @Post("trigger-nightly")
  @ApiOperation({ summary: "Manually trigger nightly sync for all providers (admin only)" })
  async triggerNightly(@Req() req: any) {
    requireAdmin(req);
    const status = getNightlySyncStatus();
    if (status.isRunning) {
      return { message: "Nightly sync is already running", isRunning: true };
    }
    runNightlySync(this.prisma, this.storageService);
    return { message: "Nightly sync started", isRunning: true };
  }

  @Post("trigger-sync/:providerId/:type")
  @ApiOperation({ summary: "Trigger sync for a single provider (admin only)" })
  async triggerSingleSync(
    @Req() req: any,
    @Param("providerId") providerId: string,
    @Param("type") type: string,
    @Query("limit") limitStr?: string,
  ) {
    requireAdmin(req);
    const validTypes = ["egg-donor", "surrogate", "sperm-donor"];
    if (!validTypes.includes(type)) {
      throw new BadRequestException("Invalid sync type");
    }
    const existing = getActiveSyncJob(providerId, type as DonorType);
    if (existing) {
      throw new BadRequestException("A sync is already running for this provider");
    }
    const profileLimit = limitStr ? parseInt(limitStr, 10) : undefined;
    const jobId = await startSync(this.prisma, providerId, type as DonorType, profileLimit, this.storageService);
    return { message: "Sync started", jobId };
  }

  @Post("stop-sync/:providerId/:type")
  @ApiOperation({ summary: "Stop a running sync for a provider (admin only)" })
  async stopSync(
    @Req() req: any,
    @Param("providerId") providerId: string,
    @Param("type") type: string,
  ) {
    requireAdmin(req);
    const validTypes = ["egg-donor", "surrogate", "sperm-donor"];
    if (!validTypes.includes(type)) {
      throw new BadRequestException("Invalid sync type");
    }
    const cancelled = cancelSync(providerId, type as DonorType);
    if (!cancelled) {
      throw new BadRequestException("No running sync found for this provider");
    }
    return { message: "Sync stopped" };
  }

  @Delete("donors/:providerId/:type")
  @ApiOperation({ summary: "Delete all donors of a type for a provider (admin only)" })
  async deleteDonors(
    @Req() req: any,
    @Param("providerId") providerId: string,
    @Param("type") type: string,
  ) {
    requireAdmin(req);
    const validTypes = ["egg-donor", "surrogate", "sperm-donor"];
    if (!validTypes.includes(type)) {
      throw new BadRequestException("Invalid sync type");
    }
    const count = await deleteAllDonors(this.prisma, providerId, type as DonorType);
    return { message: `Deleted ${count} ${type} profiles`, count };
  }

  @Get("nightly-status")
  @ApiOperation({ summary: "Get nightly sync status (admin only)" })
  async getNightlyStatus(@Req() req: any) {
    requireAdmin(req);
    return getNightlySyncStatus();
  }

  @Get("report/:providerId/:type")
  @ApiOperation({ summary: "Get detailed sync report for a provider (admin only)" })
  async getReport(
    @Req() req: any,
    @Param("providerId") providerId: string,
    @Param("type") type: string,
  ) {
    requireAdmin(req);
    const validTypes = ["egg-donor", "surrogate", "sperm-donor"];
    if (!validTypes.includes(type)) {
      throw new BadRequestException("Invalid sync type");
    }

    const missingFields = await analyzeMissingFields(this.prisma, providerId, type as DonorType);

    const donorTable = type === "egg-donor" ? "eggDonor" : type === "surrogate" ? "surrogate" : "spermDonor";
    const totalProfiles = await (this.prisma[donorTable] as any).count({ where: { providerId } });

    const nightlyStatus = getNightlySyncStatus();
    const nightlyResult = nightlyStatus.results.find(
      (r: any) => r.providerId === providerId && r.type === type
    );

    let lastSyncErrors: string[] = [];
    let lastSyncStats: { succeeded: number; failed: number; total: number } | null = null;
    let lastSyncAt: Date | null = null;
    let staleDonorsMarked = 0;
    let newProfiles = 0;
    let lastSyncStartedAt: Date | null = null;
    let lastSyncEndedAt: Date | null = null;

    const syncConfigTable = type === "egg-donor" ? "eggDonorSyncConfig" : type === "surrogate" ? "surrogateSyncConfig" : "spermDonorSyncConfig";
    const syncConfig = await (this.prisma[syncConfigTable] as any).findUnique({
      where: { providerId },
      select: { lastSyncStartedAt: true, lastSyncEndedAt: true },
    });
    if (syncConfig) {
      lastSyncStartedAt = syncConfig.lastSyncStartedAt;
      lastSyncEndedAt = syncConfig.lastSyncEndedAt;
    }

    const latestJob = getLatestCompletedSyncJob(providerId, type as DonorType);
    if (latestJob) {
      lastSyncErrors = latestJob.errors || [];
      lastSyncStats = {
        succeeded: latestJob.succeeded,
        failed: latestJob.failed,
        total: latestJob.total,
      };
      lastSyncAt = latestJob.completedAt || latestJob.startedAt;
      staleDonorsMarked = latestJob.staleDonorsMarked || 0;
      newProfiles = latestJob.newProfiles || 0;
      if (latestJob.missingFields && latestJob.missingFields.length > 0) {
        return {
          missingFields: latestJob.missingFields,
          lastSyncErrors,
          lastSyncStats,
          lastSyncAt,
          staleDonorsMarked,
          newProfiles,
          totalProfiles,
          lastSyncStartedAt,
          lastSyncEndedAt,
        };
      }
    } else if (nightlyResult) {
      lastSyncErrors = nightlyResult.errors || [];
      lastSyncStats = {
        succeeded: nightlyResult.succeeded,
        failed: nightlyResult.failed,
        total: nightlyResult.total,
      };
      lastSyncAt = nightlyResult.completedAt || nightlyResult.startedAt;

      if (nightlyResult.jobId) {
        const job = getSyncJob(nightlyResult.jobId);
        if (job) {
          staleDonorsMarked = job.staleDonorsMarked || 0;
          newProfiles = job.newProfiles || 0;
          if (job.missingFields && job.missingFields.length > 0) {
            return {
              missingFields: job.missingFields,
              lastSyncErrors,
              lastSyncStats,
              lastSyncAt,
              staleDonorsMarked,
              newProfiles,
              totalProfiles,
              lastSyncStartedAt,
              lastSyncEndedAt,
            };
          }
        }
      }
    }

    if (!lastSyncStats && lastSyncEndedAt && totalProfiles > 0) {
      lastSyncStats = {
        succeeded: totalProfiles,
        failed: 0,
        total: totalProfiles,
      };
      lastSyncAt = lastSyncEndedAt;
    }

    return {
      missingFields,
      lastSyncErrors,
      lastSyncStats,
      lastSyncAt,
      staleDonorsMarked,
      newProfiles,
      totalProfiles,
      lastSyncStartedAt,
      lastSyncEndedAt,
    };
  }

  @Get("cdc-syncs/:id/report")
  @ApiOperation({ summary: "Get detailed CDC sync report (admin only)" })
  async getCdcSyncReport(@Req() req: any, @Param("id") id: string) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }

    const [successRateCount, metricBreakdown] = await Promise.all([
      this.prisma.ivfSuccessRate.count({ where: { year: job.year } }),
      this.prisma.ivfSuccessRate.groupBy({
        by: ["profileType"],
        where: { year: job.year },
        _count: { id: true },
      }),
    ]);

    return {
      job,
      stats: {
        totalSuccessRates: successRateCount,
        profileBreakdown: metricBreakdown.map((g) => ({
          profileType: g.profileType,
          count: g._count.id,
        })),
      },
    };
  }

  @Get("cdc-syncs/:id/clinic-results")
  @ApiOperation({ summary: "Get per-clinic CDC results for a sync job (admin only)" })
  async getCdcClinicResults(@Req() req: any, @Param("id") id: string) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }

    const grouped = await this.prisma.ivfSuccessRate.groupBy({
      by: ["providerId", "profileType"],
      where: { year: job.year },
      _count: { id: true },
      _sum: { cycleCount: true },
    });

    const clinicMap = new Map<string, { totalRecords: number; totalCycles: number; hasOwnEggs: boolean; hasDonor: boolean }>();
    for (const g of grouped) {
      const existing = clinicMap.get(g.providerId) || { totalRecords: 0, totalCycles: 0, hasOwnEggs: false, hasDonor: false };
      existing.totalRecords += g._count.id;
      existing.totalCycles += g._sum.cycleCount || 0;
      if (g.profileType === "own_eggs") existing.hasOwnEggs = true;
      if (g.profileType === "donor") existing.hasDonor = true;
      clinicMap.set(g.providerId, existing);
    }

    const providerIds = Array.from(clinicMap.keys());
    const providers = await this.prisma.provider.findMany({
      where: { id: { in: providerIds } },
      select: { id: true, name: true, locations: { select: { city: true, state: true }, take: 1 } },
      orderBy: { name: "asc" },
    });

    const clinics = providers.map((p) => {
      const stats = clinicMap.get(p.id)!;
      const loc = p.locations[0];
      return {
        providerId: p.id,
        name: p.name,
        city: loc?.city || null,
        state: loc?.state || null,
        totalRecords: stats.totalRecords,
        totalCycles: stats.totalCycles,
        hasOwnEggs: stats.hasOwnEggs,
        hasDonor: stats.hasDonor,
      };
    });

    const currentYearProviderIds = new Set(providerIds);

    const prevYearAgg = await this.prisma.ivfSuccessRate.aggregate({
      _max: { year: true },
      where: { year: { lt: job.year } },
    });
    const prevYear = prevYearAgg._max.year;

    let newClinicIds: string[] = [];
    let disappearedClinicIds: string[] = [];

    if (prevYear !== null) {
      const previousYearRates = await this.prisma.ivfSuccessRate.groupBy({
        by: ["providerId"],
        where: { year: prevYear },
      });
      const previousProviderIds = new Set(previousYearRates.map((r) => r.providerId));

      newClinicIds = providerIds.filter((pid) => !previousProviderIds.has(pid));
      disappearedClinicIds = [...previousProviderIds].filter((pid) => !currentYearProviderIds.has(pid));
    }

    const newClinicProviders = newClinicIds.length > 0
      ? await this.prisma.provider.findMany({
          where: { id: { in: newClinicIds } },
          select: { id: true, name: true, locations: { select: { city: true, state: true }, take: 1 } },
          orderBy: { name: "asc" },
        })
      : [];

    const disappearedClinicProviders = disappearedClinicIds.length > 0
      ? await this.prisma.provider.findMany({
          where: { id: { in: disappearedClinicIds } },
          select: { id: true, name: true, websiteUrl: true, locations: { select: { city: true, state: true }, take: 1 } },
          orderBy: { name: "asc" },
        })
      : [];

    const newClinics = newClinicProviders.map((p) => {
      const stats = clinicMap.get(p.id);
      const loc = p.locations[0];
      return {
        providerId: p.id,
        name: p.name,
        city: loc?.city || null,
        state: loc?.state || null,
        totalRecords: stats?.totalRecords || 0,
        totalCycles: stats?.totalCycles || 0,
        hasOwnEggs: stats?.hasOwnEggs || false,
        hasDonor: stats?.hasDonor || false,
      };
    });

    const disappearedClinics = disappearedClinicProviders.map((p) => {
      const loc = p.locations[0];
      return {
        providerId: p.id,
        name: p.name,
        city: loc?.city || null,
        state: loc?.state || null,
        websiteUrl: p.websiteUrl || null,
      };
    });

    return {
      year: job.year,
      totalClinics: clinics.length,
      withOwnEggs: clinics.filter((c) => c.hasOwnEggs).length,
      withDonorEggs: clinics.filter((c) => c.hasDonor).length,
      totalSuccessRateRecords: clinics.reduce((sum, c) => sum + c.totalRecords, 0),
      clinics,
      newClinics,
      disappearedClinics,
    };
  }

  @Patch("cdc-syncs/:id/clinic/:providerId/website")
  @ApiOperation({ summary: "Update a clinic's website URL (admin only)" })
  async updateClinicWebsite(
    @Req() req: any,
    @Param("id") id: string,
    @Param("providerId") providerId: string,
    @Body() body: { websiteUrl: string },
  ) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }

    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) {
      throw new NotFoundException("Provider not found.");
    }

    await this.prisma.provider.update({
      where: { id: providerId },
      data: { websiteUrl: body.websiteUrl || null },
    });

    return { success: true, websiteUrl: body.websiteUrl || null };
  }

  @Get("cdc-syncs/:id/clinic/:providerId/success-rates")
  @ApiOperation({ summary: "Get full success rate detail for a single clinic (admin only)" })
  async getClinicSuccessRates(
    @Req() req: any,
    @Param("id") id: string,
    @Param("providerId") providerId: string,
  ) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        name: true,
        cdcClinicId: true,
        locations: { select: { city: true, state: true, address: true, zip: true }, take: 1 },
      },
    });
    if (!provider) {
      throw new NotFoundException("Provider not found.");
    }

    const rates = await this.prisma.ivfSuccessRate.findMany({
      where: { providerId, year: job.year },
      orderBy: [{ profileType: "asc" }, { metricCode: "asc" }, { isNewPatient: "asc" }, { ageGroup: "asc" }, { submetric: "asc" }],
    });

    const HEADLINE_OWN_EGGS = "pct_intended_retrievals_live_births";
    const HEADLINE_NEW_PATIENTS = "pct_new_patients_live_birth_after_all_retrievals";
    const HEADLINE_DONOR = "pct_transfers_live_births_donor";

    const ownEggs: Record<string, any[]> = { allPatients: [], newPatients: [] };
    const donorEggs: Record<string, any[]> = {};
    const allMetrics: Record<string, any[]> = {};

    for (const r of rates) {
      const entry = {
        metricCode: r.metricCode,
        ageGroup: r.ageGroup,
        submetric: r.submetric,
        isNewPatient: r.isNewPatient,
        successRate: r.successRate !== null && r.successRate !== undefined ? Number(r.successRate) : null,
        cycleCount: r.cycleCount,
        percentile: r.percentile !== null && r.percentile !== undefined ? Number(r.percentile) : null,
        top10pct: r.top10pct,
        nationalAverage: r.nationalAverage !== null && r.nationalAverage !== undefined ? Number(r.nationalAverage) : null,
      };

      if (!allMetrics[r.metricCode]) allMetrics[r.metricCode] = [];
      allMetrics[r.metricCode].push(entry);

      if (r.profileType === "own_eggs" && r.metricCode === HEADLINE_OWN_EGGS) {
        ownEggs.allPatients.push(entry);
      } else if (r.profileType === "own_eggs" && r.metricCode === HEADLINE_NEW_PATIENTS) {
        ownEggs.newPatients.push(entry);
      } else if (r.profileType === "donor" && r.metricCode === HEADLINE_DONOR) {
        const sub = r.submetric || "other";
        if (!donorEggs[sub]) donorEggs[sub] = [];
        donorEggs[sub].push(entry);
      }
    }

    return {
      year: job.year,
      provider: {
        id: provider.id,
        name: provider.name,
        cdcClinicId: provider.cdcClinicId || null,
        city: provider.locations[0]?.city || null,
        state: provider.locations[0]?.state || null,
        address: provider.locations[0]?.address || null,
        zip: provider.locations[0]?.zip || null,
      },
      totalRecords: rates.length,
      ownEggs,
      donorEggs,
      allMetrics,
    };
  }

  @Get("cdc-syncs/:id/enrichment-report")
  @ApiOperation({ summary: "Get detailed enrichment report (admin only)" })
  async getEnrichmentReport(@Req() req: any, @Param("id") id: string) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }

    const ivfClinics = await this.prisma.provider.findMany({
      where: {
        services: { some: { providerType: { name: "IVF Clinic" } } },
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        websiteUrl: true,
        phone: true,
        about: true,
        logoUrl: true,
        locations: {
          select: { city: true, state: true },
          take: 1,
        },
      },
    });

    const totalClinics = ivfClinics.length;
    const withWebsite = ivfClinics.filter((c) => c.websiteUrl && c.websiteUrl.trim() !== "").length;
    const withPhone = ivfClinics.filter((c) => c.phone && c.phone.trim() !== "").length;
    const withAbout = ivfClinics.filter((c) => c.about && c.about.trim() !== "").length;
    const withLogo = ivfClinics.filter((c) => c.logoUrl && c.logoUrl.trim() !== "").length;

    const memberCounts = await this.prisma.providerMember.groupBy({
      by: ["providerId"],
      where: {
        providerId: { in: ivfClinics.map((c) => c.id) },
      },
      _count: { id: true },
    });
    const withTeam = memberCounts.length;

    const isInProgress = job.enrichmentStatus === "PROCESSING" || job.enrichmentStatus === "PENDING";

    const processedClinics = isInProgress
      ? ivfClinics.slice(0, job.enrichmentProcessed)
      : ivfClinics;

    const missingWebsite = processedClinics
      .filter((c) => !c.websiteUrl || c.websiteUrl.trim() === "")
      .map((c) => ({
        id: c.id,
        name: c.name,
        city: c.locations[0]?.city || null,
        state: c.locations[0]?.state || null,
      }));

    let recentResults: {
      name: string;
      foundWebsite: boolean;
      websiteUrl: string | null;
      hasPhone: boolean;
      hasAbout: boolean;
      hasLogo: boolean;
      teamCount: number;
      locationCount: number;
    }[] = [];

    const showResults = (isInProgress && job.enrichmentProcessed > 0) || job.enrichmentStatus === "COMPLETED" || job.enrichmentStatus === "FAILED";
    if (showResults) {
      const clinicsWithMembers = await this.prisma.provider.findMany({
        where: {
          services: { some: { providerType: { name: "IVF Clinic" } } },
        },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          websiteUrl: true,
          phone: true,
          about: true,
          logoUrl: true,
          _count: { select: { members: true, locations: true } },
        },
      });

      const processedWithMembers = isInProgress
        ? clinicsWithMembers.slice(0, job.enrichmentProcessed)
        : clinicsWithMembers;

      recentResults = processedWithMembers.map((c) => ({
        name: c.name,
        foundWebsite: !!(c.websiteUrl && c.websiteUrl.trim() !== ""),
        websiteUrl: c.websiteUrl,
        hasPhone: !!(c.phone && c.phone.trim() !== ""),
        hasAbout: !!(c.about && c.about.trim() !== ""),
        hasLogo: !!(c.logoUrl && c.logoUrl.trim() !== ""),
        teamCount: c._count.members,
        locationCount: c._count.locations,
      }));
    }

    return {
      job: {
        year: job.year,
        enrichmentStatus: job.enrichmentStatus,
        enrichmentProcessed: job.enrichmentProcessed,
        enrichmentTotal: job.enrichmentTotal,
        enrichmentErrors: job.enrichmentErrors,
        enrichmentSkipped: job.enrichmentSkipped,
        enrichmentErrorMessage: job.enrichmentErrorMessage,
        completedAt: job.completedAt,
        startedAt: job.startedAt,
      },
      coverage: {
        totalClinics,
        withWebsite,
        withPhone,
        withAbout,
        withLogo,
        withTeam,
      },
      missingWebsite,
      recentResults: recentResults.length > 0 ? recentResults : undefined,
    };
  }

  @Get("cdc-syncs")
  @ApiOperation({ summary: "List CDC sync jobs (admin only)" })
  async getCdcSyncs(@Req() req: any) {
    requireAdmin(req);
    return this.prisma.cdcSyncJob.findMany({
      orderBy: { startedAt: "desc" },
    });
  }

  @Delete("cdc-syncs/:id")
  @ApiOperation({ summary: "Delete a failed CDC sync job (admin only)" })
  async deleteCdcSync(@Req() req: any, @Param("id") id: string) {
    requireAdmin(req);
    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }
    if (job.status === "PROCESSING" || job.status === "PENDING") {
      throw new BadRequestException("Cannot delete an active sync job.");
    }
    if (job.enrichmentStatus === "PROCESSING" || job.enrichmentStatus === "PENDING") {
      throw new BadRequestException("Cannot delete a job while enrichment is running.");
    }
    await this.prisma.cdcSyncJob.delete({ where: { id } });
    return { success: true };
  }

  @Post("cdc-syncs/:id/enrich")
  @ApiOperation({ summary: "Trigger profile enrichment for a completed CDC sync job (admin only)" })
  async triggerEnrichment(
    @Req() req: any,
    @Param("id") id: string,
    @Query("restart") restart?: string,
    @Query("mode") mode?: string,
  ) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }
    if (job.status !== "COMPLETED") {
      throw new BadRequestException("Can only enrich a completed sync job.");
    }
    if (job.enrichmentStatus === "PROCESSING" || job.enrichmentStatus === "PENDING") {
      throw new HttpException("Enrichment is already running.", HttpStatus.CONFLICT);
    }

    const validModes = ["skipped", "team", "logo", "about", "phone"];
    if (mode && !validModes.includes(mode)) {
      throw new BadRequestException(`Invalid mode "${mode}". Must be one of: ${validModes.join(", ")}.`);
    }

    if (mode && validModes.includes(mode)) {
      const { count } = await this.prisma.cdcSyncJob.updateMany({
        where: {
          id,
          OR: [
            { enrichmentStatus: null },
            { enrichmentStatus: { notIn: ["PROCESSING", "PENDING"] } },
          ],
        },
        data: {
          enrichmentStatus: "PENDING",
          enrichmentErrorMessage: null,
          enrichmentProcessed: 0,
          enrichmentErrors: 0,
          enrichmentSkipped: 0,
        },
      });

      if (count === 0) {
        throw new HttpException("Enrichment is already running.", HttpStatus.CONFLICT);
      }

      const updated = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
      this.clinicEnrichmentService.runTargetedEnrichment(id, mode as "skipped" | "team" | "logo" | "about" | "phone");
      return updated;
    }

    const forceRestart = restart === "true";
    const isResume = !forceRestart && job.enrichmentProcessed > 0 && job.enrichmentStatus !== "COMPLETED";

    const { count } = await this.prisma.cdcSyncJob.updateMany({
      where: {
        id,
        OR: [
          { enrichmentStatus: null },
          { enrichmentStatus: { notIn: ["PROCESSING", "PENDING"] } },
        ],
      },
      data: {
        enrichmentStatus: "PENDING",
        enrichmentErrorMessage: null,
        ...(isResume ? {} : { enrichmentProcessed: 0, enrichmentErrors: 0, enrichmentSkipped: 0 }),
      },
    });

    if (count === 0) {
      throw new HttpException("Enrichment is already running.", HttpStatus.CONFLICT);
    }

    const updated = await this.prisma.cdcSyncJob.findUnique({ where: { id } });

    this.clinicEnrichmentService.runEnrichment(id);

    return updated;
  }

  @Post("cdc-syncs/:id/cancel-enrichment")
  @ApiOperation({ summary: "Cancel a running enrichment process (admin only)" })
  async cancelEnrichment(@Req() req: any, @Param("id") id: string) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }
    if (job.enrichmentStatus !== "PROCESSING" && job.enrichmentStatus !== "PENDING") {
      throw new BadRequestException("Enrichment is not currently running.");
    }

    await this.prisma.cdcSyncJob.update({
      where: { id },
      data: {
        enrichmentStatus: "FAILED",
        enrichmentErrorMessage: "Cancelled by admin",
      },
    });

    return { success: true, message: "Enrichment cancelled" };
  }

  @Post("cdc-syncs/:id/cancel")
  @ApiOperation({ summary: "Cancel a running CDC sync process (admin only)" })
  async cancelCdcSync(@Req() req: any, @Param("id") id: string) {
    requireAdmin(req);

    const job = await this.prisma.cdcSyncJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException("CDC sync job not found.");
    }
    if (job.status !== "PROCESSING" && job.status !== "PENDING") {
      throw new BadRequestException("CDC sync is not currently running.");
    }

    await this.prisma.cdcSyncJob.update({
      where: { id },
      data: {
        status: "FAILED",
        errorMessage: "Cancelled by admin",
        completedAt: new Date(),
      },
    });

    return { success: true, message: "CDC sync cancelled" };
  }

  @Post("cdc-syncs/sync-latest")
  @ApiOperation({ summary: "Discover latest CDC year and trigger sync (admin only)" })
  async syncLatestCdc(@Req() req: any) {
    requireAdmin(req);

    try {
      const { year } = await this.cdcSyncService.discoverLatestYear();
      const job = await this.cdcSyncService.triggerSync(year);
      return { ...job, latestYear: year };
    } catch (err: any) {
      if (err.status === 409) {
        throw new HttpException(err.message, HttpStatus.CONFLICT);
      }
      throw new HttpException(
        err.message || "Failed to start CDC sync",
        err.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post("cdc-syncs/trigger")
  @ApiOperation({ summary: "Trigger a CDC data sync for a given year (admin only)" })
  async triggerCdcSync(@Req() req: any, @Body() body: { year: number }) {
    requireAdmin(req);

    const year = Number(body.year);
    const currentYear = new Date().getFullYear();
    if (!year || year < 2015 || year > currentYear) {
      throw new BadRequestException(`Year must be between 2015 and ${currentYear}.`);
    }

    try {
      const job = await this.cdcSyncService.triggerSync(year);
      return job;
    } catch (err: any) {
      if (err.status === 404) {
        throw new NotFoundException(err.message);
      }
      if (err.status === 409) {
        throw new HttpException(err.message, HttpStatus.CONFLICT);
      }
      throw new HttpException(
        err.message || "Failed to start CDC sync",
        err.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
