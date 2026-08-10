import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { serviceLabel } from "@/components/ui/service-tag";
import { FileCard } from "./attachment-message-card";

/**
 * One invoice, as a document card.
 *
 * Draws as a FileCard - the same tile a sent attachment and an agreement use -
 * because an invoice IS a generated PDF. The glyph band says INVOICE rather
 * than PDF: every document in the rail is a PDF, so naming the file type says
 * nothing the amount and status do not, while naming the PAPERWORK makes the
 * column scannable at a glance.
 *
 * Shared by the chat sidebar's Invoices section and the parent record's
 * Documents panel, so one invoice never looks like two different objects.
 * Status styling stays in InvoiceStatusBadge (it also encodes medical
 * clearance), passed straight through as the card's status node.
 */
export function InvoiceRow({
  invoice,
  payLink,
  documentHref,
  providerName,
  testId,
}: {
  invoice: any;
  /** Parent-only: a Pay-now link for AWAITING_PAYMENT invoices. */
  payLink?: string | null;
  /** Provider/admin: opens the invoice document (receipt PDF once paid). */
  documentHref?: string | null;
  /** Admin only: which org sent it. Omitted where the surface already says. */
  providerName?: string | null;
  testId?: string;
}) {
  const isDead = ["CANCELLED", "EXPIRED"].includes(invoice.status);
  const isPayable = !!payLink && invoice.status === "AWAITING_PAYMENT";
  const when = new Date(invoice.createdAt).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  // One vocabulary across the three document cards, so the same service does
  // not read "surrogacy" here and "Surrogacy" on the agreement beside it.
  const service = invoice.description || serviceLabel(invoice.serviceType);

  return (
    <FileCard
      name={formatCents(invoice.serviceAmount)}
      glyph={{ label: "INVOICE", accent: "hsl(var(--primary))" }}
      subtitle={[when, service, providerName]}
      nameBreak="words"
      status={
        <InvoiceStatusBadge
          status={invoice.status}
          medicalClearanceStatus={invoice.medicalClearanceStatus}
        />
      }
      href={!isPayable && documentHref ? documentHref : null}
      download={
        !isPayable && documentHref
          ? { url: documentHref, name: `${invoice.status === "PAID" ? "Receipt" : "Invoice"}.pdf` }
          : null
      }
      action={
        isPayable ? (
          <Link
            to={payLink as string}
            className="flex items-center gap-1 text-xs font-medium hover:underline text-primary whitespace-nowrap"
          >
            Pay now <ExternalLink className="w-3 h-3" />
          </Link>
        ) : null
      }
      className={isDead ? "opacity-70" : undefined}
      testId={testId || `invoice-row-${invoice.id}`}
    />
  );
}
