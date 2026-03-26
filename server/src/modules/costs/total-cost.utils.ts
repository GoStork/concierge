import { PrismaService } from "../prisma/prisma.service";

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

export async function resolveCompensationAndTotalCost(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  profileCompensation: number | null | undefined,
  sheetStatuses: string[] = ["APPROVED"],
  subType?: string | null,
): Promise<{ resolvedCompensation: number | null; calculatedTotalCost: { min: number; max: number } | null }> {
  const providerTypeId = await findProviderTypeIdForDonorType(prisma, providerId, donorType);

  const baseWhere: any = {
    providerId,
    parentClientId: null,
    status: { in: sheetStatuses },
    ...(providerTypeId ? { providerTypeId } : {}),
  };
  let sheetWhere: any;
  if (subType === "fresh") {
    sheetWhere = {
      AND: [baseWhere],
      OR: [{ subType: "fresh" }, { subType: null }],
    };
  } else if (subType !== undefined) {
    sheetWhere = { ...baseWhere, subType };
  } else {
    sheetWhere = baseWhere;
  }

  const approvedSheet = await prisma.providerCostSheet.findFirst({
    where: sheetWhere,
    include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    orderBy: { version: "desc" },
  });

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

  const isBaseCompItem = (item: { key: string }) => baseCompTemplateKeys.has(item.key);

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

async function getFrozenEggSheetData(
  prisma: PrismaService,
  providerId: string,
  sheetStatuses: string[] = ["APPROVED"],
): Promise<{ eggLotCost: number | null; numberOfEggs: number | null } | null> {
  const eggDonorType = await prisma.providerType.findFirst({
    where: { name: { contains: "Egg Donor Agency", mode: "insensitive" } },
  });
  if (!eggDonorType) return null;

  const frozenSheet = await prisma.providerCostSheet.findFirst({
    where: {
      providerId,
      status: { in: sheetStatuses },
      parentClientId: null,
      subType: "frozen",
      providerTypeId: eggDonorType.id,
    },
    include: { items: true },
    orderBy: { version: "desc" },
  });
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
          const { calculatedTotalCost } = await resolveCompensationAndTotalCost(
            prisma, providerId, "egg-donor", donor.donorCompensation ?? null,
            ["APPROVED"], "fresh",
          );
          const updateData: any = {
            totalCost: calculatedTotalCost ? Math.round(calculatedTotalCost.min) : null,
          };
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
        const { calculatedTotalCost } = await resolveCompensationAndTotalCost(
          prisma, providerId, "surrogate", comp,
        );
        if (calculatedTotalCost) {
          await prisma.surrogate.update({
            where: { id: s.id },
            data: {
              totalCostMin: calculatedTotalCost.min,
              totalCostMax: calculatedTotalCost.max,
            },
          });
        }
      }
    } else if (donorType === "sperm-donor") {
      const donors = await prisma.spermDonor.findMany({
        where: { providerId },
        select: { id: true, compensation: true },
      });
      for (const donor of donors) {
        const comp = donor.compensation != null ? Number(donor.compensation) : null;
        const { calculatedTotalCost } = await resolveCompensationAndTotalCost(
          prisma, providerId, "sperm-donor", comp,
        );
        if (calculatedTotalCost) {
          await prisma.spermDonor.update({
            where: { id: donor.id },
            data: { totalCost: Math.round(calculatedTotalCost.min) },
          });
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

async function getProviderSheetData(
  prisma: PrismaService,
  providerId: string,
  donorType: string,
  statuses: string[],
  subType?: string | null,
): Promise<CachedSheetData> {
  const providerTypeId = await findProviderTypeIdForDonorType(prisma, providerId, donorType);

  const baseWhere: any = {
    providerId,
    parentClientId: null,
    status: { in: statuses },
    ...(providerTypeId ? { providerTypeId } : {}),
  };
  let sheetWhere: any;
  if (subType === "fresh") {
    sheetWhere = {
      AND: [baseWhere],
      OR: [{ subType: "fresh" }, { subType: null }],
    };
  } else if (subType !== undefined) {
    sheetWhere = { ...baseWhere, subType };
  } else {
    sheetWhere = baseWhere;
  }

  const approvedSheet = await prisma.providerCostSheet.findFirst({
    where: sheetWhere,
    include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    orderBy: { version: "desc" },
  });

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

function computeCostFromSheet(
  sheetData: CachedSheetData,
  profileCompensation: number | null | undefined,
): { resolvedCompensation: number | null; calculatedTotalCost: { min: number; max: number } | null } {
  const { approvedSheet, baseCompTemplateKeys } = sheetData;

  if (!approvedSheet || approvedSheet.items.length === 0) {
    return { resolvedCompensation: profileCompensation ?? null, calculatedTotalCost: null };
  }

  const isBaseCompItem = (item: { key: string }) => baseCompTemplateKeys.has(item.key);
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
    const sheetData = await getProviderSheetData(prisma, providerId, donorType, statuses);
    return donors.map((donor) => {
      const { resolvedCompensation, calculatedTotalCost } = computeCostFromSheet(
        sheetData, donor.compensation != null ? Number(donor.compensation) : null,
      );
      return {
        ...donor,
        ...(resolvedCompensation != null ? { resolvedCompensation } : {}),
        ...(calculatedTotalCost ? { totalCost: Math.round(calculatedTotalCost.min), calculatedTotalCost } : {}),
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

  return donors;
}
