// Type-only import: PrismaService is used purely as a parameter type here, so
// importing the type (erased at compile time) lets the standalone MCP process
// reuse these cost utils without pulling in the NestJS service / a 2nd Prisma client.
import type { PrismaService } from "../prisma/prisma.service";

const DONOR_TYPE_SERVICE_NAMES: Record<string, string[]> = {
  "egg-donor": ["Egg Donor Agency", "Egg Bank"],
  "surrogate": ["Surrogacy Agency"],
  "sperm-donor": ["Sperm Bank"],
};

export async function findProviderTypeIdForDonorType(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
): Promise<string | undefined> {
  const serviceNames = DONOR_TYPE_SERVICE_NAMES[donorType];
  if (!serviceNames) return undefined;

  const service = await prisma.providerService.findFirst({
    where: {
      providerId,
      providerType: { name: { in: serviceNames } },
    },
    include: { providerType: true },
  });
  return service?.providerTypeId;
}

// Maps a donor type (+ egg fresh/frozen) to the canonical subTypes[] coverage
// leaf carried on cost sheets, so the total-cost calculator matches sheets the
// same way the parent-facing matcher does. Returns null when the donor type has
// no cost-sheet coverage concept (then we fall back to any provider sheet).
function canonicalSubTypeLeaf(donorType: string, subType?: string | null): string | null {
  if (donorType === "egg-donor") return subType === "frozen" ? "egg_donor_frozen" : "egg_donor_fresh";
  if (donorType === "surrogate") return "surrogacy";
  if (donorType === "sperm-donor") return "sperm_donor";
  return null;
}

// All canonical subTypes[] leaves that belong to a donor type's own service, so
// we can tell a DEDICATED single-service sheet from a BUNDLED multi-service one
// that merely also covers this service.
function serviceLeavesForDonorType(donorType: string): string[] {
  if (donorType === "egg-donor") return ["egg_donor_fresh", "egg_donor_frozen"];
  if (donorType === "surrogate") return ["surrogacy"];
  if (donorType === "sperm-donor") return ["sperm_donor"];
  return [];
}

// Among cost sheets that all cover the target leaf, pick the one most specific to
// this service: a dedicated sheet (every subType is within this service) beats a
// bundled multi-service sheet (so an egg donor gets the Egg Donation Program
// price, not a surrogacy+IVF package that happens to include donor eggs); then
// fewest subTypes; then newest version.
function pickMostSpecificSheet<T extends { subTypes?: string[] | null; version?: number | null }>(
  sheets: T[],
  serviceLeaves: string[],
): T | null {
  if (sheets.length === 0) return null;
  const isDedicated = (s: T) => (s.subTypes || []).length > 0 && (s.subTypes || []).every((st) => serviceLeaves.includes(st));
  return [...sheets].sort((a, b) => {
    const ad = isDedicated(a) ? 0 : 1;
    const bd = isDedicated(b) ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const al = (a.subTypes || []).length;
    const bl = (b.subTypes || []).length;
    if (al !== bl) return al - bl;
    return (b.version || 0) - (a.version || 0);
  })[0];
}

