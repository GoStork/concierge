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
const HEADER_H = 92; // logo zone at the top of every page
const FOOTER_LIMIT = 750; // LETTER height 792 - 42

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
  appliesTo?: string[];
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
  // Clinic name is stored as { name, providerId } (directory autocomplete).
  if (typeof value === "object" && !Array.isArray(value) && typeof value.name === "string" && !("address" in value) && !("e164" in value)) {
    return value.name;
  }
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
  // Program types the downloading provider represents; sections are filtered to
  // core + these tags. Null/undefined = no filter (admin sees everything).
  programTypes?: string[] | null;
}): Promise<{ buffer: Buffer; fileName: string }> {
  const response = await prisma.ipFormResponse.findUnique({ where: { id: opts.responseId } });
  if (!response) throw new Error("Response not found");

  // Global template questions only - custom questions of OTHER providers must
  // never print on this provider's PDF; this provider's own are merged below.
  let sections = (await prisma.ipFormSection.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    include: { questions: { where: { providerId: null }, orderBy: { sortOrder: "asc" } } },
  })) as unknown as PdfSection[];
  // Restrict to the provider's program (surrogacy agency -> surrogacy sections;
  // IVF clinic -> core + ivf). A core section (no appliesTo) always shows.
  if (opts.programTypes && opts.programTypes.length) {
    const pt = opts.programTypes;
    sections = sections.filter((s) => !(s.appliesTo || []).length || (s.appliesTo || []).some((t) => pt.includes(t)));
  }
  // Per-provider Parent Form adjustments: drop hidden sections/questions,
  // apply label/help overrides, merge this provider's custom questions.
  if (opts.providerId) {
    const [overrides, customQs] = await Promise.all([
      prisma.ipFormProviderOverride.findMany({ where: { providerId: opts.providerId } }),
      prisma.ipFormQuestion.findMany({ where: { providerId: opts.providerId }, orderBy: { sortOrder: "asc" } }),
    ]);
    if (overrides.length || customQs.length) {
      const byTarget = new Map(overrides.map((o) => [`${o.targetType}:${o.targetId}`, o]));
      sections = sections
        .filter((s) => !byTarget.get(`section:${s.id}`)?.hidden)
        .map((s) => {
          let questions = s.questions.filter((q) => !byTarget.get(`question:${q.id}`)?.hidden);
          questions = questions.map((q) => {
            const o = byTarget.get(`question:${q.id}`);
            return o ? { ...q, label: o.label ?? q.label } : q;
          });
          const custom = customQs.filter((q) => q.sectionId === s.id) as unknown as PdfQuestion[];
          if (custom.length) questions = [...questions, ...custom].sort((a: any, b: any) => a.sortOrder - b.sortOrder);
          const so = byTarget.get(`section:${s.id}`);
          return { ...s, title: so?.label || s.title, questions };
        });
    }
  }

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
  // ID-document photocopies (file widget): pre-fetch image scans per parent so
  // the PDF can render them; PDFs/other files render as an "attached" note.
  const photocopyBuffers = new Map<number, Buffer>();
  const fileQuestions = sections.flatMap((s) => s.questions).filter((q) => q.widget === "file");
  for (const fq of fileQuestions) {
    for (const slot of [1, 2]) {
      const a = answers.find((x) => x.questionId === fq.id && (x.parentSlot || 0) === slot);
      const val = a?.value as any;
      const url = val && typeof val === "object" ? val.url : typeof val === "string" ? val : null;
      const ct = val && typeof val === "object" ? String(val.contentType || "") : "";
      if (url && (ct.startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(String(url)))) {
        const buf = await fetchImageBuffer(url);
        if (buf) photocopyBuffers.set(slot, buf);
      }
    }
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
    photocopyBuffers,
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
  photocopyBuffers?: Map<number, Buffer>;
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

      // Compact layout: short fields pack two per row, long fields (textarea /
      // address) span the full width. This mirrors the legacy form so each
      // section fits its page instead of orphaning a couple of fields onto the
      // next one. When a section genuinely overflows, the continuation page
      // reprints "<Title> (Continued)".
      const GUTTER = 16;
      const colWidth = (contentWidth - GUTTER) / 2;
      const LABEL_SIZE = 9;
      const VALUE_SIZE = 9.5;
      const BOX_PAD_X = 7;
      const BOX_MIN_SHORT = 16;
      const BOX_MIN_TALL = 30; // multi-line answers (textarea) get a taller box
      const ROW_GAP = 6;

      // The section title reprinted on any mid-section page break. Null while a
      // title is being drawn (so its own space check doesn't reprint itself).
      let activeSectionTitle: string | null = null;

      const ensureSpace = (needed: number) => {
        if (doc.y + needed > FOOTER_LIMIT) {
          doc.addPage();
          if (activeSectionTitle) {
            doc.fillColor(primary).font("Helvetica-Bold").fontSize(20).text(`${activeSectionTitle} (Continued)`, contentLeft, doc.y, { width: contentWidth });
            doc.moveDown(0.4);
          }
        }
      };

      const sectionTitle = (title: string) => {
        activeSectionTitle = null;
        ensureSpace(50);
        doc.fillColor(primary).font("Helvetica-Bold").fontSize(20).text(title, contentLeft, doc.y, { width: contentWidth });
        doc.moveDown(0.4);
        activeSectionTitle = title;
      };

      const subHeading = (text: string) => {
        ensureSpace(36);
        doc.fillColor(primary).font("Helvetica-Bold").fontSize(12).text(text, contentLeft, doc.y, { width: contentWidth });
        doc.moveDown(0.15);
      };

      const paragraph = (text: string, color = TEXT_MUTED) => {
        ensureSpace(40);
        doc.fillColor(color).font("Helvetica").fontSize(10).text(text, contentLeft, doc.y, { width: contentWidth });
        doc.moveDown(0.5);
      };

      const labelH = (label: string, w: number) => {
        doc.font("Helvetica").fontSize(LABEL_SIZE);
        return doc.heightOfString(label, { width: w });
      };
      const boxH = (value: string, w: number, tall: boolean) => {
        doc.font("Helvetica").fontSize(VALUE_SIZE);
        const h = doc.heightOfString(value || " ", { width: w - BOX_PAD_X * 2 });
        return Math.max(tall ? BOX_MIN_TALL : BOX_MIN_SHORT, h + 8);
      };
      const cellH = (label: string, value: string, w: number, tall: boolean) => labelH(label, w) + 2 + boxH(value, w, tall);

      /** Draw one label-over-boxed-value cell at (x,y); returns the content bottom Y.
       *  A tall box whose text exceeds the page (a long letter) fills its
       *  background only to the page bottom and lets the text flow onto the next
       *  pages, so it never wastes a blank page or leaves the value clipped. */
      const drawCell = (x: number, y: number, w: number, label: string, value: string, tall: boolean) => {
        doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(LABEL_SIZE).text(label, x, y, { width: w });
        const lh = labelH(label, w);
        const by = y + lh + 2;
        const bh = boxH(value, w, tall);
        const overflows = tall && by + bh > FOOTER_LIMIT;
        const fillH = overflows ? FOOTER_LIMIT - by : bh;
        if (fillH > 4) doc.roundedRect(x, by, w, fillH, 3).fill(VALUE_BG);
        doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(VALUE_SIZE).text(value || " ", x + BOX_PAD_X, by + 4, { width: w - BOX_PAD_X * 2 });
        // For flowed text, doc.y is already the true end on the last page.
        return overflows ? doc.y : by + bh;
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

      // Full-width widgets span the page; only free-text (textarea) also gets a
      // taller box. Addresses span full width but stay single-line height.
      const isFullWidth = (widget: string) => widget === "textarea" || widget === "address";
      const isTall = (widget: string) => widget === "textarea";

      const renderQuestions = (section: PdfSection, questions: PdfQuestion[], slot: number) => {
        // Build the visible items first, then lay them out (short fields 2-up).
        const items: { label: string; value: string; fullWidth: boolean; tall: boolean; fileSlot?: number }[] = [];
        for (const q of questions) {
          if (!q.isActive && answerFor(q, slot) == null) continue; // deactivated but answered still prints
          if (variant === "surrogate" && q.excludeFromSurrogatePdf) continue;
          if (q.widget === "photos") continue; // rendered by the photos grid
          if (q.key === "clinic_none") continue; // the escape checkbox is not a printed field
          if (!conditionMet(q, slot, section.perParent)) continue;
          let raw = answerFor(q, slot);
          // Mailing address defaults to "same as residential".
          if (q.key === "ip_mailing_address" && (raw == null || raw.sameAsResidential)) {
            const residentialQ = section.questions.find((x) => x.key === "ip_residential_address");
            raw = residentialQ ? answerFor(residentialQ, slot) : raw;
          }
          // ID document photocopy (file widget): render the scan if it's an
          // image, else a note. Skip entirely when no file was uploaded.
          if (q.widget === "file") {
            const val = raw as any;
            const name = val && typeof val === "object" ? String(val.name || "") : "";
            const hasFile = !!(val && (typeof val === "string" ? val : val.url));
            if (!hasFile) continue;
            const hasImg = args.photocopyBuffers?.has(slot);
            items.push({ label: q.label, value: hasImg ? "" : `Attached: ${name || "ID document"}`, fullWidth: true, tall: false, fileSlot: slot });
            continue;
          }
          items.push({ label: q.label, value: displayValue(q.widget, raw), fullWidth: isFullWidth(q.widget), tall: isTall(q.widget) });
        }

        let i = 0;
        while (i < items.length) {
          const it = items[i];
          if (it.fileSlot != null) {
            const buf = args.photocopyBuffers?.get(it.fileSlot);
            const imgH = buf ? 150 : 0;
            ensureSpace(labelH(it.label, contentWidth) + (buf ? imgH : BOX_MIN_SHORT) + ROW_GAP + 6);
            doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(LABEL_SIZE).text(it.label, contentLeft, doc.y, { width: contentWidth });
            let y = doc.y + labelH(it.label, contentWidth) + 2;
            if (buf) {
              try { doc.image(buf, contentLeft, y, { fit: [200, imgH] }); } catch { /* skip */ }
              y += imgH;
            } else {
              const bh = boxH(it.value, contentWidth, false);
              doc.roundedRect(contentLeft, y, contentWidth, bh, 3).fill(VALUE_BG);
              doc.fillColor(TEXT_DARK).font("Helvetica").fontSize(VALUE_SIZE).text(it.value, contentLeft + BOX_PAD_X, y + 4, { width: contentWidth - BOX_PAD_X * 2 });
              y += bh;
            }
            doc.y = y + ROW_GAP;
            doc.x = contentLeft;
            i++;
            continue;
          }
          if (it.fullWidth) {
            // A tall box (letter) only needs room to START on this page - it
            // flows onto following pages. A single-line full-width box (address)
            // must fit whole.
            const need = it.tall ? labelH(it.label, contentWidth) + BOX_MIN_TALL + ROW_GAP : cellH(it.label, it.value, contentWidth, false) + ROW_GAP;
            ensureSpace(need);
            const bottom = drawCell(contentLeft, doc.y, contentWidth, it.label, it.value, it.tall);
            doc.y = bottom + ROW_GAP;
            doc.x = contentLeft;
            i++;
          } else {
            // Pair with the next short field, if any.
            const pair = i + 1 < items.length && !items[i + 1].fullWidth ? items[i + 1] : null;
            const rowH = Math.max(cellH(it.label, it.value, colWidth, false), pair ? cellH(pair.label, pair.value, colWidth, false) : 0);
            ensureSpace(rowH + ROW_GAP);
            const rowTop = doc.y;
            drawCell(contentLeft, rowTop, colWidth, it.label, it.value, false);
            if (pair) drawCell(contentLeft + colWidth + GUTTER, rowTop, colWidth, pair.label, pair.value, false);
            doc.y = rowTop + rowH + ROW_GAP;
            doc.x = contentLeft;
            i += pair ? 2 : 1;
          }
        }
      };

      const slots: (1 | 2)[] = hasSecondParent ? [1, 2] : [1];

      // Each major section starts a fresh page - EXCEPT the first rendered one,
      // which uses the initial page pdfkit already created (no blank page 1).
      let firstSection = true;
      const startSection = () => { if (!firstSection) doc.addPage(); firstSection = false; };

      // The surrogate-facing PDF leads with the parents' Personal Information
      // (the get-to-know-you section) instead of the agency-only Profile.
      let orderedSections = args.sections;
      if (variant === "surrogate") {
        const personal = args.sections.filter((s) => s.key === "personal_info");
        const rest = args.sections.filter((s) => s.key !== "personal_info");
        orderedSections = [...personal, ...rest];
      }

      for (const section of orderedSections) {
        if (variant === "surrogate" && section.excludeFromSurrogatePdf) continue;
        const activeQuestions = section.questions.filter(
          (q) => (q.isActive || answerMap.has(`${q.id}:0`) || answerMap.has(`${q.id}:1`) || answerMap.has(`${q.id}:2`)) &&
            !(variant === "surrogate" && q.excludeFromSurrogatePdf),
        );

        // ── Photos: 2-column grid of pre-fetched buffers ──
        if (section.key === "photos") {
          if (!args.photoBuffers.length) continue;
          startSection();
          sectionTitle(section.title);
          activeSectionTitle = null; // the grid manages its own paging below
          const cell = (contentWidth - 24) / 2;
          let col = 0;
          let rowY = doc.y + 6;
          for (const photo of args.photoBuffers) {
            if (rowY + cell > FOOTER_LIMIT) {
              doc.addPage();
              sectionTitle(`${section.title} (Continued)`);
              activeSectionTitle = null;
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
          startSection();
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

        // ── Per-parent SECTION: one page per parent ──
        if (section.perParent) {
          for (const slot of slots) {
            startSection();
            sectionTitle(`Intended Parent ${slot} | ${section.title}`);
            if (section.description) paragraph(section.description);
            renderQuestions(section, activeQuestions, slot);
          }
          continue;
        }

        // ── Shared section (may contain per-parent question blocks) ──
        startSection();
        sectionTitle(section.title);
        if (section.description) paragraph(section.description);
        // "No fertility clinic yet": print a note instead of empty clinic fields.
        if (section.key === "clinic") {
          const noneQ = section.questions.find((q) => q.key === "clinic_none");
          if (noneQ && normalized(answerFor(noneQ, 0)) === "yes") {
            paragraph("The intended parents do not have a fertility clinic yet.", TEXT_DARK);
            continue;
          }
        }
        const perParentQs = activeQuestions.filter((q) => q.perParent);
        const sharedQs = activeQuestions.filter((q) => !q.perParent);
        if (perParentQs.length) {
          for (const slot of slots) {
            subHeading(`Intended Parent (${slot})`);
            renderQuestions(section, perParentQs, slot);
            doc.moveDown(0.1);
          }
        }
        // Emergency contact fields get their own labelled group, matching the
        // legacy form ("Emergency Contact Information" heading).
        const emergencyQs = sharedQs.filter((q) => q.key.startsWith("emergency"));
        const otherSharedQs = sharedQs.filter((q) => !q.key.startsWith("emergency"));
        renderQuestions(section, otherSharedQs, 0);
        if (emergencyQs.length) {
          if (perParentQs.length || otherSharedQs.length) doc.moveDown(0.2);
          subHeading("Emergency Contact Information");
          renderQuestions(section, emergencyQs, 0);
        }
      }

      (doc as any).flushPages?.();
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
