/**
 * Provider Payouts page
 * Route: /provider/payouts
 *
 * Every payout GoStork has sent (or is sending) to the provider's bank, with
 * transfer status derived from the Stripe transfer/bank-payout fields. Split
 * out of the old 3-tab Billing page. Reached from the Home dashboard's
 * Payouts quick-link card.
 */

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { Loader2, Landmark, CheckCircle2, ChevronDown, ChevronUp, FileText } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { formatDateTime } from "@/lib/format-date";
import { derivePayoutStatus } from "@/lib/payout-status";
import { inDateRange } from "@/components/date-range-filter";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { FilterRow, FilterSearch, FilterDropdown, FilterDateRange } from "@/components/ui/filter-controls";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { ServiceTag } from "@/components/ui/service-tag";
import { ParentInfoBlock, InvoiceInfoBlock } from "@/components/invoice-details-blocks";
import { Button } from "@/components/ui/button";

const PAYOUT_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "sent", label: "Sent" },
  { key: "pending", label: "Pending" },
  { key: "failed", label: "Failed" },
];

export default function ProviderPayoutsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Header sort layers on top of the newest-first default: with no active key
  // sortData returns the list untouched, so that default survives. Same
  // comparator as the Settings payout table, so the two never disagree.
  const { sortConfig, handleSort, sortData } = useTableSort();
  const sortedRows = sortData(payoutRows, (inv: any, key) => {
    switch (key) {
      case "parent": return (inv.parentUser?.name || inv.parentUser?.email || "").toLowerCase();
      case "service": return (inv.serviceType || "").toLowerCase();
      case "payout": return inv.providerPayoutAmount ?? null;
      case "status": return derivePayoutStatus(inv).label;
      case "date": return new Date(inv.bankPayoutCompletedAt || inv.payoutInitiatedAt || inv.paidAt || inv.createdAt).getTime();
      default: return null;
    }
  });

  const totalReceived = invoices
    .filter((i: any) => i.status === "PAID")
    .reduce((sum: number, i: any) => sum + (i.providerPayoutAmount || 0), 0);
  const pendingPayouts = invoices.filter((i: any) => i.status === "PAID" && (i.providerPayoutAmount || 0) > 0 && !derivePayoutStatus(i).isReceived).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Payouts</h1>
        <p className="t-helper mt-1">Every payout GoStork has sent you</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-[var(--container-radius)] border border-border bg-card shadow-sm p-4 space-y-1">
          <p className="t-micro-label">Total received</p>
          <p className="text-2xl font-heading font-bold">{formatCents(totalReceived)}</p>
        </div>
        <div className="rounded-[var(--container-radius)] border border-border bg-card shadow-sm p-4 space-y-1">
          <p className="t-micro-label">Pending payouts</p>
          <p className="text-2xl font-heading font-bold">{pendingPayouts}</p>
        </div>
      </div>

      {/* The shared filter controls every other table uses - the raw input and
          selects here predated them and were the only filters in the product
          that did not match. */}
      <div className="flex items-start justify-between gap-3">
        <FilterRow>
          <FilterSearch
            placeholder="Search by parent, service, or description..."
            value={q}
            onChange={(v) => setParam({ q: v })}
            testId="provider-payouts-search"
          />
          <FilterDateRange
            from={dateFrom}
            to={dateTo}
            onFrom={(v) => setParam({ from: v })}
            onTo={(v) => setParam({ to: v })}
            testIdPrefix="provider-payouts-date"
          />
          <FilterDropdown
            single
            label="All statuses"
            options={PAYOUT_STATUS_FILTERS.filter(f => f.key !== "all").map(f => [f.key, f.label] as [string, string])}
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
        </FilterRow>
        <ClearFiltersButton
          pill
          show={!!(q || dateFrom || dateTo || status !== "all" || service !== "all")}
          onClick={() => setParam({ q: null, from: null, to: null, status: null, service: null })}
          testId="provider-payouts-clear-filters"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !payoutRows.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Landmark className="w-8 h-8 text-muted-foreground" />
          <p className="t-helper">No payouts match your filters</p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Parent</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Service</th>
                  <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">Your Payout</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">GoStork Paid You</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Date</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {payoutRows.map((inv: any) => {
                  const s = derivePayoutStatus(inv);
                  return (
                    <>
                    <tr
                      key={inv.id}
                      className="border-b last:border-0 hover:bg-muted/10 cursor-pointer"
                      onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
                      data-testid={`provider-billing-payout-${inv.id}`}
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap">{inv.parentUser?.name || inv.parentUser?.email || "Parent"}</td>
                      <td className="t-helper px-4 py-2.5 whitespace-nowrap">{(inv.serviceType || "-").replace(/_/g, " ").toLowerCase()}</td>
                      <td className="px-4 py-2.5 text-right font-medium whitespace-nowrap">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-xs font-medium whitespace-nowrap" style={{ color: s.color }}>
                        <span title={s.tooltip} className="cursor-help underline decoration-dotted underline-offset-2 inline-flex items-center gap-1">
                          {s.isReceived && <CheckCircle2 className="w-3.5 h-3.5" />}
                          {s.label}
                        </span>
                      </td>
                      <td className="t-helper px-4 py-2.5 whitespace-nowrap">{formatDateTime(inv.bankPayoutCompletedAt || inv.payoutInitiatedAt || inv.paidAt || inv.createdAt)}</td>
                      <td className="px-2 py-2.5 text-muted-foreground">
                        {expandedId === inv.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </td>
                    </tr>
                    {expandedId === inv.id && (
                      <tr key={`${inv.id}-detail`} className="bg-muted/10 border-b last:border-0">
                        <td colSpan={6} className="px-6 py-5">
                          <div className="grid md:grid-cols-2 gap-6 text-sm">
                            <div className="space-y-5">
                              <ParentInfoBlock parentUser={inv.parentUser} />
                              <InvoiceInfoBlock inv={inv} />
                            </div>
                            <div className="space-y-3">
                              <h3 className="font-semibold">Actions</h3>
                              <div>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => window.open(`/api/provider/invoices/${inv.id}/document`, "_blank", "noopener,noreferrer")}
                                >
                                  <FileText className="w-3.5 h-3.5 mr-1.5" /> Open invoice document
                                </Button>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </>
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