export async function resolveCompensationAndTotalCost(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  profileCompensation: number | null | undefined,
  sheetStatuses: string[] = ["APPROVED"],
  subType?: string | null,
): Promise<{ resolvedCompensation: number | null; calculatedTotalCost: { min: number; max: number } | null }> {
  // Still needed below to identify base-compensation template fields.
  const providerTypeId = await findProviderTypeIdForDonorType(prisma, providerId, donorType);

  // Match cost sheets by the canonical subTypes[] coverage leaf - the same field
  // the parent-facing matcher uses - instead of the legacy providerTypeId, which
  // the upload-first flow never populates (the AI classifier sets serviceTypes /
  // subTypes but not providerTypeId). This makes sheets reliably discoverable and
  // lets a bundled multi-service sheet (e.g. egg-donor + surrogacy) correctly
  // count toward each service it covers.
  const leaf = canonicalSubTypeLeaf(donorType, subType);
  const baseWhere: any = {
    providerId,
    parentClientId: null,
    status: { in: sheetStatuses },
  };
  const sheetWhere: any = leaf ? { ...baseWhere, subTypes: { has: leaf } } : baseWhere;

  const candidateSheets = await prisma.providerCostSheet.findMany({
    where: sheetWhere,
    include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    orderBy: { version: "desc" },
  });
  const approvedSheet = pickMostSpecificSheet(candidateSheets, serviceLeavesForDonorType(donorType));

  if (!approvedSheet || approvedSheet.items.length === 0) {
    return { resolvedCompensation: profileCompensation ?? null, calculatedTotalCost: null };
  }

  const baseCompTemplateKeys = new Set<string>();
  if (providerTypeId) {
    const templates = await prisma.costTemplate.findMany({
      where: { providerTypeId, isBaseCompensation: true },
    });
    for (const t of templates) {
      baseCompTemplateKeys.add(t.fieldName);
    }
  }

  // An item is the base compensation line when it matches a base-comp template
  // field name, OR - since AI-extracted keys routinely differ from the template
  // names (e.g. "Donor Compensation" vs the "Egg Donor Compensation" template) -
  // when it sits in the canonical compensation category and reads as a base
  // compensation line rather than a surcharge / bonus / add-on.
  const baseCompCategories = new Set(["donor_compensation", "surrogate_compensation"]);
  const isBaseCompItem = (item: { key: string; category?: string }) => {
    if (baseCompTemplateKeys.has(item.key)) return true;
    const cat = (item.category || "").toLowerCase();
    const key = (item.key || "").toLowerCase();
    return (
      baseCompCategories.has(cat) &&
      key.includes("compensation") &&
      !/surcharge|additional|bonus|vip|premium|extra/.test(key)
    );
  };

  const baseCompItem = approvedSheet.items.find(item => isBaseCompItem(item) && item.isIncluded);

  const hasProfileComp = profileCompensation != null;
  let resolvedCompensation: number | null = profileCompensation ?? null;
  if (!hasProfileComp && baseCompItem) {
    resolvedCompensation = baseCompItem.minValue ?? null;
  }

  let minTotal = 0;
  let maxTotal = 0;
  for (const item of approvedSheet.items) {
    if (!item.isIncluded) continue;
    if (isBaseCompItem(item) && hasProfileComp && profileCompensation != null) {
      minTotal += profileCompensation;
      maxTotal += profileCompensation;
    } else {
      const min = item.minValue ?? 0;
      const max = item.maxValue ?? min;
      minTotal += min;
      maxTotal += max === 0 && min > 0 ? min : max;
    }
  }

  return {
    resolvedCompensation,
    calculatedTotalCost: { min: minTotal, max: maxTotal },
  };
}

// Return the LINE ITEMS of the cost sheet that resolveCompensationAndTotalCost
// would total for this donor type - same most-specific-sheet selection - so a
// caller can render a full per-line cost-sheet breakdown (e.g. a side-by-side
// donor cost-sheet comparison) instead of only the summed total. Returns null
// when the provider has no matching approved sheet.
export async function getMatchedCostSheetItems(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  subType?: string | null,
  sheetStatuses: string[] = ["APPROVED"],
): Promise<{ items: { category: string; key: string; minValue: number | null; maxValue: number | null; isIncluded: boolean; isTier: boolean }[] } | null> {
  const leaf = canonicalSubTypeLeaf(donorType, subType);
  const baseWhere: any = { providerId, parentClientId: null, status: { in: sheetStatuses } };
  const sheetWhere: any = leaf ? { ...baseWhere, subTypes: { has: leaf } } : baseWhere;
  const candidateSheets = await prisma.providerCostSheet.findMany({
    where: sheetWhere,
    include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    orderBy: { version: "desc" },
  });
  const sheet = pickMostSpecificSheet(candidateSheets, serviceLeavesForDonorType(donorType));
  if (!sheet || sheet.items.length === 0) return null;
  return {
    items: sheet.items.map((i: any) => ({
      category: i.category,
      key: i.key,
      minValue: i.minValue,
      maxValue: i.maxValue,
      isIncluded: i.isIncluded,
      isTier: i.isTier === true,
    })),
  };
}

