import { Link } from "react-router-dom";
import { ExternalLink, FileText } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";

/**
 * One invoice, as a card.
 *
 * Extracted from the chat sidebar's Invoices section so the parent record's
 * Documents panel can draw the exact same row - the record was showing the
 * same invoice as a one-line coloured pill, so one document looked like two
 * different objects depending on the page. Same reason CostSheetRow exists.
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
  return (
    <div
      key={invoice.id}
      className="rounded-md border p-2 text-xs space-y-0.5"
      style={{
        background: isDead ? "hsl(var(--muted) / 0.3)" : "hsl(var(--background))",
        opacity: isDead ? 0.7 : 1,
      }}
      data-testid={testId || `invoice-row-${invoice.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{formatCents(invoice.serviceAmount)}</span>
        <InvoiceStatusBadge status={invoice.status} medicalClearanceStatus={invoice.medicalClearanceStatus} />
      </div>
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span>
          {new Date(invoice.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </span>
        {isPayable ? (
          <Link
            to={payLink as string}
            className="flex items-center gap-1 font-medium hover:underline text-primary"
          >
            Pay now <ExternalLink className="w-3 h-3" />
          </Link>
        ) : documentHref ? (
          <a
            href={documentHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 hover:underline"
          >
            <FileText className="w-3 h-3 shrink-0" />
            {invoice.status === "PAID" ? "Receipt" : "Invoice"}
          </a>
        ) : null}
      </div>
      {providerName && <p className="text-muted-foreground">{providerName}</p>}
      {(invoice.description || invoice.serviceType) && (
        <p className="text-muted-foreground italic truncate">
          {invoice.description || String(invoice.serviceType).replace(/_/g, " ").toLowerCase()}
        </p>
      )}
    </div>
  );
}
