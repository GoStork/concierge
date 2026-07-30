import { Inject, Injectable, Logger } from "@nestjs/common";
import { programDisplayName } from "./program-name";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { CostsAiService } from "./costs-ai.service";
import { PaymentScheduleService, buildParentPaymentSchedule } from "./payment-schedule.service";
import * as crypto from "crypto";
import { recalcAndPersistTotalCostsForProvider } from "./total-cost.utils";
import {
  ALL_SUBTYPES,
  isValidSubType,
  isValidTab,
  resolveTemplate,
  sheetMatchesParentJourney,
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

// Generic, non-IVF leaves that double as serviceType tags - they add no useful
// program subtitle (the program name already conveys "surrogacy" / "egg donor").
const GENERIC_SUBTYPE_LEAVES = new Set<string>([
  "surrogacy", "egg_donor_fresh", "egg_donor_frozen", "sperm_donor",
]);

// Pick the most descriptive subtype for a program's subtitle from its canonical
// subTypes[] coverage. Prefers the specific IVF-journey leaf (e.g. ship-embryos-
// to-surrogate) over the generic surrogacy/egg-donor tags, using ALL_SUBTYPES
// order (specific leaves come first). Falls back to the legacy scalar only when
// it is itself a valid specific leaf. Returns null when nothing descriptive
// applies. The legacy scalar `subType` is unreliable on its own (it can hold a
// stale value), so the canonical array is consulted first.
function pickDisplaySubType(subTypes: unknown, scalar: string | null | undefined): SubType | null {
  const arr = Array.isArray(subTypes) ? (subTypes as string[]) : [];
  const specific = arr
    .filter((s) => isValidSubType(s) && !GENERIC_SUBTYPE_LEAVES.has(s))
    .sort((a, b) => ALL_SUBTYPES.indexOf(a as SubType) - ALL_SUBTYPES.indexOf(b as SubType));
  if (specific.length > 0) return specific[0] as SubType;
  // Only trust the legacy scalar when there is NO canonical coverage at all
  // (an un-migrated program). When subTypes[] is populated but carries only
  // generic leaves (e.g. ["surrogacy"]), the program has no specific IVF
  // journey, so it gets no subtitle - never the stale scalar.
  if (arr.length === 0 && scalar && isValidSubType(scalar) && !GENERIC_SUBTYPE_LEAVES.has(scalar)) return scalar as SubType;
  return null;
}

@Injectable()
export class CostsService {
  private readonly logger = new Logger(CostsService.name);

  // Canonical country names used to infer the default program country from
  // a provider's existing Locations. Kept in sync with the client's
  // COUNTRIES list in country-autocomplete-input.tsx so a provider whose
  // locations show "Mexico City, Mexico" defaults new cost-sheet uploads
  // to Mexico instead of the legacy hardcoded "United States".
  private static readonly KNOWN_COUNTRIES: readonly string[] = [
    "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda",
    "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain",
    "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan",
    "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria",
    "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada",
    "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros",
    "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark",
    "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador",
    "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji",
    "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece",
    "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras",
    "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel",
    "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati",
    "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia",
    "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi",
    "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania",
    "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia",
    "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal",
    "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea",
    "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama",
    "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
    "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia",
    "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe",
    "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore",
    "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea",
    "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland",
    "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo",
    "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
    "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States",
    "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam",
    "Yemen", "Zambia", "Zimbabwe",
  ];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(CostsAiService) private readonly costsAi: CostsAiService,
    @Inject(PaymentScheduleService) private readonly paymentSchedule: PaymentScheduleService,
  ) {}

  /**
   * Look at the provider's existing ProviderLocation rows and infer the most
   * likely country, so a fresh cost-sheet upload (or program reset) defaults
   * to the right place instead of always landing on "United States". Returns
   * "United States" when the provider has no locations or none match a known
   * country name.
   *
   * ProviderLocation has no dedicated `country` column - the country is
   * either stored in `state` for non-US scrapes ("Mexico City" / "Mexico")
   * or appended to the city/address string ("Barranquilla, Colombia"), so
   * we scan those text fields against the canonical country list. Most
   * common derived country across all locations wins; ties break to the
   * first location's country by sortOrder.
   */
  private async deriveDefaultCountryFromLocations(providerId: string): Promise<string> {
    const locations = await this.prisma.providerLocation.findMany({
      where: { providerId },
      orderBy: { sortOrder: "asc" },
      select: { address: true, city: true, state: true },
    });
    if (locations.length === 0) {
      this.logger.log(`[country-derive] provider=${providerId} no locations -> United States`);
      return "United States";
    }

    const counts = new Map<string, number>();
    let firstMatch: string | null = null;
    const debugRows: string[] = [];
    for (const loc of locations) {
      const matched = this.detectCountryInLocation(loc);
      debugRows.push(`{a=${JSON.stringify(loc.address)},c=${JSON.stringify(loc.city)},s=${JSON.stringify(loc.state)}}->${matched ?? "(no match)"}`);
      if (!matched) continue;
      if (firstMatch === null) firstMatch = matched;
      counts.set(matched, (counts.get(matched) ?? 0) + 1);
    }
    if (counts.size === 0) {
      this.logger.warn(`[country-derive] provider=${providerId} no country matched in ${locations.length} locations -> United States | ${debugRows.join(" | ")}`);
      return "United States";
    }

    let best = firstMatch as string;
    let bestCount = counts.get(best) ?? 0;
    for (const [country, count] of counts) {
      if (count > bestCount) {
        best = country;
        bestCount = count;
      }
    }
    this.logger.log(`[country-derive] provider=${providerId} -> ${best} (from ${locations.length} locations) | ${debugRows.join(" | ")}`);
    return best;
  }

  // A US state code/name in the STATE field means the row is a US-format
  // location. Without this, a firm with 9 US offices ("CA", "NY", ...) and
  // one "Beijing, China" row derives country=China - the US rows match no
  // KNOWN_COUNTRIES entry, so the single foreign office wins the vote.
  private static readonly US_STATE_TOKENS = new Set<string>([
    "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc",
    "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming","district of columbia",
  ]);

  private detectCountryInLocation(loc: {
    address: string | null;
    city: string | null;
    state: string | null;
  }): string | null {
    const stateToken = (loc.state || "").trim().toLowerCase();
    if (stateToken && CostsService.US_STATE_TOKENS.has(stateToken)) return "United States";
    const fields: string[] = [loc.state, loc.city, loc.address]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .map(s => s.toLowerCase());
    if (fields.length === 0) return null;
    for (const country of CostsService.KNOWN_COUNTRIES) {
      const lc = country.toLowerCase();
      for (const field of fields) {
        if (field === lc || field.endsWith(", " + lc) || field.endsWith(" " + lc)) {
          return country;
        }
      }
    }
    return null;
  }

  /**
   * Run the full Gemini parse + classification + template-merge pipeline for
   * an already-uploaded sheet, emitting live progress to ProviderCostSheet so
   * the client's poll can render a real progress bar.
   *
   * Fire-and-forget by design - the caller (POST /upload OR the startup
   * resume sweep) returns immediately and the work continues in the
   * background. On any failure the sheet is flipped to a DRAFT with
   * parseStage = "Parse failed - using empty template" so the row never
   * stays stuck in PARSING forever.
   *
   * Extracted from CostsController.backgroundParseAndSave so the same
   * pipeline is reused by resumeOrphanedParsingSheets() on server boot.
   */
  runBackgroundParse(
    sheetId: string,
    buffer: Buffer,
    contentType: string,
    providerType: string,
    filename: string,
    subType?: string,
    autoApproveAfterParse: boolean = false,
    approvedTypeNames?: string[],
  ): void {
    (async () => {
      try {
        this.logger.log(`Background AI parse+classify started for sheet ${sheetId}`);
        await this.updateParseProgress(sheetId, "Reading document with AI", 10, 0);

        const { items, classification, tranches, paymentTerms } = await this.costsAi.parseAndClassifyDocument(
          buffer, contentType, providerType, filename, subType,
          async ({ itemsCount }) => {
            const streamProgress = Math.min(85, 15 + Math.round(itemsCount * 3.5));
            await this.updateParseProgress(
              sheetId,
              `Extracting items (${itemsCount} found)`,
              streamProgress,
              itemsCount,
            );
          },
          approvedTypeNames,
        );

        await this.updateParseProgress(sheetId, "Classifying program type", 90, items.length);
        if (classification) {
          await this.saveAiClassification(sheetId, classification);
        }

        await this.updateParseProgress(sheetId, "Mapping to GoStork template", 95, items.length);

        // A-la-carte fee schedules spanning several journeys (law firms,
        // wellness menus) split into one program per journey - a single
        // program summing every independently-purchasable service into one
        // total is meaningless to parents. When a split applies it writes
        // each sheet's item subset itself; otherwise fall through to the
        // normal single-program save.
        let allSheetIds: string[] = [sheetId];
        if (classification?.programSplits && classification.programSplits.length >= 2) {
          try {
            allSheetIds = await this.applyProgramSplits(sheetId, classification.programSplits, items);
          } catch (err: any) {
            this.logger.warn(`[program-split] Split failed for sheet ${sheetId} (keeping single program): ${err.message}`);
          }
        }
        if (allSheetIds.length === 1) {
          await this.saveParseResults(sheetId, items);
        }

        // Payment schedule. Runs AFTER items are persisted because tranches
        // reference line items by id. Best-effort by design: a schedule is
        // additive information, so a failure here must never fail an
        // otherwise-good parse or leave the sheet stuck in PARSING. Only the
        // single-program path gets one - a split fee schedule spans several
        // programs and its tranches can't be attributed to any single sheet.
        if (allSheetIds.length === 1 && (tranches.length > 0 || paymentTerms)) {
          try {
            await this.paymentSchedule.saveParsedSchedule(sheetId, tranches, paymentTerms);
          } catch (err: any) {
            this.logger.warn(`Payment schedule save failed for sheet ${sheetId}: ${err.message}`);
          }
        }

        // Admin uploads skip the review queue: once parsing succeeds the
        // sheet flips straight to APPROVED. Mirrors the /submit endpoint's
        // admin auto-approve so both upload paths converge on the same
        // terminal state, and prevents admin-uploaded sheets from sitting
        // in DRAFT with no Save bar visible to advance them.
        if (autoApproveAfterParse) {
          for (const sid of allSheetIds) {
            try {
              await this.approveSheet(sid);
              this.logger.log(`Background parse: auto-approved sheet ${sid} (admin upload)`);
            } catch (err: any) {
              this.logger.warn(`Background parse: auto-approve failed for sheet ${sid}: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        this.logger.error(`Background AI parse failed for sheet ${sheetId}: ${err.message}`);
        await this.markParseError(sheetId);
      }
    })();
  }

  /**
   * Split one uploaded a-la-carte fee schedule into multiple programs (one
   * per parent journey) per the AI's programSplits proposal. The original
   * upload-first program becomes split[0]; each further split gets its own
   * CostProgram + ProviderCostSheet referencing the SAME uploaded file.
   * Safety: only fires when the sheet is its program's only sheet (the
   * upload-first shape) - never rearranges an established program.
   */
  private async applyProgramSplits(
    sheetId: string,
    splits: { programName: string; serviceTypes: string[]; itemKeys: string[] }[],
    parsedItems: Array<{ category: string; key: string; minValue: number | null; maxValue: number | null; isCustom: boolean; isIncluded: boolean; isTier?: boolean; comment: string | null }>,
  ): Promise<string[]> {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (!sheet?.programId) return [sheetId];
    const siblingCount = await this.prisma.providerCostSheet.count({
      where: { programId: sheet.programId, id: { not: sheetId } },
    });
    if (siblingCount > 0) return [sheetId];
    const program = await this.prisma.costProgram.findUnique({ where: { id: sheet.programId } });
    if (!program) return [sheetId];

    const keyOf = (it: { category: string; key: string }) => `${it.category}::${it.key}`;
    const subsets = splits
      .map((sp) => {
        const wanted = new Set(sp.itemKeys);
        return { ...sp, items: parsedItems.filter((it) => wanted.has(keyOf(it))) };
      })
      .filter((sp) => sp.items.length > 0);
    if (subsets.length < 2) return [sheetId];

    this.logger.log(`[program-split] Splitting sheet ${sheetId} into ${subsets.length} programs: ${subsets.map((sp) => `"${sp.programName}" (${sp.items.length} items)`).join(", ")}`);

    // Sibling programs are created FIRST: the client refetches the program
    // list the moment the ORIGINAL sheet flips to Complete, so the siblings
    // must already exist by then or the provider sees only one program
    // until a manual refresh.
    const siblingSheetIds: string[] = [];
    for (const sp of subsets.slice(1)) {
      const subTypes = this.deriveSubTypesLeaves(sp.serviceTypes, null);
      const newProgram = await this.prisma.costProgram.create({
        data: {
          providerId: program.providerId,
          providerTypeId: program.providerTypeId,
          name: sp.programName,
          country: program.country,
          tab: null,
          subType: null,
          serviceTypes: sp.serviceTypes,
          subTypes,
        },
      });
      const newSheet = await this.prisma.providerCostSheet.create({
        data: {
          providerId: sheet.providerId,
          providerTypeId: sheet.providerTypeId,
          subType: null,
          subTypes,
          programId: newProgram.id,
          filePath: sheet.filePath,
          originalFileName: sheet.originalFileName,
          isFixedCost: sheet.isFixedCost,
          status: "PARSING",
          parseStage: "Splitting programs",
          parseProgress: 95,
        },
      });
      await this.saveParseResults(newSheet.id, sp.items);
      siblingSheetIds.push(newSheet.id);
    }

    // The original program becomes split[0] - renamed, retagged, and its
    // sheet's items narrowed to the subset. This is what flips the original
    // sheet to Complete, triggering the client's refetch.
    const first = subsets[0];
    const firstSubTypes = this.deriveSubTypesLeaves(first.serviceTypes, null);
    await this.prisma.costProgram.update({
      where: { id: program.id },
      data: { name: first.programName, serviceTypes: first.serviceTypes, subTypes: firstSubTypes },
    });
    await this.prisma.providerCostSheet.update({ where: { id: sheetId }, data: { subTypes: firstSubTypes } });
    await this.saveParseResults(sheetId, first.items);

    return [sheetId, ...siblingSheetIds];
  }

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
    // with name + country" step beforehand. Country is derived from the
    // provider's existing Locations rows so a Colombia / Mexico / etc.
    // provider doesn't land on "United States" as the visible default
    // (Eran's request: don't make non-US clinics correct USA every upload).
    let resolvedProgramId = programId || null;
    if (!resolvedProgramId) {
      const defaultCountry = await this.deriveDefaultCountryFromLocations(providerId);
      const newProgram = await this.prisma.costProgram.create({
        data: {
          providerId,
          providerTypeId: providerTypeId || null,
          name: "Untitled",
          country: defaultCountry,
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
        parseStage: "Uploading document",
        parseProgress: 5,
        parseItemsCount: 0,
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
      data: {
        status: "DRAFT",
        parseStage: "Complete",
        parseProgress: 100,
        parseItemsCount: parsedItems.length,
      },
    });

    this.logger.log(`Auto-parse complete for sheet ${sheetId}: ${parsedItems.length} items extracted`);
  }

  async markParseError(sheetId: string) {
    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: {
        status: "DRAFT",
        parseStage: "Parse failed - using empty template",
        parseProgress: 100,
      },
    });
  }

  /**
   * Live progress update for the background AI parse. Called by the
   * controller as Gemini streams items back so the client poll can render
   * a real, non-fake progress bar. itemsCount is the running count of
   * complete items extracted from the partial stream.
   */
  async updateParseProgress(
    sheetId: string,
    stage: string,
    progress: number,
    itemsCount?: number,
  ) {
    const data: any = {
      parseStage: stage,
      parseProgress: Math.max(0, Math.min(100, Math.round(progress))),
    };
    if (itemsCount !== undefined) data.parseItemsCount = itemsCount;
    try {
      await this.prisma.providerCostSheet.update({ where: { id: sheetId }, data });
    } catch (err: any) {
      // Best-effort. Don't crash the parse if a single progress write fails.
      // The dominant case is "row was deleted mid-parse because the clinic
      // cancelled or trashed the program" - Prisma raises P2025 ("No record
      // was found for an update") and the background parse keeps trying to
      // update progress for the deleted row every ~250ms until it finishes,
      // which spams the log with 4-line warnings each. Detect that specific
      // case and stay silent (or one concise line for visibility); reserve
      // the loud warning for genuinely unexpected failures.
      const isRecordGone =
        err?.code === "P2025" ||
        /No record was found for an update/i.test(err?.message ?? "");
      if (isRecordGone) {
        // Optional: this.logger.debug(`updateParseProgress(${sheetId}) skipped - row deleted`);
        return;
      }
      this.logger.warn(`updateParseProgress(${sheetId}) failed: ${err.message}`);
    }
  }

  /**
   * Persist the AI's proposed classification on a freshly-parsed sheet.
   * Always overwrites - the admin can re-edit any value afterward via the
   * inline controls, and Save is the single persistence step.
   */
  async saveAiClassification(
    sheetId: string,
    proposal: { tab: Tab; subType: SubType; isFixedCost: boolean; confidence: number; reasoning: string; programName?: string; country?: string; serviceTypes?: string[]; eggDonorSubType?: "fresh" | "frozen" },
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) return;
    // Empty tab/subType mean the provider type doesn't use the IVF
    // taxonomy (surrogacy / sperm bank). Persist as null in those cases.
    const persistedTab = proposal.tab && (proposal.tab as string).length > 0 ? proposal.tab : null;
    const persistedSubType = proposal.subType && (proposal.subType as string).length > 0 ? proposal.subType : null;

    // Derive the canonical subTypes[] coverage array from the legacy
    // (serviceTypes, subType) pair using the same rules as the migration
    // backfill (20260603_cost_sheet_multi_subtypes). Without this the
    // multi-toggle UI on the program row stays blank even after the AI
    // correctly classifies a sheet as e.g. ["surrogacy"]. The UI reads
    // subTypes[], not the legacy serviceTypes. The third arg lets a
    // mixed IVF+egg-donor sheet narrow the egg-donor leg from BOTH
    // fresh+frozen to just the one the AI extracted.
    const derivedSubTypes = this.deriveSubTypesLeaves(
      proposal.serviceTypes ?? [],
      persistedSubType,
      proposal.eggDonorSubType,
    );

    await this.prisma.providerCostSheet.update({
      where: { id: sheetId },
      data: {
        tab: persistedTab,
        subType: persistedSubType,
        subTypes: derivedSubTypes,
        isFixedCost: proposal.isFixedCost,
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
      // Override country ONLY when the program is still on the legacy
      // "United States" fallback (i.e. uploadFile couldn't derive a
      // country from the provider's locations). When locations did give
      // us a real country - Colombia for Inser, Mexico for an MX clinic,
      // etc. - that's the authoritative signal: a US-formatted cost sheet
      // dropped on Inser shouldn't silently flip Colombia to USA because
      // the AI noticed dollar signs in the sheet. Clinics that disagree
      // can edit the country manually in the auto-edit-mode row.
      const isLegacyDefault = !program?.country || program.country === "United States";
      if (proposal.country && isLegacyDefault && proposal.country !== "United States") {
        data.country = proposal.country;
      }
      // Only seed serviceTypes when the program doesn't yet have any tags
      // (fresh upload-first creation). Don't stomp an existing array - the
      // provider may have edited tags by hand.
      if (proposal.serviceTypes && proposal.serviceTypes.length > 0 && (!program?.serviceTypes || program.serviceTypes.length === 0)) {
        data.serviceTypes = proposal.serviceTypes;
        // Mirror onto the canonical subTypes[] using the same derivation
        // we ran on the sheet. Without this the multi-toggle UI on the
        // program row stays blank even when serviceTypes is correct.
        data.subTypes = derivedSubTypes;
      }
      await this.prisma.costProgram.update({
        where: { id: sheet.programId },
        data,
      });
    }
  }

  /**
   * Derive the canonical subTypes[] coverage array from the legacy
   * (serviceTypes, subType) pair. Mirrors the SQL rules in the
   * 20260603_cost_sheet_multi_subtypes migration so freshly-saved AI
   * classifications populate the array the way the migration would
   * have backfilled them.
   *
   *   IVF clinic   - subType is already one of the 14 IVF leaf ids
   *   surrogacy    - emit "surrogacy"
   *   sperm_donor  - emit "sperm_donor"
   *   egg_donor + fresh  - emit "egg_donor_fresh"
   *   egg_donor + frozen - emit "egg_donor_frozen"
   *   egg_donor + null   - emit BOTH (conservatively cover both, admin
   *                        can narrow later)
   */
  private deriveSubTypesLeaves(
    serviceTypes: string[],
    subType: string | null,
    eggDonorSubType?: "fresh" | "frozen",
  ): string[] {
    const leaves = new Set<string>();

    // IVF leaf: the legacy subType IS the leaf id when it matches one of
    // the IVF taxonomy prefixes.
    if (
      subType &&
      (subType.startsWith("ivf_") ||
        subType.startsWith("embryo_") ||
        subType.startsWith("fet_") ||
        subType.startsWith("shipping_") ||
        subType.startsWith("egg_freezing_"))
    ) {
      leaves.add(subType);
    }

    // Non-IVF leaves derived from serviceTypes.
    if (serviceTypes.includes("surrogacy")) leaves.add("surrogacy");
    if (serviceTypes.includes("sperm_donor")) leaves.add("sperm_donor");

    if (serviceTypes.includes("egg_donor")) {
      // Precedence:
      //   1. explicit eggDonorSubType from the AI (set even on mixed
      //      IVF+egg-donor sheets) - narrows to a single leaf so the
      //      Fresh/Frozen matcher filter actually discriminates.
      //   2. legacy subType === "fresh"|"frozen" (pure egg-donor sheets).
      //   3. fall back to BOTH leaves so the program still matches when
      //      we genuinely don't know.
      if (eggDonorSubType === "fresh") {
        leaves.add("egg_donor_fresh");
      } else if (eggDonorSubType === "frozen") {
        leaves.add("egg_donor_frozen");
      } else if (subType === "fresh") {
        leaves.add("egg_donor_fresh");
      } else if (subType === "frozen") {
        leaves.add("egg_donor_frozen");
      } else {
        // Egg donor with no fresh/frozen distinction - conservatively
        // cover both leaves so the matcher still finds the program.
        leaves.add("egg_donor_fresh");
        leaves.add("egg_donor_frozen");
      }
    }

    return Array.from(leaves);
  }

  /**
   * Clinic updates the classification. Any value set here is the
   * authoritative one - there is no separate confirm step.
   */
  async saveClinicClassification(
    sheetId: string,
    payload: { tab?: Tab; subType?: SubType; isFixedCost?: boolean },
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
   *
   * Memoized for a few seconds because the program matcher calls this once per
   * PROVIDER: pricing a 450-clinic deck for one parent asked the identical
   * question 450 times. The TTL is short enough that an onboarding edit shows
   * up on the parent's next interaction, and the key is the parent account so
   * no answer can leak across accounts.
   */
  private subtypeMemo = new Map<string, { at: number; value: Promise<any> }>();
  private static readonly SUBTYPE_MEMO_TTL_MS = 5_000;

  async getMatchingSubtypesForParent(parentAccountId: string) {
    const hit = this.subtypeMemo.get(parentAccountId);
    if (hit && Date.now() - hit.at < CostsService.SUBTYPE_MEMO_TTL_MS) return hit.value;
    const value = this._getMatchingSubtypesForParent(parentAccountId).catch((e) => {
      // Never cache a failure - drop it so the next caller retries for real.
      this.subtypeMemo.delete(parentAccountId);
      throw e;
    });
    this.subtypeMemo.set(parentAccountId, { at: Date.now(), value });
    // Keep the map from growing without bound on a long-lived server.
    if (this.subtypeMemo.size > 500) {
      for (const [k, v] of Array.from(this.subtypeMemo.entries())) {
        if (Date.now() - v.at >= CostsService.SUBTYPE_MEMO_TTL_MS) this.subtypeMemo.delete(k);
      }
    }
    return value;
  }

  private async _getMatchingSubtypesForParent(parentAccountId: string) {
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
  async getProviderParentPrograms(
    providerId: string,
    parentAccountId: string,
    specificDonorId?: string,
    specificDonorType?: string,
    showAll: boolean = false,
  ) {
    // Two effects of being on a specific donor / surrogate profile:
    //   1. implicitNeed - the profile-view itself is an explicit signal of
    //      interest in that service type, so the matcher should include it
    //      even when the parent's IP profile is empty. Without this, a parent
    //      who hasn't completed onboarding sees "no matching programs" on
    //      provider profiles whose costs they clearly want to see.
    //   2. specificCompensation - swap the program's generic comp range with
    //      this person's actual comp before totaling. Only fires for
    //      surrogates (baseCompensation) and FRESH egg donors (donorCompensation).
    //      Frozen egg donors and sperm donors are flat-product pricing; the
    //      program's range is preserved for them.
    let specificComp: number | null = null;
    let implicitNeed: string | null = null;
    // For sperm-donor profile views: the donor's vialTypes (["ICI","IUI","IVF"]
    // - any subset) tell the parent which procedures THIS specific donor's
    // vials are sold for. We use them to filter the bank's program list so
    // only relevant programs show up. A donor with vialTypes=["ICI"] should
    // not surface IUI Premium / IVF programs - they're not available for him.
    let spermDonorVialTypes: string[] | null = null;
    if (specificDonorId && specificDonorType) {
      const t = specificDonorType.toLowerCase();
      if (t === "surrogate" || t === "surrogates") {
        implicitNeed = "surrogacy";
        const s = await this.prisma.surrogate.findUnique({
          where: { id: specificDonorId },
          select: { baseCompensation: true },
        });
        if (s?.baseCompensation != null) specificComp = Number(s.baseCompensation);
      } else if (t === "egg-donor" || t === "eggdonor" || t === "egg-donors" || t === "eggdonors") {
        implicitNeed = "egg_donor";
        const d = await this.prisma.eggDonor.findUnique({
          where: { id: specificDonorId },
          select: { donorCompensation: true, donorType: true },
        });
        // Comp override only for FRESH egg donors - frozen lots are sold
        // at a flat price, not per-person comp.
        const isFresh = (d?.donorType ?? "").toLowerCase().includes("fresh");
        if (isFresh && d?.donorCompensation != null) {
          specificComp = Number(d.donorCompensation);
        }
      } else if (t === "sperm-donor" || t === "spermdonor" || t === "sperm-donors" || t === "spermdonors") {
        implicitNeed = "sperm_donor";
        // No comp override - vials are flat-product pricing.
        const sd = await this.prisma.spermDonor.findUnique({
          where: { id: specificDonorId },
          select: { vialTypes: true },
        });
        spermDonorVialTypes = sd?.vialTypes ?? [];
      }
    }
    // STRICT DONOR-PROFILE SCOPE: when standing on a single-product donor
    // profile (egg donor or sperm donor), the cost section must show ONLY that
    // donor's own programs - never the agency's surrogacy / IVF programs. The
    // generic matcher unions implicitNeed onto the logged-in parent's broader
    // needs (so a parent who also wants surrogacy would otherwise see surrogacy
    // programs leak onto an egg-donor profile). strictScopeType forces a pure
    // single-service filter that ignores the parent's other needs and showAll.
    const strictScopeType =
      implicitNeed === "egg_donor" || implicitNeed === "sperm_donor" ? implicitNeed : null;
    // SURROGATE-PROFILE SCOPE: a surrogate profile must only surface programs
    // that actually include the surrogacy leg - never the agency's standalone
    // egg-donation / IVF-only programs, which would otherwise leak in via the
    // logged-in parent's broader needs (egg_donor in parentNeeds matches a
    // pure ["egg_donor"] program). Unlike the donor strict scope this is a
    // "must HAVE surrogacy" filter, not "must be ONLY surrogacy", so combined
    // international packages (surrogacy + egg_donor + ivf) still surface. Only
    // applied on the profile-view path - the combined-cost flow passes its own
    // null scope so it can still gather egg/IVF legs across providers.
    const requireScopeType = implicitNeed === "surrogacy" ? "surrogacy" : null;
    return this._getProviderParentPrograms(providerId, parentAccountId, specificComp, implicitNeed, spermDonorVialTypes, showAll, strictScopeType, requireScopeType);
  }

  /**
   * Marketplace agencies tab: parent-matched starting cost per surrogacy
   * agency, used by both the card's "Starting at $X" line and the Total Cost
   * filter (which needs every agency's price upfront, so a per-card fetch
   * won't do). Returns { [agencyId]: startingCost } - the cheapest matched
   * program minTotal; agencies with no priced program are omitted. Reuses the
   * SAME matcher the card uses, so the numbers are identical.
   */
  async getAgencyStartingCosts(parentAccountId: string): Promise<Record<string, number>> {
    const agencies = await this.prisma.provider.findMany({
      where: { services: { some: { status: "APPROVED", providerType: { name: "Surrogacy Agency" } } } },
      select: { id: true },
    });
    const out: Record<string, number> = {};
    await Promise.all(
      agencies.map(async (a) => {
        try {
          const res = await this.getProviderParentPrograms(a.id, parentAccountId, undefined, undefined, true);
          const programs: any[] = (res as any)?.programs || [];
          const totals = programs
            .map((p) => Number(p.minTotal))
            .filter((n) => Number.isFinite(n) && n > 0);
          if (totals.length) out[a.id] = Math.min(...totals);
        } catch { /* skip - an unpriced agency simply has no starting cost */ }
      }),
    );
    return out;
  }

  /**
   * Marketplace decks: parent-matched programs for MANY providers in one call.
   *
   * Every clinic / doctor / agency card used to fetch its own programs, so a
   * 175-card clinic deck fired 175 requests. They saturated the browser's
   * connection pool and the tail took 13-30s, which then delayed the card data
   * and the parent's next search behind them. This is the batched form: one
   * request for the whole deck.
   *
   * Reuses getProviderParentPrograms per provider - identical numbers to the
   * single-provider endpoint and the parent profile, no second matcher to keep
   * in sync. Providers that throw or have no programs are simply omitted.
   */
  async getParentProgramsForProviders(
    providerIds: string[],
    parentAccountId: string,
  ): Promise<Record<string, { programs: any[] }>> {
    const ids = Array.from(new Set(providerIds.filter(Boolean)));
    const out: Record<string, { programs: any[] }> = {};
    // Bounded concurrency: the matcher issues several queries per provider, so
    // an unbounded Promise.all over a 450-clinic deck would open hundreds of
    // connections at once and starve the rest of the server.
    const CONCURRENCY = 12;
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          const res = await this.getProviderParentPrograms(id, parentAccountId);
          const programs: any[] = (res as any)?.programs || [];
          if (programs.length) out[id] = { programs };
        } catch { /* skip - an unpriced provider simply has no programs */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
    return out;
  }

  /**
   * Combined cost for an international surrogacy program (Part 4).
   *
   * An international program is agency-led: the surrogacy agency plus one or
   * more partner IVF clinics (linked via Provider.partnerProviderIds) deliver
   * the full journey together. When the agency IS the clinic (e.g. a Mexico
   * provider that offers both services under one company), there are no
   * partner ids and a single provider supplies every leg.
   *
   * We sum the parent-matched program total across all providers in the
   * program, picking - per needed service - the cheapest matched program,
   * and treating a combined-package program (one sheet tagged with multiple
   * serviceTypes) as covering all of those services at once so it is never
   * double-counted. All totals come from getProviderParentPrograms (the same
   * matcher the parent profile uses) - no arithmetic is re-implemented here.
   *
   * Returns null if the agency does not exist. components is empty + a
   * missingServices list is returned when no matched programs are priced.
   */
  async getCombinedCountryProgramCost(agencyId: string, parentAccountId: string) {
    const agency = await this.prisma.provider.findUnique({
      where: { id: agencyId },
      select: {
        id: true,
        name: true,
        logoUrl: true,
        partnerProviderIds: true,
        locations: {
          select: { city: true, state: true },
          orderBy: { sortOrder: "asc" as const },
          take: 1,
        },
      },
    });
    if (!agency) return null;

    const partnerIds = Array.isArray(agency.partnerProviderIds)
      ? (agency.partnerProviderIds as string[])
      : [];
    const providerIds = [...new Set([agencyId, ...partnerIds])];

    // Gather every parent-matched program across all providers in the program.
    type Candidate = {
      providerId: string;
      providerName: string;
      programName: string;
      programCountry: string;
      services: string[]; // intersection with the 3 journey services
      minTotal: number;
      maxTotal: number;
      lineItems: any[];
    };
    const JOURNEY_SERVICES = ["surrogacy", "ivf_clinic", "egg_donor"];
    const candidates: Candidate[] = [];
    let isPartialProfile = false;

    for (const pid of providerIds) {
      const prov =
        pid === agencyId
          ? { name: agency.name }
          : await this.prisma.provider.findUnique({ where: { id: pid }, select: { name: true } });
      // implicitNeed = "surrogacy": the parent is actively in the international
      // surrogacy matching flow (they selected this country), so bypass the
      // "complete your profile" gate and surface the program costs - same
      // semantics as standing on a specific surrogate profile.
      const res = await this._getProviderParentPrograms(pid, parentAccountId, null, "surrogacy", null, false, null);
      if (res.isPartialProfile) isPartialProfile = true;
      for (const prog of res.programs) {
        let services = (prog.serviceTypes || []).filter((s: string) => JOURNEY_SERVICES.includes(s));
        // ROLE AWARENESS: when the agency has separate partner clinics (e.g.
        // Colombia: Bioética agency + Inser clinic), the agency supplies the
        // surrogacy leg and the clinic(s) supply the IVF / egg-donor legs.
        // Some clinic programs are over-tagged with "surrogacy" in their
        // serviceTypes; without this constraint the set-cover would let the
        // clinic's combined program stand in for the agency and the real
        // agency fee would be dropped, undercounting the journey. When the
        // agency IS the clinic (no partner ids, e.g. Mexico/Eggspecting), a
        // single provider legitimately supplies every leg - no constraint.
        if (partnerIds.length > 0) {
          if (pid === agencyId) {
            services = services.filter((s) => s === "surrogacy");
          } else {
            services = services.filter((s) => s === "ivf_clinic" || s === "egg_donor");
          }
        }
        if (services.length === 0) continue;
        candidates.push({
          providerId: pid,
          providerName: prov?.name || "",
          programName: prog.programName,
          programCountry: prog.country || "",
          services,
          minTotal: prog.minTotal,
          maxTotal: prog.maxTotal,
          lineItems: prog.lineItems || [],
        });
      }
    }

    // Country label - the cost programs carry the authoritative country
    // ("Colombia", "Mexico"). The agency's location state can be a US state
    // (e.g. a Mexico program run by a provider with a GA mailing address), so
    // prefer the program country and only fall back to location.
    const loc = agency.locations?.[0];
    const country =
      candidates.find((c) => c.programCountry)?.programCountry || loc?.state || loc?.city || "";

    // Needed services = whatever the matcher actually surfaced for this parent
    // (it already filtered to the parent's biology + intent). Always includes
    // whatever showed up; we never invent a service the parent doesn't need.
    const neededServices = new Set<string>();
    for (const c of candidates) c.services.forEach((s) => neededServices.add(s));

    // Greedy set-cover: prefer programs that cover the most still-needed
    // services (so a combined Mexico package wins as one line), breaking ties
    // by lowest min total. Few services (<=3) so greedy is optimal in practice.
    const covered = new Set<string>();
    const chosen: Candidate[] = [];
    const pool = [...candidates];
    while (covered.size < neededServices.size && pool.length > 0) {
      pool.sort((a, b) => {
        const aNew = a.services.filter((s) => !covered.has(s)).length;
        const bNew = b.services.filter((s) => !covered.has(s)).length;
        if (bNew !== aNew) return bNew - aNew;
        return a.minTotal - b.minTotal;
      });
      const pick = pool.shift()!;
      const addsNew = pick.services.some((s) => !covered.has(s));
      if (!addsNew) continue;
      chosen.push(pick);
      pick.services.forEach((s) => covered.add(s));
    }

    const SERVICE_LABEL: Record<string, string> = {
      surrogacy: "Surrogacy",
      ivf_clinic: "IVF",
      egg_donor: "Egg Donor",
    };

    const components = chosen.map((c) => ({
      providerId: c.providerId,
      providerName: c.providerName,
      // Label the services this line covers (e.g. "Surrogacy + IVF" for a
      // combined package, or just "IVF" for a standalone clinic program).
      serviceLabel: c.services.map((s) => SERVICE_LABEL[s] || s).join(" + "),
      services: c.services,
      programName: c.programName,
      minTotal: c.minTotal,
      maxTotal: c.maxTotal,
    }));

    const combinedMinTotal = chosen.reduce((sum, c) => sum + c.minTotal, 0);
    const combinedMaxTotal = chosen.reduce((sum, c) => sum + c.maxTotal, 0);
    const missingServices = JOURNEY_SERVICES.filter(
      (s) => neededServices.has(s) && !covered.has(s),
    );

    return {
      agencyId: agency.id,
      agencyName: agency.name,
      agencyLogo: agency.logoUrl || null,
      country,
      combinedMinTotal,
      combinedMaxTotal,
      components,
      missingServices,
      isPartialProfile,
      hasCost: components.length > 0,
    };
  }

  private async _getProviderParentPrograms(
    providerId: string,
    parentAccountId: string,
    specificCompensation: number | null,
    implicitNeed: string | null,
    spermDonorVialTypes: string[] | null,
    showAll: boolean = false,
    strictScopeType: string | null = null,
    requireScopeType: string | null = null,
  ) {
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

    // The parent's persisted preference about the tailor form overrides
    // the per-request showAll flag. "show_all" means the parent already
    // ticked the skip checkbox on a previous profile and asked us to stop
    // filtering globally. "tailored" means they filled the form and
    // we should run the matcher normally (no auto-skip).
    const persistedPref = (ip as any)?.costProgramsPreference as string | null | undefined;
    if (persistedPref === "show_all") showAll = true;

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
    // interestedServices is the explicit, parent-chosen list from the
    // "Services You're Looking For" chips on the settings page. Map each
    // chip 1:1 onto its serviceType tag so a parent who picked a chip
    // sees that provider type's programs everywhere.
    const interestedSet = new Set((ip?.interestedServices ?? []).map((s: string) => s.toLowerCase()));
    if (interestedSet.has("fertility clinic")) parentNeeds.add("ivf_clinic");
    if (interestedSet.has("surrogate") || interestedSet.has("surrogacy")) parentNeeds.add("surrogacy");
    if (interestedSet.has("egg donor")) parentNeeds.add("egg_donor");
    if (interestedSet.has("sperm donor")) parentNeeds.add("sperm_donor");
    // Standing on a specific donor / surrogate profile IS an explicit
    // signal of interest in that service type. Surface the provider's
    // matching programs even when the parent's chips don't include it -
    // the parent navigated here to learn more about THIS person, so
    // they care about the cost path to acquire her / him. Without this,
    // a sperm-only parent who clicks through to a surrogate from a 3-way
    // chat (or marketplace nav) sees an empty cost section even though
    // the agency has a published surrogacy program. The vialTypes filter
    // and comp-override paths continue to narrow / personalize the result
    // for sperm-donor and surrogate / fresh-egg-donor profiles.
    if (implicitNeed) parentNeeds.add(implicitNeed);

    // Profile is "partial" when we don't know ANY of the relevant tags.
    // The client gates the grid behind "Complete your profile" CTA.
    // interestedServices counts as "knowing" - a parent who picked chips
    // has declared their interest even if they haven't finished biological
    // baseline yet. A specific-donor view also counts - the parent is
    // literally pointing at a profile of that type.
    const hasInterested = (ip?.interestedServices ?? []).length > 0;
    const knowsSurrogacy = ip?.needsSurrogate != null || ip?.carrier != null || hasInterested;
    const knowsEggDonor = ip?.needsEggDonor != null || ip?.eggSource != null || hasInterested;
    const knowsSpermDonor = ip?.spermSource != null || primary?.gender != null || hasInterested;
    const resolvedIsPartialProfile = !implicitNeed && !showAll && (isPartialProfile ||
      (!knowsSurrogacy && !knowsEggDonor && !knowsSpermDonor && subtypes.length === 0));

    if (resolvedIsPartialProfile) {
      return { programs: [], matchingSubtypes: subtypes, isPartialProfile: true, costProgramsPreference: persistedPref ?? null };
    }

    // showAll bypasses the parent-needs intersection - we surface every
    // approved program this provider has so the parent can browse without
    // first completing onboarding. Donor-specific narrowing (vialTypes,
    // comp override) still applies downstream.
    if (!showAll && parentNeeds.size === 0) {
      return { programs: [], matchingSubtypes: subtypes, isPartialProfile: false, costProgramsPreference: persistedPref ?? null };
    }

    const parentNeedsArr = Array.from(parentNeeds);

    // Match programs by serviceTypes intersection with parent needs. Each
    // program holds 1+ tags (e.g. ["surrogacy"] or ["surrogacy", "egg_donor"]
    // for a combined package). Postgres `hasSome` returns true when ANY tag
    // overlaps. IVF-tagged programs additionally filter by the biology-driven
    // subtype list so we don't show "own eggs" programs to donor-eggs parents.
    const activeProviderTypeIdsArr = Array.from(activeProviderTypeIds) as string[];
    // serviceTypes filter:
    //  - strictScopeType (egg/sperm donor profile): show ONLY programs that are
    //    purely that donor's service. The program must carry the scope tag AND
    //    carry none of the other journey services - a program tagged
    //    ["surrogacy","egg_donor","ivf_clinic"] is a combined package and must
    //    not leak onto a single egg-donor profile. This overrides showAll and
    //    the parent-needs union by design.
    //  - requireScopeType (surrogate profile): show only programs that carry the
    //    scope tag, but DO allow combined packages that also carry other tags -
    //    a ["surrogacy","egg_donor","ivf_clinic"] international package belongs
    //    on a surrogate profile, a pure ["egg_donor"] program does not. Like the
    //    strict scope this overrides showAll and the parent-needs union.
    //  - showAll: skip the intersection entirely (parent opted to browse all).
    //  - default: intersect with the parent's needs (hasSome).
    const ALL_JOURNEY_SERVICE_TYPES = ["surrogacy", "egg_donor", "ivf_clinic", "sperm_donor"];
    const serviceTypeFilter = strictScopeType
      ? {
          serviceTypes: { has: strictScopeType },
          NOT: { serviceTypes: { hasSome: ALL_JOURNEY_SERVICE_TYPES.filter((t) => t !== strictScopeType) } },
        }
      : requireScopeType
        ? { serviceTypes: { has: requireScopeType } }
        : showAll
          ? {}
          : { serviceTypes: { hasSome: parentNeedsArr } };
    const programs = await this.prisma.costProgram.findMany({
      where: {
        providerId,
        ...serviceTypeFilter,
        costSheets: { some: { status: "APPROVED" } },
        // Two independent filters combined via AND so they don't fight the
        // top-level OR each other would otherwise overwrite.
        AND: [
          {
            // providerTypeId pins the program to a specific approved service.
            // Programs created through upload-first sometimes land with null
            // (the wizard ties to a program, not a service row), so accept
            // null as "not tied to a specific service" - the program's
            // serviceTypes tag is the authoritative signal for those rows.
            // Without this branch, every upload-first program with
            // providerTypeId=null was silently filtered out by Prisma's
            // `in` operator (which never matches null).
            OR: [
              { providerTypeId: null },
              { providerTypeId: { in: activeProviderTypeIdsArr } },
            ],
          },
          {
            // Match on the canonical subTypes[] coverage array - the single
            // source of truth. The legacy scalar `subType` is unreliable: it
            // can hold a stale value from an earlier classification (e.g. a
            // ship-embryos-to-surrogate program left with
            // "ivf_cycle_own_eggs_own_carry"), which silently HID the correct
            // program and SURFACED the wrong one whose stale scalar happened to
            // overlap the parent's list. Scope the constraint to IVF-tagged
            // programs only - non-IVF programs always pass (their IVF taxonomy
            // is irrelevant).
            OR: [
              // Non-IVF program: doesn't carry the ivf_clinic tag in serviceTypes.
              { NOT: { serviceTypes: { has: "ivf_clinic" } } },
              // IVF program not yet classified into any canonical subtype.
              { subTypes: { isEmpty: true } },
              // IVF program whose coverage overlaps the parent's eligible
              // biology-driven subtypes.
              ...(subtypes.length > 0 ? [{ subTypes: { hasSome: subtypes } }] : []),
            ],
          },
        ],
      },
      include: {
        costSheets: {
          where: { status: "APPROVED", parentClientId: null },
          orderBy: { updatedAt: "desc" },
          take: 1,
          include: {
            items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] },
            // Payment schedule. Loaded here so the card can render it without
            // an extra round trip; gated below on the provider having
            // confirmed it, so an unreviewed AI parse never reaches a parent.
            tranches: {
              orderBy: { sortOrder: "asc" },
              include: {
                itemPayments: {
                  orderBy: { sortOrder: "asc" },
                  include: { costItem: { select: { key: true, category: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Journey-aware tightening for IVF-tagged programs. The DB hasSome above
    // matches when ANY leaf overlaps, which lets a clinic cycle bundle ride
    // in on a supplementary agency leaf (e.g. "IVF Surrogacy - Single Cycle"
    // tagged [ivf_cycle_own_eggs_surrogate_carry, surrogacy] reaching a
    // parent with frozen embryos just because their carrier is a surrogate).
    // Require the overlap on the program's clinic leaves when it has any.
    // Scope views (standing on a specific donor / surrogate profile) skip
    // this by design - the inquiry wins over the parent's own profile.
    const journeyPrograms = (strictScopeType || requireScopeType || subtypes.length === 0)
      ? programs
      : programs.filter((p: any) => {
          if (!(p.serviceTypes || []).includes("ivf_clinic")) return true;
          if (!p.subTypes || p.subTypes.length === 0) return true;
          return sheetMatchesParentJourney(p.subTypes, subtypes);
        });

    // Vial-type narrowing for sperm-donor profile views. The donor's
    // vialTypes field tells us which procedures THIS donor's vials are
    // sold for (e.g. ["ICI"] - ICI only, not IUI/IVF). Filter the bank's
    // program list down to programs that target one of those vial types.
    // Match on a word-boundary token in the program name so "ICI" doesn't
    // pick up "IUI" or any other false positive. When the donor has no
    // vialTypes set (data gap), don't filter - show everything rather
    // than nothing. Same when there's no specific donor in scope (provider
    // profile view).
    const filteredPrograms = (() => {
      if (!spermDonorVialTypes || spermDonorVialTypes.length === 0) return journeyPrograms;
      const tokens = spermDonorVialTypes
        .map((v) => (v || "").trim().toUpperCase())
        .filter(Boolean);
      if (tokens.length === 0) return journeyPrograms;
      const re = new RegExp(`\\b(${tokens.join("|")})\\b`, "i");
      return journeyPrograms.filter((p) => re.test(p.name));
    })();

    const COUNTED_ONLY_KEYS = new Set([
      "Number of Egg Retrievals Included",
      "Number of Sperm Collections Included",
      "Number of Transfers Included",
    ]);

    // For each matching program, emit one card per pricing tier when tiers
    // exist (so 1 cycle / 2 cycles / 3 cycles / unlimited become 4 separate
    // parent-facing cards under the same program). When no tiers exist,
    // emit a single card as before.
    // True when an item is the donor's / surrogate's compensation line that
    // we want to override with the specific person's actual comp. Match on
    // category=Compensation OR a key containing "compensation" - covers
    // "Surrogate Compensation", "Donor Compensation", "Egg Donor Compensation",
    // etc., without false-positiving on lines like "Health Insurance".
    const isCompensationKey = (item: { category: string; key: string }) => {
      const cat = (item.category || "").toLowerCase();
      const key = (item.key || "").toLowerCase();
      return cat === "compensation" || key.includes("compensation");
    };

    const result = filteredPrograms
      .filter((p) => p.costSheets.length > 0)
      .flatMap((p) => {
        const sheet = p.costSheets[0];
        const tierItems = sheet.items.filter((i: any) => i.isTier === true);
        const baselineItems = sheet.items.filter((i: any) => i.isTier !== true);

        // Sum the non-tier (baseline) items - common to every tier card.
        // When a specific donor / surrogate is in scope and the line is the
        // compensation row, swap in that person's actual comp so the total
        // narrows to "what THIS person would actually cost the parent",
        // instead of the program's published range.
        let baseMin = 0;
        let baseMax = 0;
        for (const item of baselineItems) {
          if (!item.isIncluded) continue;
          const baseKey = item.key.replace(/\s*\((?:Standard|Variant \d+)\)$/, "");
          if (COUNTED_ONLY_KEYS.has(baseKey)) continue;
          if (specificCompensation != null && isCompensationKey(item)) {
            baseMin += specificCompensation;
            baseMax += specificCompensation;
            continue;
          }
          const min = item.minValue ?? 0;
          const max = item.maxValue ?? min;
          baseMin += min;
          baseMax += max === 0 && min > 0 ? min : max;
        }

        // Derive the subtitle from the canonical subTypes[] (the scalar subType
        // can be stale and mislabels the program - e.g. a ship-embryos program
        // showing "Own eggs, own/self carry").
        const displaySubType = pickDisplaySubType(p.subTypes, p.subType);
        const programMeta = {
          programId: p.id,
          country: p.country,
          tab: p.tab,
          subType: displaySubType,
          subTypeLabel: displaySubType ? SUBTYPE_LABEL[displaySubType] : null,
          tabLabel: p.tab && isValidTab(p.tab) ? TAB_LABEL[p.tab as Tab] : null,
          isFixedCost: sheet.isFixedCost,
          updatedAt: sheet.updatedAt,
          serviceTypes: Array.isArray(p.serviceTypes) ? p.serviceTypes : [],
          // Installment plan, only once the provider has confirmed or
          // authored it. Payment terms are higher-stakes than a subtype
          // label, so an unreviewed parse stays provider-only.
          paymentSchedule: buildParentPaymentSchedule(sheet),
        };

        // Render the compensation row at the donor's / surrogate's actual
        // comp on cards displayed inside that person's profile. The original
        // min/max are preserved everywhere else (provider profile, no
        // specificDonorId).
        const mapLineItem = (i: any) => {
          if (specificCompensation != null && isCompensationKey(i)) {
            return {
              category: i.category,
              key: i.key,
              minValue: specificCompensation,
              maxValue: specificCompensation,
              isIncluded: i.isIncluded,
              comment: i.comment,
            };
          }
          return {
            category: i.category,
            key: i.key,
            minValue: i.minValue,
            maxValue: i.maxValue,
            isIncluded: i.isIncluded,
            comment: i.comment,
          };
        };

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
            programName: programDisplayName(p.name, tier.key, tierItems.length),
            tierLabel: tier.key,
            minTotal: baseMin + tierMin,
            maxTotal: baseMax + (tierMax === 0 && tierMin > 0 ? tierMin : tierMax),
            lineItems: cardLineItems,
          };
        });
      });

    return { programs: result, matchingSubtypes: subtypes, isPartialProfile: resolvedIsPartialProfile, costProgramsPreference: persistedPref ?? null };
  }

  /**
   * Pick up cost sheets that were mid-parse when the server died (status
   * still PARSING, parseProgress < 100). Downloads the original PDF/XLSX
   * back from GCS and re-runs runBackgroundParse so the work completes
   * automatically without the provider re-uploading. The client poll
   * watching parseProgress on the row picks up the new updates seamlessly.
   *
   * Sheets whose file is missing (deleted from GCS, or the upload itself
   * never finished writing) get a soft fail: status flips to DRAFT and
   * parseStage records why. They show up in the UI as an empty template
   * the provider can either delete or re-upload, instead of staying stuck
   * spinning forever.
   *
   * Called from CostsModule.onModuleInit on every server boot.
   */
  async resumeOrphanedParsingSheets() {
    const orphans = await this.prisma.providerCostSheet.findMany({
      where: { status: "PARSING" },
      select: {
        id: true,
        providerId: true,
        providerTypeId: true,
        subType: true,
        filePath: true,
        originalFileName: true,
      },
    });
    if (orphans.length === 0) return;

    this.logger.warn(`Found ${orphans.length} orphaned PARSING sheet(s) on startup; resuming...`);

    for (const sheet of orphans) {
      try {
        if (!sheet.filePath || !sheet.originalFileName) {
          this.logger.warn(`Sheet ${sheet.id} has no stored file - cannot resume; marking as DRAFT`);
          await this.markParseError(sheet.id);
          continue;
        }

        let downloaded: { buffer: Buffer; contentType: string };
        try {
          downloaded = await this.storage.downloadBuffer(sheet.filePath);
        } catch (err: any) {
          this.logger.warn(`Sheet ${sheet.id} GCS download failed (${err.message}); marking as DRAFT`);
          await this.markParseError(sheet.id);
          continue;
        }

        // Derive providerType the same way the upload endpoint does:
        // single-service providers use the ProviderType.name verbatim,
        // multi-service providers (e.g. Eggspecting: IVF Clinic + Surrogacy
        // + Egg Donor) get the "multi-service" union branch so the AI
        // doesn't force-classify a surrogacy PDF into an IVF subtype.
        const activeServices = await this.prisma.providerService.findMany({
          where: { providerId: sheet.providerId, status: "APPROVED" },
          select: { providerType: { select: { name: true } } },
        });
        const activeServiceCount = activeServices.length;
        const approvedTypeNames = activeServices.map((sv) => sv.providerType?.name).filter(Boolean) as string[];
        let providerType: string | null = "multi-service";
        if (activeServiceCount <= 1 && sheet.providerTypeId) {
          const pt = await this.prisma.providerType.findUnique({
            where: { id: sheet.providerTypeId },
            select: { name: true },
          });
          providerType = pt?.name ?? "multi-service";
        }

        // Reset the visible progress so the user's poll sees activity
        // immediately ("Resuming parse..." -> the normal stages from there).
        await this.updateParseProgress(sheet.id, "Resuming parse after server restart", 8, 0);

        this.runBackgroundParse(
          sheet.id,
          downloaded.buffer,
          downloaded.contentType,
          providerType,
          sheet.originalFileName,
          sheet.subType || undefined,
          false,
          approvedTypeNames,
        );
      } catch (err: any) {
        this.logger.error(`Failed to resume sheet ${sheet.id}: ${err.message}`);
        await this.markParseError(sheet.id).catch(() => {});
      }
    }
  }

  /**
   * Delete a sheet's GCS blob ONLY when no other sheet row references the
   * same filePath. Program-split sheets share one uploaded file - deleting
   * one split must not break its siblings' stored document.
   */
  private async deleteObjectIfUnreferenced(filePath: string, excludeSheetId: string) {
    const stillReferenced = await this.prisma.providerCostSheet.count({
      where: { filePath, id: { not: excludeSheetId } },
    });
    if (stillReferenced > 0) {
      this.logger.log(`[program-split] Keeping shared blob ${filePath} (${stillReferenced} sibling sheet(s) reference it)`);
      return;
    }
    await this.storage.deleteObject(filePath);
  }

  async cancelUpload(sheetId: string) {
    const sheet = await this.prisma.providerCostSheet.findUnique({
      where: { id: sheetId },
    });
    if (!sheet) throw new Error("Sheet not found");

    if (sheet.filePath) {
      try { await this.deleteObjectIfUnreferenced(sheet.filePath, sheetId); } catch {}
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
      await this.deleteObjectIfUnreferenced(sheet.filePath, sheetId);
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
        try { await this.deleteObjectIfUnreferenced(sheet.filePath, sheet.id); } catch {}
      }
      await this.prisma.costItem.deleteMany({ where: { providerCostSheetId: sheet.id } });
    }

    await this.prisma.providerCostSheet.deleteMany({ where });

    // When scoped to a single program, also reset the program row back to
    // its placeholder state - name + country + tab + subType. Without this,
    // the program keeps the AI-classified label from the deleted upload and
    // the next upload looks confused (old name on a freshly-parsed sheet).
    // The reset country mirrors the upload-time default (derived from the
    // provider's Locations) so a Colombia / Mexico / etc. provider doesn't
    // get bounced back to a US placeholder mid-flow.
    if (programId) {
      const program = await this.prisma.costProgram.findUnique({
        where: { id: programId },
        select: { providerId: true },
      });
      const resetCountry = program
        ? await this.deriveDefaultCountryFromLocations(program.providerId)
        : "United States";
      await this.prisma.costProgram.update({
        where: { id: programId },
        data: {
          name: "Untitled",
          country: resetCountry,
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
      // Creating a fresh sheet because the prior one is APPROVED/ARCHIVED.
      // Carry over the classification (isFixedCost, tab, subType, subTypes)
      // from the most recent prior sheet so a re-submit (e.g. admin clicks
      // Save twice in a row) doesn't wipe a manually-set Fixed-Cost / tag.
      // Without this, /submit on an APPROVED sheet creates a phantom row
      // with all defaults (isFixedCost=null), and approveSheet then stamps
      // that phantom APPROVED - the user's previously-saved classification
      // disappears from the UI.
      const prior = programId
        ? await this.prisma.providerCostSheet.findFirst({
            where: { providerId, programId, parentClientId: null },
            orderBy: { version: "desc" },
          })
        : null;
      sheet = await this.prisma.providerCostSheet.create({
        data: {
          providerId,
          providerTypeId: providerTypeId || prior?.providerTypeId || null,
          subType: subType || prior?.subType || null,
          tab: prior?.tab || null,
          subTypes: prior?.subTypes || [],
          isFixedCost: prior?.isFixedCost ?? null,
          // The uploaded source document belongs to the program, not the
          // version row - carry it forward so re-saving items on an APPROVED
          // sheet doesn't orphan the PDF on the archived version.
          filePath: prior?.filePath || null,
          fileUrl: prior?.fileUrl || null,
          originalFileName: prior?.originalFileName || null,
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
      recurrence?: any;
    }>,
  ) {
    const sheet = await this.prisma.providerCostSheet.findUnique({ where: { id: sheetId } });
    if (sheet && (sheet.status === "APPROVED" || sheet.status === "ARCHIVED")) {
      throw new Error(`Cannot modify a cost sheet with status ${sheet.status}`);
    }

    // This method rewrites items by delete + recreate, which cascade-deletes
    // their CostItemPayment rows. Snapshot the payment-schedule assignments
    // first (keyed by category::key, the only identity that survives a
    // rewrite) and restore them afterwards - otherwise every routine line-item
    // edit would silently empty the provider's installment plan.
    const priorAssignments = await this.prisma.costItemPayment.findMany({
      where: { costItem: { providerCostSheetId: sheetId } },
      include: { costItem: { select: { category: true, key: true } } },
    });
    const assignmentsByItemKey = new Map<string, typeof priorAssignments>();
    for (const a of priorAssignments) {
      const k = `${a.costItem.category}::${a.costItem.key}`;
      const list = assignmentsByItemKey.get(k) ?? [];
      list.push(a);
      assignmentsByItemKey.set(k, list);
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
          recurrence: item.recurrence ?? undefined,
        })),
      });
    }

    // Re-link surviving items to their tranches. Items the provider renamed
    // or removed simply don't match and their assignment is dropped, which
    // is the correct outcome - the tranche keeps its own stated amount.
    if (assignmentsByItemKey.size > 0) {
      const newItems = await this.prisma.costItem.findMany({
        where: { providerCostSheetId: sheetId },
        select: { id: true, category: true, key: true },
      });
      const restore: any[] = [];
      for (const ni of newItems) {
        const prior = assignmentsByItemKey.get(`${ni.category}::${ni.key}`);
        if (!prior) continue;
        for (const a of prior) {
          restore.push({
            costItemId: ni.id,
            trancheId: a.trancheId,
            minValueCents: a.minValueCents,
            maxValueCents: a.maxValueCents,
            percent: a.percent,
            label: a.label,
            sortOrder: a.sortOrder,
          });
        }
      }
      if (restore.length > 0) {
        // skipDuplicates guards the (costItemId, trancheId) unique index in
        // the rare case a rewrite collapses two items onto one key.
        await this.prisma.costItemPayment.createMany({ data: restore, skipDuplicates: true });
      }
      const lost = priorAssignments.length - restore.length;
      if (lost > 0) {
        this.logger.log(
          `updateSheetItems(${sheetId}): ${lost} payment-schedule assignment(s) dropped - their line items were renamed or removed`,
        );
      }
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
    if (programs.length === 0) {
      return programs.map((p: any) => ({ ...p, latestSheetStatus: null, latestSheetItems: [] }));
    }
    const programIds = programs.map((p) => p.id);
    // Pull every master sheet (parentClientId=null) for these programs, plus
    // their items. We pick the latest per program below. Items shipped down
    // here so the ProgramTotalBadge can derive totals without firing its own
    // queries (which caused stale-cache and race-condition bugs after a
    // fresh upload+parse - the badge stayed empty while the editor below
    // showed the correct Estimated Total).
    const latestSheets = await this.prisma.providerCostSheet.findMany({
      where: { programId: { in: programIds }, parentClientId: null },
      orderBy: { createdAt: "desc" },
      include: { items: { orderBy: [{ category: "asc" }, { sortOrder: "asc" }] } },
    });
    const statusByProgram = new Map<string, string>();
    const itemsByProgram = new Map<string, any[]>();
    // Phase: the consolidated top-bar UI needs the latest sheet's id +
    // isFixedCost so it can render the Fixed/Not Fixed toggle inline.
    // Ship it down here so the client doesn't have to fire a second query.
    const latestSheetByProgram = new Map<string, any>();
    for (const s of latestSheets) {
      if (s.programId && !statusByProgram.has(s.programId)) {
        statusByProgram.set(s.programId, s.status);
        itemsByProgram.set(s.programId, s.items);
        latestSheetByProgram.set(s.programId, {
          id: s.id,
          isFixedCost: s.isFixedCost,
          status: s.status,
        });
      }
    }
    return programs.map((p) => ({
      ...p,
      latestSheetStatus: statusByProgram.get(p.id) ?? null,
      latestSheetItems: itemsByProgram.get(p.id) ?? [],
      latestSheet: latestSheetByProgram.get(p.id) ?? null,
    }));
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
  async updateProgram(
    programId: string,
    name: string,
    country: string,
    subType?: string,
    tab?: string,
    serviceTypes?: string[],
    subTypes?: string[],
  ) {
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
    // Canonical multi-leaf write path. Validate every leaf against the full
    // SubType union (14 IVF + 4 non-IVF), drop unknowns, dedupe. Mirror to
    // legacy subType (= first leaf or null) and to serviceTypes[] (derived
    // from each leaf's parent service tag).
    if (subTypes !== undefined) {
      const { ALL_SUBTYPES, SERVICE_TAG_OF_NON_IVF_LEAF, NON_IVF_LEAVES } = await import(
        "./cost-templates-config"
      );
      const validLeaves: string[] = Array.from(new Set(
        (Array.isArray(subTypes) ? subTypes : [])
          .map((t: any) => String(t).trim())
          .filter((t: string) => (ALL_SUBTYPES as string[]).includes(t)),
      ));
      data.subTypes = validLeaves;
      // Mirror to legacy single subType.
      data.subType = validLeaves[0] ?? null;
      // Mirror to legacy serviceTypes if not explicitly provided in the same
      // call. Each non-IVF leaf maps to one service tag; IVF leaves all map
      // to ivf_clinic.
      if (serviceTypes === undefined) {
        const tags = new Set<string>();
        for (const leaf of validLeaves) {
          if ((NON_IVF_LEAVES as readonly string[]).includes(leaf)) {
            const tag = (SERVICE_TAG_OF_NON_IVF_LEAF as Record<string, string>)[leaf];
            if (tag) tags.add(tag);
          } else {
            // IVF leaf
            tags.add("ivf_clinic");
          }
        }
        data.serviceTypes = Array.from(tags);
      }
    }
    const updated = await this.prisma.costProgram.update({
      where: { id: programId },
      data,
    });
    // Mirror canonical fields to the latest master cost sheet so legacy
    // readers (matcher fallback, AI prompts) see the same picture.
    if (subType !== undefined || tab !== undefined || subTypes !== undefined) {
      const latest = await this.prisma.providerCostSheet.findFirst({
        where: { programId, parentClientId: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (latest) {
        const sheetData: any = {};
        if (subType !== undefined) sheetData.subType = subType;
        if (tab !== undefined) sheetData.tab = tab;
        if (subTypes !== undefined) {
          sheetData.subTypes = data.subTypes;
          // Also mirror the picked legacy subType back to the sheet so the
          // existing matcher fallback still works pre-migration.
          if (data.subType !== undefined) sheetData.subType = data.subType;
        }
        if (Object.keys(sheetData).length > 0) {
          await this.prisma.providerCostSheet.update({ where: { id: latest.id }, data: sheetData });
        }
      }
    }
    return updated;
  }

  async deleteProgram(programId: string) {
    const sheets = await this.prisma.providerCostSheet.findMany({ where: { programId } });
    for (const sheet of sheets) {
      if (sheet.filePath) {
        try { await this.deleteObjectIfUnreferenced(sheet.filePath, sheet.id); } catch {}
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
