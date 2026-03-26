import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CostsAiService {
  private readonly logger = new Logger(CostsAiService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async parseFile(
    fileBuffer: Buffer,
    contentType: string,
    providerTypeName: string,
    originalFileName: string,
  ): Promise<
    Array<{
      category: string;
      key: string;
      minValue: number | null;
      maxValue: number | null;
      isCustom: boolean;
      isIncluded: boolean;
      comment: string | null;
    }>
  > {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);

    const providerType = await this.prisma.providerType.findFirst({
      where: { name: { contains: providerTypeName, mode: "insensitive" } },
    });
    const templates = providerType
      ? await this.prisma.costTemplate.findMany({
          where: { providerTypeId: providerType.id },
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

    const systemPrompt = `You are a fertility industry cost sheet parser. Extract cost line items from the provided document.

${templateContext}
${exclusionRules}

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
        model: "gemini-2.5-flash",
        generationConfig: { temperature: 0 } as any,
      });

      const result = await model.generateContent(
        `${systemPrompt}\n\nDocument content (CSV):\n${textContent}`,
      );
      const responseText = result.response.text();
      return this.parseJsonResponse(responseText);
    } else {
      const base64Data = fileBuffer.toString("base64");

      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { temperature: 0 } as any,
      });

      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: contentType,
            data: base64Data,
          },
        },
        { text: systemPrompt + "\n\nParse the cost items from this document." },
      ]);
      const responseText = result.response.text();
      return this.parseJsonResponse(responseText);
    }
  }

  private parseJsonResponse(text: string): Array<{
    category: string;
    key: string;
    minValue: number | null;
    maxValue: number | null;
    isCustom: boolean;
    isIncluded: boolean;
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

      return parsed.map((item: any) => ({
        category: String(item.category || "Other"),
        key: String(item.key || "Unknown"),
        minValue: item.minValue != null ? Number(item.minValue) : null,
        maxValue: item.maxValue != null ? Number(item.maxValue) : null,
        isCustom: Boolean(item.isCustom),
        isIncluded: item.isIncluded !== false,
        comment: item.comment ? String(item.comment) : null,
      }));
    } catch (e) {
      this.logger.error(`Failed to parse AI JSON: ${e}`);
      throw new Error("Failed to parse AI response as JSON");
    }
  }
}
