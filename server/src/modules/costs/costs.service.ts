import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import * as crypto from "crypto";
import { recalcAndPersistTotalCostsForProvider } from "./total-cost.utils";
import {
  ALL_SUBTYPES,
  isValidSubType,
  isValidTab,
  resolveTemplate,
  SubType,
  SUBTYPE_LABEL,
  Tab,
  TAB_LABEL,
  TAB_OF,
} from "./cost-templates-config";
import {
  matchSubtypes,
  MatcherInput,
} from "./cost-sheet-subtype-matcher";

@Injectable()
export class CostsService {
  private readonly logger = new Logger(CostsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  private async resolveTemplateFieldIds(
    providerTypeId: string | undefined | null,
    subType: string | undefined | null,
    items: Array<{ category: string; key: string; templateFieldId?: string | null; [k: string]: any }>,
  ) {
    if (!providerTypeId) {
      return items.map((item) => ({ ...item, templateFieldId: item.templateFieldId ?? null }));
    }
    const where: any = { providerTypeId };
    if (subType === "fresh" || !subType) {
      where.OR = [{ subType: null }, { subType: "fresh" }];
    } else {
      where.subType = subType;
    }
    const templates = await this.prisma.costTemplate.findMany({ where });
    const byId = new Map(templates.map((t) => [t.id, t]));
    const byCatKey = new Map(templates.map((t) => [`${t.category}::${t.fieldName}`, t]));

    return items.map((item) => {
      if (item.templateFieldId && byId.has(item.templateFieldId)) {
        const tpl = byId.get(item.templateFieldId)!;
        return { ...item, templateFieldId: tpl.id, category: tpl.category, key: tpl.fieldName };
      }
      const match = byCatKey.get(`${item.category}::${item.key}`);
      return { ...item, templateFieldId: match?.id ?? null };
    });
  }

  async getTemplatesByProviderType(providerTypeName: string, subType?: string) {
    const providerType = await this.prisma.providerType.findFirst({
      where: { name: { contains: providerTypeName, mode: "insensitive" } },
    });
    if (!providerType) return [];

    const where: any = { providerTypeId: providerType.id };
    // "fresh", "ivf_cycle", or no subType: return base items (subType null) + subType-specific additions
    if (!subType || subType === "fresh" || subType === "ivf_cycle") {
      where.OR = [{ subType: null }, { subType: subType === "ivf_cycle" ? "ivf_cycle" : "fresh" }];
    } else {
      where.subType = subType;
    }

    const templates = await this.prisma.costTemplate.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }],
    });

    const grouped: Record<string, typeof templates> = {};
    for (const t of templates) {
      if (!grouped[t.category]) grouped[t.category] = [];
      grouped[t.category].push(t);
    }
    return { providerTypeId: providerType.id, templates: grouped };
  }

  async uploadFile(
    providerId: string,
    buffer: Buffer,
    filename: string,
    contentType: string,
    providerTypeId?: string,
    subType?: string,
    programId?: string,
  ) {
    const uniqueId = crypto.randomUUID();
    const gcsPath = `cost-sheets/${providerId}/${uniqueId}-${filename}`;

    await this.storage.uploadBuffer(buffer, gcsPath, contentType);

    // Upload-first flow: when no programId is provided, auto-create a
    // placeholder program with default name + country. The AI classifier
    // fills these in once it runs (see saveAiClassification). This keeps
    // the UX a single "drop a file" action - no separate "create program
    // with name + country" step beforehand.
    let resolvedProgramId = programId || null;
    if (!resolvedProgramId) {
      const newProgram = await this.prisma.costProgram.create({
        data: {
          providerId,
          providerTypeId: providerTypeId || null,
          name: "Untitled",
          country: "United States",
          subType: null,
          tab: null,
        },
      });
      resolvedProgramId = newProgram.id;
    }

    const sheet = await this.prisma.providerCostSheet.create({
      data: {
        providerId,
        providerTypeId: providerTypeId || null,
        subType: subType || null,
        programId: resolvedProgramId,
        filePath: gcsPath,
        originalFileName: filename,
        status: "PARSING",
      },
    });

    return { sheet, buffer, contentType: contentType, programId: resolvedProgramId };
  }

  async saveParseResults(
    sheetId: string,
    parsedItems: Array<{
      category: string;
      key: string;
      minValue: number | null;
      maxValue: number | null;
      isCustom: boolean;
      isIncluded: boolean;
      isTier?: boolean;
      comment: string | null;
    }>,
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) return;

    const templateWhere: any = sheet.providerTypeId ? { providerTypeId: sheet.providerTypeId } : null;
    if (templateWhere && sheet.subType) {
      templateWhere.OR = [{ subType: null }, { subType: sheet.subType }];
    }
    const templates = templateWhere
      ? await this.prisma.costTemplate.findMany({
          where: templateWhere,
          orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
        })
      : [];

    const templateItems = templates.map((t, idx) => ({
      templateFieldId: t.id,
      category: t.category,
      key: t.fieldName,
      minValue: null as number | null,
      maxValue: null as number | null,
      isCustom: false,
      comment: null as string | null,
      isIncluded: true,
      sortOrder: idx,
    }));

    const merged = templateItems.map((tpl) => {
      const match = parsedItems.find(
        (p) => p.category === tpl.category && p.key === tpl.key,
      );
      return match
        ? { ...tpl, minValue: match.minValue, maxValue: match.maxValue, comment: match.comment, isIncluded: match.isIncluded, isTier: match.isTier === true }
        : { ...tpl, isTier: false };
    });
    const customItems = parsedItems.filter(
      (p) => p.isCustom || !templateItems.some((t) => t.category === p.category && t.key === p.key),
    ).map((p) => ({ ...p, isTier: p.isTier === true }));
    const finalItems = [...merged, ...customItems].map((item, i) => ({ ...item, sortOrder: i }));

    await this.updateSheetItems(sheetId, finalItems);

    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: { status: "DRAFT" },
    });

    this.logger.log(`Auto-parse complete for sheet ${sheetId}: ${parsedItems.length} items extracted`);
  }

  async markParseError(sheetId: string) {
    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: { status: "DRAFT" },
    });
  }

  /**
   * Persist the AI's proposed classification on a freshly-parsed sheet. We
   * do NOT overwrite values the clinic has already confirmed - this only
   * sets the proposal when the source is null or still 'ai_proposed'.
   */
  async saveAiClassification(
    sheetId: string,
    proposal: { tab: Tab; subType: SubType; isFixedCost: boolean; confidence: number; reasoning: string; programName?: string; country?: string; serviceTypes?: string[] },
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) return;
    if (sheet.isFixedCostSource === "clinic_confirmed") {
      this.logger.log(`Skipping AI classification for sheet ${sheetId} - clinic already confirmed`);
      return;
    }
    // Empty tab/subType mean the provider type doesn't use the IVF
    // taxonomy (surrogacy / sperm bank). Persist as null in those cases.
    const persistedTab = proposal.tab && (proposal.tab as string).length > 0 ? proposal.tab : null;
    const persistedSubType = proposal.subType && (proposal.subType as string).length > 0 ? proposal.subType : null;
    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: {
        tab: persistedTab,
        subType: persistedSubType,
        isFixedCost: proposal.isFixedCost,
        isFixedCostSource: "ai_proposed",
      },
    });
    // Mirror onto the parent program so the tab/subtype hierarchy stays
    // consistent in the provider editor list view. Also fill in name and
    // country when they're still placeholders ("Untitled" / "United States"
    // default) so the clinic doesn't have to type them.
    if (sheet.programId) {
      const program = await this.prisma.costProgram.findUnique({
        where: { id: sheet.programId },
        select: { name: true, country: true, serviceTypes: true },
      });
      const data: any = { tab: persistedTab, subType: persistedSubType };
      const isPlaceholderName = !program?.name || program.name === "Untitled" || program.name === "Untitled Program" || /^untitled/i.test(program.name);
      if (proposal.programName && isPlaceholderName) {
        data.name = proposal.programName;
      }
      // Only override country when the program is still on the default "United States"
      // AND the AI confidently picked something else. This avoids stomping a clinic's
      // explicit pick with an AI guess.
      const isDefaultCountry = !program?.country || program.country === "United States";
      if (proposal.country && isDefaultCountry && proposal.country !== "United States") {
        data.country = proposal.country;
      }
      // Only seed serviceTypes when the program doesn't yet have any tags
      // (fresh upload-first creation). Don't stomp an existing array - the
      // provider may have edited tags by hand.
      if (proposal.serviceTypes && proposal.serviceTypes.length > 0 && (!program?.serviceTypes || program.serviceTypes.length === 0)) {
        data.serviceTypes = proposal.serviceTypes;
      }
      await this.prisma.costProgram.update({
        where: { id: sheet.programId },
        data,
      });
    }
  }

  /**
   * Clinic confirms or overrides the classification. Source flips to
   * 'clinic_confirmed' so future AI parses on the same sheet leave it alone.
   * Also clears legacyNeedsReview because the clinic has now actively chosen.
   */
  async saveClinicClassification(
    sheetId: string,
    payload: { tab?: Tab; subType?: SubType; isFixedCost?: boolean; confirm?: boolean },
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) throw new Error("Sheet not found");

    if (payload.tab !== undefined && !isValidTab(payload.tab)) {
      throw new Error(`Invalid tab: ${payload.tab}`);
    }
    if (payload.subType !== undefined && !isValidSubType(payload.subType)) {
      throw new Error(`Invalid subType: ${payload.subType}`);
    }
    if (payload.tab && payload.subType && TAB_OF[payload.subType] !== payload.tab) {
      throw new Error(`Subtype ${payload.subType} does not belong to tab ${payload.tab}`);
    }
    // If only one is provided, derive the other.
    const subType = payload.subType ?? (sheet.subType as SubType | null);
    const tab = payload.tab ?? (subType ? TAB_OF[subType as SubType] : (sheet.tab as Tab | null));

    const data: any = { tab, subType };
    if (payload.isFixedCost !== undefined) {
      data.isFixedCost = payload.isFixedCost;
    }
    // Only flip source to clinic_confirmed (and clear legacyNeedsReview)
    // when the clinic explicitly confirmed. Toggling the Fixed pill alone
    // updates the value but keeps the AI-proposed status so Submit stays
    // blocked until the clinic clicks the prominent Confirm button.
    if (payload.confirm === true) {
      data.isFixedCostSource = "clinic_confirmed";
      data.legacyNeedsReview = false;
    }
    const updated = await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data,
    });
    if (sheet.programId && tab && subType) {
      await this.prisma.costProgram.update({
        where: { id: sheet.programId },
        data: { tab, subType },
      });
    }
    return updated;
  }

  /**
   * Return the resolved field list for a given (tab, subType), with
   * mandatory flags already collapsed against the current isFixedCost.
   */
  async getResolvedTemplate(tab: string, subType: string, isFixedCost: boolean) {
    if (!isValidTab(tab)) throw new Error(`Invalid tab: ${tab}`);
    if (!isValidSubType(subType)) throw new Error(`Invalid subType: ${subType}`);
    if (TAB_OF[subType] !== tab) throw new Error(`Subtype ${subType} does not belong to tab ${tab}`);
    return resolveTemplate(subType, isFixedCost);
  }

  /**
   * Look up the eligible subtypes for a parent. Reads gender from the
   * primary User (the account's first member by createdAt) and journey
   * flags from IntendedParentProfile.
   */
  async getMatchingSubtypesForParent(parentAccountId: string) {
    const account = await this.prisma.parentAccount.findUnique({
      where: { id: parentAccountId },
      include: {
        intendedParentProfile: true,
        members: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!account) return { subtypes: [], isPartialProfile: true };

    const primaryUser = account.members[0];
    const ip = account.intendedParentProfile;

    const input: MatcherInput = {
      userGender: primaryUser?.gender ?? null,
      partnerGender: primaryUser?.partnerGender ?? null,
      hasEmbryos: ip?.hasEmbryos ?? null,
      eggSource: ip?.eggSource ?? null,
      spermSource: ip?.spermSource ?? null,
      carrier: ip?.carrier ?? null,
      interestedServices: ip?.interestedServices ?? null,
    };
    return matchSubtypes(input);
  }

  /**
   * Parent-facing program list for a clinic. Returns one row per APPROVED
   * program that matches the parent's eligible subtypes. Items are flattened
   * into a lineItems array suitable for the card view.
   */
  async getProviderParentPrograms(providerId: string, parentAccountId: string) {
    const { subtypes, isPartialProfile } =
      await this.getMatchingSubtypesForParent(parentAccountId);

    // Detect provider type so non-IVF agencies use simple eligibility
    // checks instead of the 14-subtype taxonomy.
    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      include: {
        services: { include: { providerType: true } },
      },
    });
    // Only APPROVED services count - parents shouldn't see programs for a
    // service the provider no longer offers (or never had approved). Without
    // this filter, orphan cost programs from a service that was later removed
    // continue to render on the parent page indefinitely.
    const activeServices = (provider?.services ?? []).filter((s: any) => s.status === "APPROVED");
    const activeProviderTypeIds = new Set(activeServices.map((s: any) => s.providerTypeId));
    const providerTypeNames = activeServices
      .map((s: any) => s.providerType?.name?.toLowerCase() ?? "")
      .filter(Boolean);
    const isIvfProvider = providerTypeNames.some((n: string) => n.includes("ivf") || n.includes("clinic"));
    const isSurrogacyProvider = providerTypeNames.some((n: string) => n.includes("surrogacy"));
    const isEggProvider = providerTypeNames.some((n: string) => n.includes("egg donor") || n.includes("egg bank"));
    const isSpermProvider = providerTypeNames.some((n: string) => n.includes("sperm bank") || n.includes("sperm donor"));

    // Pull the parent's IP profile + primary user to derive simple
    // eligibility for non-IVF agencies.
    const account = parentAccountId
      ? await this.prisma.parentAccount.findUnique({
          where: { id: parentAccountId },
          include: {
            intendedParentProfile: true,
            members: { orderBy: { createdAt: "asc" } },
          },
        })
      : null;
    const ip = account?.intendedParentProfile;
    const primary = account?.members?.[0];

    // Build the parent's needs set as an array of serviceType tags. Eva
    // stores values like "Egg donor" / "Sperm donor" / "Gestational surrogate"
    // / "Self" - normalize before comparing.
    const eggLower = (ip?.eggSource ?? "").toLowerCase();
    const spermLower = (ip?.spermSource ?? "").toLowerCase();
    const carrierLower = (ip?.carrier ?? "").toLowerCase();
    const eggIsDonor = eggLower.includes("donor");
    const spermIsDonor = spermLower.includes("donor");
    const carrierIsSurrogate = carrierLower.includes("surrogate") || carrierLower.includes("gestational");
    const lacksSperm = primary?.gender === "I'm a woman"
      && (primary?.partnerGender == null || primary?.partnerGender === "woman");

    const parentNeeds = new Set<string>();
    // IVF: every parent who needs to create / transfer embryos at a clinic.
    // Conservative: surface IVF programs whenever the IP profile shows ANY
    // clinic-side activity (embryos, eggSource, carrier all imply IVF).
    if (subtypes.length > 0) parentNeeds.add("ivf_clinic");
    if (ip?.needsSurrogate === true || carrierIsSurrogate) parentNeeds.add("surrogacy");
    if (ip?.needsEggDonor === true || eggIsDonor) parentNeeds.add("egg_donor");
    if (spermIsDonor || lacksSperm) parentNeeds.add("sperm_donor");

    // Profile is "partial" when we don't know ANY of the relevant tags.
    // The client gates the grid behind "Complete your profile" CTA.
    const knowsSurrogacy = ip?.needsSurrogate != null || ip?.carrier != null;
    const knowsEggDonor = ip?.needsEggDonor != null || ip?.eggSource != null;
    const knowsSpermDonor = ip?.spermSource != null || primary?.gender != null;
    const resolvedIsPartialProfile = isPartialProfile ||
      (!knowsSurrogacy && !knowsEggDonor && !knowsSpermDonor && subtypes.length === 0);

    if (resolvedIsPartialProfile) {
      return { programs: [], matchingSubtypes: subtypes, isPartialProfile: true };
    }

    if (parentNeeds.size === 0) {
      return { programs: [], matchingSubtypes: subtypes, isPartialProfile: false };
    }

    const parentNeedsArr = Array.from(parentNeeds);

    // Match programs by serviceTypes intersection with parent needs. Each
    // program holds 1+ tags (e.g. ["surrogacy"] or ["surrogacy", "egg_donor"]
    // for a combined package). Postgres `hasSome` returns true when ANY tag
    // overlaps. IVF-tagged programs additionally filter by the biology-driven
    // subtype list so we don't show "own eggs" programs to donor-eggs parents.
    const programs = await this.prisma.costProgram.findMany({
      where: {
        providerId,
        providerTypeId: { in: Array.from(activeProviderTypeIds) as string[] },
        serviceTypes: { hasSome: parentNeedsArr },
        costSheets: { some: { status: "APPROVED" } },
        // Non-IVF programs (no subType) always pass. IVF programs only pass
        // when their subType is in the parent's matching subtype list.
        OR: [
          { subType: null },
          ...(subtypes.length > 0 ? [{ subType: { in: subtypes } }] : []),
        ],
      },
      include: {
        costSheets: {
          where: { status: "APPROVED", parentClientId: null },
          orderBy: { updatedAt: "desc" },
          take: 1,
          include: {
            items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const COUNTED_ONLY_KEYS = new Set([
      "Number of Egg Retrievals Included",
      "Number of Sperm Collections Included",
      "Number of Transfers Included",
    ]);

    // For each matching program, emit one card per pricing tier when tiers
    // exist (so 1 cycle / 2 cycles / 3 cycles / unlimited become 4 separate
    // parent-facing cards under the same program). When no tiers exist,
    // emit a single card as before.
    const result = programs
      .filter((p) => p.costSheets.length > 0)
      .flatMap((p) => {
        const sheet = p.costSheets[0];
        const tierItems = sheet.items.filter((i: any) => i.isTier === true);
        const baselineItems = sheet.items.filter((i: any) => i.isTier !== true);

        // Sum the non-tier (baseline) items - common to every tier card.
        let baseMin = 0;
        let baseMax = 0;
        for (const item of baselineItems) {
          if (!item.isIncluded) continue;
          const baseKey = item.key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
          if (COUNTED_ONLY_KEYS.has(baseKey)) continue;
          const min = item.minValue ?? 0;
          const max = item.maxValue ?? min;
          baseMin += min;
          baseMax += max === 0 && min > 0 ? min : max;
        }

        const programMeta = {
          programId: p.id,
          country: p.country,
          tab: p.tab,
          subType: p.subType,
          subTypeLabel: p.subType && isValidSubType(p.subType) ? SUBTYPE_LABEL[p.subType as SubType] : null,
          tabLabel: p.tab && isValidTab(p.tab) ? TAB_LABEL[p.tab as Tab] : null,
          isFixedCost: sheet.isFixedCost,
          updatedAt: sheet.updatedAt,
        };

        const mapLineItem = (i: any) => ({
          category: i.category,
          key: i.key,
          minValue: i.minValue,
          maxValue: i.maxValue,
          isIncluded: i.isIncluded,
          comment: i.comment,
        });

        if (tierItems.length === 0) {
          return [{
            ...programMeta,
            programName: p.name,
            tierLabel: null as string | null,
            minTotal: baseMin,
            maxTotal: baseMax,
            lineItems: sheet.items.map(mapLineItem),
          }];
        }

        return tierItems.map((tier: any) => {
          const tierMin = tier.minValue ?? 0;
          const tierMax = tier.maxValue ?? tierMin;
          // The card's line item list shows the chosen tier as a row plus
          // every non-tier item. Other tiers are not included on this card -
          // they're rendered as their own card.
          const cardLineItems = [mapLineItem(tier), ...baselineItems.map(mapLineItem)];
          return {
            ...programMeta,
            programName: `${p.name} · ${tier.key}`,
            tierLabel: tier.key,
            minTotal: baseMin + tierMin,
            maxTotal: baseMax + (tierMax === 0 && tierMin > 0 ? tierMin : tierMax),
            lineItems: cardLineItems,
          };
        });
      });

    return { programs: result, matchingSubtypes: subtypes, isPartialProfile: resolvedIsPartialProfile };
  }

  async resetOrphanedParsingSheets() {
    const result = await this.prisma.providerCostSheet.updateMany({
      where: { status: "PARSING" },
      data: { status: "DRAFT" },
    });
    if (result.count > 0) {
      this.logger.warn(`Reset ${result.count} orphaned PARSING sheet(s) to DRAFT on startup`);
    }
  }

  async cancelUpload(sheetId: string) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
    });
    if (!sheet) throw new Error("Sheet not found");

    if (sheet.filePath) {
      try { await this.storage.deleteObject(sheet.filePath); } catch {}
    }

    await this.prisma.costItem.deleteMany({ where: { providerCostSheetId: sheetId } });
    await this.prisma.providerCostSheet.delete({ where: { id: sheetId } });

    return { cancelled: true };
  }

  async deleteFile(sheetId: string) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
    });
    if (!sheet) throw new Error("Sheet not found");

    if (sheet.filePath) {
      await this.storage.deleteObject(sheet.filePath);
    }

    return this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: { fileUrl: null, filePath: null, originalFileName: null },
    });
  }

  private applySubTypeFilter(where: any, subType?: string) {
    if (subType === "fresh") {
      where.OR = [{ subType: null }, { subType: "fresh" }];
    } else if (subType) {
      where.subType = subType;
    } else {
      where.subType = null;
    }
  }

  async resetProviderCosts(providerId: string, providerTypeId?: string, subType?: string, programId?: string) {
    const where: any = { providerId, parentClientId: null };
    // Scope the reset to a single program when programId is provided. This
    // is the upload-first flow's "trash this program's sheet" path - it
    // bypasses providerTypeId/subType filtering which would otherwise miss
    // every row (every sheet has a subType after migration; legacy filter
    // forced subType=null and matched nothing).
    if (programId) {
      where.programId = programId;
    } else {
      if (providerTypeId) where.providerTypeId = providerTypeId;
      this.applySubTypeFilter(where, subType);
    }

    const sheets = await this.prisma.providerCostSheet.findMany({ where });

    for (const sheet of sheets) {
      if (sheet.filePath) {
        try { await this.storage.deleteObject(sheet.filePath); } catch {}
      }
      await this.prisma.costItem.deleteMany({ where: { providerCostSheetId: sheet.id } });
    }

    await this.prisma.providerCostSheet.deleteMany({ where });

    // When scoped to a single program, also reset the program row back to
    // its placeholder state - name + country + tab + subType. Without this,
    // the program keeps the AI-classified label from the deleted upload and
    // the next upload looks confused (old name on a freshly-parsed sheet).
    if (programId) {
      await this.prisma.costProgram.update({
        where: { id: programId },
        data: {
          name: "Untitled",
          country: "United States",
          tab: null,
          subType: null,
        },
      });
    }

    return { reset: true, sheetsDeleted: sheets.length };
  }

  async getDownloadUrl(sheetId: string) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
    });
    if (!sheet?.filePath) throw new Error("No file attached to sheet");

    const url = await this.storage.getSignedUrl(sheet.filePath, 60);
    return { url };
  }

  async getProviderSheets(providerId: string, status?: string, providerTypeId?: string, subType?: string, programId?: string) {
    const where: any = { providerId };
    if (status) where.status = status;
    if (programId) {
      where.programId = programId;
    } else {
      if (providerTypeId) where.providerTypeId = providerTypeId;
      this.applySubTypeFilter(where, subType);
    }

    return this.prisma.providerCostSheet.findMany({
      where,
      include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
      orderBy: { createdAt: "desc" },
    });
  }

  async getApprovedMasterSheet(providerId: string, providerTypeId?: string, subType?: string, programId?: string) {
    const where: any = {
      providerId,
      parentClientId: null,
      status: "APPROVED",
    };
    if (programId) {
      where.programId = programId;
    } else {
      if (providerTypeId) where.providerTypeId = providerTypeId;
      this.applySubTypeFilter(where, subType);
    }

    return this.prisma.providerCostSheet.findFirst({
      where,
      include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
      orderBy: { version: "desc" },
    });
  }

  async getSheet(sheetId: string) {
    return this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
      include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    });
  }

  // Patch the optional category / description / lineItemTemplate on a
  // sheet. matchingRules is gone - classification is now derived from
  // subType + parent profile state via the subtype matcher.
  async updateSheetMetadata(
    sheetId: string,
    patch: {
      category?: string | null;
      description?: string | null;
      lineItemTemplate?: unknown;
    },
  ) {
    const data: any = {};
    if (patch.category !== undefined) data.category = patch.category;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.lineItemTemplate !== undefined) data.lineItemTemplate = patch.lineItemTemplate as any;
    return this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data,
      include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    });
  }

  async submitCostSheet(
    providerId: string,
    items: Array<{
      category: string;
      key: string;
      minValue?: number | null;
      maxValue?: number | null;
      isCustom?: boolean;
      comment?: string | null;
      isIncluded?: boolean;
      sortOrder?: number;
    }>,
    sheetId?: string,
    providerTypeId?: string,
    subType?: string,
    programId?: string,
  ) {
    const versionWhere: any = { providerId, parentClientId: null };
    if (programId) {
      versionWhere.programId = programId;
    } else {
      if (providerTypeId) versionWhere.providerTypeId = providerTypeId;
      this.applySubTypeFilter(versionWhere, subType);
    }
    const maxVersion = await this.prisma.providerCostSheet.aggregate({
      where: versionWhere,
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version || 0) + 1;

    let sheet: any;
    let useSheetId = sheetId;
    if (!useSheetId && programId) {
      const programSheet = await this.prisma.providerCostSheet.findFirst({
        where: { providerId, programId, status: { notIn: ["ARCHIVED"] } },
        orderBy: { version: "desc" },
      });
      if (programSheet && programSheet.status !== "APPROVED") {
        useSheetId = programSheet.id;
      }
    }
    if (useSheetId) {
      const existingSheet = await this.prisma.providerCostSheet.findUnique({ where: { id: useSheetId } });
      if (existingSheet && (existingSheet.status === "APPROVED" || existingSheet.status === "ARCHIVED")) {
        useSheetId = undefined;
      }
    }
    if (useSheetId) {
      sheet = await this.prisma.providerCostSheet.update({
        where: { id: useSheetId },
        data: { status: "PENDING", version: nextVersion, providerTypeId: providerTypeId || undefined, subType: subType || undefined },
      });
      await this.prisma.costItem.deleteMany({
        where: { providerCostSheetId: useSheetId },
      });
    } else {
      sheet = await this.prisma.providerCostSheet.create({
        data: {
          providerId,
          providerTypeId: providerTypeId || null,
          subType: subType || null,
          programId: programId || null,
          status: "PENDING",
          version: nextVersion,
        },
      });
    }

    if (items.length > 0) {
      const resolved = await this.resolveTemplateFieldIds(providerTypeId, subType, items);
      await this.prisma.costItem.createMany({
        data: resolved.map((item: any, idx) => ({
          providerCostSheetId: sheet.id,
          templateFieldId: item.templateFieldId ?? null,
          category: item.category,
          key: item.key,
          minValue: item.minValue ?? null,
          maxValue: item.maxValue ?? null,
          isCustom: item.isCustom ?? false,
          comment: item.comment ?? null,
          isIncluded: item.isIncluded !== undefined ? item.isIncluded : true,
          isTier: item.isTier === true,
          sortOrder: item.sortOrder ?? idx,
        })),
      });
    }

    return this.getSheet(sheet.id);
  }

  async approveSheet(sheetId: string) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
    });
    if (!sheet) throw new Error("Sheet not found");

    const archiveWhere: any = {
      providerId: sheet.providerId,
      parentClientId: null,
      status: "APPROVED",
      id: { not: sheetId },
    };
    if (sheet.programId) {
      archiveWhere.programId = sheet.programId;
    } else {
      if (sheet.providerTypeId) archiveWhere.providerTypeId = sheet.providerTypeId;
      this.applySubTypeFilter(archiveWhere, sheet.subType || undefined);
    }

    await this.prisma.providerCostSheet.updateMany({
      where: archiveWhere,
      data: { status: "ARCHIVED" },
    });

    const approved = await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: { status: "APPROVED", adminFeedback: null },
      include: { items: true },
    });

    let donorTypesToRecalc: string[] = [];
    if (sheet.providerTypeId) {
      const pt = await this.prisma.providerType.findUnique({ where: { id: sheet.providerTypeId } });
      const providerTypeName = pt?.name;
      if (providerTypeName === "Egg Donor Agency" || providerTypeName === "Egg Bank") {
        donorTypesToRecalc.push("egg-donor");
      }
      if (providerTypeName === "Surrogacy Agency") {
        donorTypesToRecalc.push("surrogate");
      }
      if (providerTypeName === "Sperm Bank") {
        donorTypesToRecalc.push("sperm-donor");
      }
    } else {
      donorTypesToRecalc = ["egg-donor", "surrogate", "sperm-donor"];
    }

    recalcAndPersistTotalCostsForProvider(this.prisma, sheet.providerId, donorTypesToRecalc)
      .catch((err) => this.logger.warn(`Failed to recalc total costs after approval: ${err.message}`));

    return approved;
  }

  async rejectSheet(sheetId: string, feedback: string) {
    return this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: { status: "REJECTED", adminFeedback: feedback },
      include: { items: true },
    });
  }

  async saveDraft(
    providerId: string,
    items: Array<{
      category: string;
      key: string;
      minValue?: number | null;
      maxValue?: number | null;
      isCustom?: boolean;
      comment?: string | null;
      isIncluded?: boolean;
      sortOrder?: number;
    }>,
    sheetId?: string,
    providerTypeId?: string,
    subType?: string,
    programId?: string,
  ) {
    if (sheetId) {
      const existing = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
      if (existing && existing.providerId !== providerId) {
        throw new Error("Sheet does not belong to this provider");
      }
      if (existing && existing.status !== "APPROVED" && existing.status !== "ARCHIVED") {
        if (providerTypeId && !existing.providerTypeId) {
          await this.prisma.providerCostSheet.update({ where: { id: sheetId }, data: { providerTypeId } });
        }
        return this.updateSheetItems(sheetId, items);
      }
    }

    const findWhere: any = { providerId, parentClientId: null, status: { in: ["DRAFT", "PENDING"] } };
    if (programId) {
      findWhere.programId = programId;
    } else {
      if (providerTypeId) findWhere.providerTypeId = providerTypeId;
      this.applySubTypeFilter(findWhere, subType);
    }

    const existing = await this.prisma.providerCostSheet.findFirst({
      where: findWhere,
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return this.updateSheetItems(existing.id, items);
    }

    const sheet = await this.prisma.providerCostSheet.create({
      data: { providerId, providerTypeId: providerTypeId || null, subType: subType || null, programId: programId || null, status: "DRAFT", version: 1 },
    });

    return this.updateSheetItems(sheet.id, items);
  }

  async updateSheetItems(
    sheetId: string,
    items: Array<{
      category: string;
      key: string;
      minValue?: number | null;
      maxValue?: number | null;
      isCustom?: boolean;
      comment?: string | null;
      isIncluded?: boolean;
      sortOrder?: number;
      templateFieldId?: string | null;
    }>,
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (sheet && (sheet.status === "APPROVED" || sheet.status === "ARCHIVED")) {
      throw new Error(`Cannot modify a cost sheet with status ${sheet.status}`);
    }

    await this.prisma.costItem.deleteMany({
      where: { providerCostSheetId: sheetId },
    });

    if (items.length > 0) {
      const resolved = await this.resolveTemplateFieldIds(sheet?.providerTypeId, sheet?.subType, items);
      await this.prisma.costItem.createMany({
        data: resolved.map((item: any, idx) => ({
          providerCostSheetId: sheetId,
          templateFieldId: item.templateFieldId ?? null,
          category: item.category,
          key: item.key,
          minValue: item.minValue ?? null,
          maxValue: item.maxValue ?? null,
          isCustom: item.isCustom ?? false,
          comment: item.comment ?? null,
          isIncluded: item.isIncluded !== undefined ? item.isIncluded : true,
          isTier: item.isTier === true,
          sortOrder: item.sortOrder ?? idx,
        })),
      });
    }

    return this.getSheet(sheetId);
  }

  async createCustomQuote(providerId: string, parentId: string) {
    const master = await this.getApprovedMasterSheet(providerId);
    if (!master) throw new Error("No approved master sheet exists");

    const sheet = await this.prisma.providerCostSheet.create({
      data: {
        providerId,
        parentClientId: parentId,
        status: "PENDING",
        version: 1,
      },
    });

    if (master.items.length > 0) {
      await this.prisma.costItem.createMany({
        data: master.items.map((item: any) => ({
          providerCostSheetId: sheet.id,
          templateFieldId: item.templateFieldId ?? null,
          category: item.category,
          key: item.key,
          minValue: item.minValue,
          maxValue: item.maxValue,
          isCustom: item.isCustom,
          comment: item.comment,
          isIncluded: item.isIncluded,
          isTier: item.isTier === true,
          sortOrder: item.sortOrder,
        })),
      });
    }

    return this.getSheet(sheet.id);
  }

  async sendQuote(sheetId: string) {
    return this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: { status: "SENT_TO_PARENT" },
      include: { items: true },
    });
  }

  async getPrograms(providerId: string, providerTypeId?: string, subType?: string) {
    const where: any = { providerId };
    if (providerTypeId) where.providerTypeId = providerTypeId;
    if (subType) where.subType = subType;
    const programs = await this.prisma.costProgram.findMany({
      where,
      orderBy: { createdAt: "asc" },
    });
    if (programs.length === 0) return programs.map((p: any) => ({ ...p, latestSheetStatus: null }));
    const programIds = programs.map((p) => p.id);
    const latestSheets = await this.prisma.providerCostSheet.findMany({
      where: { programId: { in: programIds }, parentClientId: null },
      orderBy: { createdAt: "desc" },
      select: { programId: true, status: true },
    });
    const statusByProgram = new Map<string, string>();
    for (const s of latestSheets) {
      if (s.programId && !statusByProgram.has(s.programId)) {
        statusByProgram.set(s.programId, s.status);
      }
    }
    return programs.map((p) => ({ ...p, latestSheetStatus: statusByProgram.get(p.id) ?? null }));
  }

  async createProgram(providerId: string, providerTypeId: string | null, subType: string | null, name: string, country: string, tab?: string | null) {
    return this.prisma.costProgram.create({
      data: {
        providerId,
        providerTypeId: providerTypeId || null,
        subType: subType || null,
        tab: tab || null,
        name,
        country,
      },
    });
  }

  // Mirror subType/tab to the program's latest non-parent sheet so the
  // editor's classification card stays consistent with the program-level value.
  async updateProgram(programId: string, name: string, country: string, subType?: string, tab?: string, serviceTypes?: string[]) {
    const data: any = { name, country };
    if (subType !== undefined) data.subType = subType;
    if (tab !== undefined) data.tab = tab;
    if (serviceTypes !== undefined) {
      const ALLOWED = new Set(["ivf_clinic", "surrogacy", "egg_donor", "sperm_donor"]);
      const cleaned = Array.from(new Set(
        (Array.isArray(serviceTypes) ? serviceTypes : [])
          .map((t: any) => String(t).toLowerCase().trim())
          .filter((t: string) => ALLOWED.has(t)),
      ));
      data.serviceTypes = cleaned;
    }
    const updated = await this.prisma.costProgram.update({
      where: { id: programId },
      data,
    });
    if (subType !== undefined || tab !== undefined) {
      const latest = await this.prisma.providerCostSheet.findFirst({
        where: { programId, parentClientId: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latest) {
        const sheetData: any = {};
        if (subType !== undefined) sheetData.subType = subType;
        if (tab !== undefined) sheetData.tab = tab;
        sheetData.legacyNeedsReview = false;
        await this.prisma.providerCostSheet.update({ where: { id: latest.id }, data: sheetData });
      }
    }
    return updated;
  }

  async deleteProgram(programId: string) {
    const sheets = await this.prisma.providerCostSheet.findMany({ where: { programId } });
    for (const sheet of sheets) {
      if (sheet.filePath) {
        try { await this.storage.deleteObject(sheet.filePath); } catch {}
      }
      await this.prisma.costItem.deleteMany({ where: { providerCostSheetId: sheet.id } });
    }
    await this.prisma.providerCostSheet.deleteMany({ where: { programId } });
    await this.prisma.costProgram.delete({ where: { id: programId } });
    return { deleted: true };
  }

  async ensureFrozenEggTemplates() {
    const providerTypes = await this.prisma.providerType.findMany();
    const eggType = providerTypes.find((pt) =>
      ["egg"].some((kw) => pt.name.toLowerCase().includes(kw)),
    );
    if (!eggType) return { added: 0 };

    const existingFrozen = await this.prisma.costTemplate.count({
      where: { providerTypeId: eggType.id, subType: "frozen" },
    });
    if (existingFrozen > 0) return { added: 0 };

    const frozenEggItems = [
      { fieldName: "Number of Eggs in Egg Lot", category: "Frozen Eggs", isMandatory: true, isBaseCompensation: false, allowMultiple: true, sortOrder: 0 },
      { fieldName: "Egg Lot Cost", category: "Frozen Eggs", isMandatory: true, isBaseCompensation: false, allowMultiple: true, sortOrder: 1 },
    ];

    await this.prisma.costTemplate.createMany({
      data: frozenEggItems.map((item) => ({
        ...item,
        providerTypeId: eggType.id,
        subType: "frozen",
      })),
    });

    this.logger.log(`Added ${frozenEggItems.length} frozen egg cost templates`);
    return { added: frozenEggItems.length };
  }

  async seedTemplates(force = false) {
    const existing = await this.prisma.costTemplate.count();
    if (existing > 0 && !force) {
      await this.ensureFrozenEggTemplates();
      this.logger.log("Cost templates already seeded, ensured frozen egg templates exist");
      return { seeded: false, count: existing };
    }

    if (force && existing > 0) {
      await this.prisma.costTemplate.deleteMany();
      this.logger.log(`Deleted ${existing} existing templates for reseed`);
    }

    const providerTypes = await this.prisma.providerType.findMany();
    const findType = (keywords: string[]) =>
      providerTypes.find((pt) =>
        keywords.some((kw) => pt.name.toLowerCase().includes(kw)),
      );

    const eggType = findType(["egg"]);
    const surrogacyType = findType(["surrog"]);
    const ivfType = findType(["ivf", "clinic"]);

    const templates: Array<{
      providerTypeId: string;
      category: string;
      fieldName: string;
      isMandatory: boolean;
      isBaseCompensation: boolean;
      allowMultiple: boolean;
      sortOrder: number;
      subType?: string;
    }> = [];

    if (eggType) {
      const eggItems = [
        { fieldName: "Agency Fee", category: "Agency Fee", isMandatory: true, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "International Parents Fees", category: "Agency Fee", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Egg Donor Compensation", category: "Egg Donor Fees", isMandatory: true, isBaseCompensation: true, allowMultiple: true },
        { fieldName: "Local Monitoring", category: "Egg Donor Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Travel Expenses", category: "Egg Donor Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Psychological Screening", category: "Egg Donor Screening", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Genetic Testing", category: "Egg Donor Screening", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Parent Representation", category: "Legal Representation", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Donor Representation", category: "Legal Representation", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Donor Insurance", category: "Donor Insurance", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Escrow", category: "Escrow", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
      ];
      eggItems.forEach((item, idx) =>
        templates.push({ ...item, providerTypeId: eggType.id, sortOrder: idx, subType: "fresh" }),
      );

      const frozenEggItems = [
        { fieldName: "Number of Eggs in Egg Lot", category: "Frozen Eggs", isMandatory: true, isBaseCompensation: false, allowMultiple: true },
        { fieldName: "Egg Lot Cost", category: "Frozen Eggs", isMandatory: true, isBaseCompensation: false, allowMultiple: true },
      ];
      frozenEggItems.forEach((item, idx) =>
        templates.push({ ...item, providerTypeId: eggType.id, sortOrder: idx, subType: "frozen" }),
      );
    }

    if (surrogacyType) {
      const surrogacyItems = [
        { fieldName: "Agency Fees", category: "Agency", isMandatory: true, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "International Parents Fees", category: "Agency", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Surrogate Compensation", category: "Surrogate Fees", isMandatory: true, isBaseCompensation: true, allowMultiple: true },
        { fieldName: "Travel Expenses", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Injectable Medication Start Fee", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Embryo Transfer Payment", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Monthly Allowance for the Whole Journey", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Maternity Clothing (Full Journey)", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Housekeeping", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Local Monitoring", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Lost Wages", category: "Surrogate Fees", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Parent Representation", category: "Legal", isMandatory: true, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Surrogate Representation", category: "Legal", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Psychological Screening", category: "Screening", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Criminal Background Check", category: "Screening", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Parents Background Check", category: "Screening", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Psychological Support", category: "Surrogate Psychological Support", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Health Insurance", category: "Insurance", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Life Insurance", category: "Insurance", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Insurance Verification", category: "Insurance", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Escrow Management", category: "Administrative", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
      ];
      surrogacyItems.forEach((item, idx) =>
        templates.push({ ...item, providerTypeId: surrogacyType.id, sortOrder: idx }),
      );
    }

    if (ivfType) {
      const ivfItems = [
        { fieldName: "Consultation", category: "Consultation", isMandatory: true, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "IVF Cycle", category: "Medical", isMandatory: true, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Medication", category: "Medical", isMandatory: true, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Lab Fees", category: "Medical", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Embryo Transfer", category: "Medical", isMandatory: true, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Cryopreservation", category: "Medical", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Genetic Testing (PGT)", category: "Testing", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Monitoring", category: "Medical", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
        { fieldName: "Administrative Fees", category: "Administrative", isMandatory: false, isBaseCompensation: false, allowMultiple: false },
      ];
      ivfItems.forEach((item, idx) =>
        templates.push({ ...item, providerTypeId: ivfType.id, sortOrder: idx }),
      );
    }

    if (templates.length > 0) {
      await this.prisma.costTemplate.createMany({ data: templates });
    }

    this.logger.log(`Seeded ${templates.length} cost templates`);

    await this.backfillTemplateFieldIds();

    return { seeded: true, count: templates.length };
  }

  async backfillTemplateFieldIds() {
    const allTemplates = await this.prisma.costTemplate.findMany();
    const lookup = new Map<string, string>();
    for (const t of allTemplates) {
      const key = `${t.providerTypeId}::${t.subType ?? ""}::${t.category}::${t.fieldName}`;
      lookup.set(key, t.id);
    }

    const orphanItems = await this.prisma.costItem.findMany({
      where: { templateFieldId: null, isCustom: false },
      include: { providerCostSheet: { select: { providerTypeId: true, subType: true } } },
    });

    let updated = 0;
    for (const item of orphanItems) {
      const ptId = item.providerCostSheet?.providerTypeId;
      if (!ptId) continue;

      const sub = item.providerCostSheet?.subType ?? "";
      let templateId = lookup.get(`${ptId}::${sub}::${item.category}::${item.key}`);
      if (!templateId && sub === "") {
        templateId = lookup.get(`${ptId}::fresh::${item.category}::${item.key}`);
      }
      if (!templateId) {
        templateId = lookup.get(`${ptId}::::${item.category}::${item.key}`);
      }

      if (templateId) {
        await this.prisma.costItem.update({
          where: { id: item.id },
          data: { templateFieldId: templateId },
        });
        updated++;
      }
    }

    if (updated > 0) {
      this.logger.log(`Backfilled templateFieldId for ${updated} cost items`);
    }
    return { backfilled: updated };
  }
}
