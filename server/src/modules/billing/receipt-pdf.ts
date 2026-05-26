/**
 * Generates a detailed PDF receipt for a paid invoice.
 *
 * Used as an email attachment after Stripe confirms payment so the parent
 * has a document they can forward to their employer (FSA/HSA), insurance,
 * or accountant. Agencies receive the same PDF as proof of payment.
 *
 * Layout (single page, US Letter):
 *   - Header band in the agency's brand color, agency logo + name big on
 *     the left, "PAYMENT RECEIPT" + "Processed by GoStork" on the right
 *   - Receipt # / date issued / status (Paid in Full) row
 *   - Two-column section: Billed To (parent) | Issued By (agency + tax ID)
 *   - Itemized line items table (loops invoice.lineItems)
 *   - Total Paid row in agency primary color
 *   - Payment method block (card brand + last4, transaction ID, date/time)
 *   - GoStork Deposit Protection disclaimer
 *   - Footer with FSA/HSA/insurance disclaimer
 */

import PDFDocument from "pdfkit";

export interface ReceiptInvoice {
  id: string;
  invoiceNumber: string | null;
  serviceAmount: number; // cents - sum of line items, or single legacy amount
  referralFeeAmount: number; // cents
  providerPayoutAmount: number; // cents
  currency: string;
  serviceType: string;
  providerName: string;
  description: string | null;
  paidAt: Date;
  isProtected: boolean;
  stripeTransactionId: string | null;
  stripePaymentIntentId: string | null;
  lineItems?: Array<{
    serviceType: string;
    serviceTypeLabel?: string;
    description?: string | null;
    amountCents: number;
  }>;
}

export interface ReceiptParent {
  name: string;
  email: string;
  city?: string | null;
  state?: string | null;
}

export interface ReceiptCardDetails {
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
}

export interface ReceiptBrand {
  /** Agency's primary brand color (defaults to GoStork teal). */
  primaryColor?: string | null;
  /** Logo bytes - PNG or JPEG. Fetched from logoUrl by the caller. */
  logoBuffer?: Buffer | null;
  /** Agency legal entity name (e.g. "Eggceptional Fertility LLC"). */
  legalName?: string | null;
  /** Federal tax ID / EIN. Shown in footer when set. */
  taxId?: string | null;
}

const DEFAULT_BRAND_PRIMARY = "#26584A";
const TEXT_DARK = "#1f2937";
const TEXT_MUTED = "#6b7280";
const BORDER = "#e5e7eb";

const LINE_TYPE_LABELS: Record<string, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
  OTHER: "Other",
};
function lineLabel(li: { serviceType: string; serviceTypeLabel?: string }): string {
  if (li.serviceTypeLabel) return li.serviceTypeLabel;
  return LINE_TYPE_LABELS[(li.serviceType || "").toUpperCase()] || li.serviceType || "Service";
}

