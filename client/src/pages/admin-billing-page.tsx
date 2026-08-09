/**
 * Admin Billing Dashboard
 * Route: /admin/billing
 *
 * Shows all invoices with revenue stats, filtering, inline detail expansion,
 * and manual payout/mark-paid controls.
 */

import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DollarSign,
  Clock,
  CheckCircle2,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { PageHeader, TableShell } from "@/components/ui/page-header";
import { FilterRow, FilterSearch, FilterDropdown, FilterDateRange } from "@/components/ui/filter-controls";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { Input } from "@/components/ui/input";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { derivePayoutStatus } from "@/lib/payout-status";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { useToast } from "@/hooks/use-toast";
import { ParentInfoBlock, InvoiceInfoBlock } from "@/components/invoice-details-blocks";

function StatCard({ label, value, icon: Icon, sub }: { label: string; value: string; icon: any; sub?: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-border/50 bg-card p-4 space-y-1">
      <div className="t-helper flex items-center gap-2">
        <Icon className="w-4 h-4" />
        <span>{label}</span>
      </div>
      <p className="text-2xl font-heading font-bold">{value}</p>
      {sub && <p className="t-helper">{sub}</p>}
    </div>
  );
}

// Payout status is derived, not a column - these keys are the ones the
// server's payoutStatus filter understands.
const PAYOUT_STATUS_OPTIONS: [string, string][] = [
  ["pending", "Pending"],
  ["sent", "Sent"],
  ["received", "Received"],
  ["failed", "Failed"],
];

const STATUS_OPTIONS = [
  { key: "all",             label: "All statuses"  },
  { key: "AWAITING_PAYMENT",label: "Awaiting Payment" },
  { key: "AUTHORIZED",      label: "Authorized"    },
  { key: "PAID",            label: "Paid"          },
  { key: "CLEARANCE_FAILED",label: "Failed"        },
  { key: "EXPIRED",         label: "Expired"       },
];

