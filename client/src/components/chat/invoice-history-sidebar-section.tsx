import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CreditCard, ExternalLink } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";

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
        {invoices.map(inv => {
          const isPayable = canPay && inv.status === "AWAITING_PAYMENT";
          const isDead = ["CANCELLED", "EXPIRED"].includes(inv.status);
          return (
            <div
              key={inv.id}
              className="rounded-md border p-2 text-xs space-y-0.5"
              style={{
                background: isDead ? "hsl(var(--muted) / 0.3)" : "hsl(var(--background))",
                opacity: isDead ? 0.7 : 1,
              }}
              data-testid={`sidebar-invoice-${inv.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{formatCents(inv.serviceAmount)}</span>
                <InvoiceStatusBadge status={inv.status} />
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>
                  {new Date(inv.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
                {isPayable && (
                  <Link
                    to={`/pay/${inv.paymentToken}?returnTo=${encodeURIComponent(`/chat`)}`}
                    className="flex items-center gap-1 font-medium hover:underline"
                    style={{ color: brandColor }}
                  >
                    Pay now <ExternalLink className="w-3 h-3" />
                  </Link>
                )}
              </div>
              {(inv.description || inv.serviceType) && (
                <p className="text-muted-foreground italic truncate">{inv.description || inv.serviceType}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
