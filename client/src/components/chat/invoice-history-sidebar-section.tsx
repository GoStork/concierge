import { useQuery } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { InvoiceRow } from "./invoice-row";

// Read-only "Invoices" list for the chat right sidebar - the payment twin of
// the Cost Sheets section above it. Parents see every invoice on this
// conversation with its status; pending ones get a Pay link straight to the
// secure payment page.

interface SessionInvoiceRow {
  id: string;
  paymentToken: string;
  serviceType: string | null;
  serviceAmount: number;
  status: string;
  medicalClearanceStatus?: string | null;
  dueAt: string | null;
  createdAt: string;
  description: string | null;
  lineItems: Array<{ id: string; serviceType: string; description: string | null; amountCents: number }>;
}

export function InvoiceHistorySidebarSection({
  sessionId,
  brandColor,
  canPay = true,
}: {
  sessionId: string;
  brandColor: string;
  /** Parents get a Pay-now link on pending invoices; provider viewers don't. */
  canPay?: boolean;
}) {
  const { data } = useQuery<{ invoices: SessionInvoiceRow[] }>({
    queryKey: ["/api/sessions/invoices", sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/invoices`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
    enabled: !!sessionId,
  });

  const invoices = data?.invoices ?? [];
  if (invoices.length === 0) return null;

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex items-center gap-2">
        <CreditCard className="w-4 h-4" style={{ color: brandColor }} />
        <h3 className="text-sm font-semibold">Invoices</h3>
      </div>
      <div className="space-y-1.5">
        {/* The SAME row the parent record's Documents panel draws, so one
            invoice never looks like two different objects. */}
        {invoices.map(inv => (
          <InvoiceRow
            key={inv.id}
            invoice={inv}
            payLink={canPay && inv.status === "AWAITING_PAYMENT"
              ? `/pay/${inv.paymentToken}?returnTo=${encodeURIComponent(`/chat`)}`
              : null}
            testId={`sidebar-invoice-${inv.id}`}
          />
        ))}
      </div>
    </div>
  );
}