async function getFrozenEggSheetData(
  prisma: PrismaService,
  providerId: string,
  sheetStatuses: string[] = ["APPROVED"],
): Promise<{ eggLotCost: number | null; numberOfEggs: number | null } | null> {
  const frozenCandidates = await prisma.providerCostSheet.findMany({
    where: {
      providerId,
      status: { in: sheetStatuses },
      parentClientId: null,
      subTypes: { has: "egg_donor_frozen" },
    },
    include: { items: true },
    orderBy: { version: "desc" },
  });
  const frozenSheet = pickMostSpecificSheet(frozenCandidates, serviceLeavesForDonorType("egg-donor"));
  if (!frozenSheet || frozenSheet.items.length === 0) return null;

  const lotCostItem = frozenSheet.items.find((i) => /egg lot cost/i.test(i.key) && i.isIncluded);
  const numEggsItem = frozenSheet.items.find((i) => /number of eggs/i.test(i.key) && i.isIncluded);

  return {
    eggLotCost: lotCostItem?.minValue ?? null,
    numberOfEggs: numEggsItem?.minValue ?? null,
  };
}

export async function recalcAndPersistTotalCostsForProvider(
  prisma: PrismaService,
  providerId: string,
  donorTypes?: string[],
): Promise<void> {
  const typesToProcess = donorTypes || ["egg-donor", "surrogate", "sperm-donor"];

  for (const donorType of typesToProcess) {
    if (donorType === "egg-donor") {
      const donors = await prisma.eggDonor.findMany({
        where: { providerId },
        select: { id: true, donorCompensation: true, donorType: true },
      });

      const frozenSheetData = await getFrozenEggSheetData(prisma, providerId);

      for (const donor of donors) {
        const hasFrozen = donor.donorType && /frozen/i.test(donor.donorType);
        const hasFresh = donor.donorType && /fresh/i.test(donor.donorType);
        const isFrozenOnly = hasFrozen && !hasFresh;
        const isFreshAndFrozen = hasFresh && hasFrozen;

        if (isFrozenOnly && frozenSheetData) {
          await prisma.eggDonor.update({
            where: { id: donor.id },
            data: {
              eggLotCost: frozenSheetData.eggLotCost != null ? Math.round(frozenSheetData.eggLotCost) : null,
              numberOfEggs: frozenSheetData.numberOfEggs != null ? Math.round(frozenSheetData.numberOfEggs) : null,
              totalCost: frozenSheetData.eggLotCost != null ? Math.round(frozenSheetData.eggLotCost) : null,
            },
          });
        } else {
          const { resolvedCompensation, calculatedTotalCost } = await resolveCompensationAndTotalCost(
            prisma, providerId, "egg-donor", donor.donorCompensation ?? null,
            ["APPROVED"], "fresh",
          );
          const updateData: any = {
            totalCost: calculatedTotalCost ? Math.round(calculatedTotalCost.min) : null,
          };
          // When the scraped profile carries no compensation (e.g. Eggspecting
          // doesn't publish per-donor comp), fall back to the agency cost sheet's
          // base Egg Donor Compensation so the profile field isn't blank.
          if (donor.donorCompensation == null && resolvedCompensation != null) {
            updateData.donorCompensation = Math.round(resolvedCompensation);
          }
          if (isFreshAndFrozen && frozenSheetData) {
            updateData.eggLotCost = frozenSheetData.eggLotCost != null ? Math.round(frozenSheetData.eggLotCost) : null;
            updateData.numberOfEggs = frozenSheetData.numberOfEggs != null ? Math.round(frozenSheetData.numberOfEggs) : null;
          }
          await prisma.eggDonor.update({
            where: { id: donor.id },
            data: updateData,
          });
        }
      }
    } else if (donorType === "surrogate") {
      const surrogates = await prisma.surrogate.findMany({
        where: { providerId },
        select: { id: true, baseCompensation: true },
      });
      for (const s of surrogates) {
        const comp = s.baseCompensation != null ? Number(s.baseCompensation) : null;
        const { resolvedCompensation, calculatedTotalCost } = await resolveCompensationAndTotalCost(
          prisma, providerId, "surrogate", comp,
        );
        const sUpdate: any = {};
        if (calculatedTotalCost) {
          sUpdate.totalCostMin = calculatedTotalCost.min;
          sUpdate.totalCostMax = calculatedTotalCost.max;
        }
        // Fall back to the cost sheet's base Surrogate Compensation when the
        // scraped profile has none.
        if (comp == null && resolvedCompensation != null) {
          sUpdate.baseCompensation = resolvedCompensation;
        }
        if (Object.keys(sUpdate).length > 0) {
          await prisma.surrogate.update({ where: { id: s.id }, data: sUpdate });
        }
      }
    } else if (donorType === "sperm-donor") {
      const donors = await prisma.spermDonor.findMany({
        where: { providerId },
        select: { id: true, compensation: true },
      });
      for (const donor of donors) {
        const comp = donor.compensation != null ? Number(donor.compensation) : null;
        const { resolvedCompensation, calculatedTotalCost } = await resolveCompensationAndTotalCost(
          prisma, providerId, "sperm-donor", comp,
        );
        const spUpdate: any = {};
        if (calculatedTotalCost) {
          spUpdate.totalCost = Math.round(calculatedTotalCost.min);
        }
        // Fall back to the cost sheet's base compensation when the profile has none.
        if (comp == null && resolvedCompensation != null) {
          spUpdate.compensation = Math.round(resolvedCompensation);
        }
        if (Object.keys(spUpdate).length > 0) {
          await prisma.spermDonor.update({ where: { id: donor.id }, data: spUpdate });
        }
      }
    }
  }
}

