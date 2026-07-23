/**
 * Intended Parent Form PDF generator (pdfkit, pattern: receipt-pdf.ts).
 *
 * Mirrors the previous GoStork platform's form PDFs: every page carries the
 * downloading AGENCY'S logo and a rounded border; sections render as a big
 * title in the agency brand color followed by label-over-boxed-value rows;
 * per-parent sections repeat per parent; the letter flows across pages;
 * photos render in a 2-column grid; the acknowledgment repeats the legal
 * text (with {{AGENCY_NAME}} substituted) + signature image per parent.
 *
 * Variants:
 *   full      - everything (agency records)
 *   surrogate - sections/questions flagged excludeFromSurrogatePdf are
 *               stripped (private info, contact details, DOB, IDs)
 *
 * All remote images (agency logo, parent photos, signature PNGs) may live in
 * the private GCS bucket - fetchImageBuffer signs GCS URLs before fetching.
 * A single failed photo never fails the document.
 */
import PDFDocument from "pdfkit";
import { prisma } from "./db";
import { IP_FORM_ACKNOWLEDGMENT_TEXT } from "./ip-form-defaults";

const DEFAULT_PRIMARY = "#08726F"; // GoStork teal
const TEXT_DARK = "#1f2937";
const TEXT_MUTED = "#6b7280";
const VALUE_BG = "#f0f0ef";

const PAGE_MARGIN = 50;
const HEADER_H = 110; // logo zone at the top of every page
const FOOTER_LIMIT = 742; // LETTER height 792 - 50

interface PdfQuestion {
  id: string;
  key: string;
  label: string;
  widget: string;
  perParent: boolean;
  excludeFromSurrogatePdf: boolean;
  conditionalOnQuestionId: string | null;
  conditionalTriggerValue: string | null;
  isActive: boolean;
}

interface PdfSection {
  id: string;
  key: string;
  title: string;
  description: string | null;
  perParent: boolean;
  excludeFromSurrogatePdf: boolean;
  questions: PdfQuestion[];
}

interface PdfAnswer {
  questionId: string;
  parentSlot: number; // 0 = shared, 1 | 2 per-parent
  value: any;
}

interface PdfSignature {
  parentSlot: number;
  fullLegalName: string;
  signatureImageUrl: string;
  signedAt: Date;
}

export interface IpFormPdfBrand {
  agencyName: string;
  primaryColor: string;
  logoBuffer: Buffer | null;
}

/** Sign a private-GCS URL (uniform bucket-level access) so it can be fetched. */
async function signIfGcs(url: string): Promise<string> {
  if (!url || !url.includes("storage.googleapis.com")) return url;
  try {
    const { Storage } = await import("@google-cloud/storage");
    const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
    if (!keyJson) return url;
    const credentials = JSON.parse(keyJson);
    const storage = new Storage({ credentials });
    const bucketName = process.env.GCS_BUCKET_NAME || "gostork-recordings";
    const urlObj = new URL(url);
    const objectPath = decodeURIComponent(urlObj.pathname.slice(`/${bucketName}/`.length));
    const [signed] = await storage.bucket(bucketName).file(objectPath).getSignedUrl({
      action: "read",
      expires: Date.now() + 60 * 60 * 1000,
    });
    return signed;
  } catch {
    return url;
  }
}

