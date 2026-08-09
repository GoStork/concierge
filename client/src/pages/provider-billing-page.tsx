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
import { Fragment } from "react";
import { Receipt, ChevronDown, ChevronUp, MessageCircle, FileText } from "lucide-react";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { formatDateTime } from "@/lib/format-date";
import { derivePayoutStatus } from "@/lib/payout-status";
import { inDateRange } from "@/components/date-range-filter";
import { FilterSearch, FilterDropdown, FilterDateRange } from "@/components/ui/filter-controls";
import { ListPageHeader, StatGrid, StatCard, ListFilterBar, ListLoading, ListEmpty, TableShell, TableHeadRow, TableBodyRow } from "@/components/ui/list-page";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { ServiceTag } from "@/components/ui/service-tag";
import { ParentInfoBlock, InvoiceInfoBlock } from "@/components/invoice-details-blocks";
import { Button } from "@/components/ui/button";

const INVOICE_STATUS_FILTERS = [
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

  const { sortConfig, handleSort, sortData } = useTableSort();
  const sortedInvoices = sortData(filteredInvoices, (inv: any, key) => {
    switch (key) {
      case "parent": return (inv.parentUser?.name || inv.parentUser?.email || "").toLowerCase();
      case "service": return (inv.serviceType || "").toLowerCase();
      case "amount": return inv.serviceAmount ?? null;
      case "fee": return inv.referralFeeAmount ?? null;
      case "payout": return inv.providerPayoutAmount ?? null;
      case "status": return inv.status || "";
      case "payoutStatus": return derivePayoutStatus(inv).label;
      case "date": return new Date(inv.createdAt).getTime();
      default: return null;
    }
  });

  const totalReceived = invoices
    .filter((i: any) => i.status === "PAID")
    .reduce((sum: number, i: any) => sum + (i.providerPayoutAmount || 0), 0);
  const awaitingCount = invoices.filter((i: any) => ["AWAITING_PAYMENT", "AUTHORIZED"].includes(i.status)).length;
  const pendingPayouts = invoices.filter((i: any) => i.status === "PAID" && (i.providerPayoutAmount || 0) > 0 && !derivePayoutStatus(i).isReceived).length;

  return (
    // Nine columns need more than the 5xl the sibling pages use - at that
    // width the table overflowed into a scroller on a screen with room left.
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      <ListPageHeader title="Invoices" subtitle="Every invoice you've sent to parents" />

      <StatGrid>
        <StatCard label="Total received" value={formatCents(totalReceived)} testId="stat-total-received" />
        <StatCard label="Awaiting payment" value={awaitingCount} testId="stat-awaiting" />
        <StatCard label="Pending payouts" value={pendingPayouts} testId="stat-pending-payouts" />
      </StatGrid>

      <ListFilterBar
        showClear={!!(q || dateFrom || dateTo || status !== "all" || service !== "all")}
        onClear={() => setParam({ q: null, from: null, to: null, status: null, service: null })}
        testId="provider-invoices-clear-filters"
      >
        <FilterSearch
          placeholder="Search by parent, service, or description..."
          value={q} onChange={(v) => setParam({ q: v })}
          testId="provider-billing-search"
        />
        <FilterDateRange
          from={dateFrom} to={dateTo}
          onFrom={(v) => setParam({ from: v })} onTo={(v) => setParam({ to: v })}
          testIdPrefix="provider-billing-date"
        />
        <FilterDropdown
          single label="All statuses"
          options={INVOICE_STATUS_FILTERS.map(f => [f.key, f.label] as [string, string])}
          selected={status === "all" ? [] : [status]}
          onChange={(next) => setParam({ status: next[0] || null })}
          testId="provider-billing-status-filter"
        />
        {serviceTypes.length > 1 && (
          <FilterDropdown
            single label="All services"
            options={serviceTypes.map(st => [st, st.replace(/_/g, " ")] as [string, string])}
            selected={service === "all" ? [] : [service]}
            onChange={(next) => setParam({ service: next[0] || null })}
            testId="provider-billing-service-filter"
            renderOption={(_k, text) => <ServiceTag service={text} />}
          />
        )}
      </ListFilterBar>

      {isLoading ? (
        <ListLoading />
      ) : !filteredInvoices.length ? (
        <ListEmpty
          icon={<Receipt className="w-8 h-8 text-muted-foreground" />}
          message={invoices.length ? "No invoices match your filters" : "No invoices yet"}
        />
      ) : (
        <TableShell minWidth={860}>
          <TableHeadRow>
            <SortableTableHead label="Parent" sortKey="parent" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <SortableTableHead label="Service" sortKey="service" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <SortableTableHead label="Amount" sortKey="amount" currentSort={sortConfig} onSort={handleSort} align="right" className="whitespace-nowrap" />
            <SortableTableHead label="GoStork fee" sortKey="fee" currentSort={sortConfig} onSort={handleSort} align="right" className="whitespace-nowrap" />
            <SortableTableHead label="Your payout" sortKey="payout" currentSort={sortConfig} onSort={handleSort} align="right" className="whitespace-nowrap" />
            <SortableTableHead label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <SortableTableHead label="Payout status" sortKey="payoutStatus" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <SortableTableHead label="Date" sortKey="date" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <th className="w-10" />
          </TableHeadRow>
          <tbody>
            {sortedInvoices.map((inv: any) => {
              const ps = derivePayoutStatus(inv);
              const open = expandedId === inv.id;
              return (
                // Fragment carries the key - it is the mapped root, so the key
                // on the inner <tr> never applied and React warned.
                <Fragment key={inv.id}>
                  <TableBodyRow
                    onClick={() => setExpandedId(open ? null : inv.id)}
                    testId={`provider-billing-invoice-${inv.id}`}
                  >
                    <td className="p-4 align-middle whitespace-nowrap font-medium">{inv.parentUser?.name || inv.parentUser?.email || "Parent"}</td>
                    <td className="p-4 align-middle whitespace-nowrap"><ServiceTag service={inv.serviceType} /></td>
                    <td className="p-4 align-middle text-right font-medium whitespace-nowrap tabular-nums">{formatCents(inv.serviceAmount, inv.currency)}</td>
                    <td className="p-4 align-middle text-right text-muted-foreground whitespace-nowrap tabular-nums">{formatCents(inv.referralFeeAmount, inv.currency)}</td>
                    <td className="p-4 align-middle text-right font-medium whitespace-nowrap tabular-nums">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                    <td className="p-4 align-middle whitespace-nowrap"><InvoiceStatusBadge status={inv.status} medicalClearanceStatus={(inv as any).medicalClearanceStatus} /></td>
                    <td className="p-4 align-middle text-xs font-medium whitespace-nowrap">
                      <span title={ps.tooltip} className="cursor-help underline decoration-dotted underline-offset-2" style={{ color: ps.color }}>
                        {ps.label}
                      </span>
                    </td>
                    <td className="t-helper p-4 align-middle whitespace-nowrap">{formatDateTime(inv.createdAt)}</td>
                    <td className="p-4 align-middle text-muted-foreground">
                      {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                  </TableBodyRow>
                  {open && (
                    <tr className="bg-secondary/40 border-b last:border-0">
                      <td colSpan={9} className="px-6 py-5">
                        <div className="grid md:grid-cols-2 gap-6 text-sm">
                          <div className="space-y-5">
                            <ParentInfoBlock parentUser={inv.parentUser} />
                            <InvoiceInfoBlock inv={inv} />
                          </div>
                          <div className="space-y-3">
                            <h3 className="font-semibold">Actions</h3>
                            {["AWAITING_PAYMENT", "AUTHORIZED"].includes(inv.status) && inv.sessionId && (
                              <Button size="sm" onClick={() => navigate(`/chat/${inv.sessionId}`)} data-testid={`provider-invoice-remind-${inv.id}`}>
                                <MessageCircle className="w-3.5 h-3.5 mr-1.5" /> Remind in chat
                              </Button>
                            )}
                            <div>
                              <Button
                                size="sm" variant="outline" className="bg-card"
                                onClick={() => window.open(`/api/provider/invoices/${inv.id}/document`, "_blank", "noopener,noreferrer")}
                              >
                                <FileText className="w-3.5 h-3.5 mr-1.5" /> Open invoice document
                              </Button>
                            </div>
                            {!["AWAITING_PAYMENT", "AUTHORIZED"].includes(inv.status) && inv.sessionId && (
                              <button onClick={() => navigate(`/chat/${inv.sessionId}`)} className="t-helper underline block">
                                Open chat with parent
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
