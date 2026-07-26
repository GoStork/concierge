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
  Search,
  X,
  Link2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { Input } from "@/components/ui/input";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { derivePayoutStatus } from "@/lib/payout-status";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { useToast } from "@/hooks/use-toast";
import { ParentInfoBlock, InvoiceInfoBlock } from "@/components/invoice-details-blocks";

function StatCard({ label, value, icon: Icon, sub }: { label: string; value: string; icon: any; sub?: string }) {
  return (
    <div className="rounded-xl border p-4 space-y-1">
      <div className="t-helper flex items-center gap-2">
        <Icon className="w-4 h-4" />
        <span>{label}</span>
      </div>
      <p className="text-2xl font-heading font-bold">{value}</p>
      {sub && <p className="t-helper">{sub}</p>}
    </div>
  );
}

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

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [serviceType, payoutStatus, paidFrom, paidTo]);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/invoices", tab, page, search, serviceType, payoutStatus, paidFrom, paidTo],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (tab !== "all") params.set("status", tab);
      if (search) params.set("search", search);
      if (serviceType !== "all") params.set("serviceType", serviceType);
      if (payoutStatus !== "all") params.set("payoutStatus", payoutStatus);
      if (paidFrom) params.set("paidFrom", paidFrom);
      if (paidTo) params.set("paidTo", paidTo);
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
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Billing Dashboard</h1>
        <p className="t-helper mt-1">Track all parent payments and provider payouts</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Gross Income"    value={formatCents(stats.totalRevenue)}         icon={DollarSign}    sub="Total Paid Invoices" />
        <StatCard label="Payouts Sent"    value={formatCents(stats.totalProviderPayouts)} icon={CheckCircle2}  sub="COGS" />
        <StatCard label="Net Income"      value={formatCents(stats.totalGoStorkFees)}     icon={TrendingUp}    sub="GoStork Fees" />
        <StatCard label="Pending Payouts" value={formatCents((stats.totalRevenue || 0) - (stats.totalProviderPayouts || 0))} icon={DollarSign} sub="Future COGS" />
        <StatCard label="Unpaid Invoices" value={formatCents(stats.pendingAmount)}        icon={Clock}         sub="Future Invoices" />
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-nowrap sm:overflow-x-auto sm:scrollbar-hide sm:flex-1 sm:min-w-0">
        <div className="flex-1 min-w-[180px]">
          <label className="t-helper mb-1 block">Search</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Parent, provider, invoice ID, or session ID"
              className="pl-9 pr-9"
              data-testid="billing-search"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="w-[170px] shrink-0">
          <label className="t-helper mb-1 block">Invoice Status</label>
          <select
            value={tab}
            onChange={e => setStatus(e.target.value)}
            className="w-full h-10 rounded-[var(--radius)] border border-input bg-background px-3 text-sm"
            data-testid="billing-status"
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="w-[170px] shrink-0">
          <label className="t-helper mb-1 block">Payout Status</label>
          <select
            value={payoutStatus}
            onChange={e => setPayoutStatus(e.target.value)}
            className="w-full h-10 rounded-[var(--radius)] border border-input bg-background px-3 text-sm"
            data-testid="billing-payout-status"
          >
            <option value="all">All payout statuses</option>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="received">Received</option>
            <option value="failed">Failed</option>
          </select>
        </div>

        <div className="w-[170px] shrink-0">
          <label className="t-helper mb-1 block">Service Type</label>
          <select
            value={serviceType}
            onChange={e => setServiceType(e.target.value)}
            className="w-full h-10 rounded-[var(--radius)] border border-input bg-background px-3 text-sm"
            data-testid="billing-service-type"
          >
            <option value="all">All services</option>
            {serviceTypeOptions.map(st => (
              <option key={st} value={st}>{st}</option>
            ))}
          </select>
        </div>

        <div className="w-[150px] shrink-0">
          <label className="t-helper mb-1 block">Date From</label>
          <Input type="date" value={paidFrom} onChange={e => setPaidFrom(e.target.value)} data-testid="billing-paid-from" />
        </div>

        <div className="w-[150px] shrink-0">
          <label className="t-helper mb-1 block">Date To</label>
          <Input type="date" value={paidTo} onChange={e => setPaidTo(e.target.value)} data-testid="billing-paid-to" />
        </div>

        </div>
        <ClearFiltersButton show={hasActiveFilters} onClick={clearFilters} testId="billing-clear-filters" />
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
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Parent</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Provider</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Service</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Amount</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">GoStork Fee</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Payout</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">Invoice Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">Payout Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
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
        </div>
      )}
    </div>
  );
}
