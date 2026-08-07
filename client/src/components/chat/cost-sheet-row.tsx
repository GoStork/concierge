import { Paperclip } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

/**
 * One sent cost sheet, as a card.
 *
 * The chat sidebar has drawn cost-sheet history this way since it was built:
 * the amount, a CURRENT / Superseded state, the date, and the file. The parent
 * record was showing the same rows as a one-line coloured pill, so the same
 * quote looked like two different objects depending on which page you were on.
 * This is the single renderer for both.
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
  /** Optional click-through. The file link stops propagation so it still works. */
  onOpen?: () => void;
  testId?: string;
}) {
  const superseded = !!quote.supersededAt;
  const acked = !superseded && !!quote.parentAcknowledgedAt;
  const session = sessionId || quote.sessionId || null;
  const file = quote.costSheetFileUrl
    ? { href: `/api/sessions/${session}/cost-sheets/${quote.id}/file`, name: quote.costSheetFileName || "File" }
    : null;

  return (
    <div
      className="rounded-md border p-2 text-xs space-y-0.5"
      style={{
        background: superseded ? "hsl(var(--muted) / 0.3)" : "hsl(var(--background))",
        opacity: superseded ? 0.7 : 1,
        cursor: onOpen ? "pointer" : undefined,
      }}
      onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(); } : undefined}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{formatCents(quote.totalCostCents)}</span>
        {superseded ? (
          <span className="t-micro-label">Superseded</span>
        ) : (
          <span
            className="text-[10px] uppercase tracking-wide font-medium shrink-0"
            // Acknowledged is settled, so it reads success. A sheet the family
            // has not opened yet is the one that needs chasing, which is the
            // same warning tone the parents table uses for it.
            style={{ color: acked ? "hsl(var(--brand-success))" : "hsl(var(--brand-warning))" }}
          >
            {acked ? "Acknowledged" : "Current"}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span>
          {new Date(quote.createdAt).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          })}
        </span>
        {file && session && (
          <a
            href={file.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="hover:underline flex items-center gap-1 min-w-0"
          >
            <Paperclip className="w-3 h-3 shrink-0" />
            <span className="truncate">{file.name}</span>
          </a>
        )}
      </div>
      {providerName && <p className="text-muted-foreground">{providerName}</p>}
      {quote.notes && <p className="text-muted-foreground italic">{quote.notes}</p>}
    </div>
  );
}
