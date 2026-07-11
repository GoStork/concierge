import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  ALL_SUBTYPES,
  RETRIEVALS_INCLUDED,
  SPERM_COLLECTIONS_INCLUDED,
  SubType,
  SUBTYPE_LABEL,
  Tab,
  TAB_LABEL,
  TAB_OF,
  TRANSFERS_INCLUDED,
} from "./cost-templates-config";

export interface ClassificationResult {
  tab: Tab;
  subType: SubType;
  isFixedCost: boolean;
  confidence: number; // 0-1
  reasoning: string;
  // Program-level proposals that the classifier extracts from the document
  // so the clinic doesn't have to type them by hand. Always populated -
  // country defaults to "United States" when nothing in the doc indicates
  // otherwise, and programName falls back to a sensible label.
  programName: string;
  country: string;
  // 1+ service-type tags ("ivf_clinic", "surrogacy", "egg_donor",
  // "sperm_donor"). A bundled cost sheet (e.g. egg-donor + surrogate
  // package) gets multiple tags; parent matcher unions them.
  serviceTypes: string[];
  // Egg-donor fresh/frozen flavor when "egg_donor" is in serviceTypes -
  // populated for BOTH pure egg-donor sheets (where it duplicates subType)
  // AND mixed sheets like "IVF + Egg Donation" where the primary subType
  // is the IVF leaf (e.g. ivf_cycle_donor_eggs_surrogate_carry) but the
  // donor route is still fresh vs frozen. Without this, mixed sheets fall
  // back to "subtypes carries BOTH egg_donor_fresh and egg_donor_frozen"
  // and the matcher can't distinguish a Fresh-donor program from a
  // Frozen-lot one for filter purposes.
  eggDonorSubType?: "fresh" | "frozen";
  // Optional multi-program split for a-la-carte fee schedules that span
  // several parent journeys (law firms, wellness menus). Each split becomes
  // its own CostProgram; itemKeys reference "<category>::<key>" of the
  // emitted items. Absent for normal single-program sheets.
  programSplits?: { programName: string; serviceTypes: string[]; itemKeys: string[] }[];
}

