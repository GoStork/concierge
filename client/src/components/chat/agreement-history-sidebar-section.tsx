import { useQuery } from "@tanstack/react-query";
import { FileSignature } from "lucide-react";
import { AgreementRow } from "./agreement-row";

/**
 * Read-only "Agreements" list for the provider chat rail - the paperwork twin
 * of the Invoices section above it. Every agreement on this conversation with
 * its signature state; signed ones carry a download link for the signed PDF.
 *
 * Distinct from AgreementSidebarSection, which is the SEND form (generate and
 * send for signature). This is history, like InvoiceHistorySidebarSection.
 */
export function AgreementHistorySidebarSection({
  sessionId,
  brandColor,
}: {
  sessionId: string;
  brandColor: string;
}) {
  const { data } = useQuery<any[]>({
    queryKey: ["/api/agreements", sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/agreements?sessionId=${encodeURIComponent(sessionId)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreements");
      return res.json();
    },
    enabled: !!sessionId,
  });

  const agreements = data ?? [];
  if (agreements.length === 0) return null;

  return (
    <div className="space-y-3 border-t pt-3" data-testid="sidebar-agreements-section">
      <div className="flex items-center gap-2">
        <FileSignature className="w-4 h-4" style={{ color: brandColor }} />
        <h3 className="text-sm font-semibold">Agreements</h3>
      </div>
      <div className="space-y-1.5">
        {agreements.map((agr) => (
          <AgreementRow key={agr.id} agreement={agr} testId={`sidebar-agreement-${agr.id}`} />
        ))}
      </div>
    </div>
  );
}
