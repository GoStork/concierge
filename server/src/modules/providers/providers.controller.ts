import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
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
import { deriveIvfParentContext, evaluateIvfRequirements, ivfRequirementsFromProvider } from "../../../../shared/ivf-requirements";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiBody } from "@nestjs/swagger";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { insertProviderSchema } from "@shared/schema";
import { hasProviderRole, isProviderWriteRestricted } from "@shared/roles";
import { enrichDonorsWithPendingCosts, enrichDonorsAcrossProviders } from "../costs/total-cost.utils";
import { updateProfileEmbedding, applyProviderFaceAuthorization } from "./profile-sync.service";
import { getAsrmRequirements, reevaluateAllSurrogatesAsrm, invalidateAsrmRequirementsCache } from "./asrm";
import { describeSurrogateAsrmRequirements } from "../../../../shared/surrogate-requirements";
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

export function invalidateMarketplaceCache(prefix?: string): void {
  if (!prefix) {
    marketplaceCache.clear();
    return;
  }
  for (const key of Array.from(marketplaceCache.keys())) {
    if (key.startsWith(prefix)) marketplaceCache.delete(key);
  }
}
import {
  CreateProviderDto,
  UpdateProviderDto,
  ProviderResponseDto,
} from "../../dto/provider.dto";
import { ErrorResponseDto } from "../../dto/auth.dto";
import { scrapeProviderWebsite } from "./scrape.service";
import { US_STATES, STATE_NAME_TO_ABBR } from "./us-states";
import { searchSartForClinic, mergeTeamMembers, verifyClinicUrl } from "./clinic-enrichment.service";
import { Prisma } from "@prisma/client";
import { type EggSource, type AgeGroup } from "../../lib/ivf-success-rate";
import { DOCTOR_MEMBER_SELECT, enrichDoctorRows } from "../../lib/doctor-enrichment";
import { applySponsoredOrdering, SPONSORED_FIRST_ORDER } from "./sponsorship-sort";

const JSON_NULLABLE_FIELDS = ["ivfAcceptingPatients", "surrogacyCitizensNotAllowed", "surrogacyBirthCertificateListing", "partnerProviderIds"] as const;

function coerceJsonNullFields(input: Record<string, any>): Record<string, any> {
  const result = { ...input };
  for (const field of JSON_NULLABLE_FIELDS) {
    if (field in result && result[field] === null) {
      result[field] = Prisma.JsonNull;
    }
  }
  return result;
}

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

// Insurance values are stored as "Carrier" or "Carrier - Plan". Filtering is
// carrier-level (a clinic that accepts a carrier accepts it regardless of plan).
function insuranceCarrierOf(value: string): string {
  const idx = value.indexOf(" - ");
  return idx === -1 ? value : value.slice(0, idx);
}
function acceptsInsuranceCarrier(accepted: string[] | null | undefined, carrier: string): boolean {
  return !!accepted && accepted.some((v) => insuranceCarrierOf(v) === carrier);
}

// Canonical donor/surrogate statuses surfaced to the marketplace UI.
// INACTIVE is intentionally excluded - it's a soft-delete that must never
// be shown anywhere (chat, marketplace, AI search, provider's own list).
const SELECTABLE_DONOR_STATUSES = ["AVAILABLE", "ON_HOLD", "PENDING", "MATCHED"] as const;

// Parse the optional ?status= query param (comma-separated subset of the
// canonical set) into a Prisma `where.status` clause. Empty / missing /
// invalid values fall back to "show everything except INACTIVE", which is
// the marketplace default - the user wants all three states visible with
// status badges by default and the filter chip narrows the set.
function buildDonorStatusFilter(raw?: string | null): { in: string[] } | { not: string } {
  if (!raw) return { not: "INACTIVE" };
  const requested = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => (SELECTABLE_DONOR_STATUSES as readonly string[]).includes(s));
  if (requested.length === 0) return { not: "INACTIVE" };
  return { in: requested };
}

// Parent-facing surrogate list: MATCHED surrogates are hidden entirely
// (only their own agency sees them), regardless of the requested filter.
function buildParentSurrogateStatusFilter(raw?: string | null): { in: string[] } | { notIn: string[] } {
  const base = buildDonorStatusFilter(raw);
  if ("in" in base) {
    const allowed = base.in.filter((s) => s !== "MATCHED");
    if (allowed.length > 0) return { in: allowed };
  }
  return { notIn: ["INACTIVE", "MATCHED"] };
}

