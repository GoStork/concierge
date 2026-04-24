import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Patch,
  Param,
  Query,
  Body,
  Inject,
  Req,
  Res,
  UseGuards,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import {
  getSyncConfig,
  saveSyncConfig,
  startSync,
  getSyncJob,
  getActiveSyncJob,
  getActivePdfJob,
  cancelSync,
  getProfiles,
  DonorType,
  getScrapersSummary,
  runNightlySync,
  getNightlySyncStatus,
  startPdfSync,
  deletePdfSurrogates,
  repairPhotoUrls,
} from "./profile-sync.service";
import {
  resolveCompensationAndTotalCost,
  recalcAndPersistSingleDonorCost,
  recalcAndPersistTotalCostsForProvider,
  enrichDonorsWithPendingCosts,
  enrichDonorsAcrossProviders,
} from "../costs/total-cost.utils";

const VALID_TYPES: DonorType[] = ["egg-donor", "surrogate", "sperm-donor"];

function isParentUser(user: any): boolean {
  if (!user?.roles) return true;
  return user.roles.includes("PARENT") && user.roles.length === 1;
}

const DONOR_TYPE_SERVICE_NAMES: Record<string, string[]> = {
  "egg-donor": ["Egg Donor Agency", "Egg Bank"],
  "surrogate": ["Surrogacy Agency"],
  "sperm-donor": ["Sperm Bank"],
};

async function hasApprovedService(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
): Promise<boolean> {
  const serviceNames = DONOR_TYPE_SERVICE_NAMES[donorType];
  if (!serviceNames) return false;
  const count = await prisma.providerService.count({
    where: {
      providerId,
      status: "APPROVED",
      providerType: { name: { in: serviceNames } },
    },
  });
  return count > 0;
}

function validateType(type: string): DonorType {
  if (!VALID_TYPES.includes(type as DonorType)) {
    throw new BadRequestException(
      `Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`,
    );
  }
  return type as DonorType;
}

