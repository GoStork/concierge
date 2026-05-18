/**
 * In-chat invoice card.
 * Rendered when a chat message has uiCardType === "invoice".
 * Shown to the parent in the provider session chat.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Shield, Clock, CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { InvoiceStatusBadge } from "./invoice-status-badge";

function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function CountdownTimer({ dueAt }: { dueAt: string }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const tick = () => {
      const diff = new Date(dueAt).getTime() - Date.now();
      if (diff <= 0) { setRemaining("Expired"); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      setRemaining(`${h}h ${m.toString().padStart(2, "0")}m remaining`);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [dueAt]);

  return (
    <span className="flex items-center gap-1 text-xs font-medium" style={{ color: "hsl(var(--brand-warning))" }}>
      <Clock className="w-3 h-3" />
      {remaining}
    </span>
  );
}

interface InvoiceCardData {
  invoiceId: string;
  paymentToken: string;
  paymentUrl: string;
  providerName: string;
  serviceType: string;
  serviceAmount: number;
  referralFeeAmount: number;
  providerPayoutAmount: number;
  currency: string;
  status: string;
  isProtected: boolean;
  dueAt?: string | null;
  description?: string | null;
}

interface InvoiceCardProps {
  data: InvoiceCardData;
  isParent?: boolean;
}

export function InvoiceCard({ data, isParent = true }: InvoiceCardProps) {
  const isPaid = data.status === "PAID" || data.status === "AUTHORIZED";

  return (
    <div className="rounded-xl border overflow-hidden max-w-sm" style={{ background: "hsl(var(--background))" }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between border-b" style={{ background: "hsl(var(--primary) / 0.05)" }}>
        <div>
          <p className="text-xs text-muted-foreground">Payment Request</p>
          <p className="font-semibold text-sm mt-0.5">{data.providerName}</p>
        </div>
        <InvoiceStatusBadge status={data.status} />
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">{data.serviceType}</span>
          <span className="font-heading font-bold text-lg">{formatCents(data.serviceAmount, data.currency)}</span>
        </div>

        {data.description && (
          <p className="text-xs text-muted-foreground">{data.description}</p>
        )}

        {/* Countdown */}
        {data.dueAt && data.status === "AWAITING_PAYMENT" && (
          <CountdownTimer dueAt={data.dueAt} />
        )}

        {/* GoStork Guarantee */}
        {data.isProtected && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "hsl(var(--brand-success))" }}>
            <Shield className="w-3.5 h-3.5" />
            <span>Protected by GoStork Guarantee</span>
          </div>
        )}

        {/* Paid state */}
        {isPaid && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{data.status === "AUTHORIZED" ? "Funds securely held" : "Payment complete"}</span>
          </div>
        )}
      </div>

      {/* Footer CTA */}
      {isParent && data.status === "AWAITING_PAYMENT" && (
        <div className="px-4 pb-4">
          <Button
            asChild
            className="w-full"
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
          >
            <a href={data.paymentUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              Pay Now Securely
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}