export default function AdminBillingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Status filter lives in the URL (?tab=) so the browser back button restores it.
  const tab = searchParams.get("tab") || "all";
  const setStatus = (value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (value === "all") next.delete("tab");
      else next.set("tab", value);
      return next;
    }, { replace: true });
    setPage(1);
  };
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { toast } = useToast();
  const [adminNotes, setAdminNotes] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);

  // Filters. ?q= deep links (from the admin Home "Resolve"/"Review" rows)
  // pre-fill the search so the page opens scoped to the exact invoice.
  const initialQ = searchParams.get("q") || "";
  const [searchInput, setSearchInput] = useState(initialQ);
  const [search, setSearch] = useState(initialQ);
  const [serviceType, setServiceType] = useState("all");
  const [payoutStatus, setPayoutStatus] = useState("all");
  const [paidFrom, setPaidFrom] = useState("");
  const [paidTo, setPaidTo] = useState("");
  // Sort is a server concern here: the table is paginated, so sorting the 25
  // rows on screen would claim an order the other pages don't share.
  const { sortConfig, handleSort } = useTableSort();

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [serviceType, payoutStatus, paidFrom, paidTo, sortConfig.key, sortConfig.direction]);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/invoices", tab, page, search, serviceType, payoutStatus, paidFrom, paidTo, sortConfig.key, sortConfig.direction],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (tab !== "all") params.set("status", tab);
      if (search) params.set("search", search);
      if (serviceType !== "all") params.set("serviceType", serviceType);
      if (payoutStatus !== "all") params.set("payoutStatus", payoutStatus);
      if (paidFrom) params.set("paidFrom", paidFrom);
      if (paidTo) params.set("paidTo", paidTo);
      if (sortConfig.key && sortConfig.direction) {
        params.set("sortBy", sortConfig.key);
        params.set("sortDir", sortConfig.direction);
      }
      const res = await fetch(`/api/admin/invoices?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
  });

  const serviceTypeOptions: string[] = data?.serviceTypes || [];
  const hasActiveFilters = !!search || serviceType !== "all" || payoutStatus !== "all" || !!paidFrom || !!paidTo || tab !== "all";
  const clearFilters = () => { setSearchInput(""); setSearch(""); setServiceType("all"); setPayoutStatus("all"); setPaidFrom(""); setPaidTo(""); setStatus("all"); };

  const markPaidMutation = useMutation({
    mutationFn: async ({ id, notes }: { id: string; notes: string }) => {
      const res = await fetch(`/api/admin/invoices/${id}/mark-paid`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) throw new Error("Failed to mark as paid");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices"] });
    },
  });

  const payoutMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/invoices/${id}/initiate-payout`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to initiate payout");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices"] });
    },
  });

  const stats = data || { totalGoStorkFees: 0, totalRevenue: 0, totalProviderPayouts: 0, pendingAmount: 0 };

  return (
    <div className="space-y-8">
      <PageHeader title="Billing Dashboard" subtitle="Track all parent payments and provider payouts" />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Gross Income"    value={formatCents(stats.totalRevenue)}         icon={DollarSign}    sub="Total Paid Invoices" />
        <StatCard label="Payouts Sent"    value={formatCents(stats.totalProviderPayouts)} icon={CheckCircle2}  sub="COGS" />
        <StatCard label="Net Income"      value={formatCents(stats.totalGoStorkFees)}     icon={TrendingUp}    sub="GoStork Fees" />
        <StatCard label="Pending Payouts" value={formatCents((stats.totalRevenue || 0) - (stats.totalProviderPayouts || 0))} icon={DollarSign} sub="Future COGS" />
        <StatCard label="Unpaid Invoices" value={formatCents(stats.pendingAmount)}        icon={Clock}         sub="Future Invoices" />
      </div>

      {/* Filters. Stacked label-over-control selects became pills: the labels
          restated what each control already says when nothing is picked
          ("Invoice Status" above "All statuses"), and the extra row of text
          pushed the table below the fold. */}
      <div className="flex items-start justify-between gap-3">
        <FilterRow className="flex-1 min-w-0">
          <FilterSearch
            value={searchInput}
            onChange={setSearchInput}
            placeholder="Parent, provider, invoice ID, or session ID"
            testId="billing-search"
          />
          <FilterDateRange
            from={paidFrom}
            to={paidTo}
            onFrom={setPaidFrom}
            onTo={setPaidTo}
            testIdPrefix="billing-paid"
          />
          <FilterDropdown
            single
            label="All statuses"
            options={STATUS_OPTIONS.filter((o) => o.key !== "all").map((o) => [o.key, o.label] as [string, string])}
            selected={tab === "all" ? [] : [tab]}
            onChange={(next) => setStatus(next[0] || "all")}
            testId="billing-status"
          />
          <FilterDropdown
            single
            label="All payout statuses"
            options={PAYOUT_STATUS_OPTIONS}
            selected={payoutStatus === "all" ? [] : [payoutStatus]}
            onChange={(next) => setPayoutStatus(next[0] || "all")}
            testId="billing-payout-status"
          />
          <FilterDropdown
            single
            label="All services"
            options={serviceTypeOptions.map((st) => [st, st] as [string, string])}
            selected={serviceType === "all" ? [] : [serviceType]}
            onChange={(next) => setServiceType(next[0] || "all")}
            testId="billing-service-type"
          />
        </FilterRow>
        <ClearFiltersButton pill show={hasActiveFilters} onClick={clearFilters} testId="billing-clear-filters" />
      </div>

      {/* Invoice table */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data?.invoices?.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <AlertCircle className="w-8 h-8 text-muted-foreground" />
          <p className="t-helper">No invoices found</p>
        </div>
      ) : (
        <TableShell>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted">
                <SortableTableHead label="Parent" sortKey="parent" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Provider" sortKey="provider" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Service" sortKey="service" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Amount" sortKey="amount" currentSort={sortConfig} onSort={handleSort} align="right" className="whitespace-nowrap" />
                <SortableTableHead label="GoStork Fee" sortKey="fee" currentSort={sortConfig} onSort={handleSort} align="right" className="whitespace-nowrap" />
                <SortableTableHead label="Payout" sortKey="payout" currentSort={sortConfig} onSort={handleSort} align="right" className="whitespace-nowrap" />
                <SortableTableHead label="Invoice Status" sortKey="invoiceStatus" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Payout Status" sortKey="payoutStatus" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Date" sortKey="date" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((inv: any) => (
                <>
                  <tr
                    key={inv.id}
                    className="border-b hover:bg-muted/20 cursor-pointer transition-colors"
                    onClick={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
                  >
                    <td className="px-4 py-3 font-medium">{inv.parentUser?.name || inv.parentUser?.email}</td>
                    <td className="px-4 py-3 text-muted-foreground">{inv.providerName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{inv.serviceType}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatCents(inv.serviceAmount, inv.currency)}</td>
                    <td className="px-4 py-3 text-right" style={{ color: "hsl(var(--brand-success))" }}>{formatCents(inv.referralFeeAmount, inv.currency)}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                    <td className="px-4 py-3"><InvoiceStatusBadge status={inv.status} medicalClearanceStatus={(inv as any).medicalClearanceStatus} /></td>
                    <td className="px-4 py-3 text-xs font-medium whitespace-nowrap">
                      {(() => {
                        const ps = derivePayoutStatus(inv);
                        return (
                          <span title={ps.tooltip} className="cursor-help underline decoration-dotted underline-offset-2" style={{ color: ps.color }}>
                            {ps.label}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="t-helper px-4 py-3">{new Date(inv.paidAt || inv.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      {expandedId === inv.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedId === inv.id && (
                    <tr key={`${inv.id}-detail`} className="bg-muted/10">
                      <td colSpan={10} className="px-6 py-5">
                        <div className="grid md:grid-cols-2 gap-6">
                          {/* Details */}
                          <div className="space-y-5 text-sm">
                            <ParentInfoBlock parentUser={inv.parentUser} />
                            <InvoiceInfoBlock inv={inv} showAdminFields />
                          </div>

                          {/* Actions */}
                          <div className="space-y-3">
                            <h3 className="text-sm font-semibold">Actions</h3>

                            {inv.status === "AWAITING_PAYMENT" && inv.paymentToken && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  navigator.clipboard.writeText(`${window.location.origin}/pay/${inv.paymentToken}`);
                                  toast({ title: "Payment link copied", description: "Send it to the parent so they can pay directly." });
                                }}
                              >
                                <Link2 className="w-3.5 h-3.5 mr-1.5" /> Copy payment link
                              </Button>
                            )}

                            {inv.status === "AWAITING_PAYMENT" && (
                              <div className="space-y-2">
                                <Input
                                  placeholder="Admin notes (optional)"
                                  value={adminNotes[inv.id] || ""}
                                  onChange={e => setAdminNotes(p => ({ ...p, [inv.id]: e.target.value }))}
                                  className="text-sm"
                                />
                                <Button
                                  size="sm"
                                  disabled={markPaidMutation.isPending}
                                  onClick={() => markPaidMutation.mutate({ id: inv.id, notes: adminNotes[inv.id] || "" })}
                                  style={{ background: "hsl(var(--brand-success))", color: "#fff", borderRadius: "var(--radius)" }}
                                >
                                  {markPaidMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                                  Mark as Paid (Manual Override)
                                </Button>
                              </div>
                            )}

                            {inv.status === "PAID" && !inv.payoutInitiatedAt && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={payoutMutation.isPending}
                                onClick={() => payoutMutation.mutate(inv.id)}
                              >
                                {payoutMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                                Initiate Payout ({formatCents(inv.providerPayoutAmount, inv.currency)} to {inv.providerName})
                              </Button>
                            )}

                            {inv.status === "PAID" && inv.payoutInitiatedAt && !inv.payoutCompletedAt && (
                              <p className="t-helper">Payout initiated - awaiting confirmation</p>
                            )}

                            {inv.status === "PAID" && inv.payoutCompletedAt && (
                              <p className="text-sm" style={{ color: "hsl(var(--brand-success))" }}>Payout complete</p>
                            )}

                            <a
                              href={`/chat?session=${inv.sessionId}`}
                              className="t-helper underline"
                            >
                              View session in chat
                            </a>
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

          {/* Pagination */}
          {data.total > 25 && (
            <div className="t-helper flex items-center justify-between px-4 py-3 border-t">
              <span>Showing {Math.min((page - 1) * 25 + 1, data.total)}-{Math.min(page * 25, data.total)} of {data.total}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
                <Button size="sm" variant="outline" disabled={page * 25 >= data.total} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </TableShell>
      )}
    </div>
  );
}
