import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import * as crypto from "crypto";
import { recalcAndPersistTotalCostsForProvider } from "./total-cost.utils";

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
    if (subType === "fresh" || !subType) {
      where.OR = [{ subType: null }, { subType: "fresh" }];
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
  ) {
    const uniqueId = crypto.randomUUID();
    const gcsPath = `cost-sheets/${providerId}/${uniqueId}-${filename}`;

    await this.storage.uploadBuffer(buffer, gcsPath, contentType);

    const sheet = await this.prisma.providerCostSheet.create({
      data: {
        providerId,
        providerTypeId: providerTypeId || null,
        subType: subType || null,
        filePath: gcsPath,
        originalFileName: filename,
        status: "PARSING",
      },
    });

    return { sheet, buffer, contentType: contentType };
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
      comment: string | null;
    }>,
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) return;

    const templates = sheet.providerTypeId
      ? await this.prisma.costTemplate.findMany({
          where: { providerTypeId: sheet.providerTypeId },
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
        ? { ...tpl, minValue: match.minValue, maxValue: match.maxValue, comment: match.comment, isIncluded: match.isIncluded }
        : { ...tpl };
    });
    const customItems = parsedItems.filter(
      (p) => p.isCustom || !templateItems.some((t) => t.category === p.category && t.key === p.key),
    );
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

  async resetProviderCosts(providerId: string, providerTypeId?: string, subType?: string) {
    const where: any = { providerId, parentClientId: null };
    if (providerTypeId) where.providerTypeId = providerTypeId;
    this.applySubTypeFilter(where, subType);

    const sheets = await this.prisma.providerCostSheet.findMany({ where });

    for (const sheet of sheets) {
      if (sheet.filePath) {
        try { await this.storage.deleteObject(sheet.filePath); } catch {}
      }
      await this.prisma.costItem.deleteMany({ where: { providerCostSheetId: sheet.id } });
    }

    await this.prisma.providerCostSheet.deleteMany({ where });

    return { reset: true };
  }

  async getDownloadUrl(sheetId: string) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
    });
    if (!sheet?.filePath) throw new Error("No file attached to sheet");

    const url = await this.storage.getSignedUrl(sheet.filePath, 60);
    return { url };
  }

  async getProviderSheets(providerId: string, status?: string, providerTypeId?: string, subType?: string) {
    const where: any = { providerId };
    if (status) where.status = status;
    if (providerTypeId) where.providerTypeId = providerTypeId;
    this.applySubTypeFilter(where, subType);

    return this.prisma.providerCostSheet.findMany({
      where,
      include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
      orderBy: { createdAt: "desc" },
    });
  }

  async getApprovedMasterSheet(providerId: string, providerTypeId?: string, subType?: string) {
    const where: any = {
      providerId,
      parentClientId: null,
      status: "APPROVED",
    };
    if (providerTypeId) where.providerTypeId = providerTypeId;
    this.applySubTypeFilter(where, subType);

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
  ) {
    const versionWhere: any = { providerId, parentClientId: null };
    if (providerTypeId) versionWhere.providerTypeId = providerTypeId;
    this.applySubTypeFilter(versionWhere, subType);
    const maxVersion = await this.prisma.providerCostSheet.aggregate({
      where: versionWhere,
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version || 0) + 1;

    let sheet: any;
    let useSheetId = sheetId;
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
          status: "PENDING",
          version: nextVersion,
        },
      });
    }

    if (items.length > 0) {
      const resolved = await this.resolveTemplateFieldIds(providerTypeId, subType, items);
      await this.prisma.costItem.createMany({
        data: resolved.map((item, idx) => ({
          providerCostSheetId: sheet.id,
          templateFieldId: item.templateFieldId ?? null,
          category: item.category,
          key: item.key,
          minValue: item.minValue ?? null,
          maxValue: item.maxValue ?? null,
          isCustom: item.isCustom ?? false,
          comment: item.comment ?? null,
          isIncluded: item.isIncluded !== undefined ? item.isIncluded : true,
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
    if (sheet.providerTypeId) archiveWhere.providerTypeId = sheet.providerTypeId;
    this.applySubTypeFilter(archiveWhere, sheet.subType || undefined);

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
    if (providerTypeId) findWhere.providerTypeId = providerTypeId;
    this.applySubTypeFilter(findWhere, subType);

    const existing = await this.prisma.providerCostSheet.findFirst({
      where: findWhere,
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return this.updateSheetItems(existing.id, items);
    }

    const sheet = await this.prisma.providerCostSheet.create({
      data: { providerId, providerTypeId: providerTypeId || null, subType: subType || null, status: "DRAFT", version: 1 },
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
        data: resolved.map((item, idx) => ({
          providerCostSheetId: sheetId,
          templateFieldId: item.templateFieldId ?? null,
          category: item.category,
          key: item.key,
          minValue: item.minValue ?? null,
          maxValue: item.maxValue ?? null,
          isCustom: item.isCustom ?? false,
          comment: item.comment ?? null,
          isIncluded: item.isIncluded !== undefined ? item.isIncluded : true,
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
