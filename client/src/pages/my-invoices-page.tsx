/**
 * Parent invoices page
 * Route: /my/invoices
 *
 * Shows all invoices for the logged-in parent across all providers.
 * Includes status badges, payment links, and GoStork Guarantee indicator.
 */

import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Shield, ExternalLink, ChevronDown, ChevronUp, Loader2, AlertCircle, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

const TABS = [
  { key: "all",     label: "All Invoices"    },
  { key: "pending", label: "Pending Payment" },
  { key: "paid",    label: "Paid"            },
];

export default function MyInvoicesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("status") || "all";
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/my/invoices"],
    queryFn: async () => {
      const res = await fetch("/api/my/invoices", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
  });

  const filtered = invoices.filter((inv: any) => {
    if (tab === "all") return true;
    if (tab === "pending") return ["AWAITING_PAYMENT", "AUTHORIZED"].includes(inv.status);
    if (tab === "paid") return inv.status === "PAID";
    return true;
  });

  const totalPaid = invoices.filter((i: any) => i.status === "PAID").reduce((sum: number, i: any) => sum + i.serviceAmount, 0);
  const pendingCount = invoices.filter((i: any) => ["AWAITING_PAYMENT", "AUTHORIZED"].includes(i.status)).length;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">My Invoices</h1>
        <p className="text-sm text-muted-foreground mt-1">All payments for your fertility journey</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Paid</p>
          <p className="text-xl font-heading font-bold">{formatCents(totalPaid)}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Pending</p>
          <p className="text-xl font-heading font-bold">{pendingCount}</p>
        </div>
      </div>

      {/* GoStork Guarantee callout */}
      <div className="flex items-start gap-3 rounded-xl border px-4 py-4 text-sm" style={{ borderColor: "hsl(var(--brand-success) / 0.3)", background: "hsl(var(--brand-success) / 0.06)" }}>
        <Shield className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "hsl(var(--brand-success))" }} />
        <div>
          <p className="font-semibold" style={{ color: "hsl(var(--brand-success))" }}>GoStork Guarantee</p>
          <p className="text-muted-foreground text-xs mt-0.5">
            All payments made through GoStork are protected. If a surrogate match fails medical clearance, your deposit can be redirected to any other GoStork agency at no extra cost.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setSearchParams({ status: t.key }, { replace: true })}
            className="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
            style={{
              borderBottomColor: tab === t.key ? "hsl(var(--primary))" : "transparent",
              color: tab === t.key ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Invoices */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !filtered.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <FileText className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No invoices yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((inv: any) => (
            <div key={inv.id} className="rounded-xl border overflow-hidden">
              {/* Summary row */}
              <button
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/20 transition-colors text-left"
                onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
              >
                <div className="space-y-0.5">
                  <p className="font-semibold">{inv.providerName}</p>
                  <p className="text-sm text-muted-foreground">{inv.serviceType} - {new Date(inv.createdAt).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-3">
                  <InvoiceStatusBadge status={inv.status} />
                  <p className="font-heading font-bold">{formatCents(inv.serviceAmount, inv.currency)}</p>
                  {expandedId === inv.id ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
              </button>

              {/* Expanded detail */}
              {expandedId === inv.id && (
                <div className="px-5 pb-5 pt-0 space-y-4 border-t">
                  {/* Amount breakdown */}
                  <div className="rounded-lg bg-muted/30 p-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Service Total</span>
                      <span>{formatCents(inv.serviceAmount, inv.currency)}</span>
                    </div>
                    {inv.description && (
                      <p className="text-xs text-muted-foreground">{inv.description}</p>
                    )}
                  </div>

                  {/* GoStork Guarantee status */}
                  {inv.isProtected && (
                    <div className="flex items-center gap-2 text-xs" style={{ color: "hsl(var(--brand-success))" }}>
                      <Shield className="w-3.5 h-3.5" />
                      <span>Protected by GoStork Guarantee</span>
                    </div>
                  )}

                  {/* Medical clearance status for AT_CLEARANCE */}
                  {inv.medicalClearanceStatus && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Medical Clearance: </span>
                      <span className={
                        inv.medicalClearanceStatus === "CLEARED" ? "text-green-600" :
                        inv.medicalClearanceStatus === "FAILED"  ? "text-red-600" :
                        "text-yellow-600"
                      }>
                        {inv.medicalClearanceStatus === "CLEARED" ? "Cleared" :
                         inv.medicalClearanceStatus === "FAILED"  ? "Failed - Guarantee active" :
                         "Pending medical review"}
                      </span>
                    </div>
                  )}

                  {/* CTA */}
                  <div className="flex gap-2 flex-wrap">
                    {["AWAITING_PAYMENT"].includes(inv.status) && (
                      <Button
                        asChild
                        style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
                      >
                        <a href={`/pay/${inv.paymentToken}`} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                          Pay Now
                        </a>
                      </Button>
                    )}
                    {inv.status === "PAID" && (
                      <Button variant="outline" size="sm" onClick={() => {
                        // Download invoice PDF - hits a server endpoint
                        window.open(`/api/my/invoices/${inv.id}/download`, "_blank");
                      }}>
                        Download Receipt
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
