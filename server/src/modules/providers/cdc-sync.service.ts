import { PrismaService } from "../prisma/prisma.service";
import { buildEnrichmentSqlStatements } from "./cdc-enrichment.sql";

const SOCRATA_CATALOG_URL = "https://api.us.socrata.com/api/catalog/v1";
const CDC_DATA_BASE = "https://data.cdc.gov/resource";
const PAGE_SIZE = 5000;

export class CdcSyncService {
  constructor(private readonly prisma: PrismaService) {
    this.recoverStaleJobs();
  }

  private async recoverStaleJobs() {
    try {
      const staleJobs = await this.prisma.cdcSyncJob.findMany({
        where: { status: { in: ["PROCESSING", "PENDING"] } },
        select: { id: true, year: true, recordsProcessed: true, errorMessage: true },
      });

      if (staleJobs.length === 0) return;

      for (const job of staleJobs) {
        if (job.errorMessage === "Server restarted during sync") {
          console.log(`[CDC Sync] Skipping auto-resume for job ${job.id} (year ${job.year}) — already failed on previous restart`);
          await this.prisma.cdcSyncJob.update({
            where: { id: job.id },
            data: { status: "FAILED", completedAt: new Date() },
          });
          continue;
        }

        console.log(`[CDC Sync] Auto-resuming sync for job ${job.id} (year ${job.year}) from offset ${job.recordsProcessed}...`);
        await this.prisma.cdcSyncJob.update({
          where: { id: job.id },
          data: { errorMessage: "Server restarted during sync" },
        });

        const datasetId = await this.getDatasetIdForYear(job.year).catch((err) => {
          console.error(`[CDC Sync] Cannot resume job ${job.id} — dataset lookup failed:`, err.message);
          return null;
        });

        if (!datasetId) {
          await this.prisma.cdcSyncJob.update({
            where: { id: job.id },
            data: { status: "FAILED", errorMessage: "Failed to resume — dataset not found", completedAt: new Date() },
          });
          continue;
        }

        this.runSync(job.id, job.year, datasetId, job.recordsProcessed).catch((err) => {
          console.error(`[CDC Sync] Failed to auto-resume sync for year ${job.year}:`, err.message);
        });
      }
    } catch (err) {
      console.error("[CDC Sync] Failed to recover stale jobs:", err);
    }
  }

  async discoverLatestYear(): Promise<{ year: number; datasetId: string }> {
    const searchUrl = `https://api.us.socrata.com/api/catalog/v1?domains=data.cdc.gov&q=ART%20Fertility%20Clinic%20Success%20Rates&limit=50`;
    console.log(`[CDC Sync] Searching Socrata catalog for latest ART dataset...`);

    const res = await fetch(searchUrl);
    if (!res.ok) {
      throw new Error(`Socrata catalog API returned ${res.status}`);
    }

    const data = await res.json();
    const results = data.results || [];

    let bestYear = 0;
    let bestDatasetId = "";

    for (const r of results) {
      const name = (r.resource?.name || "").toLowerCase();
      if (!name.includes("art") || !name.includes("success")) continue;

      const yearMatch = name.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        const y = parseInt(yearMatch[1], 10);
        if (y > bestYear && r.resource?.id) {
          bestYear = y;
          bestDatasetId = r.resource.id;
        }
      }
    }

    if (!bestYear || !bestDatasetId) {
      throw new Error("Could not find any ART Fertility Clinic Success Rates dataset on CDC.");
    }

    await this.prisma.cdcDatasetMap.upsert({
      where: { year: bestYear },
      update: { datasetId: bestDatasetId },
      create: { year: bestYear, datasetId: bestDatasetId },
    });