@Injectable()
export class CostsAiService {
  private readonly logger = new Logger(CostsAiService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async parseFile(
    fileBuffer: Buffer,
    contentType: string,
    providerTypeName: string,
    originalFileName: string,
    subType?: string,
  ): Promise<
    Array<{
      category: string;
      key: string;
      minValue: number | null;
      maxValue: number | null;
      isCustom: boolean;
      isIncluded: boolean;
      isTier: boolean;
      comment: string | null;
    }>
  > {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    // Multi-service providers have no ProviderType row of their own - load
    // the union of their approved types' templates so mapping/consolidation
    // guidance survives the multi-service prompt branch.
    const typeNamesForTemplates =
      providerTypeName.toLowerCase() === "multi-service" && approvedTypeNames && approvedTypeNames.length > 0
        ? approvedTypeNames
        : [providerTypeName];
    const providerTypes = await this.prisma.providerType.findMany({
      where: { OR: typeNamesForTemplates.map((n) => ({ name: { contains: n, mode: "insensitive" as const } })) },
    });
    const templateWhere: any = providerTypes.length > 0 ? { providerTypeId: { in: providerTypes.map((t) => t.id) } } : null;
    if (templateWhere && subType) {
      templateWhere.OR = [{ subType: null }, { subType }];
    }
    const templates = templateWhere
      ? await this.prisma.costTemplate.findMany({
          where: templateWhere,
          orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
        })
      : [];

    const templateContext =
      templates.length > 0
        ? `Known cost categories and fields for this provider type:\n${templates
            .map(
              (t) =>
                `- Category: "${t.category}", Field: "${t.fieldName}" (mandatory: ${t.isMandatory}, compensation: ${t.isBaseCompensation})`,
            )
            .join("\n")}`
        : "No predefined templates available. Categorize based on common fertility industry categories.";

    const isEggDonation = providerTypeName.toLowerCase().includes("egg");

    const exclusionRules = isEggDonation
      ? `
IMPORTANT EXCLUSIONS for Egg Donation cost sheets:
- Do NOT include any items related to: Donor medical screening, IVF expenses, Donor medication, PGT/PGS, embryo genetic testing, IVF cycle costs, embryo transfer, cryopreservation, or any clinic/IVF-related procedures.
- These belong to the IVF clinic cost sheet, NOT the egg donation agency cost sheet.
- Only include costs that the egg donation AGENCY charges (agency fees, donor compensation, donor screening, travel, insurance, legal, escrow).`
      : "";

    const ivfSynonymHint = (!isEggDonation && subType === "ivf_cycle") ? `
IVF FIELD MAPPING SYNONYMS - use these to map common terminology to the exact template field names:
- "Consultation" = initial consultation, evaluation, fertility consultation, new patient visit, consultation fee, workup fee
- "IVF Cycle" = IVF fee, cycle fee, IVF package, embryo creation, stimulation cycle, retrieval + fertilization, monitoring + retrieval, base IVF
- "Medication" = medications, drugs, injectable medications, stimulation medications, fertility medications, Follistim, Gonal-F, Lupron, Menopur, Progesterone
- "Embryo Transfer" = ET fee, embryo transfer procedure, frozen embryo transfer (FET), fresh embryo transfer, transfer fee
- "Cryopreservation" = embryo freezing, freeze fee, cryo fee, embryo storage, vitrification
- "Lab Fees" = laboratory fees, andrology fees, ICSI, fertilization fee, sperm washing
- "Genetic Testing (PGT)" = PGT, PGS, PGT-A, genetic screening, biopsy fee, NGS testing
- "Monitoring" = monitoring visits, ultrasound monitoring, blood work, cycle monitoring, local monitoring` : "";

    const systemPrompt = `You are a fertility industry cost sheet parser. Extract cost line items from the provided document.

${templateContext}
${exclusionRules}
${ivfSynonymHint}

Rules:
1. Map recognized items to the known categories/fields above when possible. Use the EXACT category and key names from the template.
2. For range values like "$5,000 - $10,000", extract minValue=5000, maxValue=10000.
3. For single values like "$5,000", set both minValue=5000 and maxValue=5000.
4. Items not matching any known template field should have isCustom=true.
5. Bundled/included items (no additional cost) should have isIncluded=true, minValue=0, maxValue=0.
6. BY DEFAULT, all extracted items should have isIncluded=true. Most items in a cost sheet are standard fees that should be included in the total.
6b. The ONLY items that should have isIncluded=false are those that appear under an explicitly labeled optional/contingency section in the document (e.g. a section titled "Other possible expenses", "Additional/optional costs", "Contingency fees"). These are costs that only apply in certain circumstances (e.g. C-section, multiple birth, complications). Regular line items with variable amounts (like "varies depending on location") are NOT optional - they are standard costs and should have isIncluded=true.
7. Any notes or conditions should go in the comment field.
8. Output items in the same order as the template fields listed above.
9. CONSOLIDATION RULE: If the document lists multiple line items that map to the SAME template field, you MUST consolidate (sum) them into a single output item. Common examples:
   - Multiple agency fees (e.g. "1st agency fee $25,000" + "2nd agency fee $20,000") → single "Agency Fees" with minValue=45000, maxValue=45000. List the breakdown in the comment field (e.g. "1st agency fee $25,000 + 2nd agency fee $20,000").
   - Multiple travel expenses (e.g. "Travel for screening $3,500" + "Travel for transfer $4,000") → single "Travel Expenses" with minValue=7500, maxValue=7500. List the breakdown in the comment.
   - Multiple legal fees for the same party → consolidate similarly.
   - Multiple compensation installments (e.g. "50% base $25,000" + "50% base $25,000") → single "Surrogate Compensation" with the total.
   This applies to ALL template fields: never output two items with the same key. Always sum the values and document the breakdown in the comment.

Return ONLY a valid JSON array with objects having these exact fields:
{ "category": string, "key": string, "minValue": number|null, "maxValue": number|null, "isCustom": boolean, "isIncluded": boolean, "comment": string|null }`;

    let textContent: string;

    if (
      contentType.includes("spreadsheet") ||
      contentType.includes("excel") ||
      originalFileName.match(/\.xlsx?$/i)
    ) {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer);
      const csvParts: string[] = [];
      workbook.eachSheet((worksheet) => {
        const rows: string[] = [];
        worksheet.eachRow({ includeEmpty: false }, (row) => {
          const values = (row.values as (string | number | null | undefined)[]).slice(1);
          const csvRow = values
            .map((v) => {
              const s = v != null ? String(v) : "";
              return s.includes(",") || s.includes('"') || s.includes("\n")
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(",");
          rows.push(csvRow);
        });
        csvParts.push(`--- Sheet: ${worksheet.name} ---\n${rows.join("\n")}`);
      });
      textContent = csvParts.join("\n\n");

      const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash",
        generationConfig: {
          temperature: 0,
          // 32k headroom: a 30-item cost sheet with descriptions + comments
          // can run 8-10k tokens for the items alone before we even get to
          // the classification block. The previous 8192 ceiling was being
          // hit mid-response - the items array survived (it's first in the
          // JSON output) but the classification object got truncated off
          // the end, which is why subType / isFixedCost / serviceTypes /
          // programName / country were all coming back empty on long sheets.
          // Gemini 2.0+ Flash supports up to 32768 output tokens, so we
          // give it the full budget.
          maxOutputTokens: 32768,
          // JSON mode: Gemini's decoder is supposed to mask every next-
          // token candidate against the JSON grammar at inference time so
          // it can't emit syntactically broken output. In practice we still
          // see occasional broken JSON (see the server log "strict JSON.
          // parse failed; jsonrepair recovered" warnings), so jsonrepair
          // stays as a middle fallback. JSON mode does still help by
          // increasing the rate at which strict parse succeeds and by
          // discouraging the model from veering into prose.
          responseMimeType: "application/json",
        } as any,
      });

      const timeoutMs = 120000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI parsing timed out after 2 minutes")), timeoutMs),
      );
      const result = await Promise.race([
        model.generateContent(`${systemPrompt}\n\nDocument content (CSV):\n${textContent}`),
        timeoutPromise,
      ]);
      const responseText = result.response.text();
      return this.parseJsonResponse(responseText);
    } else {
      const base64Data = fileBuffer.toString("base64");

      const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash",
        generationConfig: {
          temperature: 0,
          // 32k headroom: a 30-item cost sheet with descriptions + comments
          // can run 8-10k tokens for the items alone before we even get to
          // the classification block. The previous 8192 ceiling was being
          // hit mid-response - the items array survived (it's first in the
          // JSON output) but the classification object got truncated off
          // the end, which is why subType / isFixedCost / serviceTypes /
          // programName / country were all coming back empty on long sheets.
          // Gemini 2.0+ Flash supports up to 32768 output tokens, so we
          // give it the full budget.
          maxOutputTokens: 32768,
          // JSON mode: Gemini's decoder is supposed to mask every next-
          // token candidate against the JSON grammar at inference time so
          // it can't emit syntactically broken output. In practice we still
          // see occasional broken JSON (see the server log "strict JSON.
          // parse failed; jsonrepair recovered" warnings), so jsonrepair
          // stays as a middle fallback. JSON mode does still help by
          // increasing the rate at which strict parse succeeds and by
          // discouraging the model from veering into prose.
          responseMimeType: "application/json",
        } as any,
      });

      const timeoutMs = 120000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI parsing timed out after 2 minutes")), timeoutMs),
      );
      const result = await Promise.race([
        model.generateContent([
          { inlineData: { mimeType: contentType, data: base64Data } },
          { text: systemPrompt + "\n\nParse the cost items from this document." },
        ]),
        timeoutPromise,
      ]);
      const responseText = result.response.text();
      return this.parseJsonResponse(responseText);
    }
  }

  /**
   * Walk the streamed JSON text, find the items array, and pull out every
   * COMPLETE { ... } object inside it. Tolerant of a truncated final object
   * at the end of the stream (returns only the finished ones). Used by the
   * streaming parse path to emit partial item counts as Gemini types.
   */
  private extractCompleteItemsFromStream(text: string): any[] {
    const itemsKeyIdx = text.indexOf('"items"');
    if (itemsKeyIdx === -1) return [];
    const bracketStart = text.indexOf("[", itemsKeyIdx);
    if (bracketStart === -1) return [];

    const items: any[] = [];
    const droppedFragments: string[] = [];
    let depth = 0;
    let objStart = -1;
    let inString = false;
    let escape = false;

    for (let i = bracketStart + 1; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === "\\" && inString) { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (c === "{") {
        if (depth === 0) objStart = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && objStart !== -1) {
          const objText = text.slice(objStart, i + 1);
          try {
            items.push(JSON.parse(objText));
          } catch (e: any) {
            // Drop one item but record what we tried to parse so we can
            // see, in the server log, exactly which row Gemini broke.
            // Trimmed to 200 chars so a long description doesn't flood
            // the log; usually the first few keys (category / key) are
            // enough to identify which PDF row it was.
            droppedFragments.push(objText.slice(0, 200).replace(/\s+/g, " ").trim());
          }
          objStart = -1;
        }
      } else if (c === "]" && depth === 0) {
        break;
      }
    }
    // Stash on the instance for the caller to read after the fact (we
    // don't want to change the return type and break every existing
    // call site that just wants the items array).
    this._lastDroppedFragments = droppedFragments;
    return items;
  }

  // Filled by extractCompleteItemsFromStream every time it runs.
  // The streaming caller reads this AFTER each call to know whether
  // anything was silently dropped. Reset on each extractor invocation.
  private _lastDroppedFragments: string[] = [];

  /**
   * One-shot: parse line items AND classify the program (tab, subType,
   * isFixedCost, name, country) in a single Gemini call. Saves a full
   * round-trip vs running parseFile + classifyDocument sequentially.
   *
   * Returns { items, classification }. Classification can be null if the
   * model omitted or malformed it - the caller should still use items in
   * that case (graceful degradation matches the old two-call behavior).
   *
   * onProgress (optional) is invoked as the AI streams its response - the
   * callback receives the current item count so the controller can persist
   * live progress to the DB. Items are parsed incrementally from the
   * stream; the caller can render "12 items extracted so far" while the
   * model is still typing.
   */
  async parseAndClassifyDocument(
    fileBuffer: Buffer,
    contentType: string,
    providerTypeName: string,
    originalFileName: string,
    subType?: string,
    onProgress?: (info: { itemsCount: number; streaming: boolean }) => void | Promise<void>,
    // Approved service-type names of the provider - lets a "multi-service"
    // parse load the UNION of those types' cost templates. Without it a
    // multi-service upload finds no ProviderType named "multi-service",
    // loads ZERO templates, and the model free-forms granular items
    // instead of consolidating to template fields.
    approvedTypeNames?: string[],
  ): Promise<{
    items: Array<{
      category: string;
      key: string;
      minValue: number | null;
      maxValue: number | null;
      isCustom: boolean;
      isIncluded: boolean;
      isTier: boolean;
      comment: string | null;
    }>;
    classification: ClassificationResult | null;
  }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    const providerType = await this.prisma.providerType.findFirst({
      where: { name: { contains: providerTypeName, mode: "insensitive" } },
    });
    const templateWhere: any = providerType ? { providerTypeId: providerType.id } : null;
    if (templateWhere && subType) {
      templateWhere.OR = [{ subType: null }, { subType }];
    }
    const templates = templateWhere
      ? await this.prisma.costTemplate.findMany({
          where: templateWhere,
          orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
        })
      : [];

    const templateContext =
      templates.length > 0
        ? `Known cost categories and fields for this provider type:\n${templates
            .map(
              (t) =>
                `- Category: "${t.category}", Field: "${t.fieldName}" (mandatory: ${t.isMandatory})`,
            )
            .join("\n")}`
        : "No predefined templates available. Categorize based on common fertility industry categories.";

    const subtypeMenu = ALL_SUBTYPES.map(
      (s) => `  - "${s}" (${TAB_LABEL[TAB_OF[s]]} > ${SUBTYPE_LABEL[s]})`,
    ).join("\n");

    // Detect provider type. The 14-subtype taxonomy is IVF-specific. Egg
    // donor agencies/banks get a simpler fresh/frozen pick. Surrogacy and
    // sperm banks don't need any subtype - the classifier just emits
    // programName + country + isFixedCost + tiers.
    //
    // "multi-service" is the signal a provider has >1 ProviderService row
    // (e.g. Eggspecting: IVF Clinic + Surrogacy Agency + Egg Donor Agency).
    // In that case the prompt is the UNION of all branches and validation
    // is driven by the AI's emitted serviceTypes tags, not by the
    // provider's primary service - otherwise a surrogacy PDF dropped on
    // a multi-service provider would be force-classified as an IVF subtype.
    const lowerType = providerTypeName.toLowerCase();
    const isMultiServiceProvider = lowerType === "multi-service";
    const isIvfProvider = !isMultiServiceProvider && (lowerType.includes("ivf") || lowerType.includes("clinic"));
    const isEggProvider = !isMultiServiceProvider && lowerType.includes("egg");
    // No-subtype providers: surrogacy + sperm bank + anything else.
    const noSubtypeProvider = !isMultiServiceProvider && !isIvfProvider && !isEggProvider;

    const classificationSection = isMultiServiceProvider ? `== PART B: CLASSIFICATION ==

This provider offers MULTIPLE services (e.g. IVF Clinic + Surrogacy Agency + Egg Donor Agency). You must FIRST decide which service the uploaded cost sheet covers by reading the document content, then pick the right classification path:

STEP 1 - Emit "serviceTypes" array (1+ tags) from: "ivf_clinic", "surrogacy", "egg_donor", "sperm_donor", "legal", "therapy", "genetic_counseling", "nutrition", "coaching", "doula". Detection cues:
- "ivf_clinic": IVF cycle / FET / embryo creation / shipping embryos / PGT / embryo transfer / stimulation / retrieval done by a clinic, clinical fees stated.
- "surrogacy": "Surrogate Compensation", "Surrogacy", "Gestational Carrier" / "GC fee", "Surrogate Insurance", "Surrogate Screening", "Surrogate Sign-on bonus", "Maternity Leave", "Lloyds of London", "Newborn Insurance", "Escrow", "Agency fee" in a surrogacy context.
- "egg_donor": "Egg Donor Compensation", "Egg Donor Agency Fees", "Donor screening", "Donor IVF cycle", "Fresh Donor Cycle", "Frozen Egg Lot", "donor matching fee".
- "legal": the WHOLE document is a law firm / attorney fee schedule - "Retainer", "Gestational Carrier Agreement drafting", "Donor Agreement review", "Pre-Birth Parentage Order", "Second-Parent Adoption", "Escrow management (legal)", hourly attorney rates. Do NOT use this tag for legal LINE ITEMS inside an agency or clinic cost sheet - those keep the agency/clinic tag.
- "sperm_donor": "Sperm Donor", "Sperm Bank", "Vial of sperm", per-vial pricing.
- "therapy": mental-health / counseling fee schedule - "therapy session", "psychological evaluation", "support group", per-session or package rates from a therapist practice.
- "genetic_counseling": genetic counseling consults, carrier-screening review sessions, results-review appointments.
- "nutrition": fertility nutrition consults, dietitian packages, meal-plan programs.
- "coaching": fertility coaching sessions or packages (non-clinical guidance/support).
- "doula": birth or postpartum doula support packages.
A bundled sheet can have multiple tags (e.g. an Egg Donor agency that includes the surrogacy match -> ["egg_donor", "surrogacy"]).

STEP 2 - Pick "subType" based on STEP 1:
- If "ivf_clinic" is in serviceTypes, you MUST pick exactly one of the 14 IVF subtypes:
${subtypeMenu}
  Then "tab" is the parent of that subtype. See the heuristics block below.
- Else if "egg_donor" is in serviceTypes AND "ivf_clinic" is NOT (pure egg-donor agency / egg bank sheet, no IVF clinical fees), pick "fresh" or "frozen":
    - "fresh" - Fresh donor cycle (synchronized donor + recipient, fresh retrieval -> immediate fertilization).
    - "frozen" - Frozen egg lot purchase from an egg bank (vitrified eggs, per-lot pricing).
- Else (pure surrogacy / pure sperm bank / no IVF + no egg donor), emit "subType": "" and "tab": "".

STEP 2b - Whenever "egg_donor" is in serviceTypes (including mixed IVF + egg-donor sheets where the primary subType is an IVF leaf), ALSO emit "eggDonorSubType" as "fresh" or "frozen":
- "fresh" - Donor stimulation language: "donor meds", "ovarian stimulations", "synchronized cycle", "fresh donor", "donor candidates evaluation", "minimum N eggs from retrieval".
- "frozen" - Egg bank language: "frozen egg lot", "vitrified eggs", "X eggs per lot", "thaw guarantee", "egg bank", per-lot pricing.
- Default to "fresh" if the sheet describes donor evaluation/screening + retrieval but is ambiguous on cycle type.
- Omit this field entirely (or set null) when "egg_donor" is NOT in serviceTypes.

IVF SUBTYPE HEURISTICS (only when "ivf_clinic" is in serviceTypes):

A. PROGRAM HAS BOTH CREATION AND TRANSFER:
- "ivf_cycle_donor_eggs_*": explicit donor egg usage AND there's an embryo transfer step.
- "ivf_cycle_*_surrogate_carry": surrogacy/GC/gestational carrier IS part of the program AND there are IVF clinical fees (not just agency fees).
- "ivf_cycle_reciprocal": explicitly reciprocal IVF / shared-motherhood / partner-IVF.
- "ivf_cycle_own_eggs_own_carry": basic full cycle without donor/surrogate language. Default for unmarked IVF.

B. PROGRAM HAS CREATION BUT NO TRANSFER (parent freezes embryos):
- "embryo_creation_only_*": doc mentions egg retrieval + embryo creation + cryopreservation / freezing / storage but does NOT mention embryo transfer, FET, or carrier.

C. PROGRAM HAS TRANSFER BUT NO CREATION OR SHIPPING (in-house FET):
- "fet_to_*": embryos are already at THIS clinic. Look for: "FET", "Frozen Embryo Transfer", absence of "shipping", "receiving fee", "embryo retrieval", "stimulation".

D. PROGRAM SHIPS EMBRYOS IN FROM ANOTHER CLINIC:
- "shipping_embryos_*": "embryo receiving fee", "shipping embryos", "incoming embryo transfer".

E. PROGRAM SHIPS GAMETES IN AND CREATES EMBRYOS:
- "shipping_eggs_sperm_*": clinic receives raw gametes AND creates embryos here.

F. PROGRAM IS PURE EGG FREEZING:
- "egg_freezing_*": retrieval + storage only, no embryo creation, no transfer.

CRITICAL: do NOT force-pick an IVF subtype for a non-IVF document. A surrogacy agency cost sheet (background checks + escrow + agency fees + GC compensation + insurance + legal, with the clinical fees explicitly stated as "Paid directly to clinic" or absent) is NOT an IVF cycle. Emit subType="" in that case.` : isIvfProvider ? `== PART B: CLASSIFICATION ==

Pick exactly one subtype from this list:
${subtypeMenu}

Subtype heuristics - PICK CAREFULLY, several look similar:

A. PROGRAM HAS BOTH CREATION AND TRANSFER:
- "ivf_cycle_donor_eggs_*": explicit donor egg usage ("donor eggs", "egg donor compensation", "donor egg lot") AND there's an embryo transfer step.
- "ivf_cycle_*_surrogate_carry": surrogacy/GC/gestational carrier IS part of the program.
- "ivf_cycle_reciprocal": explicitly reciprocal IVF / shared-motherhood / partner-IVF.
- "ivf_cycle_own_eggs_own_carry": basic full cycle without donor/surrogate language. Default for unmarked IVF.

B. PROGRAM HAS CREATION BUT NO TRANSFER (parent freezes embryos):
- "embryo_creation_only_*": doc mentions egg retrieval + embryo creation + cryopreservation / freezing / storage but does NOT mention embryo transfer, FET, or carrier. Look for phrases like "create + freeze", "no transfer included", "stop after freezing", "embryo banking". If donor eggs -> "embryo_creation_only_donor_eggs". Otherwise own.

C. PROGRAM HAS TRANSFER BUT NO CREATION OR SHIPPING (in-house FET):
- "fet_to_*": embryos are already at THIS clinic (not shipped in, not created in this cycle). Look for: "FET", "Frozen Embryo Transfer", "transfer of stored embryos", absence of "shipping", "receiving fee", "embryo retrieval", "stimulation". Often a much cheaper sheet than IVF Cycle. If transfer is to a surrogate -> "fet_to_surrogate". Otherwise own/self.

D. PROGRAM SHIPS EMBRYOS IN FROM ANOTHER CLINIC:
- "shipping_embryos_*": doc explicitly mentions receiving/shipping embryos from another clinic ("embryo receiving fee", "shipping embryos", "incoming embryo transfer", FedEx/courier language).

E. PROGRAM SHIPS GAMETES IN AND CREATES EMBRYOS:
- "shipping_eggs_sperm_*": clinic receives raw gametes (donor egg lot from external bank, sperm from external bank) AND creates embryos here.

F. PROGRAM IS PURE EGG FREEZING:
- "egg_freezing_*": retrieval + storage only, no embryo creation, no transfer.

CRITICAL TIE-BREAKERS:
- If the document mentions "Frozen Embryo Transfer" or "FET" WITHOUT any shipping/receiving language, prefer "fet_to_*" over "shipping_embryos_*".
- If the document is ONLY about creating + freezing embryos with NO transfer line items at all, prefer "embryo_creation_only_*" over "ivf_cycle_*".
- If the document only has retrieval and storage (no fertilization, no transfer), prefer "egg_freezing_*".` : isEggProvider ? `== PART B: CLASSIFICATION ==

This is an Egg Donor Agency / Egg Bank cost sheet. Pick exactly one of these two subtypes:
  - "fresh" - Fresh donor cycle (synchronized donor + recipient, fresh retrieval -> immediate fertilization). Look for: "fresh donor", "synchronized cycle", "fresh egg retrieval", donor + recipient coordination, single donor matched to single recipient.
  - "frozen" - Frozen egg lot purchase from an egg bank (donor eggs already retrieved and vitrified). Look for: "frozen eggs", "egg lot", "X eggs in lot", "egg bank", "vitrified eggs", "thaw guarantee", per-lot pricing.

When uncertain, prefer "fresh" (the more common product).` : `== PART B: CLASSIFICATION ==

This is a ${providerTypeName} cost sheet. There is NO subtype distinction for this provider type - just extract the program label, country, and Fixed/Not-Fixed flag below.`;

    const subtypeOutputSchema = isMultiServiceProvider
      ? `    "tab": "<tab-id or empty string>",
    "subType": "<subtype-id or fresh|frozen or empty string>",
    "eggDonorSubType": "<fresh | frozen | omit when serviceTypes has no egg_donor>",`
      : isIvfProvider
      ? `    "tab": "<tab-id>",
    "subType": "<subtype-id>",
    "eggDonorSubType": "<fresh | frozen | omit when serviceTypes has no egg_donor>",`
      : isEggProvider
      ? `    "subType": "<fresh | frozen>",`
      : ``;

    const subtypeTrailingNote = isMultiServiceProvider
      ? `\n"tab" is the parent of "subType" when subType is one of the 14 IVF subtypes; empty string otherwise. Confidence: 0.9+ on explicit keyword matches; 0.6-0.8 inferred; <0.5 guessing.`
      : isIvfProvider
      ? `\n"tab" must be the parent of "subType". Confidence: 0.9+ on explicit keyword matches; 0.6-0.8 inferred; <0.5 guessing.`
      : `\nConfidence: 0.9+ on explicit keyword matches; 0.6-0.8 inferred; <0.5 guessing.`;

    const systemPrompt = `You are a fertility-industry cost-sheet parser. You will (A) extract EVERY line item visible in the document and (B) classify the program. Return BOTH in a single JSON object.

== PART A: LINE ITEMS ==

${templateContext}

CRITICAL: Extract EVERY visible line item. A typical complete cost sheet has 10-30 line items. If you emit fewer than 5, you are missing items - re-scan the document.

Cost sheets are usually organized into 2+ sections:
  1. "Included Services" / "Includes" / "Package Includes" - items bundled in the headline price. THESE ARE THE BULK OF THE ITEMS. Extract EACH ONE with isIncluded=true. If they have no individual price ($ symbol absent), set minValue=0 and maxValue=0 - they are included in the package.
  2. "Additional Services" / "Other Services" / "Not Included" / "Optional" / "Contingency Fees" - items only charged in certain circumstances. Extract each with isIncluded=false and their actual price.
You MUST extract items from BOTH sections - never stop at the section boundary.

Rules:
1. Map recognized items to the known categories/fields when possible. Use the EXACT category and key names from the template.
2. Items NOT matching a template field MUST still be extracted with isCustom=true. Never drop an item just because it doesn't match a template.
3. Range "$5,000 - $10,000" -> minValue=5000, maxValue=10000. Single "$5,000" -> both = 5000.
4. Items in an "Includes" / "Included Services" section without an individual price: isIncluded=true, minValue=0, maxValue=0. Their cost is folded into the headline package price - emit them anyway so the parent sees what's covered.
5. Items in an "Additional Services" / "Optional" / "Contingency" section: isIncluded=false, set their stated price (or null if none).
6. Notes/conditions (e.g. "if using frozen sperm", "up to 15 embryos") -> comment field.
7. CONSOLIDATE multiple lines that map to the same template field (sum values; list breakdown in comment). Never emit two items with the same key. This applies WITHIN a section; do not consolidate an Included line with an Additional line.

CRITICAL - what counts as "included" vs "excluded":
- Required medical services with stated prices (e.g. "Medication $1,000-$1,800", "Surrogate Screening $2,300", "Coordination Fee", "Anesthesia $X") that are NOT under an explicit Optional/Contingency header are STANDARD REQUIRED COSTS -> isIncluded=true with their stated price. The fact that they have a per-line price does NOT make them optional.
- "Excluded" is ONLY for: items under a section explicitly titled "Additional Services" / "Other Services" / "Optional Services" / "Not Included" / "Contingency" / "If Needed" / "May Apply", OR items with explicit "optional" language ("if requested", "if applicable", "only if X").

PAYMENT INSTALLMENTS - SKIP ENTIRELY:
- A "payment schedule" / "installment plan" describes HOW the parent pays the program fee, NOT additional line items. Common patterns: "1st Installment $X", "2nd Installment $Y", "3rd Installment $Z", "Due at Signing $X", "Due at Match $Y", "Due at Embryo Transfer $Z".
- These installments collectively ADD UP to a single program fee (the headline tier price). If you extract them as line items they will DOUBLE-COUNT the program cost and the parent will see a wildly inflated total.
- DO NOT extract installments. Skip the entire payment-schedule section. The program fee is already captured by the tier/headline price.
- ONLY extract items that are TRULY separate fees beyond the program price - e.g. "International Parents Fees", "Travel Expenses", contingency add-ons. If you cannot find such an item, that section just has nothing extractable.
- Smell test: if Installment 1 + Installment 2 + Installment 3 ~= the tier/headline price, they're a payment schedule. Skip them.

TIERED PACKAGE PRICING (critical for FET / Surrogacy / Egg Donation sheets):
- When the document offers multiple package tiers for the same service (e.g. "Single Cycle $6,500" / "Two Cycles $10,500" / "Three Cycles $13,500" / "Unlimited Package $20,000"), these are ALTERNATIVES the parent picks ONE of. Emit EACH tier as its own item with:
  * isTier=true (this marks them as alternatives, not additive line items)
  * isIncluded=true (they are real prices, not optional services)
  * Distinct key (e.g. "Embryo Transfer (Single Cycle)", "Embryo Transfer (Two Cycles)") so they sort and display correctly.
- The system groups all isTier items into a dedicated "Pricing Tiers" section in the provider editor and renders one parent-facing card per tier.
- This rule applies to: cycle bundles, retrieval bundles, unlimited packages, multi-month storage discounts, group deals - anywhere the parent chooses one option among similar-but-different-priced alternatives for the same underlying service.
- DO NOT mark tiers as isCustom or excluded. They are the program's primary pricing.
- For regular (non-tier) items that have prices and aren't under an Optional section: isIncluded=true, isTier=false (the default).

${classificationSection}

isFixedCost:
- TRUE: bundled package with included quantities ("3 retrievals included", "unlimited transfers", "package price covers N cycles").
- FALSE: itemized per-service / a-la-carte pricing.

programName: the document's branded program name (e.g. "Unlimited IVF Until Live Birth", "Donor Egg + IVF + GC"). If none, derive a concise label like "Single IVF Cycle". Title Case, under 50 chars, no quotes.

country: the clinic's country of delivery. Use the full English name ("United States", "Mexico", "Colombia"). Default to "United States" when nothing in the document indicates otherwise.

serviceTypes: an ARRAY of service-type tags from: "ivf_clinic", "surrogacy", "egg_donor", "sperm_donor", "legal", "therapy", "genetic_counseling", "nutrition", "coaching", "doula". A single cost sheet can be tagged with MULTIPLE if the program bundles services (e.g. an Egg Donor agency that includes the surrogacy match -> ["egg_donor", "surrogacy"]). Detection rules:
- "ivf_clinic" - any IVF cycle / FET / embryo creation / shipping embryos line items, OR the provider type itself is an IVF clinic.
- "surrogacy" - presence of "Surrogate Compensation", "Surrogacy", "Gestational Carrier" / "GC fee", "Surrogate Insurance", "Surrogate Screening", "Lloyds of London", "Newborn Insurance".
- "egg_donor" - presence of "Egg Donor Compensation", "Egg Donor Agency Fees", "Donor screening", "Donor IVF cycle", "Fresh Donor Cycle", "Frozen Egg Lot".
- "sperm_donor" - presence of "Sperm Donor", "Sperm Bank", "Vial of sperm", per-vial pricing.
- "legal" - the WHOLE document is a law firm / attorney fee schedule: "Retainer", "Attorney Fee", "Gestational Carrier/Surrogacy Agreement drafting", "Donor Agreement review", "Pre-Birth Parentage Order", "Second-Parent Adoption", hourly attorney rates. Do NOT use this tag for legal LINE ITEMS inside an agency or clinic cost sheet - those keep the agency/clinic tag.
- "therapy": mental-health / counseling fee schedule - "therapy session", "psychological evaluation", "support group", per-session or package rates from a therapist practice.
- "genetic_counseling": genetic counseling consults, carrier-screening review sessions, results-review appointments.
- "nutrition": fertility nutrition consults, dietitian packages, meal-plan programs.
- "coaching": fertility coaching sessions or packages (non-clinical guidance/support).
- "doula": birth or postpartum doula support packages.
Always emit at least one tag. If multiple service categories are clearly represented, emit them all.

== OUTPUT ==

Output STRICT JSON only, no commentary, no markdown fence. Lead with the items array - it's the primary payload:
{
  "items": [
    { "category": string, "key": string, "minValue": number|null, "maxValue": number|null, "isCustom": boolean, "isIncluded": boolean, "isTier": boolean, "comment": string|null },
    ... (typically 10-30 items - extract them all)
  ],
  "classification": {
${subtypeOutputSchema}
    "isFixedCost": <true|false>,
    "confidence": <0..1>,
    "reasoning": "<one sentence>",
    "programName": "<label>",
    "country": "<country>",
    "serviceTypes": [<one or more of: "ivf_clinic", "surrogacy", "egg_donor", "sperm_donor", "legal", "therapy", "genetic_counseling", "nutrition", "coaching", "doula">],
    "programSplits": [ { "programName": "<label>", "serviceTypes": [<tags>], "itemKeys": ["<category>::<key>", ...] }, ... ]  <- OPTIONAL, usually omitted
  }
}

programSplits (OPTIONAL - omit for the vast majority of uploads): include ONLY when the document is an a-la-carte FEE SCHEDULE / service MENU covering MULTIPLE distinct parent journeys - e.g. a law firm listing gestational surrogacy matters AND egg/sperm/embryo donation matters AND an international package, or a wellness provider with separate per-journey offerings. Emit 2-4 splits. Each split: a concise Title Case programName (e.g. "Surrogacy Legal Services"), that journey's serviceTypes tags, and itemKeys = EVERY item belonging to that journey, written as "<category>::<key>" EXACTLY matching the category and key emitted in the items array. Items that apply to every journey (initial consultation, a general retainer) must be REPEATED in every split they apply to. Do NOT split a bundled package sold at one total price (agency or clinic packages) - splits are only for menus of independently-purchasable services.
${subtypeTrailingNote}`;

    let textContent: string | null = null;

    if (
      contentType.includes("spreadsheet") ||
      contentType.includes("excel") ||
      originalFileName.match(/\.xlsx?$/i)
    ) {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer);
      const csvParts: string[] = [];
      workbook.eachSheet((worksheet) => {
        const rows: string[] = [];
        worksheet.eachRow({ includeEmpty: false }, (row) => {
          const values = (row.values as (string | number | null | undefined)[]).slice(1);
          const csvRow = values
            .map((v) => {
              const s = v != null ? String(v) : "";
              return s.includes(",") || s.includes('"') || s.includes("\n")
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(",");
          rows.push(csvRow);
        });
        csvParts.push(`--- Sheet: ${worksheet.name} ---\n${rows.join("\n")}`);
      });
      textContent = csvParts.join("\n\n");
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash",
      generationConfig: {
        temperature: 0,
        // 32k headroom: long cost sheets with 30+ items + comments easily
        // exceed 8k tokens, and the classification block is the LAST thing
        // in the response - it gets truncated off the end when we hit the
        // cap. 32768 leaves room even for 50+ item sheets.
        maxOutputTokens: 32768,
        // JSON mode: constrain the decoder to valid JSON output. Combined
        // with the jsonrepair middle fallback and the per-object stream
        // parser, this is the three-layer parse strategy.
        responseMimeType: "application/json",
      } as any,
    });

    const timeoutMs = 180000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("AI parse+classify timed out after 3 minutes")), timeoutMs);
    });

    // Streaming path: feed Gemini's chunks into the partial-item extractor
    // so the controller can publish live progress (parseItemsCount on the
    // sheet row) while the AI is still typing. This is the only behavioural
    // change vs the old generateContent() call - final aggregate output is
    // identical (we still parse the full JSON at the end).
    const streamPromise = (async () => {
      const streamResult = textContent != null
        ? await model.generateContentStream(`${systemPrompt}\n\nFilename: ${originalFileName}\n\nDocument content (CSV):\n${textContent}`)
        : await model.generateContentStream([
            { inlineData: { mimeType: contentType, data: fileBuffer.toString("base64") } },
            { text: `${systemPrompt}\n\nFilename: ${originalFileName}\n\nParse and classify the cost sheet from this document.` },
          ]);

      let accumulated = "";
      let lastReportedCount = 0;
      let lastReportAt = 0;
      for await (const chunk of streamResult.stream) {
        accumulated += chunk.text();
        if (onProgress) {
          // Re-scan the accumulated text each chunk but throttle progress
          // callbacks to every ~250ms to avoid hammering the DB on fast
          // streams. Always emit when the count actually grows.
          const now = Date.now();
          const items = this.extractCompleteItemsFromStream(accumulated);
          if (items.length !== lastReportedCount && (now - lastReportAt >= 250 || items.length - lastReportedCount >= 3)) {
            lastReportedCount = items.length;
            lastReportAt = now;
            try { await onProgress({ itemsCount: items.length, streaming: true }); } catch { /* progress is best-effort */ }
          }
        }
      }
      const finalResponse = await streamResult.response;
      return { text: accumulated || finalResponse.text() };
    })();

    let responseText: string;
    try {
      const result = await Promise.race([streamPromise, timeoutPromise]);
      responseText = result.text;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Extract the outer JSON object. Forgiving against ```json fences.
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.error(`parseAndClassify: no JSON in response: ${responseText.slice(0, 400)}`);
      throw new Error("AI did not return valid JSON");
    }

    // Three-layer JSON parsing strategy:
    //   1. Strict JSON.parse        - succeeds on responseMimeType-constrained
    //                                  output (our default since this commit).
    //   2. jsonrepair + JSON.parse  - middle fallback for legacy responses
    //                                  with the common Gemini quirks (trailing
    //                                  commas, missing commas between items,
    //                                  unquoted keys, single quotes). Repairs
    //                                  most malformed payloads while preserving
    //                                  the classification block.
    //   3. Per-object stream parser - last resort. Drops classification, but
    //                                  rescues whatever item objects parse
    //                                  cleanly even if the surrounding doc
    //                                  is unrepairable.
    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (strictErr) {
      // Layer 2: try jsonrepair before falling all the way back to the
      // per-object parser. Often fixes everything and we keep the
      // classification, so the AI's subType / isFixedCost guess survives.
      try {
        const { jsonrepair } = await import("jsonrepair");
        const repaired = jsonrepair(jsonMatch[0]);
        parsed = JSON.parse(repaired);
        this.logger.warn(
          `parseAndClassify: strict JSON.parse failed (${strictErr}); jsonrepair recovered the full response`,
        );
      } catch (repairErr) {
        // Layer 3: per-object recovery. Last resort - drops classification
        // but rescues whatever item objects parsed cleanly during streaming.
        const recoveredItems = this.extractCompleteItemsFromStream(responseText);
        const dropped = this._lastDroppedFragments;
        if (recoveredItems.length > 0) {
          this.logger.warn(
            `parseAndClassify: strict + jsonrepair both failed (strict=${strictErr}, repair=${repairErr}); recovered ${recoveredItems.length} items from per-object stream parser, dropping classification`,
          );
          // Log every item the per-object parser had to skip so we can see
          // in the server log exactly which row Gemini broke. The first
          // ~120 chars usually carry the category + key, which is enough
          // to identify the source row in the PDF.
          if (dropped.length > 0) {
            this.logger.warn(
              `parseAndClassify: dropped ${dropped.length} item(s) the per-object parser could not parse:`,
            );
            for (let i = 0; i < dropped.length; i++) {
              this.logger.warn(`  drop[${i}]: ${dropped[i]}`);
            }
          }
          parsed = { items: recoveredItems };
        } else {
          this.logger.error(
            `parseAndClassify: JSON parse failed and no items recoverable (strict=${strictErr}, repair=${repairErr})`,
          );
          throw new Error("Failed to parse AI response as JSON");
        }
      }
    }

    // Items branch - normalize to the same shape as parseFile returns.
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items = this.enforceCycleTierGrouping(
      rawItems.map((item: any) => ({
        category: String(item.category || "Other"),
        key: String(item.key || "Unknown"),
        minValue: item.minValue != null ? Number(item.minValue) : null,
        maxValue: item.maxValue != null ? Number(item.maxValue) : null,
        isCustom: Boolean(item.isCustom),
        isIncluded: item.isIncluded !== false,
        isTier: item.isTier === true,
        comment: item.comment ? String(item.comment) : null,
      })),
    );

    // Classification branch. Three paths depending on provider type:
    //   - IVF: tab + subType are required from the 14-subtype taxonomy.
    //   - Egg donor: subType is "fresh" or "frozen" (legacy DB values).
    //   - Other (surrogacy / sperm): no subType - just name/country/fixed.
    // For non-IVF providers we still emit a ClassificationResult, but tab
    // is "" and subType is "" (or "fresh"/"frozen" for egg donor). The
    // service-level persist code handles those as nullable in the DB.
    let classification: ClassificationResult | null = null;
    const cls = parsed.classification;
    if (cls && typeof cls === "object") {
      const confidence = typeof cls.confidence === "number" ? Math.max(0, Math.min(1, cls.confidence)) : 0.5;
      const isFixedCost = cls.isFixedCost === true;
      const reasoning = typeof cls.reasoning === "string" ? cls.reasoning.slice(0, 280) : "";
      const rawName = typeof cls.programName === "string" ? cls.programName.trim().replace(/^["'`]|["'`]$/g, "") : "";
      const programName = rawName.length > 0 && rawName.length <= 80
        ? rawName
        : (originalFileName.replace(/\.(pdf|xlsx?|csv)$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled Program");
      const rawCountry = typeof cls.country === "string" ? cls.country.trim() : "";
      const country = rawCountry.length > 0 && rawCountry.length <= 60 ? rawCountry : "United States";

      // Extracted alongside subType so mixed IVF+egg-donor sheets carry the
      // fresh/frozen distinction even though their primary subType is the
      // IVF leaf. Only honored downstream when "egg_donor" is in
      // serviceTypes (see CostsService.saveAiClassification).
      const rawEggDonorSubType = typeof cls.eggDonorSubType === "string" ? cls.eggDonorSubType.toLowerCase().trim() : "";
      const eggDonorSubType: "fresh" | "frozen" | undefined =
        rawEggDonorSubType === "frozen" ? "frozen"
        : rawEggDonorSubType === "fresh" ? "fresh"
        : undefined;

      // serviceTypes - validate the AI's array against the allowed tokens.
      // Fall back to a single default tag derived from the provider type
      // so a malformed/missing field still gives the program a sensible tag.
      const ALLOWED_TAGS = new Set(["ivf_clinic", "surrogacy", "egg_donor", "sperm_donor", "legal", "therapy", "genetic_counseling", "nutrition", "coaching", "doula"]);
      const rawTags = Array.isArray(cls.serviceTypes) ? cls.serviceTypes : [];
      let serviceTypes = rawTags
        .map((t: any) => String(t).toLowerCase().trim())
        .filter((t: string) => ALLOWED_TAGS.has(t));
      serviceTypes = Array.from(new Set(serviceTypes));
      if (serviceTypes.length === 0) {
        // Multi-service providers have no sensible default - leave the
        // serviceTypes empty so the editor surfaces "Awaiting service tag"
        // and the clinic picks. Forcing a tag here would silently mis-tag
        // half the uploads on a 3-service provider.
        const defaultTag = isMultiServiceProvider ? null
          : isIvfProvider ? "ivf_clinic"
          : isEggProvider ? "egg_donor"
          : providerTypeName.toLowerCase().includes("surrogacy") ? "surrogacy"
          : providerTypeName.toLowerCase().includes("sperm") ? "sperm_donor"
          : providerTypeName.toLowerCase().includes("legal") ? "legal"
          : providerTypeName.toLowerCase().includes("therapist") ? "therapy"
          : providerTypeName.toLowerCase().includes("genetic") ? "genetic_counseling"
          : providerTypeName.toLowerCase().includes("nutrition") ? "nutrition"
          : providerTypeName.toLowerCase().includes("coach") ? "coaching"
          : providerTypeName.toLowerCase().includes("doula") ? "doula"
          : null;
        if (defaultTag) serviceTypes = [defaultTag];
      }

      if (isMultiServiceProvider) {
        // Validation routes by the AI's emitted serviceTypes, not the
        // provider's primary service. Three valid shapes:
        //   ivf_clinic in tags         -> subType must be one of 14 IVF ids
        //   egg_donor in tags, no ivf  -> subType is "fresh" | "frozen"
        //   pure surrogacy / sperm     -> subType + tab are empty strings
        const rawSubType = String(cls.subType ?? "").trim();
        const hasIvfTag = serviceTypes.includes("ivf_clinic");
        const hasEggTag = serviceTypes.includes("egg_donor");
        // Only attach the egg-donor fresh/frozen flavor when egg_donor is
        // actually one of the serviceTypes - otherwise this is noise.
        const eggDonorFlavor = hasEggTag ? eggDonorSubType : undefined;
        if (hasIvfTag) {
          const subTypeId = rawSubType as SubType;
          if ((ALL_SUBTYPES as string[]).includes(subTypeId)) {
            const tab = TAB_OF[subTypeId];
            classification = { tab, subType: subTypeId, isFixedCost, confidence, reasoning, programName, country, serviceTypes, eggDonorSubType: eggDonorFlavor };
            this.logger.log(`parseAndClassify [Multi/IVF]: ${items.length} items, ${subTypeId} (fixed=${isFixedCost}, conf=${confidence.toFixed(2)}, name="${programName}", country="${country}", tags=${JSON.stringify(serviceTypes)}, eggDonor=${eggDonorFlavor ?? "n/a"})`);
          } else {
            this.logger.warn(`parseAndClassify [Multi/IVF]: ivf_clinic tag but invalid subType "${cls.subType}", emitting classification without subType`);
            classification = { tab: "" as any, subType: "" as any, isFixedCost, confidence, reasoning, programName, country, serviceTypes, eggDonorSubType: eggDonorFlavor };
          }
        } else if (hasEggTag) {
          // Pure egg-donor: subType IS fresh/frozen. Mirror it onto
          // eggDonorSubType so downstream code can rely on a single field.
          const subType = (rawSubType.toLowerCase() === "frozen" ? "frozen" : "fresh") as any;
          classification = { tab: "" as any, subType, isFixedCost, confidence, reasoning, programName, country, serviceTypes, eggDonorSubType: eggDonorFlavor ?? subType };
          this.logger.log(`parseAndClassify [Multi/Egg]: ${items.length} items, ${subType} (fixed=${isFixedCost}, name="${programName}", country="${country}", tags=${JSON.stringify(serviceTypes)})`);
        } else {
          // Pure surrogacy / sperm bank / etc. - no subType.
          classification = { tab: "" as any, subType: "" as any, isFixedCost, confidence, reasoning, programName, country, serviceTypes };
          this.logger.log(`parseAndClassify [Multi/Agency]: ${items.length} items (fixed=${isFixedCost}, name="${programName}", country="${country}", tags=${JSON.stringify(serviceTypes)})`);
        }
      } else if (isIvfProvider) {
        // Single-service IVF clinic. Can still bundle egg-donor coverage
        // when the cost sheet describes an IVF + Egg Donation package -
        // honor eggDonorSubType only when serviceTypes confirms it.
        const eggDonorFlavor = serviceTypes.includes("egg_donor") ? eggDonorSubType : undefined;
        const subTypeId = String(cls.subType ?? "") as SubType;
        if ((ALL_SUBTYPES as string[]).includes(subTypeId)) {
          const tab = TAB_OF[subTypeId];
          classification = { tab, subType: subTypeId, isFixedCost, confidence, reasoning, programName, country, serviceTypes, eggDonorSubType: eggDonorFlavor };
          this.logger.log(`parseAndClassify [IVF]: ${items.length} items, ${subTypeId} (fixed=${isFixedCost}, conf=${confidence.toFixed(2)}, name="${programName}", country="${country}", tags=${JSON.stringify(serviceTypes)}, eggDonor=${eggDonorFlavor ?? "n/a"})`);
        } else {
          this.logger.warn(`parseAndClassify [IVF]: invalid subType "${cls.subType}", returning items without classification`);
        }
      } else if (isEggProvider) {
        const rawSub = String(cls.subType ?? "").toLowerCase().trim();
        const subType = (rawSub === "frozen" ? "frozen" : "fresh") as any;
        classification = { tab: "" as any, subType, isFixedCost, confidence, reasoning, programName, country, serviceTypes, eggDonorSubType: subType };
        this.logger.log(`parseAndClassify [Egg]: ${items.length} items, ${subType} (fixed=${isFixedCost}, name="${programName}", country="${country}", tags=${JSON.stringify(serviceTypes)})`);
      } else {
        // No-subtype provider (surrogacy / sperm bank / etc.)
        classification = { tab: "" as any, subType: "" as any, isFixedCost, confidence, reasoning, programName, country, serviceTypes };
        this.logger.log(`parseAndClassify [${providerTypeName}]: ${items.length} items (fixed=${isFixedCost}, name="${programName}", country="${country}", tags=${JSON.stringify(serviceTypes)})`);
      }

      // Optional multi-program split (a-la-carte fee schedules spanning
      // several journeys - law firms, wellness menus). Validated here so
      // downstream code can trust names/tags/keys; applied by
      // CostsService.applyProgramSplits after items are saved.
      if (classification) {
        const rawSplits = Array.isArray((cls as any).programSplits) ? (cls as any).programSplits : [];
        const programSplits = rawSplits
          .map((sp: any) => ({
            programName: String(sp?.programName || "").trim().slice(0, 60),
            serviceTypes: (Array.isArray(sp?.serviceTypes) ? sp.serviceTypes : [])
              .map((t: any) => String(t).toLowerCase().trim())
              .filter((t: string) => ALLOWED_TAGS.has(t)),
            itemKeys: (Array.isArray(sp?.itemKeys) ? sp.itemKeys : []).map((k: any) => String(k)),
          }))
          .filter((sp: any) => sp.programName && sp.itemKeys.length > 0);
        if (programSplits.length >= 2) {
          (classification as any).programSplits = programSplits;
          this.logger.log(`parseAndClassify: multi-program split proposed - ${programSplits.map((s2: any) => `"${s2.programName}"(${s2.itemKeys.length})`).join(", ")}`);
        }
      }
    } else {
      // Diagnostic: log what keys WERE in the parsed response so we can
      // tell if Gemini omitted the classification block entirely vs. the
      // response was truncated mid-block (in which case parsed would have
      // an "items" array but no "classification" key, and the response
      // text would end mid-object). Usually means we hit maxOutputTokens.
      const presentKeys = parsed && typeof parsed === "object" ? Object.keys(parsed) : [];
      const tailSnippet = responseText.slice(-200).replace(/\s+/g, " ");
      this.logger.warn(
        `parseAndClassify: missing classification block, returning items only. ` +
        `keys present in parsed=[${presentKeys.join(", ")}]; ` +
        `responseText length=${responseText.length}; tail=${JSON.stringify(tailSnippet)}`,
      );
    }

    return { items, classification };
  }

  /**
   * Second AI pass: given parsed line items + raw document text, classify
   * into {tab, subType, isFixedCost}. Runs after parseFile so the prompt
   * can lean on extracted item names rather than re-OCRing the document.
   *
   * Confidence scoring is advisory only - the clinic must confirm every
   * classification regardless of how confident the AI is.
   */
  async classifyDocument(
    parsedItems: Array<{ category: string; key: string; minValue: number | null; maxValue: number | null; comment: string | null }>,
    originalFileName: string,
    rawTextSnippet?: string,
  ): Promise<ClassificationResult | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.warn("GEMINI_API_KEY not configured, skipping classification");
      return null;
    }

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    const subtypeMenu = ALL_SUBTYPES.map(
      (s) => `  - "${s}" (${TAB_LABEL[TAB_OF[s]]} > ${SUBTYPE_LABEL[s]})`,
    ).join("\n");

    const itemsSummary = parsedItems
      .slice(0, 60)
      .map((i) => {
        const range = i.minValue != null || i.maxValue != null ? ` [$${i.minValue ?? "?"}-$${i.maxValue ?? "?"}]` : "";
        const note = i.comment ? ` (${i.comment.slice(0, 80)})` : "";
        return `  - ${i.category} / ${i.key}${range}${note}`;
      })
      .join("\n");

    const systemPrompt = `You are classifying an IVF clinic cost sheet into one of 10 subtypes across 4 tabs, AND extracting a program label + country.

Tabs and subtypes:
${subtypeMenu}

Rules for picking the SUBTYPE:
- "shipping_embryos_*" only when the document indicates the parent ships frozen embryos to the clinic for transfer (look for: "shipping embryos", "shipped embryos", "frozen embryo transfer from outside", "embryo receiving fee", "embryo thawing").
- "shipping_eggs_sperm_*" when the document indicates the clinic receives raw gametes (eggs and/or sperm) and creates embryos in-house (look for: "shipping eggs", "shipping sperm", "donor egg lot", "gamete receiving fee" combined with embryo creation).
- "ivf_cycle_donor_eggs_*" when explicit donor egg sourcing is mentioned (look for: "donor eggs", "egg donor compensation", "donor egg lot fee").
- "ivf_cycle_*_surrogate_carry" when surrogacy is part of the program (look for: "surrogacy", "GC fee", "gestational carrier", "surrogate compensation", "surrogate's insurance").
- "ivf_cycle_reciprocal" only when explicitly described as reciprocal IVF / partner-IVF / shared-motherhood. Otherwise prefer own/own.
- "egg_freezing_*" when the program is purely retrieval + storage with no transfer step (look for: "egg freezing", "egg banking", "fertility preservation", explicit absence of transfer fees).
- Default for an unmarked basic IVF document: "ivf_cycle_own_eggs_own_carry".

Rules for isFixedCost:
- TRUE when the program advertises a bundled package with included quantities (e.g. "3 retrievals included", "unlimited transfers", "package price covers up to N cycles"). Look for the presence of explicit counts for any of: "${RETRIEVALS_INCLUDED}", "${SPERM_COLLECTIONS_INCLUDED}", "${TRANSFERS_INCLUDED}".
- FALSE when costs are itemized per service with no bundled count (a la-carte pricing).

Rules for PROGRAM NAME:
- Use the program's branded name when the document states one (e.g. "Unlimited IVF Until Live Birth", "Single Cycle with Unlimited Transfers", "Donor Egg + IVF + GC", "Premium Surrogacy Package").
- If the document only describes a generic cycle, derive a concise label like "Single IVF Cycle" / "3 Egg Retrievals Package" / "Shipping Embryos + FET".
- Keep it under 50 characters. Title Case. No quotes.
- Fall back to a short label derived from the filename if the document has no clear program name.

Rules for COUNTRY:
- Use the country where the clinic delivers the program (clinic address, "Mexico City", "Colombia", "Spain", etc.).
- If the document explicitly mentions a country, use that.
- Default to "United States" when nothing in the document indicates otherwise.
- Use the full English country name (e.g. "United States", "Mexico", "Colombia"), not codes.

Output STRICT JSON only, no commentary:
{ "tab": "<tab-id>", "subType": "<subtype-id>", "isFixedCost": <true|false>, "confidence": <0..1>, "reasoning": "<one sentence>", "programName": "<label>", "country": "<country>" }

The "tab" must match the parent of "subType". Confidence: 0.9+ when explicit keywords match; 0.6-0.8 when inferred; <0.5 when guessing.`;

    const userPrompt = `Filename: ${originalFileName}

Parsed line items (${parsedItems.length} total):
${itemsSummary}
${rawTextSnippet ? `\nDocument excerpt (first 1500 chars):\n${rawTextSnippet.slice(0, 1500)}` : ""}`;

    try {
      const model = genAI.getGenerativeModel({
        model: "gemini-3.5-flash",
        generationConfig: {
          temperature: 0,
          // 32k headroom: a 30-item cost sheet with descriptions + comments
          // can run 8-10k tokens for the items alone before we even get to
          // the classification block. The previous 8192 ceiling was being
          // hit mid-response - the items array survived (it's first in the
          // JSON output) but the classification object got truncated off
          // the end, which is why subType / isFixedCost / serviceTypes /
          // programName / country were all coming back empty on long sheets.
          // Gemini 2.0+ Flash supports up to 32768 output tokens, so we
          // give it the full budget.
          maxOutputTokens: 32768,
          // JSON mode: Gemini's decoder is supposed to mask every next-
          // token candidate against the JSON grammar at inference time so
          // it can't emit syntactically broken output. In practice we still
          // see occasional broken JSON (see the server log "strict JSON.
          // parse failed; jsonrepair recovered" warnings), so jsonrepair
          // stays as a middle fallback. JSON mode does still help by
          // increasing the rate at which strict parse succeeds and by
          // discouraging the model from veering into prose.
          responseMimeType: "application/json",
        } as any,
      });
      const timeoutMs = 45000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Classification timed out")), timeoutMs),
      );
      const result = await Promise.race([
        model.generateContent(`${systemPrompt}\n\n${userPrompt}`),
        timeoutPromise,
      ]);
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn(`Classification: no JSON in response: ${text.slice(0, 300)}`);
        return null;
      }
      const parsed = JSON.parse(jsonMatch[0]);

      // Validate the proposed subtype + tab pair against our enum.
      const subType = String(parsed.subType ?? "") as SubType;
      if (!(ALL_SUBTYPES as string[]).includes(subType)) {
        this.logger.warn(`Classification returned unknown subType: ${parsed.subType}`);
        return null;
      }
      const tab = TAB_OF[subType];
      const confidence = typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
      const isFixedCost = parsed.isFixedCost === true;
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 280) : "";

      const rawName = typeof parsed.programName === "string" ? parsed.programName.trim().replace(/^["'`]|["'`]$/g, "") : "";
      const programName = rawName.length > 0 && rawName.length <= 80
        ? rawName
        : (originalFileName.replace(/\.(pdf|xlsx?|csv)$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled Program");

      const rawCountry = typeof parsed.country === "string" ? parsed.country.trim() : "";
      const country = rawCountry.length > 0 && rawCountry.length <= 60 ? rawCountry : "United States";

      this.logger.log(`Classified document as ${subType} (fixed=${isFixedCost}, conf=${confidence.toFixed(2)}, name="${programName}", country="${country}"): ${reasoning}`);
      return { tab, subType, isFixedCost, confidence, reasoning, programName, country, serviceTypes: ["ivf_clinic"] };
    } catch (err: any) {
      this.logger.warn(`Classification failed: ${err.message}`);
      return null;
    }
  }

  private parseJsonResponse(text: string): Array<{
    category: string;
    key: string;
    minValue: number | null;
    maxValue: number | null;
    isCustom: boolean;
    isIncluded: boolean;
    isTier: boolean;
    comment: string | null;
  }> {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      this.logger.error(`Failed to extract JSON from AI response: ${text.substring(0, 500)}`);
      throw new Error("AI did not return valid JSON");
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) throw new Error("Response is not an array");

      return this.enforceCycleTierGrouping(
        parsed.map((item: any) => ({
          category: String(item.category || "Other"),
          key: String(item.key || "Unknown"),
          minValue: item.minValue != null ? Number(item.minValue) : null,
          maxValue: item.maxValue != null ? Number(item.maxValue) : null,
          isCustom: Boolean(item.isCustom),
          isIncluded: item.isIncluded !== false,
          isTier: item.isTier === true,
          comment: item.comment ? String(item.comment) : null,
        })),
      );
    } catch (e) {
      this.logger.error(`Failed to parse AI JSON: ${e}`);
      throw new Error("Failed to parse AI response as JSON");
    }
  }

  /**
   * Deterministic guard for mutually-exclusive package tiers.
   *
   * A document that prices the same service at several quantities the parent
   * picks ONE of ("One Cycle" / "Two Cycles" / "Three Cycles" / "Unlimited ...
   * Until Live Birth") is a PRICING TIER menu, not a list of additive line
   * items. The AI is instructed to flag these isTier=true (see the TIERED
   * PACKAGE PRICING prompt rule) but occasionally emits them as plain
   * included line items - which then DOUBLE-COUNT into one inflated total
   * (e.g. 6,500 + 10,500 + 13,500 + 20,000 = 50,500 for a sheet whose real
   * options are 6,500 OR 10,500 OR 13,500 OR 20,000). This normalizes that
   * structurally: within a category, when 2+ items carry a cycle-count or
   * unlimited-package qualifier, force them to tiers. It corrects the flag on
   * data that already exists in the parse - it never fabricates an item.
   */
  private enforceCycleTierGrouping<
    T extends { category: string; key: string; isTier: boolean; isIncluded: boolean },
  >(items: T[]): T[] {
    // A key denotes a tier option when it carries a count-of-cycles token
    // ("One Cycle", "2 Cycles", "Single Cycle") or an unlimited-package token
    // tied to transfers / cycles / live birth. "IVF Cycle" (no count word)
    // and plain "Embryo Transfer" do NOT match, so required baseline items
    // are left alone.
    const countCycleRe = /\b(single|one|two|three|four|five|six|\d+)\s+cycles?\b/i;
    const unlimitedRe = /\bunlimited\b[\s\S]*\b(transfer|cycle|package|live\s*birth)/i;
    const isTierCandidate = (key: string) => countCycleRe.test(key) || unlimitedRe.test(key);

    // Tiers compete within the same service grouping (category), not across
    // unrelated categories.
    const byCategory = new Map<string, T[]>();
    for (const item of items) {
      if (!isTierCandidate(item.key)) continue;
      const cat = item.category || "Other";
      const group = byCategory.get(cat);
      if (group) group.push(item);
      else byCategory.set(cat, [item]);
    }

    for (const group of byCategory.values()) {
      // A lone "One Cycle" line is a genuine required cost, not a menu. Only
      // flip to tiers when there are 2+ mutually-exclusive alternatives.
      if (group.length < 2) continue;
      for (const item of group) {
        if (!item.isTier) {
          item.isTier = true;
          item.isIncluded = true; // tiers are real prices, never optional add-ons
        }
      }
    }
    return items;
  }
}