@ApiTags("Donor Sync")
@Controller("api/providers/:providerId")
@UseGuards(SessionOrJwtGuard)
export class ProfileSyncController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storageService: StorageService,
  ) {}

  @Get("sync-config/:type")
  @ApiOperation({ summary: "Get sync configuration for a donor type" })
  async getConfig(
    @Param("providerId") providerId: string,
    @Param("type") type: string,
  ) {
    const validType = validateType(type);
    const config = await getSyncConfig(this.prisma, providerId, validType);
    if (!config) return null;
    return {
      id: config.id,
      providerId: config.providerId,
      databaseUrl: config.databaseUrl,
      username: config.username,
      lastSyncAt: config.lastSyncAt,
      syncStatus: config.syncStatus,
      syncFrequency: config.syncFrequency,
    };
  }

  @Put("sync-config/:type")
  @ApiOperation({ summary: "Save sync configuration for a donor type" })
  async saveConfig(
    @Param("providerId") providerId: string,
    @Param("type") type: string,
    @Body() body: { databaseUrl: string; username?: string; password?: string },
  ) {
    const validType = validateType(type);
    if (!body.databaseUrl) {
      throw new BadRequestException("databaseUrl is required");
    }
    const config = await saveSyncConfig(
      this.prisma,
      providerId,
      validType,
      body,
    );
    return {
      id: config.id,
      providerId: config.providerId,
      databaseUrl: config.databaseUrl,
      username: config.username,
      lastSyncAt: config.lastSyncAt,
      syncStatus: config.syncStatus,
    };
  }

  @Post("sync/pdf")
  @ApiOperation({ summary: "Upload PDFs for bulk surrogate profile extraction" })
  async uploadPdfs(
    @Param("providerId") providerId: string,
    @Req() req: any,
    @Res() res: any,
  ) {
    const user = req.user;
    if (!user) return res.status(403).json({ message: "Not authenticated" });

    const isGostorkAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user.roles?.includes("PROVIDER_ADMIN");
    if (!isGostorkAdmin && !isProviderAdmin) {
      return res.status(403).json({ message: "Only admins can upload PDF profiles" });
    }
    if (!isGostorkAdmin && user.providerId !== providerId) {
      return res.status(403).json({ message: "You can only upload to your own provider" });
    }

    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) return res.status(404).json({ message: "Provider not found" });

    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return res.status(400).json({ message: "Content-Type must be multipart/form-data" });
    }

    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(400).json({ message: "Missing boundary in content-type" });
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX_FILE_SIZE = 200 * 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_FILE_SIZE) {
        req.destroy();
        return res.status(413).json({ message: "Payload too large. Maximum size is 50MB." });
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const boundary = boundaryMatch[1];

        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const parts: Buffer[] = [];
        let start = 0;
        while (true) {
          const idx = body.indexOf(boundaryBuffer, start);
          if (idx === -1) break;
          if (start > 0) parts.push(body.subarray(start, idx));
          start = idx + boundaryBuffer.length;
        }

        const pdfFiles: Array<{ originalname: string; buffer: Buffer }> = [];
        for (const part of parts) {
          const headerEnd = part.indexOf("\r\n\r\n");
          if (headerEnd === -1) continue;
          const headerStr = part.subarray(0, headerEnd).toString("utf-8");
          if (!headerStr.includes("filename=")) continue;

          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          const filename = filenameMatch?.[1] || "upload.pdf";

          if (!filename.toLowerCase().endsWith(".pdf") && !headerStr.includes("application/pdf")) continue;

          let dataStart = headerEnd + 4;
          let dataEnd = part.length;
          if (part[dataEnd - 1] === 0x0a && part[dataEnd - 2] === 0x0d) dataEnd -= 2;

          pdfFiles.push({ originalname: filename, buffer: part.subarray(dataStart, dataEnd) });
        }

        if (pdfFiles.length === 0) {
          return res.status(400).json({ message: "No valid PDF files found in upload" });
        }

        const jobId = startPdfSync(this.prisma, this.storageService, providerId, pdfFiles);
        return res.status(201).json({ jobId });
      } catch (err) {
        return res.status(500).json({ message: "Failed to process upload" });
      }
    });
  }

  @Post("sync/stop")
  @ApiOperation({ summary: "Stop an active sync job" })
  async stopSync(
    @Param("providerId") providerId: string,
    @Body() body: { type?: string },
    @Req() req: any,
  ) {
    const user = req.user;
    if (!user) throw new ForbiddenException("Not authenticated");

    const isGostorkAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user.roles?.includes("PROVIDER_ADMIN");
    if (!isGostorkAdmin && !isProviderAdmin) {
      throw new ForbiddenException("Only admins can stop sync jobs");
    }
    if (!isGostorkAdmin && user.providerId !== providerId) {
      throw new ForbiddenException("You can only stop sync jobs for your own provider");
    }

    const type: DonorType = body.type ? validateType(body.type) : "surrogate";

    const cancelled = cancelSync(providerId, type);
    if (!cancelled) {
      throw new NotFoundException("No active sync job found for this provider and type");
    }

    return { success: true, message: "Sync job stopped" };
  }

  @Post("sync/:type")
  @ApiOperation({ summary: "Start a donor sync job" })
  async triggerSync(
    @Param("providerId") providerId: string,
    @Param("type") type: string,
    @Query("limit") limitStr?: string,
  ) {
    const validType = validateType(type);

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
    });
    if (!provider) {
      throw new NotFoundException("Provider not found");
    }

    const profileLimit = limitStr ? parseInt(limitStr, 10) : undefined;

    try {
      const jobId = await startSync(this.prisma, providerId, validType, profileLimit, this.storageService);
      return { jobId };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  @Get("sync/status/:jobId")
  @ApiOperation({ summary: "Get sync job status" })
  async syncStatus(@Param("jobId") jobId: string) {
    const job = getSyncJob(jobId);
    if (!job) {
      throw new NotFoundException("Sync job not found");
    }
    return job;
  }

  @Get("sync/active/:type")
  @ApiOperation({ summary: "Get active sync job for provider+type" })
  async activeSyncJob(
    @Param("providerId") providerId: string,
    @Param("type") type: string,
    @Query("kind") kind?: string,
  ) {
    const validType = validateType(type);
    const job = kind === "pdf"
      ? getActivePdfJob(providerId, validType)
      : getActiveSyncJob(providerId, validType);
    return { job: job || null };
  }

  @Get("egg-donors")
  @ApiOperation({ summary: "List egg donors for a provider" })
  async listEggDonors(@Param("providerId") providerId: string, @Req() req: any) {
    const parent = isParentUser(req.user);
    if (parent && !(await hasApprovedService(this.prisma, providerId, "egg-donor"))) {
      return [];
    }
    const donors = await getProfiles(this.prisma, providerId, "egg-donor", { excludeHidden: parent });
    if (!parent) {
      return enrichDonorsWithPendingCosts(this.prisma, providerId, "egg-donor", donors);
    }
    return donors;
  }

  @Get("egg-donors/:donorId")
  @ApiOperation({ summary: "Get a single egg donor by ID" })
  async getEggDonor(@Param("providerId") providerId: string, @Param("donorId") donorId: string, @Req() req: any) {
    const parent = isParentUser(req.user);
    if (parent && !(await hasApprovedService(this.prisma, providerId, "egg-donor"))) {
      throw new NotFoundException("Egg donor not found");
    }
    const donor = await this.prisma.eggDonor.findFirst({ where: { id: donorId, providerId } });
    if (!donor) throw new NotFoundException("Egg donor not found");
    if (donor.hiddenFromSearch && parent) throw new NotFoundException("Egg donor not found");
    const statuses = parent ? ["APPROVED"] : ["PENDING", "APPROVED"];
    const isFrozenOnly = donor.donorType && /frozen/i.test(donor.donorType) && !/fresh/i.test(donor.donorType);
    const sheetSubType = isFrozenOnly ? "frozen" : "fresh";
    const { resolvedCompensation, calculatedTotalCost } = await resolveCompensationAndTotalCost(
      this.prisma, providerId, "egg-donor", donor.donorCompensation ?? null, statuses, sheetSubType,
    );
    return { ...donor, resolvedCompensation, calculatedTotalCost };
  }

  @Get("surrogates")
  @ApiOperation({ summary: "List surrogates for a provider" })
  async listSurrogates(@Param("providerId") providerId: string, @Req() req: any) {
    const parent = isParentUser(req.user);
    if (parent && !(await hasApprovedService(this.prisma, providerId, "surrogate"))) {
      return [];
    }
    const donors = await getProfiles(this.prisma, providerId, "surrogate", { excludeHidden: parent });
    if (!parent) {
      return enrichDonorsWithPendingCosts(this.prisma, providerId, "surrogate", donors);
    }
    return donors;
  }

  @Get("surrogates/:donorId")
  @ApiOperation({ summary: "Get a single surrogate by ID" })
  async getSurrogate(@Param("providerId") providerId: string, @Param("donorId") donorId: string, @Req() req: any) {
    const parent = isParentUser(req.user);
    if (parent && !(await hasApprovedService(this.prisma, providerId, "surrogate"))) {
      throw new NotFoundException("Surrogate not found");
    }
    const donor = await this.prisma.surrogate.findFirst({ where: { id: donorId, providerId } });
    if (!donor) throw new NotFoundException("Surrogate not found");
    if (donor.hiddenFromSearch && parent) throw new NotFoundException("Surrogate not found");
    const statuses = parent ? ["APPROVED"] : ["PENDING", "APPROVED"];
    const { resolvedCompensation, calculatedTotalCost } = await resolveCompensationAndTotalCost(
      this.prisma, providerId, "surrogate", donor.baseCompensation != null ? Number(donor.baseCompensation) : null, statuses,
    );
    return { ...donor, resolvedCompensation, calculatedTotalCost };
  }

  @Get("sperm-donors")
  @ApiOperation({ summary: "List sperm donors for a provider" })
  async listSpermDonors(@Param("providerId") providerId: string, @Req() req: any) {
    const parent = isParentUser(req.user);
    if (parent && !(await hasApprovedService(this.prisma, providerId, "sperm-donor"))) {
      return [];
    }
    return getProfiles(this.prisma, providerId, "sperm-donor", { excludeHidden: parent });
  }

  @Get("sperm-donors/:donorId")
  @ApiOperation({ summary: "Get a single sperm donor by ID" })
  async getSpermDonor(@Param("providerId") providerId: string, @Param("donorId") donorId: string, @Req() req: any) {
    const parent = isParentUser(req.user);
    if (parent && !(await hasApprovedService(this.prisma, providerId, "sperm-donor"))) {
      throw new NotFoundException("Sperm donor not found");
    }
    const donor = await this.prisma.spermDonor.findFirst({ where: { id: donorId, providerId } });
    if (!donor) throw new NotFoundException("Sperm donor not found");
    if (donor.hiddenFromSearch && parent) throw new NotFoundException("Sperm donor not found");
    const [enriched] = await enrichDonorsAcrossProviders(this.prisma, "sperm-donor", [donor]);
    return enriched;
  }

  @Patch("donors/:type/:donorId")
  @ApiOperation({ summary: "Update a donor profile (provider staff or GoStork admin)" })
  async updateDonor(
    @Param("providerId") providerId: string,
    @Param("type") type: string,
    @Param("donorId") donorId: string,
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    const validType = validateType(type);
    const user = req.user;
    if (!user) throw new ForbiddenException("Not authenticated");

    const isGostorkAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user.roles?.includes("PROVIDER_ADMIN");
    const isCoordinator = user.roles?.some((r: string) =>
      ["INTAKE_COORDINATOR", "MATCHING_COORDINATOR", "CASE_MANAGER", "PROVIDER_STAFF"].includes(r)
    );

    if (user.roles?.includes("PARENT")) {
      throw new ForbiddenException("Parents cannot edit donor profiles");
    }

    if (!isGostorkAdmin && !isProviderAdmin && !isCoordinator) {
      throw new ForbiddenException("Insufficient permissions to edit donor profiles");
    }

    if (!isGostorkAdmin && user.providerId !== providerId) {
      throw new ForbiddenException("You can only edit donors belonging to your provider");
    }

    const ALLOWED_FIELDS: Record<string, Set<string>> = {
      "egg-donor": new Set([
        "donorType", "age", "race", "ethnicity", "religion", "height", "weight",
        "eyeColor", "hairColor", "education", "location", "relationshipStatus",
        "occupation", "bloodType", "donationTypes", "donorCompensation", "eggLotCost",
        "numberOfEggs", "totalCost", "photoUrl", "videoUrl", "status", "hiddenFromSearch", "isPremium", "isExperienced", "profileData", "photos",
      ]),
      "surrogate": new Set([
        "age", "bmi", "height", "weight", "location", "relationshipStatus",
        "race", "ethnicity", "religion", "education",
        "liveBirths", "miscarriages", "cSections", "occupation", "baseCompensation",
        "totalCostMin", "totalCostMax", "agreesToAbortion",
        "agreesToTwins", "covidVaccinated", "openToSameSexCouple",
        "agreesToSelectiveReduction", "agreesToInternationalParents", "lastDeliveryYear",
        "photoUrl", "videoUrl", "status", "hiddenFromSearch", "isPremium", "isExperienced", "profileData", "photos",
      ]),
      "sperm-donor": new Set([
        "donorType", "age", "race", "ethnicity", "height", "weight",
        "eyeColor", "hairColor", "education", "location", "relationshipStatus",
        "occupation", "compensation", "photoUrl", "videoUrl", "status", "hiddenFromSearch", "isPremium", "isExperienced", "profileData", "photos",
      ]),
    };

    const allowed = ALLOWED_FIELDS[validType] || new Set();
    const changedFields: string[] = [];
    const updateData: Record<string, any> = {};

    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      updateData[key] = value;
      changedFields.push(key);
    }

    let existing: any;
    if (validType === "egg-donor") {
      existing = await this.prisma.eggDonor.findFirst({ where: { id: donorId, providerId } });
    } else if (validType === "surrogate") {
      existing = await this.prisma.surrogate.findFirst({ where: { id: donorId, providerId } });
    } else {
      existing = await this.prisma.spermDonor.findFirst({ where: { id: donorId, providerId } });
    }
    if (!existing) throw new NotFoundException("Donor not found");

    const existingManual: string[] = existing.manuallyEditedFields || [];
    const mergedManual = Array.from(new Set([...existingManual, ...changedFields]));
    updateData.manuallyEditedFields = mergedManual;
    updateData.lastEditedBy = user.id;
    updateData.lastEditedAt = new Date();

    let updated: any;
    if (validType === "egg-donor") {
      updated = await this.prisma.eggDonor.update({ where: { id: donorId }, data: updateData });
    } else if (validType === "surrogate") {
      updated = await this.prisma.surrogate.update({ where: { id: donorId }, data: updateData });
    } else {
      updated = await this.prisma.spermDonor.update({ where: { id: donorId }, data: updateData });
    }

    const compensationFields: Record<string, string> = {
      "egg-donor": "donorCompensation",
      "surrogate": "baseCompensation",
      "sperm-donor": "compensation",
    };
    const compField = compensationFields[validType];
    if (compField && changedFields.includes(compField)) {
      const compValue = updated[compField] != null ? Number(updated[compField]) : null;
      const donorSubType = validType === "egg-donor" && updated.donorType
        ? (/frozen/i.test(updated.donorType) && !/fresh/i.test(updated.donorType) ? "frozen" : "fresh")
        : undefined;
      await recalcAndPersistSingleDonorCost(this.prisma, providerId, validType, donorId, compValue, donorSubType);
      if (validType === "egg-donor") {
        updated = await this.prisma.eggDonor.findUnique({ where: { id: donorId } });
      } else if (validType === "surrogate") {
        updated = await this.prisma.surrogate.findUnique({ where: { id: donorId } });
      } else if (validType === "sperm-donor") {
        updated = await this.prisma.spermDonor.findUnique({ where: { id: donorId } });
      }
    }

    return updated;
  }

  @Delete("surrogates/pdfs")
  @ApiOperation({ summary: "Delete all surrogates created via PDF upload" })
  async deletePdfProfiles(
    @Param("providerId") providerId: string,
    @Req() req: any,
  ) {
    const user = req.user;
    if (!user) throw new ForbiddenException("Not authenticated");

    const isGostorkAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user.roles?.includes("PROVIDER_ADMIN");
    if (!isGostorkAdmin && !isProviderAdmin) {
      throw new ForbiddenException("Only admins can delete PDF profiles");
    }
    if (!isGostorkAdmin && user.providerId !== providerId) {
      throw new ForbiddenException("You can only delete profiles from your own provider");
    }

    const count = await deletePdfSurrogates(this.prisma, providerId);
    return { count, message: `Deleted ${count} PDF-uploaded surrogate profiles` };
  }

  @Post("repair-photos")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Repair expired S3 photo URLs by persisting them to GCS" })
  async repairPhotos(
    @Param("providerId") providerId: string,
    @Req() req: any,
  ) {
    const user = req.user;
    const isGostorkAdmin = user?.roles?.includes("GOSTORK_ADMIN");
    if (!isGostorkAdmin && !user?.roles?.includes("PROVIDER_ADMIN")) {
      throw new ForbiddenException("Only admins can repair photos");
    }
    if (!isGostorkAdmin && user.providerId !== providerId) {
      throw new ForbiddenException("You can only repair photos for your own provider");
    }

    const result = await repairPhotoUrls(this.prisma, this.storageService, providerId);
    return result;
  }

  @Delete("sync/:type/:donorId")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Delete a single donor/surrogate/sperm-donor profile" })
  async deleteSingleProfile(
    @Param("providerId") providerId: string,
    @Param("type") type: string,
    @Param("donorId") donorId: string,
    @Req() req: any,
  ) {
    const user = req.user;
    const isGostorkAdmin = user?.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = user?.roles?.includes("PROVIDER_ADMIN");
    if (!isGostorkAdmin && !isProviderAdmin) {
      throw new ForbiddenException("Only admins can delete profiles");
    }
    if (!isGostorkAdmin && user.providerId !== providerId) {
      throw new ForbiddenException("You can only delete profiles from your own provider");
    }

    let deleted = false;
    switch (type) {
      case "egg-donors": {
        const result = await this.prisma.eggDonor.deleteMany({ where: { id: donorId, providerId } });
        deleted = result.count > 0;
        break;
      }
      case "surrogates": {
        const result = await this.prisma.surrogate.deleteMany({ where: { id: donorId, providerId } });
        deleted = result.count > 0;
        break;
      }
      case "sperm-donors": {
        const result = await this.prisma.spermDonor.deleteMany({ where: { id: donorId, providerId } });
        deleted = result.count > 0;
        break;
      }
      default:
        throw new BadRequestException("Invalid type");
    }

    if (!deleted) {
      throw new NotFoundException("Profile not found");
    }

    await recalcAndPersistTotalCostsForProvider(this.prisma, providerId);
    return { message: "Profile deleted" };
  }
}