export async function recalcAndPersistSingleDonorCost(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  donorId: string,
  compensation: number | null,
  donorSubType?: string | null,
): Promise<void> {
  const sheetSubType = donorType === "egg-donor" ? (donorSubType || "fresh") : undefined;
  const { calculatedTotalCost } = await resolveCompensationAndTotalCost(
    prisma, providerId, donorType, compensation, ["APPROVED"], sheetSubType,
  );

  if (donorType === "egg-donor") {
    await prisma.eggDonor.update({
      where: { id: donorId },
      data: { totalCost: calculatedTotalCost ? Math.round(calculatedTotalCost.min) : null },
    });
  } else if (donorType === "surrogate") {
    await prisma.surrogate.update({
      where: { id: donorId },
      data: {
        totalCostMin: calculatedTotalCost.min,
        totalCostMax: calculatedTotalCost.max,
      },
    });
  } else if (donorType === "sperm-donor") {
    await prisma.spermDonor.update({
      where: { id: donorId },
      data: { totalCost: Math.round(calculatedTotalCost.min) },
    });
  }
}

export async function enrichDonorsAcrossProviders(
  prisma: PrismaService,
  donorType: string,
  donors: any[],
): Promise<any[]> {
  const grouped = new Map<string, any[]>();
  for (const d of donors) {
    const pid = d.providerId;
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid)!.push(d);
  }
  const enrichedGroups = await Promise.all(
    Array.from(grouped.entries()).map(([providerId, group]) =>
      enrichDonorsWithCosts(prisma, providerId, donorType, group, ["APPROVED"]),
    ),
  );
  return enrichedGroups.flat();
}

interface CachedSheetData {
  approvedSheet: { items: any[] } | null;
  baseCompTemplateKeys: Set<string>;
}

