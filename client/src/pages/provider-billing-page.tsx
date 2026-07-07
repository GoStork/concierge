/**
 * Provider Billing page
 * Route: /provider/billing
 *
 * The provider's money hub - the counterpart of the parent /my/billing page
 * and the admin Billing dashboard:
 *   - Invoices tab: every invoice sent to parents (any status), with the
 *     amount / GoStork fee / payout split
 *   - Payouts tab: what GoStork has sent (or is sending) to the bank
 * Search + status + service-type filters. View state lives in URL params so
 * the back button restores the exact tab/filter. Fee setup and bank accounts
 * stay in Settings (Billing / Payouts tabs) - this page is for history.
 */

import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Receipt, Search, Landmark, CheckCircle2, DollarSign } from "lucide-react";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { formatDateTime } from "@/lib/format-date";
import { derivePayoutStatus } from "@/lib/payout-status";

const INVOICE_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "pending", label: "Awaiting payment" },
  { key: "paid", label: "Paid" },
  { key: "other", label: "Cancelled / expired / refunded" },
];

const PAYOUT_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "sent", label: "Sent" },
  { key: "pending", label: "Pending" },
  { key: "failed", label: "Failed" },
];

export default function ProviderBillingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "payouts" ? "payouts" : "invoices";
  const status = searchParams.get("status") || "all";
  const service = searchParams.get("service") || "all";
  const q = searchParams.get("q") || "";

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
    return matchesService(inv) && matchesSearch(inv);
  });

  const payoutRows = invoices
    .filter((inv: any) => inv.status === "PAID" && (inv.providerPayoutAmount || 0) > 0)
    .filter((inv: any) => {
      if (status === "all") return matchesService(inv) && matchesSearch(inv);
      const s = derivePayoutStatus(inv);
      const key = s.label.toLowerCase();
      const want = status === "sent" ? key.includes("sent") || s.isReceived
        : status === "failed" ? key.includes("fail")
        : !key.includes("sent") && !key.includes("fail") && !s.isReceived;
      return want && matchesService(inv) && matchesSearch(inv);
    })
    .sort((a: any, b: any) => {
      const aT = new Date(a.payoutInitiatedAt || a.paidAt || a.createdAt).getTime();
      const bT = new Date(b.payoutInitiatedAt || b.paidAt || b.createdAt).getTime();
      return bT - aT;
    });

  const totalReceived = invoices
    .filter((i: any) => i.status === "PAID")
    .reduce((sum: number, i: any) => sum + (i.providerPayoutAmount || 0), 0);
  const awaitingCount = invoices.filter((i: any) => ["AWAITING_PAYMENT", "AUTHORIZED"].includes(i.status)).length;
  const pendingPayouts = invoices.filter((i: any) => i.status === "PAID" && (i.providerPayoutAmount || 0) > 0 && !derivePayoutStatus(i).isReceived).length;

  const statusFilters = tab === "invoices" ? INVOICE_STATUS_FILTERS : PAYOUT_STATUS_FILTERS;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">All invoices you've sent and every payout GoStork has sent you</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Received</p>
          <p className="text-xl font-heading font-bold">{formatCents(totalReceived)}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Awaiting Payment</p>
          <p className="text-xl font-heading font-bold">{awaitingCount}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Pending Payouts</p>
          <p className="text-xl font-heading font-bold">{pendingPayouts}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {[
          { key: "invoices", label: "Invoices", icon: Receipt },
          { key: "payouts", label: "Payouts", icon: Landmark },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setParam({ tab: t.key === "invoices" ? null : t.key, status: null })}
            className="px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5"
            style={{
              borderBottomColor: tab === t.key ? "hsl(var(--primary))" : "transparent",
              color: tab === t.key ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
            }}
            data-testid={`provider-billing-tab-${t.key}`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
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
        <select
          value={status}
          onChange={e => setParam({ status: e.target.value })}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
          data-testid="provider-billing-status-filter"
        >
          {statusFilters.map(f => (
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
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : tab === "invoices" ? (
        !filteredInvoices.length ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Receipt className="w-8 h-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{invoices.length ? "No invoices match your filters" : "No invoices yet"}</p>
          </div>
        ) : (
          <div className="rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Parent</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Service</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Amount</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">GoStork Fee</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Your Payout</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map((inv: any) => (
                    <tr
                      key={inv.id}
                      className="border-b last:border-0 hover:bg-muted/10 cursor-pointer"
                      onClick={() => window.open(`/api/provider/invoices/${inv.id}/document`, "_blank", "noopener,noreferrer")}
                      title="Open invoice document"
                      data-testid={`provider-billing-invoice-${inv.id}`}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap">{inv.parentUser?.name || inv.parentUser?.email || "Parent"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{(inv.serviceType || "-").replace(/_/g, " ").toLowerCase()}</td>
                      <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{formatCents(inv.serviceAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground whitespace-nowrap">{formatCents(inv.referralFeeAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap"><InvoiceStatusBadge status={inv.status} /></td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{formatDateTime(inv.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : (
        /* Payouts tab */
        !payoutRows.length ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Landmark className="w-8 h-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No payouts match your filters</p>
          </div>
        ) : (
          <div className="rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Parent</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Service</th>
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Your Payout</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">GoStork Paid You</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs whitespace-nowrap">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {payoutRows.map((inv: any) => {
                    const s = derivePayoutStatus(inv);
                    return (
                      <tr
                        key={inv.id}
                        className="border-b last:border-0 hover:bg-muted/10 cursor-pointer"
                        onClick={() => window.open(`/api/provider/invoices/${inv.id}/document`, "_blank", "noopener,noreferrer")}
                        title="Open invoice document"
                        data-testid={`provider-billing-payout-${inv.id}`}
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap">{inv.parentUser?.name || inv.parentUser?.email || "Parent"}</td>
                        <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{(inv.serviceType || "-").replace(/_/g, " ").toLowerCase()}</td>
                        <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                        <td className="px-4 py-2.5 text-xs font-medium whitespace-nowrap" style={{ color: s.color }}>
                          <span title={s.tooltip} className="cursor-help underline decoration-dotted underline-offset-2 inline-flex items-center gap-1">
                            {s.isReceived && <CheckCircle2 className="w-3.5 h-3.5" />}
                            {s.label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{formatDateTime(inv.bankPayoutCompletedAt || inv.payoutInitiatedAt || inv.paidAt || inv.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </div>
  );
}
