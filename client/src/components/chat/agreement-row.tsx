import { Download, ExternalLink } from "lucide-react";

/**
 * One agreement, as a card - the paperwork sibling of InvoiceRow and
 * CostSheetRow, shared by the chat rail's Agreements section and the parent
 * record's Documents panel so the two never drift.
 *
 * A SIGNED agreement links to the signed PDF via /api/agreements/:id/download,
 * which streams it from PandaDoc behind our own auth (provider, admin, or the
 * signing parent). Anything not yet signed links to the agreement page, where
 * the signature status lives.
 */
export function AgreementRow({
  agreement,
  providerName,
  testId,
}: {
  agreement: any;
  /** Admin only: which org sent it. Omitted where the surface already says. */
  providerName?: string | null;
  testId?: string;
}) {
  const signed = agreement.status === "SIGNED";
  const dead = ["CANCELLED", "REJECTED", "EXPIRED"].includes(agreement.status);
  const label = signed ? "Signed" : agreement.status === "SENT" ? "Awaiting signature"
    : String(agreement.status).charAt(0) + String(agreement.status).slice(1).toLowerCase();
  const docLabel = String(agreement.documentType || "Agreement").replace(/_/g, " ")
    .toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
  const when = agreement.signedAt || agreement.createdAt;
  return (
    <div
      className="rounded-md border p-2 text-xs space-y-0.5"
      style={{
        background: dead ? "hsl(var(--muted) / 0.3)" : "hsl(var(--background))",
        opacity: dead ? 0.7 : 1,
      }}
      data-testid={testId || `agreement-row-${agreement.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold truncate">{docLabel}</span>
        <span
          className="text-[10px] uppercase tracking-wide font-medium shrink-0"
          style={{
            color: signed ? "hsl(var(--brand-success))"
              : dead ? "hsl(var(--muted-foreground))"
              : "hsl(var(--brand-warning))",
          }}
        >
          {label}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span>
          {when ? new Date(when).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
        </span>
        {signed ? (
          <a
            href={`/api/agreements/${agreement.id}/download`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 font-medium hover:underline text-primary"
          >
            <Download className="w-3 h-3 shrink-0" /> Signed PDF
          </a>
        ) : !dead ? (
          <a
            href={`/agreements/${agreement.id}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 hover:underline"
          >
            <ExternalLink className="w-3 h-3 shrink-0" /> Open
          </a>
        ) : null}
      </div>
      {providerName && <p className="text-muted-foreground">{providerName}</p>}
    </div>
  );
}