async function getAllSpermDonorSheetItems(
  prisma: PrismaService,
  providerId: string,
  statuses: string[],
): Promise<any[]> {
  const allSheets = await prisma.providerCostSheet.findMany({
    where: {
      providerId,
      parentClientId: null,
      status: { in: statuses },
      subTypes: { has: "sperm_donor" },
    },
    include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
  });
  return allSheets.flatMap((s) => s.items);
}

async function getProviderSheetData(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  statuses: string[],
  subType?: string | null,
): Promise<CachedSheetData> {
  // Still needed below to identify base-compensation template fields.
  const providerTypeId = await findProviderTypeIdForDonorType(prisma, providerId, donorType);

  // Match by the canonical subTypes[] leaf, not the legacy providerTypeId the
  // upload-first flow never sets (see resolveCompensationAndTotalCost).
  const leaf = canonicalSubTypeLeaf(donorType, subType);
  const baseWhere: any = {
    providerId,
    parentClientId: null,
    status: { in: statuses },
  };
  const sheetWhere: any = leaf ? { ...baseWhere, subTypes: { has: leaf } } : baseWhere;

  const candidateSheets = await prisma.providerCostSheet.findMany({
    where: sheetWhere,
    include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    orderBy: { version: "desc" },
  });
  const approvedSheet = pickMostSpecificSheet(candidateSheets, serviceLeavesForDonorType(donorType));

  const baseCompTemplateKeys = new Set<string>();
  if (providerTypeId) {
    const templates = await prisma.costTemplate.findMany({
      where: { providerTypeId, isBaseCompensation: true },
    });
    for (const t of templates) {
      baseCompTemplateKeys.add(t.fieldName);
    }
  }

  return { approvedSheet, baseCompTemplateKeys };
}

/**
 * Returns all cost sheet line items matching the donor's vial types.
 * A donor available for IUI will get ALL IUI-prefixed cost items (e.g. IUI Premium + IUI Platinum).
 * Also returns per-vial minimum costs for filtering/sorting (iciCost, iuiCost, ivfCost).
 */
function matchVialCostsFromSheet(
  sheetItems: any[],
  vialTypes: string[],
): { vialCosts: { label: string; cost: number }[]; iciCost: number | null; iuiCost: number | null; ivfCost: number | null } {
  const vialCosts: { label: string; cost: number }[] = [];
  const minCosts: Record<string, number | null> = { ICI: null, IUI: null, IVF: null };

  for (const vt of vialTypes) {
    const vtLower = vt.toLowerCase();
    const matching = sheetItems.filter(ci => ci.key?.toLowerCase().startsWith(vtLower));
    for (const ci of matching) {
      const cost = ci.minValue != null ? Number(ci.minValue) : null;
      if (cost == null) continue;
      vialCosts.push({ label: ci.key, cost });
      // Track minimum cost per vial type for sorting
      if (minCosts[vt] == null || cost < minCosts[vt]!) minCosts[vt] = cost;
    }
  }

  return {
    vialCosts,
    iciCost: minCosts["ICI"],
    iuiCost: minCosts["IUI"],
    ivfCost: minCosts["IVF"],
  };
}

