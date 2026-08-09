/**
 * Provider Payouts page
 * Route: /provider/payouts
 *
 * Every payout GoStork has sent (or is sending) to the provider's bank.
 * The table itself is the shared PayoutTable, which the Settings > Payouts
 * tab also renders - this page just adds the summary figures and filters.
 */

import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { derivePayoutStatus } from "@/lib/payout-status";
import { inDateRange } from "@/components/date-range-filter";
import { FilterSearch, FilterDropdown, FilterDateRange } from "@/components/ui/filter-controls";
import { ListPageHeader, StatGrid, StatCard, ListFilterBar, ListLoading, ListEmpty } from "@/components/ui/list-page";
import { PayoutTable } from "@/components/payout-table";
import { ServiceTag } from "@/components/ui/service-tag";

const PAYOUT_STATUS_FILTERS = [
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

  const hasFilters = !!(q || dateFrom || dateTo || status !== "all" || service !== "all");

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <ListPageHeader title="Payouts" subtitle="Every payout GoStork has sent you" />

      <StatGrid>
        <StatCard label="Total received" value={formatCents(totalReceived)} testId="stat-total-received" />
        <StatCard label="Pending payouts" value={pendingPayouts} testId="stat-pending-payouts" />
      </StatGrid>

      <ListFilterBar
        showClear={hasFilters}
        onClear={() => setParam({ q: null, from: null, to: null, status: null, service: null })}
        testId="provider-payouts-clear-filters"
      >
        <FilterSearch
          placeholder="Search by parent, service, or description..."
          value={q}
          onChange={(v) => setParam({ q: v })}
          testId="provider-payouts-search"
        />
        <FilterDateRange
          from={dateFrom} to={dateTo}
          onFrom={(v) => setParam({ from: v })} onTo={(v) => setParam({ to: v })}
          testIdPrefix="provider-payouts-date"
        />
        <FilterDropdown
          single
          label="All statuses"
          options={PAYOUT_STATUS_FILTERS.map(f => [f.key, f.label] as [string, string])}
          selected={status === "all" ? [] : [status]}
          onChange={(next) => setParam({ status: next[0] || null })}
          testId="provider-payouts-status-filter"
        />
        {serviceTypes.length > 1 && (
          <FilterDropdown
            single
            label="All services"
            options={serviceTypes.map(st => [st, st.replace(/_/g, " ")] as [string, string])}
            selected={service === "all" ? [] : [service]}
            onChange={(next) => setParam({ service: next[0] || null })}
            testId="provider-payouts-service-filter"
            renderOption={(_k, text) => <ServiceTag service={text} />}
          />
        )}
      </ListFilterBar>

      {isLoading ? (
        <ListLoading />
      ) : !payoutRows.length ? (
        <ListEmpty icon={<Landmark className="w-8 h-8 text-muted-foreground" />} message="No payouts match your filters" />
      ) : (
        <PayoutTable payouts={payoutRows} mode="expand" testIdPrefix="provider-billing-payout" />
      )}
    </div>
  );
}