/** Fetch an image to a Buffer; relative /uploads paths resolve via base URL. Null on any failure. */
export async function fetchImageBuffer(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null;
  try {
    let resolved = url;
    if (resolved.startsWith("/")) {
      const { getBaseUrl } = await import("./src/lib/get-base-url");
      resolved = `${getBaseUrl()}${resolved}`;
    }
    resolved = await signIfGcs(resolved);
    const res = await fetch(resolved);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Human string for an answer value, by widget. */
function displayValue(widget: string, value: any): string {
  if (value == null) return "";
  if (widget === "yes_no") {
    const v = String(value).toLowerCase();
    return v === "yes" ? "Yes" : v === "no" ? "No" : String(value);
  }
  if (widget === "address" && typeof value === "object" && !Array.isArray(value)) {
    // apt sits right after the street line: "45 W 60th St, Apt 30A, New York..."
    return [value.address, value.apt, value.city, value.state, value.zip, value.country].filter((p) => p && String(p).trim()).join(", ");
  }
  if (widget === "phone" && typeof value === "object" && !Array.isArray(value)) {
    return value.display || value.e164 || "";
  }
  if (widget === "date" && typeof value === "string" && value) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : fmtDate(d);
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return Object.values(value).filter(Boolean).join(", ");
  return String(value);
}

function normalized(v: any): string {
  return v == null ? "" : String(v).trim().toLowerCase();
}

/**
 * Load everything and render the PDF for one provider (or unbranded GoStork
 * when providerId is null - admin download).
 */
export async function buildIpFormPdfForProvider(opts: {
  responseId: string;
  providerId: string | null;
  variant: "full" | "surrogate";
}): Promise<{ buffer: Buffer; fileName: string }> {
  const response = await prisma.ipFormResponse.findUnique({ where: { id: opts.responseId } });
  if (!response) throw new Error("Response not found");

  const sections = (await prisma.ipFormSection.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    include: { questions: { orderBy: { sortOrder: "asc" } } },
  })) as unknown as PdfSection[];

  const answers = (await prisma.ipFormAnswer.findMany({ where: { responseId: response.id } })) as unknown as PdfAnswer[];
  const signatureRows = (await prisma.ipFormSignature.findMany({
    where: { responseId: response.id },
    orderBy: { parentSlot: "asc" },
  })) as unknown as PdfSignature[];

  // Brand: the downloading agency's logo + color; GoStork site brand fallback.
  let agencyName = "GoStork";
  let primaryColor = DEFAULT_PRIMARY;
  let logoUrl: string | null = null;
  if (opts.providerId) {
    const provider = await prisma.provider.findUnique({
      where: { id: opts.providerId },
      select: { name: true, logoUrl: true },
    });
    const brandSettings = await prisma.providerBrandSettings.findUnique({
      where: { providerId: opts.providerId },
      select: { primaryColor: true, logoUrl: true },
    }).catch(() => null);
    agencyName = provider?.name || agencyName;
    primaryColor = brandSettings?.primaryColor || primaryColor;
    logoUrl = brandSettings?.logoUrl || provider?.logoUrl || null;
  } else {
    const settings = await prisma.siteSettings.findFirst({ select: { companyName: true, primaryColor: true, logoUrl: true } }).catch(() => null);
    if (settings) {
      agencyName = (settings as any).companyName || agencyName;
      primaryColor = (settings as any).primaryColor || primaryColor;
      logoUrl = (settings as any).logoUrl || null;
    }
  }
  const logoBuffer = await fetchImageBuffer(logoUrl);

  // Pre-fetch photos + signatures (photos only for pages that render them).
  const photoQuestion = sections.flatMap((s) => s.questions).find((q) => q.widget === "photos");
  const photoUrls: string[] = [];
  if (photoQuestion) {
    const a = answers.find((x) => x.questionId === photoQuestion.id);
    if (Array.isArray(a?.value)) for (const u of a!.value) if (typeof u === "string") photoUrls.push(u);
  }
  const photoBuffers = (await Promise.all(photoUrls.map((u) => fetchImageBuffer(u)))).filter(Boolean) as Buffer[];
  const signatureBuffers = new Map<number, Buffer>();
  for (const sig of signatureRows) {
    const buf = await fetchImageBuffer(sig.signatureImageUrl);
    if (buf) signatureBuffers.set(sig.parentSlot, buf);
  }

  const nameQ = sections.flatMap((s) => s.questions).find((q) => q.key === "ip_full_legal_name");
  const names: string[] = [];
  for (const slot of [1, 2]) {
    const a = nameQ ? answers.find((x) => x.questionId === nameQ.id && x.parentSlot === slot) : null;
    if (a && typeof a.value === "string" && a.value.trim()) names.push(a.value.trim());
  }
  const namePart = names.length ? names.join(" & ") : "Intended Parents";

  const buffer = await generateIpFormPdf({
    sections,
    answers,
    signatures: signatureRows,
    signatureBuffers,
    photoBuffers,
    hasSecondParent: response.hasSecondParent,
    submittedAt: response.submittedAt,
    brand: { agencyName, primaryColor, logoBuffer },
    variant: opts.variant,
  });

  const safe = (s: string) => s.replace(/[^\w\s&.-]/g, "").trim();
  const suffix = opts.variant === "surrogate" ? " (Surrogate Version)" : "";
  return { buffer, fileName: `Intended Parent Form - ${safe(namePart)}${suffix}.pdf` };
}