function computeCostFromSheet(
  sheetData: CachedSheetData,
  profileCompensation: number | null | undefined,
): { resolvedCompensation: number | null; calculatedTotalCost: { min: number; max: number } | null } {
  const { approvedSheet, baseCompTemplateKeys } = sheetData;

  if (!approvedSheet || approvedSheet.items.length === 0) {
    return { resolvedCompensation: profileCompensation ?? null, calculatedTotalCost: null };
  }

  // An item is the base compensation line when it matches a base-comp template
  // field name, OR - since AI-extracted keys routinely differ from the template
  // names (e.g. "Donor Compensation" vs the "Egg Donor Compensation" template) -
  // when it sits in the canonical compensation category and reads as a base
  // compensation line rather than a surcharge / bonus / add-on.
  const baseCompCategories = new Set(["donor_compensation", "surrogate_compensation"]);
  const isBaseCompItem = (item: { key: string; category?: string }) => {
    if (baseCompTemplateKeys.has(item.key)) return true;
    const cat = (item.category || "").toLowerCase();
    const key = (item.key || "").toLowerCase();
    return (
      baseCompCategories.has(cat) &&
      key.includes("compensation") &&
      !/surcharge|additional|bonus|vip|premium|extra/.test(key)
    );
  };
  const baseCompItem = approvedSheet.items.find(item => isBaseCompItem(item) && item.isIncluded);

  const hasProfileComp = profileCompensation != null;
  let resolvedCompensation: number | null = profileCompensation ?? null;
  if (!hasProfileComp && baseCompItem) {
    resolvedCompensation = baseCompItem.minValue ?? null;
  }

  let minTotal = 0;
  let maxTotal = 0;
  for (const item of approvedSheet.items) {
    if (!item.isIncluded) continue;
    if (isBaseCompItem(item) && hasProfileComp && profileCompensation != null) {
      minTotal += profileCompensation;
      maxTotal += profileCompensation;
    } else {
      const min = item.minValue ?? 0;
      const max = item.maxValue ?? min;
      minTotal += min;
      maxTotal += max === 0 && min > 0 ? min : max;
    }
  }

  return {
    resolvedCompensation,
    calculatedTotalCost: { min: minTotal, max: maxTotal },
  };
}

async function enrichDonorsWithCosts(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  donors: any[],
  statuses: string[],
): Promise<any[]> {
  if (donorType === "egg-donor") {
    const [frozenData, freshSheetData] = await Promise.all([
      getFrozenEggSheetData(prisma, providerId, statuses),
      getProviderSheetData(prisma, providerId, donorType, statuses, "fresh"),
    ]);
    return donors.map((donor) => {
      const hasFrozen = donor.donorType && /frozen/i.test(donor.donorType);
      const hasFresh = donor.donorType && /fresh/i.test(donor.donorType);
      const isFrozenOnly = hasFrozen && !hasFresh;
      const isFreshAndFrozen = hasFresh && hasFrozen;
      if (isFrozenOnly && frozenData) {
        return {
          ...donor,
          eggLotCost: frozenData.eggLotCost != null ? Math.round(frozenData.eggLotCost) : donor.eggLotCost,
          numberOfEggs: frozenData.numberOfEggs != null ? Math.round(frozenData.numberOfEggs) : donor.numberOfEggs,
          totalCost: frozenData.eggLotCost != null ? Math.round(frozenData.eggLotCost) : donor.totalCost,
        };
      }
      const { resolvedCompensation, calculatedTotalCost } = computeCostFromSheet(
        freshSheetData, donor.donorCompensation ?? null,
      );
      const enriched: any = {
        ...donor,
        ...(resolvedCompensation != null ? { resolvedCompensation } : {}),
        donorCompensation: resolvedCompensation ?? donor.donorCompensation,
        totalCost: calculatedTotalCost ? Math.round(calculatedTotalCost.min) : donor.totalCost,
        ...(calculatedTotalCost ? { calculatedTotalCost } : {}),
      };
      if (isFreshAndFrozen && frozenData) {
        enriched.eggLotCost = frozenData.eggLotCost != null ? Math.round(frozenData.eggLotCost) : donor.eggLotCost;
        enriched.numberOfEggs = frozenData.numberOfEggs != null ? Math.round(frozenData.numberOfEggs) : donor.numberOfEggs;
      }
      return enriched;
    });
  }
  if (donorType === "surrogate") {
    const sheetData = await getProviderSheetData(prisma, providerId, donorType, statuses);
    return donors.map((donor) => {
      const { resolvedCompensation, calculatedTotalCost } = computeCostFromSheet(
        sheetData, donor.baseCompensation != null ? Number(donor.baseCompensation) : null,
      );
      return {
        ...donor,
        ...(resolvedCompensation != null ? { resolvedCompensation } : {}),
        ...(calculatedTotalCost ? { totalCostMin: calculatedTotalCost.min, totalCostMax: calculatedTotalCost.max, calculatedTotalCost } : {}),
      };
    });
  }
  if (donorType === "sperm-donor") {
    const sheetItems = await getAllSpermDonorSheetItems(prisma, providerId, statuses);
    return donors.map((donor) => {
      const vialTypes: string[] = Array.isArray(donor.vialTypes) ? donor.vialTypes : [];
      const { vialCosts, iciCost, iuiCost, ivfCost } = matchVialCostsFromSheet(sheetItems, vialTypes);
      return {
        ...donor,
        ...(vialCosts.length > 0 ? { vialCosts, iciCost, iuiCost, ivfCost } : {}),
      };
    });
  }
  return donors;
}