function formatMoney(cents: number, currency = "USD"): string {
  const n = (cents || 0) / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function receiptNumber(invoice: ReceiptInvoice): string {
  if (invoice.invoiceNumber) return invoice.invoiceNumber;
  const shortId = invoice.id.slice(0, 8).toUpperCase();
  const datePart = invoice.paidAt
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  return `GS-${datePart}-${shortId}`;
}

export function generateReceiptPdf(args: {
  invoice: ReceiptInvoice;
  parent: ReceiptParent;
  card: ReceiptCardDetails;
  brand?: ReceiptBrand;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const brand = args.brand || {};
      const primary = (brand.primaryColor || DEFAULT_BRAND_PRIMARY).trim() || DEFAULT_BRAND_PRIMARY;
      const agencyDisplayName = brand.legalName || args.invoice.providerName;

      const doc = new PDFDocument({
        size: "LETTER",
        // Small bottom margin so the footer band can sit close to the page
        // edge without pdfkit treating the footer text as overflow.
        margins: { top: 50, bottom: 30, left: 50, right: 50 },
        info: {
          Title: `Receipt - ${receiptNumber(args.invoice)}`,
          Author: agencyDisplayName,
          Subject: `Payment receipt for ${args.invoice.providerName}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const { invoice, parent, card } = args;
      const pageWidth = doc.page.width;
      const contentLeft = 50;
      const contentRight = pageWidth - 50;
      const contentWidth = contentRight - contentLeft;

      // ───── Header band (agency brand color) ────────────────────────────
      const HEADER_H = 100;
      doc.rect(0, 0, pageWidth, HEADER_H).fill(primary);

      // Logo (if provided) - left aligned, 56x56 max. Falls back to a
      // wordmark of the agency's legal name when no logo bytes are present.
      let textStartX = contentLeft;
      if (brand.logoBuffer) {
        try {
          doc.image(brand.logoBuffer, contentLeft, 22, { fit: [56, 56] });
          textStartX = contentLeft + 70;
        } catch {
          // Bad image data - just skip and fall through to wordmark.
        }
      }

      doc
        .fillColor("#ffffff")
        .font("Helvetica-Bold")
        .fontSize(20)
        .text(agencyDisplayName, textStartX, 30, { width: contentWidth - (textStartX - contentLeft) - 200 });
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#ffffffcc")
        .text("Issued via GoStork", textStartX, 58, { width: contentWidth - (textStartX - contentLeft) - 200 });

      doc
        .fontSize(18)
        .font("Helvetica-Bold")
        .fillColor("#ffffff")
        .text("PAYMENT RECEIPT", contentLeft, 30, { align: "right", width: contentWidth });
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor("#ffffffcc")
        .text("Paid in Full • Processed by GoStork", contentLeft, 56, { align: "right", width: contentWidth });

      // ───── Meta row (receipt #, date, status) ──────────────────────────
      let y = HEADER_H + 20;
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("RECEIPT NUMBER", contentLeft, y);
      doc
        .fillColor(TEXT_DARK)
        .fontSize(11)
        .font("Helvetica")
        .text(receiptNumber(invoice), contentLeft, y + 12);

      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("DATE ISSUED", contentLeft + 200, y);
      doc
        .fillColor(TEXT_DARK)
        .fontSize(11)
        .font("Helvetica")
        .text(formatDate(invoice.paidAt), contentLeft + 200, y + 12);

      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("STATUS", contentLeft + 380, y);
      doc
        .fillColor(primary)
        .fontSize(11)
        .font("Helvetica-Bold")
        .text("PAID", contentLeft + 380, y + 12);

      y += 50;
      doc.strokeColor(BORDER).lineWidth(1).moveTo(contentLeft, y).lineTo(contentRight, y).stroke();

      // ───── Billed To / Issued By ─────────────────────────────────────────
      y += 18;
      const colWidth = (contentWidth - 30) / 2;

      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("BILLED TO", contentLeft, y);
      doc
        .fillColor(TEXT_DARK)
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(parent.name || "Customer", contentLeft, y + 14, { width: colWidth });
      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor(TEXT_DARK)
        .text(parent.email || "", contentLeft, y + 30, { width: colWidth });
      if (parent.city || parent.state) {
        doc.text(`${parent.city || ""}${parent.city && parent.state ? ", " : ""}${parent.state || ""}`, contentLeft, y + 46, { width: colWidth });
      }

      const rightColX = contentLeft + colWidth + 30;
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("ISSUED BY", rightColX, y);
      doc
        .fillColor(TEXT_DARK)
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(agencyDisplayName, rightColX, y + 14, { width: colWidth });
      let issuedByY = y + 30;
      if (brand.taxId) {
        doc
          .fontSize(10)
          .font("Helvetica")
          .fillColor(TEXT_DARK)
          .text(`Tax ID / EIN: ${brand.taxId}`, rightColX, issuedByY, { width: colWidth });
        issuedByY += 14;
      }
      doc
        .fontSize(9)
        .font("Helvetica")
        .fillColor(TEXT_MUTED)
        .text("Processed by GoStork • billing@gostork.com", rightColX, issuedByY, { width: colWidth });

      y += 80;
      doc.strokeColor(BORDER).lineWidth(1).moveTo(contentLeft, y).lineTo(contentRight, y).stroke();

      // ───── Itemized line items table ───────────────────────────────────
      y += 18;
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("SERVICES BILLED", contentLeft, y);

      y += 18;
      const amountColX = contentRight - 110; // right edge of amount column
      const descColWidth = amountColX - contentLeft - 8;
      const labelWidth = contentWidth - 120;

      // Table header
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("DESCRIPTION", contentLeft, y);
      doc.text("AMOUNT", contentLeft, y, { width: contentWidth, align: "right" });
      y += 12;
      doc.strokeColor(BORDER).lineWidth(0.5).moveTo(contentLeft, y).lineTo(contentRight, y).stroke();
      y += 6;

      const lines = invoice.lineItems && invoice.lineItems.length > 0
        ? invoice.lineItems
        // Fallback when no line items - synthesize one row from the legacy fields.
        : [{
            serviceType: invoice.serviceType,
            serviceTypeLabel: invoice.serviceType,
            description: invoice.description,
            amountCents: invoice.serviceAmount,
          }];

      for (const li of lines) {
        const label = lineLabel(li);
        const rowStartY = y;
        // Write label + amount at the same baseline. lineBreak:false stops
        // pdfkit from advancing the cursor, and continued:false isolates
        // each call from the previous one's flow state.
        doc
          .fillColor(TEXT_DARK)
          .fontSize(11)
          .font("Helvetica-Bold")
          .text(label, contentLeft, rowStartY, { width: descColWidth, lineBreak: false });
        doc
          .fontSize(11)
          .font("Helvetica")
          .text(formatMoney(li.amountCents, invoice.currency), contentLeft, rowStartY, {
            width: contentWidth,
            align: "right",
            lineBreak: false,
          });
        let rowBottom = rowStartY + 14;
        if (li.description && li.description.trim()) {
          doc
            .fillColor(TEXT_MUTED)
            .fontSize(9)
            .font("Helvetica")
            .text(li.description.trim(), contentLeft, rowBottom, { width: descColWidth });
          rowBottom = doc.y;
        }
        y = rowBottom + 6;
        doc.strokeColor("#f3f4f6").lineWidth(0.5).moveTo(contentLeft, y - 2).lineTo(contentRight, y - 2).stroke();
      }

      // GoStork service fee disclosure (informational - fee is INCLUDED in total)
      y += 6;
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(9)
        .font("Helvetica-Oblique")
        .text(
          `Includes GoStork service fee: ${formatMoney(invoice.referralFeeAmount, invoice.currency)}`,
          contentLeft + 12,
          y,
          { width: contentWidth - 12 },
        );

      y += 22;
      doc.strokeColor(BORDER).lineWidth(0.5).moveTo(contentLeft, y).lineTo(contentRight, y).stroke();

      y += 12;
      doc
        .fillColor(TEXT_DARK)
        .fontSize(13)
        .font("Helvetica-Bold")
        .text("TOTAL PAID", contentLeft, y, { width: labelWidth });
      doc
        .fillColor(primary)
        .fontSize(15)
        .font("Helvetica-Bold")
        .text(formatMoney(invoice.serviceAmount, invoice.currency), contentLeft, y - 2, {
          width: contentWidth,
          align: "right",
        });

      y += 30;
      doc.strokeColor(BORDER).lineWidth(1).moveTo(contentLeft, y).lineTo(contentRight, y).stroke();

      // ───── Payment Method ──────────────────────────────────────────────
      y += 18;
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("PAYMENT METHOD", contentLeft, y);

      const methodLine =
        card.brand && card.last4
          ? `${capitalize(card.brand)} ending in ${card.last4}`
          : "Credit/Debit Card";
      doc
        .fillColor(TEXT_DARK)
        .fontSize(11)
        .font("Helvetica")
        .text(methodLine, contentLeft, y + 14);
      if (card.expMonth && card.expYear) {
        doc
          .fontSize(9)
          .fillColor(TEXT_MUTED)
          .text(`Expires ${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`, contentLeft, y + 30);
      }

      const txnId = invoice.stripeTransactionId || invoice.stripePaymentIntentId || "-";
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("TRANSACTION ID", contentLeft + 240, y);
      doc
        .fillColor(TEXT_DARK)
        .fontSize(10)
        .font("Helvetica")
        .text(txnId, contentLeft + 240, y + 14, { width: 280 });

      doc
        .fillColor(TEXT_MUTED)
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("PROCESSED", contentLeft + 240, y + 32);
      doc
        .fillColor(TEXT_DARK)
        .fontSize(10)
        .font("Helvetica")
        .text(formatDateTime(invoice.paidAt), contentLeft + 240, y + 44);

      y += 80;
      doc.strokeColor(BORDER).lineWidth(1).moveTo(contentLeft, y).lineTo(contentRight, y).stroke();

      // ───── GoStork Guarantee disclosure ────────────────────────────────
      if (invoice.isProtected) {
        y += 18;
        doc
          .fillColor(primary)
          .fontSize(10)
          .font("Helvetica-Bold")
          .text("✓ GoStork Deposit Protection", contentLeft, y);
        doc
          .fillColor(TEXT_MUTED)
          .fontSize(9)
          .font("Helvetica")
          .text(
            "If your match falls through due to medical clearance failure, your deposit transfers to another participating agency on the GoStork platform at no extra cost.",
            contentLeft,
            y + 14,
            { width: contentWidth },
          );
        y = doc.y + 12;
      }

      // ───── Footer ──────────────────────────────────────────────────────
      // Letter is 792pt tall, bottom margin is 30. Writable region ends at
      // y=762. Pack the footer into that space without spilling.
      const pageH = doc.page.height; // 792 for LETTER
      const footerSepY = pageH - 72;
      doc.strokeColor(BORDER).lineWidth(1).moveTo(contentLeft, footerSepY).lineTo(contentRight, footerSepY).stroke();
      doc
        .fillColor(TEXT_MUTED)
        .fontSize(7.5)
        .font("Helvetica")
        .text(
          "This receipt is generated for your records and may be submitted to an employer or insurance carrier for reimbursement consideration. Coverage policies vary - please verify with your benefits administrator. For questions, contact billing@gostork.com.",
          contentLeft,
          footerSepY + 6,
          { width: contentWidth, align: "left", height: 28, ellipsis: true },
        );
      const issuerLine = brand.taxId
        ? `${agencyDisplayName} • Tax ID / EIN: ${brand.taxId} • Processed by GoStork, Inc.`
        : `${agencyDisplayName} • Processed by GoStork, Inc.`;
      doc
        .fontSize(7.5)
        .fillColor(TEXT_MUTED)
        .text(issuerLine, contentLeft, pageH - 48, {
          width: contentWidth,
          align: "center",
          lineBreak: false,
        });

      // Make sure pdfkit doesn't auto-advance to a new page from any
      // pending cursor state. flushPages() commits the current page only.
      (doc as any).flushPages?.();

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
