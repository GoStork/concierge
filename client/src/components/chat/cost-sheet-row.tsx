import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { FileCard } from "./attachment-message-card";
import { serviceLabel } from "@/components/ui/service-tag";

/**
 * One sent cost sheet, as a document card.
 *
 * Draws as a FileCard - the same tile an attachment, an invoice and an
 * agreement use - with a COSTS glyph band. Naming the paperwork rather than
 * the file type is what makes the Documents rail scannable: everything in it
 * is a PDF, so "PDF" distinguishes nothing.
 *
 * The file link needs the session, because the download route mints a fresh
 * signed URL per click (`/api/sessions/:sessionId/cost-sheets/:id/file`) - the
 * raw GCS url 403s under uniform bucket-level access.
 */
export function CostSheetRow({
  quote,
  sessionId,
  providerName,
  onOpen,
  testId,
}: {
  quote: any;
  /** Falls back to the quote's own sessionId - the record has no ambient one. */
  sessionId?: string | null;
  /** Admin only: which org sent it. Omitted where the surface already says. */
  providerName?: string | null;
  /** Optional click-through, used where the card opens the originating chat. */
  onOpen?: () => void;
  testId?: string;
}) {
  const superseded = !!quote.supersededAt;
  const acked = !superseded && !!quote.parentAcknowledgedAt;
  const session = sessionId || quote.sessionId || null;
  const file = quote.costSheetFileUrl && session
    ? {
        url: `/api/sessions/${session}/cost-sheets/${quote.id}/file`,
        name: quote.costSheetFileName || "Cost sheet.pdf",
      }
    : null;
  const when = new Date(quote.createdAt).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });

  return (
    <FileCard
      name={formatCents(quote.totalCostCents)}
      glyph={{ label: "COSTS", accent: "hsl(var(--accent))" }}
      // Date then service, matching the invoice and agreement cards. The
      // filename is gone: the save button already leads to the file, and the
      // name is near-identical between two sheets from the same agency, so it
      // wrapped the row without telling you which quote you were looking at.
      subtitle={[when, serviceLabel(quote.serviceType), providerName, quote.notes]}
      nameBreak="words"
      status={{
        label: superseded ? "Superseded" : acked ? "Acknowledged" : "Current",
        // Acknowledged is settled, so it reads success. A sheet the family has
        // not opened yet is the one that needs chasing, which is the same
        // warning tone the parents table uses for it.
        color: superseded
          ? "hsl(var(--muted-foreground))"
          : acked
            ? "hsl(var(--brand-success))"
            : "hsl(var(--brand-warning))",
      }}
      download={file}
      onClick={onOpen}
      className={superseded ? "opacity-70" : undefined}
      testId={testId || `cost-sheet-row-${quote.id}`}
    />
  );
}
