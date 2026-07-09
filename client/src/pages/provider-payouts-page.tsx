/**
 * Provider Payouts page
 * Route: /provider/payouts
 *
 * Every payout GoStork has sent (or is sending) to the provider's bank, with
 * transfer status derived from the Stripe transfer/bank-payout fields. Split
 * out of the old 3-tab Billing page. Reached from the Home dashboard's
 * Payouts quick-link card.
 */

import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search, Landmark, CheckCircle2 } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { formatDateTime } from "@/lib/format-date";
import { derivePayoutStatus } from "@/lib/payout-status";
import { DateRangeFilter, inDateRange } from "@/components/date-range-filter";

const PAYOUT_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "sent", label: "Sent" },
  { key: "pending", label: "Pending" },
  { key: "failed", label: "Failed" },
];

export default function ProviderPayoutsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
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

  const serviceTypes = Array.from(new Set(invoices.map((i: any) => i.serviceType).filter(Boolean))) as string[];

  const matchesSearch = (inv: any) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [inv.parentUser?.name, inv.parentUser?.email, inv.serviceType, inv.description, inv.id]
      .some(h => (h || "").toLowerCase().includes(needle));
  };
  const matchesService = (inv: any) => service === "all" || inv.serviceType === service;

  const payoutRows = invoices
    .filter((inv: any) => inv.status === "PAID" && (inv.providerPayoutAmount || 0) > 0)
    .filter((inv: any) => inDateRange(inv.payoutInitiatedAt || inv.paidAt || inv.createdAt, dateFrom, dateTo))
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
  const pendingPayouts = invoices.filter((i: any) => i.status === "PAID" && (i.providerPayoutAmount || 0) > 0 && !derivePayoutStatus(i).isReceived).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Payouts</h1>
        <p className="text-sm text-muted-foreground mt-1">Every payout GoStork has sent you</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Received</p>
          <p className="text-xl font-heading font-bold">{formatCents(totalReceived)}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Pending Payouts</p>
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
            data-testid="provider-payouts-search"
          />
        </div>
        <DateRangeFilter from={dateFrom} to={dateTo} onFrom={v => setParam({ from: v })} onTo={v => setParam({ to: v })} testIdPrefix="provider-payouts-date" />
        <select
          value={status}
          onChange={e => setParam({ status: e.target.value })}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
          data-testid="provider-payouts-status-filter"
        >
          {PAYOUT_STATUS_FILTERS.map(f => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        {serviceTypes.length > 1 && (
          <select
            value={service}
            onChange={e => setParam({ service: e.target.value })}
            className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
            data-testid="provider-payouts-service-filter"
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
      ) : !payoutRows.length ? (
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
      )}
    </div>
  );
}