@ApiTags("Providers")
@Controller("api/providers")
export class ProvidersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get("marketplace/egg-donors")
  @ApiOperation({ summary: "List egg donors (paginated, 100 per page)" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceEggDonors(@Req() req: Request, @Query("page") page = "0", @Query("status") status?: string) {
    const PAGE_SIZE = 100;
    const statusFilter = buildDonorStatusFilter(status);
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    if (isProviderUser && user?.providerId) {
      const donors = await this.prisma.eggDonor.findMany({
        where: { providerId: user.providerId, status: statusFilter },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        orderBy: { createdAt: "desc" },
      });
      const data = await enrichDonorsWithPendingCosts(this.prisma, user.providerId, "egg-donor", donors);
      return { data, hasMore: false, nextPage: null };
    }
    const pageNum = Math.max(0, parseInt(page) || 0);
    const cacheKey = `marketplace:egg-donors:p${pageNum}:s${status || "all"}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const rows = await this.prisma.eggDonor.findMany({
      take: PAGE_SIZE + 1,
      skip: pageNum * PAGE_SIZE,
      where: {
        hiddenFromSearch: false,
        status: statusFilter,
        provider: {
          services: {
            some: {
              status: "APPROVED",
              providerType: { name: { in: ["Egg Donor Agency", "Egg Bank"] } },
            },
          },
        },
      },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            // Approved service-type names let the client show the bank
            // skip-to-checkout Buy button ONLY on Egg Bank / Sperm Bank
            // donors (agency donors go through the match process).
            services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } },
          },
        },
      },
      orderBy: [SPONSORED_FIRST_ORDER, { createdAt: "desc" }],
    });
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const enriched = await enrichDonorsAcrossProviders(this.prisma, "egg-donor", pageRows);
    const data = applySponsoredOrdering(enriched);
    const result = { data, hasMore, nextPage: hasMore ? pageNum + 1 : null };
    setCache(cacheKey, result);
    return result;
  }

  @Get("marketplace/surrogates")
  @ApiOperation({ summary: "List surrogates (paginated, 100 per page)" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceSurrogates(@Req() req: Request, @Query("page") page = "0", @Query("status") status?: string) {
    const PAGE_SIZE = 100;
    const statusFilter = buildDonorStatusFilter(status);
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    if (isProviderUser && user?.providerId) {
      const donors = await this.prisma.surrogate.findMany({
        where: { providerId: user.providerId, status: statusFilter },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        orderBy: { createdAt: "desc" },
      });
      const data = await enrichDonorsWithPendingCosts(this.prisma, user.providerId, "surrogate", donors);
      return { data, hasMore: false, nextPage: null };
    }
    const pageNum = Math.max(0, parseInt(page) || 0);
    const cacheKey = `marketplace:surrogates:p${pageNum}:s${status || "all"}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const rows = await this.prisma.surrogate.findMany({
      take: PAGE_SIZE + 1,
      skip: pageNum * PAGE_SIZE,
      where: {
        hiddenFromSearch: false,
        asrmHidden: false,
        status: buildParentSurrogateStatusFilter(status),
        provider: {
          services: {
            some: {
              status: "APPROVED",
              providerType: { name: { in: ["Surrogacy Agency"] } },
            },
          },
        },
      },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            // Approved service-type names let the client show the bank
            // skip-to-checkout Buy button ONLY on Egg Bank / Sperm Bank
            // donors (agency donors go through the match process).
            services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } },
          },
        },
      },
      orderBy: [SPONSORED_FIRST_ORDER, { createdAt: "desc" }],
    });
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const enriched = await enrichDonorsAcrossProviders(this.prisma, "surrogate", pageRows);
    const data = applySponsoredOrdering(enriched);
    const result = { data, hasMore, nextPage: hasMore ? pageNum + 1 : null };
    setCache(cacheKey, result);
    return result;
  }

  @Get("marketplace/surrogate-countries")
  @ApiOperation({ summary: "List distinct countries from approved surrogacy agency locations and surrogate locations" })
  @Header("Cache-Control", "public, max-age=300")
  async marketplaceSurrogateCountries() {
    const US_STATE_CODES = new Set([
      "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
      "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
      "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
    ]);
    const US_STATE_NAMES = new Set([
      "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida",
      "georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine",
      "maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska",
      "nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota",
      "ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota",
      "tennessee","texas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming",
      "district of columbia",
    ]);

    function isUSState(val: string): boolean {
      return US_STATE_CODES.has(val.trim().toUpperCase()) || US_STATE_NAMES.has(val.trim().toLowerCase());
    }

    // Extract country from a surrogate "City, State" or "City, Country" location string
    function countryFromSurrogateLocation(location: string | null | undefined): string | null {
      if (!location) return null;
      const loc = location.trim();
      const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 3) {
        return capitalize(parts[parts.length - 1]);
      }
      if (parts.length === 2) {
        const last = parts[1].replace(/\d/g, "").trim();
        return isUSState(last) ? "United States" : capitalize(last);
      }
      if (parts.length === 1) {
        return isUSState(loc) ? "United States" : null;
      }
      return null;
    }

    // Extract country from a ProviderLocation where international providers store the country in the state field
    function countryFromProviderLocation(state: string | null | undefined): string | null {
      if (!state) return null;
      const s = state.trim();
      if (!s) return null;
      const lower = s.toLowerCase();
      if (lower === "usa" || lower === "us") return "United States";
      if (isUSState(s)) return "United States";
      return capitalize(s);
    }

    function capitalize(s: string): string {
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    const approvedSurrogacyAgencyFilter = {
      services: {
        some: {
          status: "APPROVED",
          providerType: { name: { in: ["Surrogacy Agency"] } },
        },
      },
    };

    const [surrogates, providerLocations] = await Promise.all([
      this.prisma.surrogate.findMany({
        where: {
          hiddenFromSearch: false,
          asrmHidden: false,
          status: { not: "INACTIVE" },
          location: { not: null },
          provider: approvedSurrogacyAgencyFilter,
        },
        select: { location: true },
      }),
      this.prisma.providerLocation.findMany({
        where: {
          state: { not: null },
          provider: approvedSurrogacyAgencyFilter,
        },
        select: { state: true },
      }),
    ]);

    const countrySet = new Set<string>();
    for (const s of surrogates) {
      const c = countryFromSurrogateLocation(s.location);
      if (c) countrySet.add(c);
    }
    for (const pl of providerLocations) {
      const c = countryFromProviderLocation(pl.state);
      if (c) countrySet.add(c);
    }
    return Array.from(countrySet).sort();
  }

  @Get("marketplace/sperm-donors")
  @ApiOperation({ summary: "List sperm donors (paginated, 100 per page)" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceSpermDonors(@Req() req: Request, @Query("page") page = "0", @Query("status") status?: string) {
    const PAGE_SIZE = 100;
    const statusFilter = buildDonorStatusFilter(status);
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    if (isProviderUser && user?.providerId) {
      const donors = await this.prisma.spermDonor.findMany({
        where: { providerId: user.providerId, status: statusFilter, hiddenFromSearch: false },
        include: { provider: { select: { id: true, name: true, logoUrl: true } } },
        orderBy: { createdAt: "desc" },
      });
      const data = await enrichDonorsWithPendingCosts(this.prisma, user.providerId, "sperm-donor", donors);
      return { data, hasMore: false, nextPage: null };
    }
    const pageNum = Math.max(0, parseInt(page) || 0);
    const cacheKey = `marketplace:sperm-donors:p${pageNum}:s${status || "all"}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const rows = await this.prisma.spermDonor.findMany({
      take: PAGE_SIZE + 1,
      skip: pageNum * PAGE_SIZE,
      where: {
        hiddenFromSearch: false,
        status: statusFilter,
        provider: {
          services: {
            some: {
              status: "APPROVED",
              providerType: { name: { in: ["Sperm Bank"] } },
            },
          },
        },
      },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            // Approved service-type names let the client show the bank
            // skip-to-checkout Buy button ONLY on Egg Bank / Sperm Bank
            // donors (agency donors go through the match process).
            services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } },
          },
        },
      },
      orderBy: [SPONSORED_FIRST_ORDER, { createdAt: "desc" }],
    });
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const enriched = await enrichDonorsAcrossProviders(this.prisma, "sperm-donor", pageRows);
    const data = applySponsoredOrdering(enriched);
    const result = { data, hasMore, nextPage: hasMore ? pageNum + 1 : null };
    setCache(cacheKey, result);
    return result;
  }

  @Get("marketplace/doctors")
  @ApiOperation({ summary: "Search doctors (provider members) across approved IVF clinics" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceDoctors(@Req() req: Request, @Query() query: any) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    const memberWhere: any = {
      isPublicProfile: true,
      slug: { not: null },
      provider: {
        services: { some: { status: "APPROVED", providerType: { name: "IVF Clinic" } } },
      },
    };

    // Provider/clinic users only ever see the doctors at their OWN clinic - never
    // the full cross-clinic directory. Mirrors the marketplace egg-donors /
    // surrogates / sperm-donors self-visibility filtering (multi-tenant isolation).
    if (isProviderUser && user?.providerId) {
      memberWhere.provider.id = user.providerId;
    } else if (query.providerId) {
      // GoStork admin "Provider" filter: narrow the directory to specific clinics.
      // Only honored for non-self-scoped (admin/parent) callers; provider users
      // stay locked to their own clinic above.
      const ids = String(query.providerId).split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length) memberWhere.provider.id = { in: ids };
    }

    if (query.location) {
      memberWhere.provider.locations = { some: { OR: buildLocationFilter(query.location.trim()) } };
    }

    if (query.search) {
      const raw = query.search.trim();
      const terms = raw.split(/[\s\-_]+/).filter(Boolean);
      // Match the doctor's name, a specialty, OR the doctor's clinic name - so
      // searching a clinic ("Boston IVF - The Syracuse Center") in the Doctors
      // tab returns every doctor at that clinic.
      const nameWhere =
        terms.length > 1
          ? { AND: terms.map((t: string) => ({ name: { contains: t, mode: "insensitive" } })) }
          : { name: { contains: raw, mode: "insensitive" } };
      const providerNameWhere =
        terms.length > 1
          ? { provider: { AND: terms.map((t: string) => ({ name: { contains: t, mode: "insensitive" } })) } }
          : { provider: { name: { contains: raw, mode: "insensitive" } } };
      memberWhere.OR = [nameWhere, { specialties: { hasSome: [raw] } }, providerNameWhere];
    }

    if (query.specialty) {
      memberWhere.specialties = { has: query.specialty };
    }

    const members = await this.prisma.providerMember.findMany({
      where: memberWhere,
      take: 600,
      orderBy: [SPONSORED_FIRST_ORDER, { isMedicalDirector: "desc" }, { name: "asc" }],
      select: DOCTOR_MEMBER_SELECT,
    });

    // Carrier-level insurance + LGBTQ+ care filters (the doctor's clinic).
    const insuranceCarrier = query.insurance ? insuranceCarrierOf(query.insurance) : null;
    const wantsLgbtq = query.lgbtq === "true";
    const filtered = members.filter((m) => {
      if (insuranceCarrier && !acceptsInsuranceCarrier(m.provider.acceptedInsurance, insuranceCarrier)) return false;
      if (wantsLgbtq && !(Array.isArray(m.provider.ivfAcceptingPatients) && (m.provider.ivfAcceptingPatients as string[]).includes("gay_couple"))) return false;
      return true;
    });

    // Success-rate context for each clinic the doctor practices at - mirrors the
    // marketplace clinic list. Anything that isn't "own_eggs" resolves to donor.
    const eggSource: EggSource = query.eggSource && query.eggSource !== "own_eggs" ? "donor" : "own_eggs";
    const ageGroup: AgeGroup = (query.ageGroup as AgeGroup) || "under_35";
    const isNewPatient = query.ivfHistory === "false" ? false : true;
    const searchTerms = (query.search || "").trim().toLowerCase().split(/[\s\-_]+/).filter(Boolean);

    // Dedup + enrich (clinics[] with success rates, matchedSpecialties) via the
    // shared helper - the SAME shaping the search_doctors / resolve_doctor_card
    // MCP tools use, so the card renders identically here and in the AI matcher.
    const enrichedDoctors = enrichDoctorRows(filtered, {
      eggSource,
      ageGroup,
      isNewPatient,
      specialtyFilter: query.specialty,
      searchTerms,
    });
    return applySponsoredOrdering(enrichedDoctors).slice(0, 250);
  }

  // Lean clinic cards for the marketplace deck. Mirrors marketplace/doctors: one
  // server-filtered, success-rate-scoped, capped query that returns EVERYTHING the
  // ClinicSwipeCard needs (logo, locations, a few public member faces, the matched
  // + fallback success-rate rows) so the deck renders with NO per-card refetch -
  // the old `/api/providers/:id`-per-card pattern was what made the Clinics tab lag.
  // Phase 4: does the authenticated parent meet this clinic's matching
  // requirements? Powers the booking-time soft warning (and anything else
  // that needs a server-verdict). Non-IVF providers always pass.
  @Get("marketplace/clinics/:id/requirements-check")
  @UseGuards(SessionOrJwtGuard)
  async clinicRequirementsCheck(@Req() req: Request, @Param("id") id: string) {
    const user = req.user as any;
    const provider = await this.prisma.provider.findUnique({
      where: { id },
      select: {
        ivfTwinsAllowed: true, ivfGenderSelectionAllowed: true, ivfTransferFromOtherClinics: true, ivfMaxAgeIp1: true,
        ivfMaxAgeIp2: true, ivfBiologicalConnection: true, ivfAcceptingPatients: true,
        services: { select: { status: true, providerType: { select: { name: true } } } },
      },
    });
    if (!provider) return { pass: true, failed: [] };
    const isIvf = (provider.services || []).some((sv: any) => sv.status === "APPROVED" && sv.providerType?.name === "IVF Clinic");
    if (!isIvf) return { pass: true, failed: [] };

    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { dateOfBirth: true, partnerAge: true, gender: true, partnerGender: true, relationshipStatus: true, sexualOrientation: true, parentAccountId: true },
    });
    const profile = dbUser?.parentAccountId
      ? await this.prisma.intendedParentProfile.findUnique({
          where: { parentAccountId: dbUser.parentAccountId },
          select: { hasEmbryos: true, eggSource: true, spermSource: true, surrogateTwins: true },
        })
      : null;
    const ctx = deriveIvfParentContext(dbUser as any, profile as any);
    return evaluateIvfRequirements(ivfRequirementsFromProvider(provider), ctx);
  }

  @Get("marketplace/clinics")
  @ApiOperation({ summary: "Lean clinic cards for the marketplace deck (no per-card refetch)" })
  @Header("Cache-Control", "public, max-age=30")
  async marketplaceClinics(@Req() req: Request, @Query() query: any) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isProviderUser = hasProviderRole(roles);
    const where: any = {
      services: { some: { status: "APPROVED", providerType: { name: "IVF Clinic" } } },
    };

    // Provider/clinic users only ever see their OWN clinic card - never the full
    // marketplace directory. Mirrors the marketplace egg-donors / surrogates /
    // sperm-donors self-visibility filtering (multi-tenant isolation).
    if (isProviderUser && user?.providerId) {
      where.id = user.providerId;
    } else if (query.providerId) {
      // GoStork admin "Provider" filter: narrow the deck to specific clinics.
      // Only honored for non-self-scoped (admin/parent) callers.
      const ids = String(query.providerId).split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length) where.id = { in: ids };
    }

    if (query.location) {
      where.locations = { some: { OR: buildLocationFilter(query.location.trim()) } };
    }

    if (query.search) {
      // Match the clinic name OR a doctor (member) at the clinic - same as the
      // legacy list, so searching a doctor returns the clinics they practice at.
      const raw = query.search.trim();
      const terms = raw.split(/[\s\-_]+/).filter(Boolean);
      const nameMatch =
        terms.length > 1
          ? { AND: terms.map((t: string) => ({ name: { contains: t, mode: "insensitive" } })) }
          : { name: { contains: raw, mode: "insensitive" } };
      const memberMatch =
        terms.length > 1
          ? { members: { some: { AND: terms.map((t: string) => ({ name: { contains: t, mode: "insensitive" } })) } } }
          : { members: { some: { name: { contains: raw, mode: "insensitive" } } } };
      where.OR = [nameMatch, memberMatch];
    }

    const eggSource = query.eggSource || "own_eggs";
    const ageGroup = query.ageGroup || "under_35";
    const isNewPatient = query.ivfHistory === "false" ? false : true;

    const latestYearResult = await this.prisma.ivfSuccessRate.aggregate({ _max: { year: true } });
    const latestYear = latestYearResult._max.year || 0;

    // Rate rows the card needs: the selected context PLUS the under-35/new-patient
    // baseline, so a clinic missing the exact context still shows the fallback bar
    // (parity with the old per-card fetch which pulled all rates).
    let contextClause: any;
    if (eggSource === "own_eggs") {
      const codes = isNewPatient
        ? ["pct_new_patients_live_birth_after_1_retrieval", "pct_intended_retrievals_live_births"]
        : ["pct_intended_retrievals_live_births"];
      contextClause = { profileType: "own_eggs", ageGroup, isNewPatient, metricCode: { in: codes } };
    } else if (eggSource === "donated_embryos") {
      contextClause = { profileType: "donor", submetric: "donated_embryos", metricCode: "pct_transfers_live_births_donor" };
    } else {
      contextClause = {
        profileType: "donor",
        submetric: { in: ["fresh_embryos_fresh_eggs", "fresh_embryos_frozen_eggs", "frozen_embryos"] },
        metricCode: "pct_transfers_live_births_donor",
      };
    }
    const fallbackClause = { profileType: "own_eggs", ageGroup: "under_35", isNewPatient: true, metricCode: "pct_new_patients_live_birth_after_1_retrieval" };
    const rateWhere = { year: latestYear, OR: [contextClause, fallbackClause] };

    const rows = await this.prisma.provider.findMany({
      where,
      take: 600,
      orderBy: [SPONSORED_FIRST_ORDER, { name: "asc" }],
      select: {
        id: true,
        name: true,
        logoUrl: true,
        sponsoredUntil: true,
        sponsorBoostSeed: true,
        // Year founded + about feed the Overview section of the card's first tab.
        about: true,
        yearFounded: true,
        acceptedInsurance: true,
        ivfAcceptingPatients: true,
        // IVF matching requirements -> the clinic's "Parents Matching Requirements" tab.
        ivfTwinsAllowed: true,
        ivfGenderSelectionAllowed: true,
        ivfTransferFromOtherClinics: true,
        ivfMaxAgeIp1: true,
        ivfMaxAgeIp2: true,
        ivfBiologicalConnection: true,
        ivfEggDonorType: true,
        // IVF surrogate matching requirements -> the clinic's "Surrogate Matching
        // Requirements" tab (only shown to parents seeking surrogacy).
        ivfSurrogateMinAge: true,
        ivfSurrogateMaxAge: true,
        ivfSurrogateMinBmi: true,
        ivfSurrogateMaxBmi: true,
        ivfSurrogateMinDeliveries: true,
        ivfSurrogateMaxDeliveries: true,
        ivfSurrogateMaxCSections: true,
        ivfSurrogateMaxMiscarriages: true,
        ivfSurrogateMaxAbortions: true,
        ivfSurrogateMaxYearsFromLastPregnancy: true,
        ivfSurrogateMonthsPostVaginal: true,
        ivfSurrogateCovidVaccination: true,
        ivfSurrogateGdDiet: true,
        ivfSurrogateGdMedication: true,
        ivfSurrogateHighBloodPressure: true,
        ivfSurrogatePreeclampsia: true,
        ivfSurrogatePlacentaPrevia: true,
        ivfSurrogateMentalHealthHistory: true,
        // CDC JSON columns drive the personalized "Experience with your needs" tab.
        cdcServices: true,
        cdcExperience: true,
        cdcCycleStats: true,
        services: { where: { status: "APPROVED" }, select: { status: true, providerType: { select: { name: true } } } },
        locations: { select: { city: true, state: true }, orderBy: { sortOrder: "asc" }, take: 8 },
        members: {
          where: { isPublicProfile: true },
          // bio + languages let the clinic card embed each doctor's own Overview
          // tab (About / Works at / Locations / Languages) on their face slide.
          select: { id: true, name: true, title: true, photoUrl: true, highResPhotoUrl: true, isPublicProfile: true, bio: true, languagesSpoken: true, sortOrder: true },
          orderBy: { sortOrder: "asc" },
          take: 12,
        },
        ivfSuccessRates: {
          where: rateWhere,
          select: {
            profileType: true, ageGroup: true, isNewPatient: true, metricCode: true,
            submetric: true, successRate: true, nationalAverage: true, top10pct: true, cycleCount: true,
          },
        },
      },
    });

    const insuranceCarrier = query.insurance ? insuranceCarrierOf(query.insurance) : null;
    const wantsLgbtq = query.lgbtq === "true";
    const clinicRows = rows.filter((p) => {
      if (insuranceCarrier && !acceptsInsuranceCarrier(p.acceptedInsurance, insuranceCarrier)) return false;
      if (wantsLgbtq && !(Array.isArray(p.ivfAcceptingPatients) && (p.ivfAcceptingPatients as string[]).includes("gay_couple"))) return false;
      return true;
    });
    return applySponsoredOrdering(clinicRows);
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
      // Normalize search: strip dashes/special chars so "Kindbody New York" matches "Kindbody-New York".
      // Match the clinic name OR a doctor (member) at the clinic, so searching a
      // doctor ("Dr. Vicken Sahakian") in the Clinics tab returns every clinic
      // that doctor practices at.
      const raw = query.search.trim();
      const searchTerms = raw.split(/[\s\-_]+/).filter(Boolean);
      const nameMatch =
        searchTerms.length > 1
          ? { AND: searchTerms.map((term: string) => ({ name: { contains: term, mode: "insensitive" } })) }
          : { name: { contains: raw, mode: "insensitive" } };
      const memberMatch =
        searchTerms.length > 1
          ? { members: { some: { AND: searchTerms.map((term: string) => ({ name: { contains: term, mode: "insensitive" } })) } } }
          : { members: { some: { name: { contains: raw, mode: "insensitive" } } } };
      where.OR = [nameMatch, memberMatch];
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

    // Post-fetch marketplace filters (carrier-level insurance + LGBTQ+ care).
    const insuranceCarrier = query.insurance ? insuranceCarrierOf(query.insurance) : null;
    const wantsLgbtq = query.lgbtq === "true";
    const applyMarketplaceFilters = (rows: any[]) =>
      rows.filter((p) => {
        if (insuranceCarrier && !acceptsInsuranceCarrier(p.acceptedInsurance, insuranceCarrier)) return false;
        if (wantsLgbtq && !(Array.isArray(p.ivfAcceptingPatients) && (p.ivfAcceptingPatients as string[]).includes("gay_couple"))) return false;
        return true;
      });

    if (isParent) {
      where.services = { some: { status: "APPROVED" } };
      const providers = await this.prisma.provider.findMany({
        where,
        include: {
          services: { where: { status: "APPROVED" }, include: { providerType: true } },
          locations: { orderBy: { sortOrder: "asc" } },
          ivfSuccessRates: { where: successRateWhere },
          // Surrogacy agency cards build their Overview/Screening tabs from this,
          // and the rotating team-member faces (CEO/Owner/Founder first) from members.
          surrogacyProfile: { include: { screening: true } },
          members: {
            where: { isPublicProfile: true },
            orderBy: { sortOrder: "asc" },
            select: { id: true, name: true, title: true, photoUrl: true, highResPhotoUrl: true, isPublicProfile: true, sortOrder: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return applyMarketplaceFilters(providers);
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

    const rows = await this.prisma.provider.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      include: {
        services: { include: { providerType: true } },
        locations: { orderBy: { sortOrder: "asc" } },
        // Agency cards build their Overview/Screening tabs from this.
        surrogacyProfile: { include: { screening: true } },
        ...(hasIvfFilters ? { ivfSuccessRates: { where: successRateWhere } } : {}),
      },
      orderBy,
    });
    return applyMarketplaceFilters(rows);
  }

  // Lightweight {id, name} list of APPROVED providers for a given marketplace
  // tab type. Powers the GoStork-admin-only "Provider" filter in the marketplace
  // (narrow any tab to specific providers). Admin/dev only.
  @Get("marketplace/provider-options")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List approved providers for a marketplace tab type (GoStork admin only)" })
  async marketplaceProviderOptions(@Req() req: Request, @Query("type") type: string) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN") && !user?.roles?.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Forbidden");
    }
    // Map the marketplace tab/bar type to the underlying provider type name(s).
    // ivf-clinic covers both the Clinics and Doctors tabs (same provider set).
    const TYPE_MAP: Record<string, string[]> = {
      "egg-donor": ["Egg Donor Agency", "Egg Bank"],
      surrogate: ["Surrogacy Agency"],
      "sperm-donor": ["Sperm Bank"],
      "ivf-clinic": ["IVF Clinic"],
      "surrogacy-agency": ["Surrogacy Agency"],
    };
    const names = TYPE_MAP[type];
    if (!names) return [];
    return this.prisma.provider.findMany({
      where: {
        // GoStork is the platform-owner account (it hosts demo content across
        // several types), not a real marketplace provider - never list it.
        NOT: { name: { equals: "GoStork", mode: "insensitive" } },
        services: { some: { status: "APPROVED", providerType: { name: { in: names } } } },
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  @Get("by-type/ivf-clinic")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all approved IVF clinic providers (for partner clinic picker)" })
  async listIvfClinics(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.roles?.includes("GOSTORK_ADMIN") && !user?.roles?.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Forbidden");
    }
    return this.prisma.provider.findMany({
      where: {
        services: {
          some: { providerType: { name: "IVF Clinic" }, status: "APPROVED" },
        },
      },
      select: {
        id: true,
        name: true,
        locations: { select: { city: true, state: true }, orderBy: { sortOrder: "asc" }, take: 3 },
      },
      orderBy: { name: "asc" },
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
    const roles = (req.user as any).roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Only GoStork team can look up success rates");
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
    const callerRoles = (req.user as any).roles || [];
    if (!callerRoles.includes("GOSTORK_ADMIN") && !callerRoles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Only GoStork team can scrape websites");
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

  @Get("doctors/:slug")
  @ApiOperation({ summary: "Get a single doctor (provider member) by slug, with every clinic affiliation" })
  @ApiParam({ name: "slug", description: "Doctor slug, e.g. vicken-sahakian" })
  @ApiResponse({ status: 404, description: "Doctor not found", type: ErrorResponseDto })
  async getDoctor(@Param("slug") slug: string, @Req() req: Request) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    const isParent = roles.includes("PARENT") && roles.length === 1;

    const primary = await this.prisma.providerMember.findUnique({
      where: { slug },
    });
    if (!primary || primary.isPublicProfile === false) {
      throw new NotFoundException("Doctor not found");
    }

    // Gather every member row for the same human across clinics (deduped by personKey).
    const memberRows = await this.prisma.providerMember.findMany({
      where: primary.personKey ? { personKey: primary.personKey } : { id: primary.id },
      orderBy: [{ isMedicalDirector: "desc" }, { sortOrder: "asc" }],
      include: {
        locations: { include: { location: true } },
        provider: {
          include: {
            services: isParent
              ? { where: { status: "APPROVED" }, include: { providerType: true } }
              : { include: { providerType: true } },
            locations: { orderBy: { sortOrder: "asc" } },
            ivfSuccessRates: true,
          },
        },
      },
    });

    // The same human can appear as several rows (SART vs website scrape,
    // "Dr. X" vs "X"). Score each row by how much profile data it carries so we
    // surface the richest one for identity and collapse duplicate clinic cards.
    const scoreRow = (m: any) =>
      (m.bio ? 1000 : 0) +
      (m.specialties?.length || 0) * 20 +
      (m.boardCertifications?.length || 0) * 10 +
      (m.education?.length || 0) * 10 +
      (m.languagesSpoken?.length || 0) * 5 +
      (m.photoUrl ? 50 : 0);

    // Parents only see clinics with an approved service.
    const eligibleRows = memberRows.filter(
      (m) => !isParent || (m.provider.services?.length ?? 0) > 0,
    );
    if (eligibleRows.length === 0) {
      throw new NotFoundException("Doctor not found");
    }

    // Identity fields come from the richest row across all of this person's clinics.
    const identity = eligibleRows.slice().sort((a, b) => scoreRow(b) - scoreRow(a))[0];

    // One affiliation per clinic: keep the richest member row for that clinic.
    const bestByProvider = new Map<string, (typeof eligibleRows)[number]>();
    for (const m of eligibleRows) {
      const cur = bestByProvider.get(m.providerId);
      if (!cur || scoreRow(m) > scoreRow(cur)) bestByProvider.set(m.providerId, m);
    }
    const affiliations = Array.from(bestByProvider.values()).map((m) => {
      const p = m.provider;
      return {
        memberId: m.id,
        title: m.title,
        isMedicalDirector: m.isMedicalDirector,
        providerId: p.id,
        providerName: p.name,
        logoUrl: p.logoUrl,
        // LGBTQ+ care is derived from the clinic's matching requirements (accepts
        // gay couples) - single source of truth, not a separate self-entry field.
        lgbtqCare: Array.isArray(p.ivfAcceptingPatients) && (p.ivfAcceptingPatients as string[]).includes("gay_couple"),
        acceptedInsurance: p.acceptedInsurance,
        offersVideoVisits: p.offersVideoVisits,
        serviceTypes: (p.services || []).map((s: any) => s.providerType?.name).filter(Boolean),
        memberLocations: m.locations.map((ml: any) => ({
          city: ml.location?.city,
          state: ml.location?.state,
          address: ml.location?.address,
          zip: ml.location?.zip,
        })),
        clinicLocations: p.locations.map((l) => ({
          city: l.city,
          state: l.state,
          address: l.address,
          zip: l.zip,
        })),
        successRates: p.ivfSuccessRates,
      };
    });

    // Published, GoStork-verified reviews for any of this person's member rows (Phase 7 populates these).
    const memberIds = memberRows.map((m) => m.id);
    const reviews = await this.prisma.providerReview.findMany({
      where: { memberId: { in: memberIds }, status: "PUBLISHED" },
      orderBy: { createdAt: "desc" },
    });

    return {
      id: identity.id,
      slug: primary.slug, // keep the slug the user navigated to
      name: identity.name,
      title: identity.title,
      bio: identity.bio,
      // Prefer the AI-upscaled crisp variant; fall back to the original.
      photoUrl: (identity as any).highResPhotoUrl || identity.photoUrl,
      isMedicalDirector: eligibleRows.some((m) => m.isMedicalDirector),
      specialties: identity.specialties,
      languagesSpoken: identity.languagesSpoken,
      boardCertifications: identity.boardCertifications,
      education: identity.education,
      professionalMemberships: identity.professionalMemberships,
      npiNumber: identity.npiNumber,
      npiTaxonomy: identity.npiTaxonomy,
      credential: identity.credential,
      licenseState: identity.licenseState,
      medicalSchool: identity.medicalSchool,
      graduationYear: identity.graduationYear,
      fieldSources: identity.fieldSources,
      yearsExperience: identity.yearsExperience,
      providerGender: identity.providerGender,
      offersVideoVisits: identity.offersVideoVisits,
      acceptingNewPatients: identity.acceptingNewPatients,
      reviewCount: identity.reviewCount,
      recommendPct: identity.recommendPct,
      avgOverallScore: identity.avgOverallScore,
      affiliations,
      reviews,
    };
  }

  // ASRM(GoStork) minimum requirements for surrogates - read from the GoStork
  // house provider's Surrogate Matching Requirements settings. Powers the
  // constant banner on the provider Surrogates tab. Must be declared before
  // the ":id" catch-all route.
  @Get("asrm/surrogate-requirements")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the platform-wide ASRM surrogate minimum requirements" })
  async asrmSurrogateRequirements() {
    const requirements = await getAsrmRequirements(this.prisma);
    return {
      requirements,
      lines: requirements ? describeSurrogateAsrmRequirements(requirements) : [],
    };
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
    const callerRoles = (req.user as any).roles || [];
    const isAdmin = callerRoles.includes("GOSTORK_ADMIN");
    const isDeveloper = callerRoles.includes("GOSTORK_DEVELOPER");
    if (!isAdmin && !isDeveloper) {
      throw new ForbiddenException("Forbidden");
    }
    try {
      const input = insertProviderSchema.parse(body);
      const data = coerceJsonNullFields(input) as any;
      if (isDeveloper && !isAdmin) data.isTestData = true;
      const provider = await this.prisma.provider.create({ data });
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
    const isDeveloper = user.roles?.includes("GOSTORK_DEVELOPER");
    const isProviderAdmin = hasProviderRole(user.roles || []) && user.providerId === id;
    if (!isAdmin && !isDeveloper && !isProviderAdmin) {
      throw new ForbiddenException("Forbidden");
    }
    if (isDeveloper && !isAdmin) {
      const target = await this.prisma.provider.findUnique({ where: { id }, select: { isTestData: true } });
      if (!target?.isTestData) throw new ForbiddenException("Developers can only update test providers");
    }
    if (!isAdmin && isProviderWriteRestricted(user.roles || [])) {
      throw new ForbiddenException("Your role cannot edit the provider profile");
    }
    try {
      const input = insertProviderSchema.partial().parse(body);
      // Biometric-matching authorization transition: stamp the attestation time
      // and (re)index or remove this agency's donor/surrogate faces.
      let bioTransition: boolean | null = null;
      if (typeof input.biometricMatchingAuthorized === "boolean") {
        const cur = await this.prisma.provider.findUnique({ where: { id }, select: { biometricMatchingAuthorized: true } });
        if (!!cur?.biometricMatchingAuthorized !== input.biometricMatchingAuthorized) {
          bioTransition = input.biometricMatchingAuthorized;
          (input as any).biometricMatchingAuthorizedAt = input.biometricMatchingAuthorized ? new Date() : null;
        }
      }
      const provider = await this.prisma.provider.update({
        where: { id },
        data: coerceJsonNullFields(input) as any,
      });
      if (input.about !== undefined || input.name !== undefined) {
        updateProfileEmbedding(this.prisma, "Provider", id, null).catch(() => {});
      }
      if (bioTransition !== null) {
        applyProviderFaceAuthorization(this.prisma, id, bioTransition).catch(() => {});
      }
      // ASRM gate: if the GoStork house provider's Surrogate Matching
      // Requirements changed, re-evaluate every surrogate against the new
      // minimums (fire-and-forget - can touch thousands of rows).
      if (Object.keys(input).some((k) => k.startsWith("ivfSurrogate"))) {
        invalidateAsrmRequirementsCache();
        const isHouseProvider = process.env.GOSTORK_PROVIDER_ID
          ? provider.id === process.env.GOSTORK_PROVIDER_ID
          : provider.name?.toLowerCase() === "gostork";
        if (isHouseProvider) {
          reevaluateAllSurrogatesAsrm(this.prisma)
            .then(() => invalidateMarketplaceCache("marketplace:surrogates:"))
            .catch((e) => console.error("[ASRM] re-evaluation after settings change failed:", e?.message || e));
        }
      }
      return provider;
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new BadRequestException({ message: "Validation error", errors: err.errors });
      }
      throw err;
    }
  }

  // Phase 2: GoStork-admin-only endpoint to flip per-provider automation
  // feature flags. Parents and provider staff cannot self-enable - we want
  // to control which providers go live with each automation incrementally.
  @Patch(":id/auto-features")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a provider's automation feature flags (GOSTORK_ADMIN only)" })
  async updateAutoFeatures(
    @Param("id") id: string,
    @Body() body: {
      autoCostSheetDraft?: boolean;
      autoInvoiceDraft?: boolean;
      autoAgreementDraft?: boolean;
    },
    @Req() req: Request,
  ) {
    const user = req.user as any;
    const roles: string[] = user?.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_CONCIERGE")) {
      throw new ForbiddenException("Only GoStork admins can flip provider automation flags");
    }
    const existing = await this.prisma.provider.findUnique({
      where: { id },
      select: { autoFeaturesEnabled: true },
    });
    if (!existing) throw new ForbiddenException("Provider not found");
    const current = (existing.autoFeaturesEnabled as any) || {};
    const next = {
      ...current,
      ...(typeof body.autoCostSheetDraft === "boolean" ? { autoCostSheetDraft: body.autoCostSheetDraft } : {}),
      ...(typeof body.autoInvoiceDraft === "boolean" ? { autoInvoiceDraft: body.autoInvoiceDraft } : {}),
      ...(typeof body.autoAgreementDraft === "boolean" ? { autoAgreementDraft: body.autoAgreementDraft } : {}),
    };
    const updated = await this.prisma.provider.update({
      where: { id },
      data: { autoFeaturesEnabled: next },
      select: { id: true, autoFeaturesEnabled: true },
    });
    return updated;
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
    const callerRoles = (req.user as any).roles || [];
    const isAdmin = callerRoles.includes("GOSTORK_ADMIN");
    const isDeveloper = callerRoles.includes("GOSTORK_DEVELOPER");
    if (!isAdmin && !isDeveloper) {
      throw new ForbiddenException("Only GoStork team can delete providers");
    }
    const provider = await this.prisma.provider.findUnique({ where: { id } });
    if (!provider) {
      throw new NotFoundException("Provider not found");
    }
    if (isDeveloper && !isAdmin && !provider.isTestData) {
      throw new ForbiddenException("Developers can only delete test providers");
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
      await tx.providerCostSheet.deleteMany({ where: { providerId: id } });
      await tx.costProgram.deleteMany({ where: { providerId: id } });
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
      await tx.syncLog.deleteMany({ where: { providerId: id } });
      await tx.ivfSuccessRate.deleteMany({ where: { providerId: id } });
      await tx.providerBrandSettings.deleteMany({ where: { providerId: id } });
      await tx.providerLocation.deleteMany({ where: { providerId: id } });
      await tx.invoice.deleteMany({ where: { providerId: id } });
      await tx.provider.delete({ where: { id } });
    });
    return { message: "Provider deleted" };
  }
}