    console.log(`[CDC Sync] Latest available year: ${bestYear} (dataset: ${bestDatasetId})`);
    return { year: bestYear, datasetId: bestDatasetId };
  }

  async getDatasetIdForYear(year: number): Promise<string> {
    const cached = await this.prisma.cdcDatasetMap.findUnique({ where: { year } });
    if (cached) return cached.datasetId;

    const searchUrl = `https://api.us.socrata.com/api/catalog/v1?domains=data.cdc.gov&q=ART%20Fertility%20Clinic%20Success%20Rates%20${year}`;
    console.log(`[CDC Sync] Searching Socrata catalog for year ${year}: ${searchUrl}`);

    const res = await fetch(searchUrl);
    if (!res.ok) {
      throw new Error(`Socrata catalog API returned ${res.status}`);
    }

    const data = await res.json();
    const results = data.results || [];

    const match = results.find((r: any) => {
      const name = (r.resource?.name || "").toLowerCase();
      return name.includes("art") && name.includes("success") && name.includes(String(year));
    });

    if (!match) {
      const error: any = new Error(`No CDC dataset has been published yet for the year ${year}.`);
      error.status = 404;
      throw error;
    }

    const datasetId = match.resource?.id;
    if (!datasetId) {
      throw new Error(`Found a catalog entry for ${year} but could not extract dataset ID.`);
    }

    await this.prisma.cdcDatasetMap.upsert({
      where: { year },
      update: { datasetId },
      create: { year, datasetId },
    });

    console.log(`[CDC Sync] Discovered dataset ID for ${year}: ${datasetId}`);
    return datasetId;
  }

  async triggerSync(year: number) {
    const datasetId = await this.getDatasetIdForYear(year);

    const activeJob = await this.prisma.cdcSyncJob.findFirst({
      where: {
        year,
        status: { in: ["PENDING", "PROCESSING"] },
      },
    });
    if (activeJob) {
      const error: any = new Error(`A CDC sync for year ${year} is already in progress.`);
      error.status = 409;
      throw error;
    }

    const job = await this.prisma.cdcSyncJob.create({
      data: { year, status: "PENDING" },
    });

    this.runSync(job.id, year, datasetId).catch((err) => {
      console.error(`[CDC Sync] Unhandled error in background sync:`, err);
    });

    return job;
  }

  private async getEstimatedCounts(datasetId: string): Promise<{ totalRecords: number; totalClinics: number }> {
    try {
      const countUrl = `${CDC_DATA_BASE}/${datasetId}.json?$select=count(*)%20as%20total`;
      const countRes = await fetch(countUrl);
      if (!countRes.ok) return { totalRecords: 0, totalClinics: 0 };
      const countData = await countRes.json();
      const totalRecords = parseInt(countData?.[0]?.total || "0", 10);

      const clinicUrl = `${CDC_DATA_BASE}/${datasetId}.json?$select=facilityname&$group=facilityname&$limit=50000`;
      const clinicRes = await fetch(clinicUrl);
      if (!clinicRes.ok) return { totalRecords, totalClinics: 0 };
      const clinicData = await clinicRes.json();
      const totalClinics = Array.isArray(clinicData) ? clinicData.length : 0;

      return { totalRecords, totalClinics };
    } catch {
      return { totalRecords: 0, totalClinics: 0 };
    }
  }

  private async runSync(jobId: string, year: number, datasetId: string, resumeFromOffset: number = 0) {
    try {
      const estimated = await this.getEstimatedCounts(datasetId);
      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: {
          status: "PROCESSING",
          errorMessage: null,
          estimatedTotalRecords: estimated.totalRecords || null,
          estimatedTotalClinics: estimated.totalClinics || null,
        },
      });

      if (resumeFromOffset === 0) {
        await this.prisma.rawCdcData.deleteMany({ where: { year } });
      } else {
        console.log(`[CDC Sync] Resuming from offset ${resumeFromOffset}, keeping existing raw data`);
      }

      let offset = resumeFromOffset;
      let totalRecords = resumeFromOffset;
      let totalClinics = new Set<string>();

      if (resumeFromOffset > 0) {
        const existingClinics = await this.prisma.rawCdcData.findMany({
          where: { year },
          select: { facilityName: true },
          distinct: ["facilityName"],
        });
        for (const c of existingClinics) {
          totalClinics.add(c.facilityName);
        }
      }

      while (true) {
        const url = `${CDC_DATA_BASE}/${datasetId}.json?$limit=${PAGE_SIZE}&$offset=${offset}`;
        console.log(`[CDC Sync] Fetching page at offset ${offset}...`);

        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`CDC API returned HTTP ${res.status} at offset ${offset}`);
        }

        const records: any[] = await res.json();
        if (!records || records.length === 0) break;

        const inserts = records.map((record: any) => ({
          year,
          facilityName: record.facilityname || "Unknown",
          rawData: record,
        }));

        await this.prisma.rawCdcData.createMany({ data: inserts });

        for (const r of records) {
          if (r.facilityname) totalClinics.add(r.facilityname);
        }
        totalRecords += records.length;

        await this.prisma.cdcSyncJob.update({
          where: { id: jobId },
          data: {
            recordsProcessed: totalRecords,
            clinicsProcessed: totalClinics.size,
          },
        });

        if (records.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      if (totalRecords === 0) {
        throw new Error(`CDC dataset ${datasetId} returned 0 records for year ${year}.`);
      }

      console.log(`[CDC Sync] Download complete. ${totalRecords} records from ${totalClinics.size} clinics. Running enrichment SQL...`);

      const statements = buildEnrichmentSqlStatements(year);
      for (let i = 0; i < statements.length; i++) {
        console.log(`[CDC Sync] Running enrichment step ${i + 1}/${statements.length}...`);
        await this.prisma.$executeRawUnsafe(statements[i]);
      }

      console.log(`[CDC Sync] Enrichment complete.`);

      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          recordsProcessed: totalRecords,
          clinicsProcessed: totalClinics.size,
          completedAt: new Date(),
        },
      });
    } catch (err: any) {
      console.error(`[CDC Sync] Sync failed:`, err);

      if (resumeFromOffset === 0) {
        try {
          await this.prisma.rawCdcData.deleteMany({ where: { year } });
        } catch {}
      }

      await this.prisma.cdcSyncJob.update({
        where: { id: jobId },
        data: {
          status: "FAILED",
          errorMessage: err.message || String(err),
          completedAt: new Date(),
        },
      }).catch(() => {});
    }
  }
}
