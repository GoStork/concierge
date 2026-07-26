/**
 * Provider Invoices page
 * Routes: /provider/invoices (canonical), /provider/billing (legacy alias)
 *
 * Every invoice sent to parents (any status), with the amount / GoStork fee /
 * payout split. Search + status + service-type filters in URL params. Split
 * out of the old 3-tab Billing page - payouts live at /provider/payouts and
 * agreements at /provider/agreements. Reached from the Home dashboard.
 * Fee setup and bank accounts stay in Settings (Billing / Payouts tabs).
 */

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Receipt, Search, ChevronDown, ChevronUp, MessageCircle, FileText } from "lucide-react";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { formatDateTime } from "@/lib/format-date";
import { derivePayoutStatus } from "@/lib/payout-status";
import { DateRangeFilter, inDateRange } from "@/components/date-range-filter";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { ParentInfoBlock, InvoiceInfoBlock } from "@/components/invoice-details-blocks";
import { Button } from "@/components/ui/button";

const INVOICE_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "pending", label: "Awaiting payment" },
  { key: "paid", label: "Paid" },
  { key: "other", label: "Cancelled / expired / refunded" },
];

export default function ProviderBillingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const status = searchParams.get("status") || "all";
  const service = searchParams.get("service") || "all";
  const q = searchParams.get("q") || "";
  const dateFrom = searchParams.get("from") || "";
  const dateTo = searchParams.get("to") || "";

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  };

  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/provider/invoices"],
    queryFn: async () => {
      const res = await fetch("/api/provider/invoices", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      const d = await res.json();
      return Array.isArray(d) ? d : (d.invoices || []);
    },
  });

  // Service-type filter options come from the data itself, so multi-service
  // agencies see exactly their services and nothing else.
  const serviceTypes = Array.from(new Set(invoices.map((i: any) => i.serviceType).filter(Boolean))) as string[];

  const matchesSearch = (inv: any) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [inv.parentUser?.name, inv.parentUser?.email, inv.serviceType, inv.description, inv.id]
      .some(h => (h || "").toLowerCase().includes(needle));
  };
  const matchesService = (inv: any) => service === "all" || inv.serviceType === service;

  const filteredInvoices = invoices.filter((inv: any) => {
    if (status === "pending" && !["AWAITING_PAYMENT", "AUTHORIZED"].includes(inv.status)) return false;
    if (status === "paid" && inv.status !== "PAID") return false;
    if (status === "other" && !["CANCELLED", "EXPIRED", "REFUNDED", "PARTIALLY_REFUNDED", "CLEARANCE_FAILED"].includes(inv.status)) return false;
    if (!inDateRange(inv.createdAt, dateFrom, dateTo)) return false;
    return matchesService(inv) && matchesSearch(inv);
  });

  const totalReceived = invoices
    .filter((i: any) => i.status === "PAID")
    .reduce((sum: number, i: any) => sum + (i.providerPayoutAmount || 0), 0);
  const awaitingCount = invoices.filter((i: any) => ["AWAITING_PAYMENT", "AUTHORIZED"].includes(i.status)).length;
  const pendingPayouts = invoices.filter((i: any) => i.status === "PAID" && (i.providerPayoutAmount || 0) > 0 && !derivePayoutStatus(i).isReceived).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Invoices</h1>
        <p className="t-helper mt-1">Every invoice you've sent to parents</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border p-4 space-y-1">
          <p className="t-micro-label">Total Received</p>
          <p className="text-xl font-heading font-bold">{formatCents(totalReceived)}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="t-micro-label">Awaiting Payment</p>
          <p className="text-xl font-heading font-bold">{awaitingCount}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="t-micro-label">Pending Payouts</p>
          <p className="text-xl font-heading font-bold">{pendingPayouts}</p>
        </div>
      </div>

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={q}
            onChange={e => setParam({ q: e.target.value })}
            placeholder="Search by parent, service, or description..."
            className="w-full h-9 pl-9 pr-3 rounded-[var(--radius)] border bg-background text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
            data-testid="provider-billing-search"
          />
        </div>
        <DateRangeFilter from={dateFrom} to={dateTo} onFrom={v => setParam({ from: v })} onTo={v => setParam({ to: v })} testIdPrefix="provider-invoices-date" />
        <select
          value={status}
          onChange={e => setParam({ status: e.target.value })}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
          data-testid="provider-billing-status-filter"
        >
          {INVOICE_STATUS_FILTERS.map(f => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        {serviceTypes.length > 1 && (
          <select
            value={service}
            onChange={e => setParam({ service: e.target.value })}
            className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
            data-testid="provider-billing-service-filter"
          >
            <option value="all">All services</option>
            {serviceTypes.map(st => (
              <option key={st} value={st}>{st}</option>
            ))}
          </select>
        )}
        <ClearFiltersButton
          show={!!(q || dateFrom || dateTo || status !== "all" || service !== "all")}
          onClick={() => setParam({ q: null, from: null, to: null, status: null, service: null })}
          testId="provider-billing-clear-filters"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !filteredInvoices.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Receipt className="w-8 h-8 text-muted-foreground" />
          <p className="t-helper">{invoices.length ? "No invoices match your filters" : "No invoices yet"}</p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Parent</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Service</th>
                  <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">Amount</th>
                  <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">GoStork Fee</th>
                  <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">Your Payout</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Status</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Payout Status</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Date</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {filteredInvoices.map((inv: any) => (
                  <>
                  <tr
                    key={inv.id}
                    className="border-b last:border-0 hover:bg-muted/10 cursor-pointer"
                    onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
                    data-testid={`provider-billing-invoice-${inv.id}`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">{inv.parentUser?.name || inv.parentUser?.email || "Parent"}</td>
                    <td className="t-helper px-4 py-2.5 whitespace-nowrap">{(inv.serviceType || "-").replace(/_/g, " ").toLowerCase()}</td>
                    <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{formatCents(inv.serviceAmount, inv.currency)}</td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{formatCents(inv.referralFeeAmount, inv.currency)}</td>
                    <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><InvoiceStatusBadge status={inv.status} medicalClearanceStatus={(inv as any).medicalClearanceStatus} /></td>
                    <td className="px-4 py-2.5 text-xs font-medium whitespace-nowrap">
                      {(() => {
                        const ps = derivePayoutStatus(inv);
                        return (
                          <span title={ps.tooltip} className="cursor-help underline decoration-dotted underline-offset-2" style={{ color: ps.color }}>
                            {ps.label}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="t-helper px-4 py-2.5 whitespace-nowrap">{formatDateTime(inv.createdAt)}</td>
                    <td className="px-2 py-2.5 text-muted-foreground">
                      {expandedId === inv.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                  </tr>
                  {expandedId === inv.id && (
                    <tr key={`${inv.id}-detail`} className="bg-muted/10 border-b last:border-0">
                      <td colSpan={9} className="px-6 py-5">
                        <div className="grid md:grid-cols-2 gap-6 text-sm">
                          <div className="space-y-5">
                            <ParentInfoBlock parentUser={inv.parentUser} />
                            <InvoiceInfoBlock inv={inv} />
                          </div>
                          <div className="space-y-3">
                            <h3 className="font-semibold">Actions</h3>
                            {["AWAITING_PAYMENT", "AUTHORIZED"].includes(inv.status) && inv.sessionId && (
                              <Button
                                size="sm"
                                onClick={() => navigate(`/chat/${inv.sessionId}`)}
                                data-testid={`provider-invoice-remind-${inv.id}`}
                              >
                                <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> Remind in chat
                              </Button>
                            )}
                            <div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => window.open(`/api/provider/invoices/${inv.id}/document`, "_blank", "noopener,noreferrer")}
                              >
                                <FileText className="w-3.5 h-3.5 mr-1.5" /> Open invoice document
                              </Button>
                            </div>
                            {!["AWAITING_PAYMENT", "AUTHORIZED"].includes(inv.status) && inv.sessionId && (
                              <button
                                onClick={() => navigate(`/chat/${inv.sessionId}`)}
                                className="t-helper underline block"
                              >
                                Open chat with parent
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
