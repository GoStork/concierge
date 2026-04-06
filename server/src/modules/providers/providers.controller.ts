import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Req,
  Query,
  HttpCode,
  HttpStatus,
  Inject,
  UseGuards,
  Header,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiBody } from "@nestjs/swagger";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { insertProviderSchema } from "@shared/schema";
import { hasProviderRole } from "@shared/roles";
import { enrichDonorsWithPendingCosts, enrichDonorsAcrossProviders } from "../costs/total-cost.utils";
import { updateProfileEmbedding } from "./profile-sync.service";
import { z } from "zod";

const marketplaceCache = new Map<string, { data: any; expiry: number }>();
const CACHE_TTL_MS = 30_000;

function getCached(key: string): any | null {
  const entry = marketplaceCache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  marketplaceCache.delete(key);
  return null;
}

function setCache(key: string, data: any): void {
  marketplaceCache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}
import {
  CreateProviderDto,
  UpdateProviderDto,
  ProviderResponseDto,
} from "../../dto/provider.dto";
import { ErrorResponseDto } from "../../dto/auth.dto";
import { scrapeProviderWebsite } from "./scrape.service";
import { searchSartForClinic, mergeTeamMembers, verifyClinicUrl } from "./clinic-enrichment.service";
import { Prisma } from "@prisma/client";

const JSON_NULLABLE_FIELDS = ["ivfAcceptingPatients", "surrogacyCitizensNotAllowed", "surrogacyBirthCertificateListing"] as const;

