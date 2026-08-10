import { FileCard } from "./attachment-message-card";

/**
 * One agreement, as a card - the paperwork sibling of InvoiceRow and
 * CostSheetRow, shared by the chat rail's Agreements section, the parent
 * record's Documents panel and the activity timeline so the three never drift.
 *
 * It draws as a FileCard, the same tile a sent attachment uses: an agreement
 * IS a PDF, so "Agreement sent" should look like the "Document sent" card it
 * sits next to in the timeline, not like a status line that happens to have a
 * link on it.
 *
 * A SIGNED agreement offers the signed PDF via /api/agreements/:id/download,
 * which streams it from PandaDoc behind our own auth (provider, admin, or the
 * signing parent). Anything not yet signed has no file to save, so it links to
 * the agreement page, where the signature status lives.
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
  const whenText = when
    ? new Date(when).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
  const downloadUrl = `/api/agreements/${agreement.id}/download`;

  return (
    <FileCard
      name={docLabel}
      mimeType="application/pdf"
      subtitle={["PDF Document", whenText, providerName]}
      href={signed ? downloadUrl : dead ? null : `/agreements/${agreement.id}`}
      download={signed ? { url: downloadUrl, name: `${docLabel}.pdf` } : null}
      status={{
        label,
        color: signed ? "hsl(var(--brand-success))"
          : dead ? "hsl(var(--muted-foreground))"
          : "hsl(var(--brand-warning))",
      }}
      // Same width cap as a sent attachment: a document tile is sized by the
      // document, not by whatever column it happens to sit in.
      className={`max-w-[300px]${dead ? " opacity-70" : ""}`}
      testId={testId || `agreement-row-${agreement.id}`}
    />
  );
}