export async function enrichDonorsWithPendingCosts(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  donors: any[],
): Promise<any[]> {
  const statuses = ["PENDING", "APPROVED"];

  if (donorType === "egg-donor") {
    const [frozenData, freshSheetData] = await Promise.all([
      getFrozenEggSheetData(prisma, providerId, statuses),
      getProviderSheetData(prisma, providerId, donorType, statuses, "fresh"),
    ]);

    return donors.map((donor) => {
      const hasFrozen = donor.donorType && /frozen/i.test(donor.donorType);
      const hasFresh = donor.donorType && /fresh/i.test(donor.donorType);
      const isFrozenOnly = hasFrozen && !hasFresh;
      const isFreshAndFrozen = hasFresh && hasFrozen;

      if (isFrozenOnly && frozenData) {
        return {
          ...donor,
          eggLotCost: frozenData.eggLotCost != null ? Math.round(frozenData.eggLotCost) : donor.eggLotCost,
          numberOfEggs: frozenData.numberOfEggs != null ? Math.round(frozenData.numberOfEggs) : donor.numberOfEggs,
          totalCost: frozenData.eggLotCost != null ? Math.round(frozenData.eggLotCost) : donor.totalCost,
        };
      }

      const { resolvedCompensation, calculatedTotalCost } = computeCostFromSheet(
        freshSheetData, donor.donorCompensation ?? null,
      );
      const enriched: any = {
        ...donor,
        ...(resolvedCompensation != null ? { resolvedCompensation } : {}),
        donorCompensation: resolvedCompensation ?? donor.donorCompensation,
        totalCost: calculatedTotalCost ? Math.round(calculatedTotalCost.min) : donor.totalCost,
        ...(calculatedTotalCost ? { calculatedTotalCost } : {}),
      };

      if (isFreshAndFrozen && frozenData) {
        enriched.eggLotCost = frozenData.eggLotCost != null ? Math.round(frozenData.eggLotCost) : donor.eggLotCost;
        enriched.numberOfEggs = frozenData.numberOfEggs != null ? Math.round(frozenData.numberOfEggs) : donor.numberOfEggs;
      }

      return enriched;
    });
  }

  if (donorType === "surrogate") {
    const sheetData = await getProviderSheetData(prisma, providerId, donorType, statuses);
    return donors.map((donor) => {
      const { resolvedCompensation, calculatedTotalCost } = computeCostFromSheet(
        sheetData, donor.baseCompensation != null ? Number(donor.baseCompensation) : null,
      );
      return {
        ...donor,
        ...(resolvedCompensation != null ? { resolvedCompensation } : {}),
        ...(calculatedTotalCost ? { totalCostMin: calculatedTotalCost.min, totalCostMax: calculatedTotalCost.max, calculatedTotalCost } : {}),
      };
    });
  }

  if (donorType === "sperm-donor") {
    const sheetItems = await getAllSpermDonorSheetItems(prisma, providerId, statuses);
    return donors.map((donor) => {
      const vialTypes: string[] = Array.isArray(donor.vialTypes) ? donor.vialTypes : [];
      const { vialCosts, iciCost, iuiCost, ivfCost } = matchVialCostsFromSheet(sheetItems, vialTypes);
      return {
        ...donor,
        ...(vialCosts.length > 0 ? { vialCosts, iciCost, iuiCost, ivfCost } : {}),
      };
    });
  }

  return donors;
}