function coerceJsonNullFields(input: Record<string, any>): Record<string, any> {
  const result = { ...input };
  for (const field of JSON_NULLABLE_FIELDS) {
    if (field in result && result[field] === null) {
      result[field] = Prisma.JsonNull;
    }
  }
  return result;
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

const STATE_NAME_TO_ABBR = Object.fromEntries(
  Object.entries(US_STATES).map(([abbr, name]) => [name.toLowerCase(), abbr])
);

function buildLocationFilter(input: string): any[] {
  const upper = input.toUpperCase();
  const lower = input.toLowerCase();
  const conditions: any[] = [];

  const isStateAbbr = upper.length === 2 && US_STATES[upper];
  const isStateName = !!STATE_NAME_TO_ABBR[lower];

  if (isStateAbbr) {
    conditions.push({ state: { equals: upper, mode: "insensitive" } });
    conditions.push({ city: { contains: US_STATES[upper], mode: "insensitive" } });
    conditions.push({ state: { contains: US_STATES[upper], mode: "insensitive" } });
  } else if (isStateName) {
    const abbr = STATE_NAME_TO_ABBR[lower];
    conditions.push({ state: { equals: abbr, mode: "insensitive" } });
    conditions.push({ city: { contains: input, mode: "insensitive" } });
    conditions.push({ state: { contains: input, mode: "insensitive" } });
  } else {
    conditions.push({ city: { contains: input, mode: "insensitive" } });
    conditions.push({ state: { contains: input, mode: "insensitive" } });
  }

  return conditions;
}

@ApiTags("Providers")
@Controller("api/providers")
export class ProvidersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get("marketplace/egg-donors")
  @ApiOperation({ summary: "List all egg donors across all providers (marketplace)" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceEggDonors(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    if (isProviderUser && user?.providerId) {
      const donors = await this.prisma.eggDonor.findMany({
        where: { providerId: user.providerId, status: { not: "INACTIVE" } },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        orderBy: { createdAt: "desc" },
      });
      return enrichDonorsWithPendingCosts(this.prisma, user.providerId, "egg-donor", donors);
    }
    const cached = getCached("marketplace:egg-donors");
    if (cached) return cached;
    const donors = await this.prisma.eggDonor.findMany({
      where: {
        hiddenFromSearch: false,
        status: { not: "INACTIVE" },
        provider: {
          services: {
            some: {
              status: "APPROVED",
              providerType: { name: { in: ["Egg Donor Agency", "Egg Bank"] } },
            },
          },
        },
      },
      include: { provider: { select: { id: true, name: true, logoUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    const result = await enrichDonorsAcrossProviders(this.prisma, "egg-donor", donors);
    setCache("marketplace:egg-donors", result);
    return result;
  }

  @Get("marketplace/surrogates")
  @ApiOperation({ summary: "List all surrogates across all providers (marketplace)" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceSurrogates(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    if (isProviderUser && user?.providerId) {
      const donors = await this.prisma.surrogate.findMany({
        where: { providerId: user.providerId, status: { not: "INACTIVE" } },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        orderBy: { createdAt: "desc" },
      });
      return enrichDonorsWithPendingCosts(this.prisma, user.providerId, "surrogate", donors);
    }
    const cached = getCached("marketplace:surrogates");
    if (cached) return cached;
    const donors = await this.prisma.surrogate.findMany({
      where: {
        hiddenFromSearch: false,
        status: { not: "INACTIVE" },
        provider: {
          services: {
            some: {
              status: "APPROVED",
              providerType: { name: { in: ["Surrogacy Agency"] } },
            },
          },
        },
      },
      include: { provider: { select: { id: true, name: true, logoUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    const result = await enrichDonorsAcrossProviders(this.prisma, "surrogate", donors);
    setCache("marketplace:surrogates", result);
    return result;
  }

  @Get("marketplace/sperm-donors")
  @ApiOperation({ summary: "List all sperm donors across all providers (marketplace)" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceSpermDonors(@Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    if (isProviderUser && user?.providerId) {
      const donors = await this.prisma.spermDonor.findMany({
        where: { providerId: user.providerId, status: { not: "INACTIVE" } },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        orderBy: { createdAt: "desc" },
      });
      return enrichDonorsWithPendingCosts(this.prisma, user.providerId, "sperm-donor", donors);
    }
    const cached = getCached("marketplace:sperm-donors");
    if (cached) return cached;
    const donors = await this.prisma.spermDonor.findMany({
      where: {
        hiddenFromSearch: false,
        status: { not: "INACTIVE" },
        provider: {
          services: {
            some: {
              status: "APPROVED",
              providerType: { name: { in: ["Sperm Bank"] } },
            },
          },
        },
      },
      include: { provider: { select: { id: true, name: true, logoUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    const result = await enrichDonorsAcrossProviders(this.prisma, "sperm-donor", donors);
    setCache("marketplace:sperm-donors", result);
    return result;
  }

  @Get()
  @ApiOperation({ summary: "List all providers with services and locations" })
  @ApiResponse({ status: 200, description: "List of providers", type: [ProviderResponseDto] })
  async list(@Req() req: Request, @Query() query: any) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isParent = roles.includes("PARENT") && roles.length === 1;

    const where: any = {};

    if (query.search) {
      // Normalize search: strip dashes/special chars so "Kindbody New York" matches "Kindbody-New York"
      const searchTerms = query.search.trim().split(/[\s\-_]+/).filter(Boolean);
      if (searchTerms.length > 1) {
        where.AND = searchTerms.map((term: string) => ({
          name: { contains: term, mode: "insensitive" },
        }));
      } else {
        where.name = { contains: query.search.trim(), mode: "insensitive" };
      }
    }

    if (query.location) {
      where.locations = {
        some: {
          OR: buildLocationFilter(query.location.trim()),
        },
      };
    }

    const eggSource = query.eggSource || "own_eggs";
    const ageGroup = query.ageGroup || "under_35";
    const isNewPatient = query.ivfHistory === "false" ? false : true;

    const latestYearResult = await this.prisma.ivfSuccessRate.aggregate({ _max: { year: true } });
    const latestYear = latestYearResult._max.year || 0;

    let successRateWhere: any;
    if (eggSource === "own_eggs") {
      const ownEggsMetricCodes = isNewPatient
        ? ["pct_new_patients_live_birth_after_1_retrieval"]
        : ["pct_intended_retrievals_live_births"];
      successRateWhere = { profileType: "own_eggs", ageGroup, isNewPatient, metricCode: { in: ownEggsMetricCodes }, year: latestYear };
    } else if (eggSource === "donated_embryos") {
      successRateWhere = { profileType: "donor", submetric: "donated_embryos", metricCode: "pct_transfers_live_births_donor", year: latestYear };
    } else {
      successRateWhere = {
        profileType: "donor",
        submetric: { in: ["fresh_embryos_fresh_eggs", "fresh_embryos_frozen_eggs", "frozen_embryos"] },
        metricCode: "pct_transfers_live_births_donor",
        year: latestYear,
      };
    }

    const isAdmin = roles.includes("GOSTORK_ADMIN");
    const isProviderUser = hasProviderRole(roles) && !isAdmin;

    if (isParent) {
      where.services = { some: { status: "APPROVED" } };
      const providers = await this.prisma.provider.findMany({
        where,
        include: {
          services: { where: { status: "APPROVED" }, include: { providerType: true } },
          locations: { orderBy: { sortOrder: "asc" } },
          ivfSuccessRates: { where: successRateWhere },
        },
        orderBy: { createdAt: "desc" },
      });
      return providers;
    }

    if (isProviderUser && user?.providerId) {
      where.id = user.providerId;
    }

    const serviceFilter: any = {};
    if (query.providerType && query.providerType !== "All") {
      serviceFilter.providerType = { name: query.providerType };
    }
    if (query.status && query.status !== "All") {
      serviceFilter.status = query.status;
    }
    if (Object.keys(serviceFilter).length > 0) {
      where.services = { some: serviceFilter };
    }

    let orderBy: any = { createdAt: "desc" };
    if (query.sortBy === "oldest") {
      orderBy = { createdAt: "asc" };
    } else if (query.sortBy === "alphabetical") {
      orderBy = { name: "asc" };
    } else if (query.sortBy === "alphabetical_desc") {
      orderBy = { name: "desc" };
    } else if (query.sortBy === "website_asc") {
      orderBy = { websiteUrl: { sort: "asc", nulls: "last" } };
    } else if (query.sortBy === "website_desc") {
      orderBy = { websiteUrl: { sort: "desc", nulls: "last" } };
    } else if (query.sortBy === "updated_asc") {
      orderBy = { updatedAt: "asc" };
    } else if (query.sortBy === "updated_desc") {
      orderBy = { updatedAt: "desc" };
    }

    const hasIvfFilters = query.eggSource || query.ageGroup || query.ivfHistory;

    return this.prisma.provider.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      include: {
        services: { include: { providerType: true } },
        locations: { orderBy: { sortOrder: "asc" } },
        ...(hasIvfFilters ? { ivfSuccessRates: { where: successRateWhere } } : {}),
      },
      orderBy,
    });
  }

  @Get("lookup-success-rates")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Look up IVF success rates by clinic name (for provider creation preview)" })
  @ApiResponse({ status: 200, description: "Matching success rates if found" })
  async lookupSuccessRates(
    @Query("name") name: string,
    @Query("city") city: string,
    @Query("state") state: string,
    @Req() req: Request,
  ) {
    if (!(req.user as any).roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GOSTORK_ADMIN can look up success rates");
    }
    if (!name) return { found: false, rates: [] };

    const normalizedName = name.toLowerCase().trim();
    const providers = await this.prisma.provider.findMany({
      where: {
        ivfSuccessRates: { some: {} },
      },
      select: {
        id: true,
        name: true,
        locations: {
          select: { city: true, state: true },
          orderBy: { sortOrder: "asc" as const },
          take: 1,
        },
        ivfSuccessRates: true,
      },
    });

    let bestMatch: (typeof providers)[0] | null = null;
    let bestScore = 0;

    const inputWords = new Set(
      normalizedName.replace(/[.,'"]/g, "").replace(/[\-–]/g, " ").split(/\s+/).filter(w => w.length >= 3)
    );

    for (const p of providers) {
      const pName = p.name.toLowerCase().replace(/[.,'"]/g, "").replace(/[\-–]/g, " ");
      const pWords = new Set(pName.split(/\s+/).filter(w => w.length >= 3));
      let matchingWords = 0;
      for (const w of inputWords) {
        if (pWords.has(w)) matchingWords++;
      }
      const score = inputWords.size > 0 ? matchingWords / inputWords.size : 0;

      let locationBonus = 0;
      const pLoc = p.locations[0];
      if (city && pLoc?.city && pLoc.city.toLowerCase() === city.toLowerCase()) locationBonus += 0.15;
      if (state && pLoc?.state && (pLoc.state.toLowerCase() === state.toLowerCase() || pLoc.state.toLowerCase() === (US_STATES as any)[state.toUpperCase()]?.toLowerCase())) locationBonus += 0.05;

      const totalScore = score + locationBonus;
      if (totalScore > bestScore && score >= 0.4) {
        bestScore = totalScore;
        bestMatch = p;
      }
    }

    if (!bestMatch) return { found: false, rates: [] };

    return {
      found: true,
      matchedProvider: { id: bestMatch.id, name: bestMatch.name },
      rates: bestMatch.ivfSuccessRates,
    };
  }

  @Post("scrape")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Scrape a website URL to extract provider profile data (GOSTORK_ADMIN only)" })
  @ApiResponse({ status: 200, description: "Scraped provider data" })
  @ApiResponse({ status: 400, description: "Invalid URL or scraping failed", type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async scrape(@Body() body: { url: string }, @Req() req: Request) {
    if (!(req.user as any).roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GOSTORK_ADMIN can scrape websites");
    }
    if (!body.url || typeof body.url !== "string") {
      throw new BadRequestException("URL is required");
    }
    try {
      const data = await scrapeProviderWebsite(body.url);

      const providerName = data.name || "";
      const firstLocation = data.locations?.[0];
      const city = firstLocation?.city || null;
      const state = firstLocation?.state || null;

      // Run verification and SART enrichment in parallel to save time
      const [verifyResult, sartResult] = await Promise.all([
        verifyClinicUrl(body.url, providerName).catch(() => ({ valid: true, reason: "fetch-error-accepted" })),
        providerName
          ? searchSartForClinic(providerName, city, state).catch((sartErr: any) => {
              console.log(`[provider-scrape] SART lookup failed for "${providerName}": ${sartErr.message} - returning scraped data only`);
              return null;
            })
          : Promise.resolve(null),
      ]);

      if (!verifyResult.valid) {
        console.log(`[provider-scrape] URL verification warning for "${body.url}" (name: "${providerName}", reason: ${verifyResult.reason}) - proceeding anyway (admin-provided)`);
      }

      if (sartResult) {
        if (sartResult.members.length > 0) {
          data.teamMembers = mergeTeamMembers(
            sartResult.members,
            data.teamMembers || [],
            providerName,
          );
        }
        if (!data.phone && sartResult.phone) {
          data.phone = sartResult.phone;
        }
        if (!data.email && sartResult.email) {
          data.email = sartResult.email;
        }
        console.log(`[provider-scrape] SART enrichment complete for "${providerName}": ${sartResult.members.length} SART members found, final team: ${data.teamMembers?.length || 0}`);
      } else if (providerName) {
        console.log(`[provider-scrape] No SART match for "${providerName}"`);
      }

      return { ...data, urlVerified: verifyResult.valid };
    } catch (err: any) {
      throw new BadRequestException(err.message || "Failed to scrape website");
    }
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a single provider by ID" })
  @ApiParam({ name: "id", description: "Provider UUID" })
  @ApiResponse({ status: 200, description: "Provider details", type: ProviderResponseDto })
  @ApiResponse({ status: 404, description: "Provider not found", type: ErrorResponseDto })
  async get(@Param("id") id: string, @Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isParent = roles.includes("PARENT") && roles.length === 1;

    const provider = await this.prisma.provider.findUnique({
      where: { id },
      include: {
        services: isParent
          ? { where: { status: "APPROVED" }, include: { providerType: true } }
          : { include: { providerType: true } },
        locations: { orderBy: { sortOrder: "asc" } },
        members: { orderBy: { sortOrder: "asc" }, include: { locations: { include: { location: true } } } },
        surrogacyProfile: { include: { screening: true } },
        ivfSuccessRates: true,
      },
    });
    if (!provider) {
      throw new NotFoundException("Provider not found");
    }
    if (isParent && provider.services.length === 0) {
      throw new NotFoundException("Provider not found");
    }
    return provider;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a new provider (GOSTORK_ADMIN only)" })
  @ApiBody({ type: CreateProviderDto })
  @ApiResponse({ status: 201, description: "Provider created", type: ProviderResponseDto })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  @ApiResponse({ status: 401, description: "Unauthorized", type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async create(@Body() body: any, @Req() req: Request) {
    if (!(req.user as any).roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderSchema.parse(body);
      const provider = await this.prisma.provider.create({ data: coerceJsonNullFields(input) as any });
      updateProfileEmbedding(this.prisma, "Provider", provider.id, null).catch(() => {});
      return provider;
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  @Put(":id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a provider (GOSTORK_ADMIN or own PROVIDER)" })
  @ApiParam({ name: "id", description: "Provider UUID" })
  @ApiBody({ type: UpdateProviderDto })
  @ApiResponse({ status: 200, description: "Provider updated", type: ProviderResponseDto })
  @ApiResponse({ status: 400, description: "Validation error", type: ErrorResponseDto })
  @ApiResponse({ status: 401, description: "Unauthorized", type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  async update(
    @Param("id") id: string,
    @Body() body: any,
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const isAdmin = user.roles?.includes("GOSTORK_ADMIN");
    const isProviderAdmin = hasProviderRole(user.roles || []) && user.providerId === id;
    if (!isAdmin && !isProviderAdmin) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderSchema.partial().parse(body);
      const provider = await this.prisma.provider.update({
        where: { id },
        data: coerceJsonNullFields(input) as any,
      });
      if (input.about !== undefined || input.name !== undefined) {
        updateProfileEmbedding(this.prisma, "Provider", id, null).catch(() => {});
      }
      return provider;
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  @Delete(":id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a provider (GOSTORK_ADMIN only)" })
  @ApiParam({ name: "id", description: "Provider UUID" })
  @ApiResponse({ status: 200, description: "Provider deleted" })
  @ApiResponse({ status: 403, description: "Forbidden", type: ErrorResponseDto })
  @ApiResponse({ status: 404, description: "Provider not found", type: ErrorResponseDto })
  async delete(@Param("id") id: string, @Req() req: Request) {
    if (!(req.user as any).roles?.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Only GOSTORK_ADMIN can delete providers");
    }
    const provider = await this.prisma.provider.findUnique({ where: { id } });
    if (!provider) {
      throw new NotFoundException("Provider not found");
    }
    await this.prisma.client.$transaction(async (tx: any) => {
      await tx.userLocation.deleteMany({ where: { user: { providerId: id } } });
      // Delete all records that reference provider staff users before deleting the users themselves
      await tx.notification.deleteMany({ where: { user: { providerId: id } } });
      await tx.availabilityOverride.deleteMany({ where: { user: { providerId: id } } });
      await tx.calendarBlock.deleteMany({ where: { user: { providerId: id } } });
      await tx.calendarConnection.deleteMany({ where: { user: { providerId: id } } });
      await tx.eventFreeOverride.deleteMany({ where: { user: { providerId: id } } });
      await tx.scheduleConfig.deleteMany({ where: { user: { providerId: id } } });
      await tx.recording.deleteMany({ where: { booking: { providerUser: { providerId: id } } } });
      await tx.booking.deleteMany({ where: { providerUser: { providerId: id } } });
      await tx.user.deleteMany({ where: { providerId: id } });
      await tx.providerService.deleteMany({ where: { providerId: id } });
      await tx.costItem.deleteMany({ where: { sheet: { providerId: id } } });
      await tx.providerCostSheet.deleteMany({ where: { providerId: id } });
      await tx.providerMemberLocation.deleteMany({ where: { member: { providerId: id } } });
      await tx.providerMember.deleteMany({ where: { providerId: id } });
      await tx.eggDonor.deleteMany({ where: { providerId: id } });
      await tx.eggDonorSyncConfig.deleteMany({ where: { providerId: id } });
      await tx.surrogate.deleteMany({ where: { providerId: id } });
      await tx.surrogateSyncConfig.deleteMany({ where: { providerId: id } });
      await tx.spermDonor.deleteMany({ where: { providerId: id } });
      await tx.spermDonorSyncConfig.deleteMany({ where: { providerId: id } });
      const surrogacyProfile = await tx.surrogacyAgencyProfile.findUnique({ where: { providerId: id } });
      if (surrogacyProfile) {
        await tx.surrogateScreening.deleteMany({ where: { surrogacyProfileId: surrogacyProfile.id } });
        await tx.surrogacyAgencyProfile.delete({ where: { id: surrogacyProfile.id } });
      }
      await tx.aiChatSession.updateMany({ where: { providerId: id }, data: { providerId: null } });
      await tx.ivfSuccessRate.deleteMany({ where: { providerId: id } });
      await tx.providerBrandSettings.deleteMany({ where: { providerId: id } });
      await tx.providerLocation.deleteMany({ where: { providerId: id } });
      await tx.provider.delete({ where: { id } });
    });
    return { message: "Provider deleted" };
  }
}