export function generateIpFormPdf(args: {
  sections: PdfSection[];
  answers: PdfAnswer[];
  signatures: PdfSignature[];
  signatureBuffers: Map<number, Buffer>;
  photoBuffers: Buffer[];
  hasSecondParent: boolean;
  submittedAt: Date | null;
  brand: IpFormPdfBrand;
  variant: "full" | "surrogate";
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const { brand, variant, hasSecondParent } = args;
      const primary = (brand.primaryColor || DEFAULT_PRIMARY).trim() || DEFAULT_PRIMARY;

      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: HEADER_H, bottom: 40, left: PAGE_MARGIN, right: PAGE_MARGIN },
        info: { Title: "Intended Parent Form", Author: brand.agencyName },
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width;
      const contentLeft = PAGE_MARGIN;
      const contentRight = pageWidth - PAGE_MARGIN;
      const contentWidth = contentRight - contentLeft;

      const drawPageChrome = () => {
        // Rounded page border (like the legacy form) + agency logo/name.
        doc.save();
        doc.roundedRect(18, 18, pageWidth - 36, doc.page.height - 36, 14).lineWidth(1.2).stroke(primary);
        if (brand.logoBuffer) {
          try {
            doc.image(brand.logoBuffer, contentLeft, 36, { fit: [120, 48] });
          } catch { /* bad image bytes - name only */ }
        } else {
          doc.fillColor(primary).font("Helvetica-Bold").fontSize(14).text(brand.agencyName, contentLeft, 42, {
            width: contentWidth,
            lineBreak: false,
            ellipsis: true,
          });
        }
        doc.restore();
      };

      drawPageChrome();
      doc.on("pageAdded", drawPageChrome);

      const answerMap = new Map<string, any>();
      for (const a of args.answers) answerMap.set(`${a.questionId}:${a.parentSlot || 0}`, a.value);
      const questionById = new Map<string, PdfQuestion>();
      for (const s of args.sections) for (const q of s.questions) questionById.set(q.id, q);

      const ensureSpace = (needed: number) => {
        if (doc.y + needed > FOOTER_LIMIT) doc.addPage();
      };

      const sectionTitle = (title: string) => {
        ensureSpace(60);
        doc.fillColor(primary).font("Helvetica-Bold").fontSize(22).text(title, contentLeft, doc.y, { width: contentWidth });
        doc.moveDown(0.5);
      };

      const subHeading = (text: string) => {
        ensureSpace(40);
        doc.fillColor(TEXT_DARK).font("Helvetica-Bold").fontSize(13).text(text, contentLeft, doc.y, { width: contentWidth });
        doc.moveDown(0.4);
      };

      const paragraph = (text: string, color = TEXT_MUTED) => {
        ensureSpace(40);
        doc.fillColor(color).font("Helvetica").fontSize(10).text(text, contentLeft, doc.y, { width: contentWidth });
        doc.moveDown(0.5);
      };

      /** Label over a filled value box, full content width. */
      const questionRow = (label: string, value: string) => {
        doc.font("Helvetica").fontSize(10);
        const labelH = doc.heightOfString(label, { width: contentWidth });
        const valueText = value || " ";
        const valueH = Math.max(18, doc.heightOfString(valueText, { width: contentWidth - 16 }) + 10);
        ensureSpace(labelH + valueH + 14);
        doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(10).text(label, contentLeft, doc.y, { width: contentWidth });
        const boxY = doc.y + 3;
        doc.roundedRect(contentLeft, boxY, contentWidth, valueH, 3).fill(VALUE_BG);
        doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(10).text(valueText, contentLeft + 8, boxY + 5, { width: contentWidth - 16 });
        doc.y = boxY + valueH + 10;
        doc.x = contentLeft;
      };

      /** Answer lookup respecting slot; conditional visibility check. */
      const answerFor = (q: PdfQuestion, slot: number) => answerMap.get(`${q.id}:${slot}`);
      const conditionMet = (q: PdfQuestion, slot: number, sectionPerParent: boolean): boolean => {
        if (!q.conditionalOnQuestionId) return true;
        const parent = questionById.get(q.conditionalOnQuestionId);
        if (!parent) return true;
        const parentSlot = parent.perParent || sectionPerParent ? slot : 0;
        return normalized(answerMap.get(`${q.conditionalOnQuestionId}:${parentSlot}`)) === normalized(q.conditionalTriggerValue);
      };

      const renderQuestions = (section: PdfSection, questions: PdfQuestion[], slot: number) => {
        for (const q of questions) {
          if (!q.isActive) {
            // Deactivated questions still render when they carry an answer.
            if (answerFor(q, slot) == null) continue;
          }
          if (variant === "surrogate" && q.excludeFromSurrogatePdf) continue;
          if (q.widget === "photos") continue; // rendered by the photos section grid
          if (!conditionMet(q, slot, section.perParent)) continue;
          let raw = answerFor(q, slot);
          // Mailing address defaults to "same as residential" - an absent
          // answer or an explicit sameAsResidential flag both resolve to the
          // residential address for this slot.
          if (q.key === "ip_mailing_address" && (raw == null || raw.sameAsResidential)) {
            const residentialQ = section.questions.find((x) => x.key === "ip_residential_address");
            raw = residentialQ ? answerFor(residentialQ, slot) : raw;
          }
          questionRow(q.label, displayValue(q.widget, raw));
        }
      };

      const slots: (1 | 2)[] = hasSecondParent ? [1, 2] : [1];

      for (const section of args.sections) {
        if (variant === "surrogate" && section.excludeFromSurrogatePdf) continue;
        const activeQuestions = section.questions.filter(
          (q) => (q.isActive || answerMap.has(`${q.id}:0`) || answerMap.has(`${q.id}:1`) || answerMap.has(`${q.id}:2`)) &&
            !(variant === "surrogate" && q.excludeFromSurrogatePdf),
        );

        // ── Photos: 2-column grid of pre-fetched buffers ──
        if (section.key === "photos") {
          if (!args.photoBuffers.length) continue;
          doc.addPage();
          sectionTitle(section.title);
          const cell = (contentWidth - 24) / 2;
          let col = 0;
          let rowY = doc.y + 6;
          for (const photo of args.photoBuffers) {
            if (rowY + cell > FOOTER_LIMIT) {
              doc.addPage();
              sectionTitle(`${section.title} (Continued)`);
              rowY = doc.y + 6;
              col = 0;
            }
            const x = contentLeft + col * (cell + 24);
            try {
              doc.image(photo, x, rowY, { fit: [cell, cell] });
            } catch { /* skip unreadable image */ }
            col++;
            if (col === 2) {
              col = 0;
              rowY += cell + 24;
            }
          }
          doc.y = col === 0 ? rowY : rowY + cell + 24;
          continue;
        }

        // ── Acknowledgment: legal text + signature per parent ──
        if (section.key === "acknowledgment") {
          doc.addPage();
          sectionTitle(section.title);
          const legalText = (section.description || IP_FORM_ACKNOWLEDGMENT_TEXT).replace(/\{\{AGENCY_NAME\}\}/g, brand.agencyName);
          for (const slot of slots) {
            const sig = args.signatures.find((s) => s.parentSlot === slot);
            ensureSpace(230);
            paragraph(legalText, TEXT_DARK);
            doc.moveDown(0.4);
            doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(10).text(`Intended Parent ${slot} (Full Legal Name)`, contentLeft, doc.y);
            const nameBoxY = doc.y + 3;
            doc.roundedRect(contentLeft, nameBoxY, contentWidth, 20, 3).fill(VALUE_BG);
            doc.fillColor(TEXT_DARK).fontSize(10).text(sig?.fullLegalName || "", contentLeft + 8, nameBoxY + 6);
            doc.y = nameBoxY + 28;
            doc.x = contentLeft;
            doc.fillColor(TEXT_DARK).fontSize(10).text("Signature", contentLeft, doc.y);
            const sigBuf = args.signatureBuffers.get(slot);
            const sigY = doc.y + 3;
            if (sigBuf) {
              try {
                doc.image(sigBuf, contentLeft + 8, sigY, { fit: [180, 60] });
              } catch { /* unreadable signature image */ }
            }
            doc.y = sigY + 66;
            doc.x = contentLeft;
            doc.fillColor(TEXT_DARK).fontSize(10).text("Date", contentLeft, doc.y);
            const dateBoxY = doc.y + 3;
            doc.roundedRect(contentLeft, dateBoxY, contentWidth, 20, 3).fill(VALUE_BG);
            doc.fillColor(TEXT_DARK).fontSize(10).text(sig ? fmtDate(new Date(sig.signedAt)) : "", contentLeft + 8, dateBoxY + 6);
            doc.y = dateBoxY + 40;
            doc.x = contentLeft;
          }
          continue;
        }

        if (!activeQuestions.length) continue;
        doc.addPage();

        // ── Per-parent SECTION: repeat whole section per parent ──
        if (section.perParent) {
          for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (i > 0) doc.addPage();
            sectionTitle(`Intended Parent ${slot} | ${section.title}`);
            if (section.description) paragraph(section.description);
            renderQuestions(section, activeQuestions, slot);
          }
          continue;
        }

        // ── Shared section (may contain per-parent question blocks) ──
        sectionTitle(section.title);
        if (section.description) paragraph(section.description);
        const perParentQs = activeQuestions.filter((q) => q.perParent);
        const sharedQs = activeQuestions.filter((q) => !q.perParent);
        if (perParentQs.length) {
          for (const slot of slots) {
            subHeading(`Intended Parent (${slot})`);
            renderQuestions(section, perParentQs, slot);
          }
        }
        renderQuestions(section, sharedQs, 0);
      }

      (doc as any).flushPages?.();
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
