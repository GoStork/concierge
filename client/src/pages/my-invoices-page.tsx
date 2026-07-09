/**
 * Parent Invoices page
 * Routes: /my/invoices (canonical), /my/billing (legacy alias)
 *
 * Dedicated invoices view across ALL providers: status, payment link, receipt
 * download, search + status filter. Cost sheets moved to their own page
 * (/my/cost-sheets); agreements live on Home (few enough to open directly).
 * Reached from the Home dashboard's Invoices section.
 */

import { Link, useSearchParams } from "react-router-dom";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Shield, ExternalLink, ChevronDown, ChevronUp, Loader2, Receipt, Search, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

const INVOICE_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "pending", label: "Pending payment" },
  { key: "paid", label: "Paid" },
  { key: "other", label: "Cancelled / expired / refunded" },
];

export default function MyInvoicesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") || "all";
  const q = searchParams.get("q") || "";
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  };

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/my/invoices"],
    queryFn: async () => {
      const res = await fetch("/api/my/invoices", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
  });

  const matchesSearch = (haystack: Array<string | null | undefined>) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return haystack.some(h => (h || "").toLowerCase().includes(needle));
  };

  const filteredInvoices = invoices.filter((inv: any) => {
    if (status === "pending" && !["AWAITING_PAYMENT", "AUTHORIZED"].includes(inv.status)) return false;
    if (status === "paid" && inv.status !== "PAID") return false;
    if (status === "other" && !["CANCELLED", "EXPIRED", "REFUNDED", "PARTIALLY_REFUNDED", "CLEARANCE_FAILED"].includes(inv.status)) return false;
    return matchesSearch([inv.providerName, inv.serviceType, inv.description, inv.id]);
  });

  const totalPaid = invoices.filter((i: any) => i.status === "PAID").reduce((sum: number, i: any) => sum + i.serviceAmount, 0);
  const pendingCount = invoices.filter((i: any) => ["AWAITING_PAYMENT", "AUTHORIZED"].includes(i.status)).length;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Invoices</h1>
        <p className="text-sm text-muted-foreground mt-1">Every invoice from all your providers, in one place</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Paid</p>
          <p className="text-xl font-heading font-bold">{formatCents(totalPaid)}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Pending Payments</p>
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

      {/* Search + status filter */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={q}
            onChange={e => setParam({ q: e.target.value })}
            placeholder="Search by provider, service, or description..."
            className="w-full h-9 pl-9 pr-3 rounded-[var(--radius)] border bg-background text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
            data-testid="billing-search"
          />
        </div>
        <select
          value={status}
          onChange={e => setParam({ status: e.target.value })}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
          data-testid="billing-status-filter"
        >
          {INVOICE_STATUS_FILTERS.map(f => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        <ClearFiltersButton
          show={!!(q || status !== "all")}
          onClick={() => setParam({ q: null, status: null })}
          testId="my-invoices-clear-filters"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !filteredInvoices.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Receipt className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{invoices.length ? "No invoices match your filters" : "No invoices yet"}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredInvoices.map((inv: any) => (
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
                      <span style={{
                        color: inv.medicalClearanceStatus === "CLEARED" ? "hsl(var(--brand-success))" :
                               inv.medicalClearanceStatus === "FAILED" ? "hsl(var(--destructive))" :
                               "hsl(var(--brand-warning))",
                      }}>
                        {inv.medicalClearanceStatus === "CLEARED" ? "Cleared" :
                         inv.medicalClearanceStatus === "FAILED" ? "Failed - Guarantee active" :
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
                        window.open(`/api/my/invoices/${inv.id}/download`, "_blank");
                      }}>
                        Download Receipt
                      </Button>
                    )}
                    {inv.sessionId && (
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/chat/${inv.sessionId}`}>
                          <MessageCircle className="w-3.5 h-3.5 mr-1.5" />
                          Open Conversation
                        </Link>
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
