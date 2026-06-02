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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

function StatCard({ label, value, icon: Icon, sub }: { label: string; value: string; icon: any; sub?: string }) {
  return (
    <div className="rounded-xl border p-4 space-y-1">
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Icon className="w-4 h-4" />
        <span>{label}</span>
      </div>
      <p className="text-2xl font-heading font-bold">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

const TABS = [
  { key: "all",             label: "All"           },
  { key: "AWAITING_PAYMENT",label: "Awaiting Payment" },
  { key: "AUTHORIZED",      label: "Authorized"    },
  { key: "PAID",            label: "Paid"          },
  { key: "CLEARANCE_FAILED",label: "Failed"        },
  { key: "EXPIRED",         label: "Expired"       },
];

export default function AdminBillingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "all";
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adminNotes, setAdminNotes] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);

  // Filters
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [serviceType, setServiceType] = useState("all");
  const [paidFrom, setPaidFrom] = useState("");
  const [paidTo, setPaidTo] = useState("");

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1); }, [serviceType, paidFrom, paidTo]);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/invoices", tab, page, search, serviceType, paidFrom, paidTo],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (tab !== "all") params.set("status", tab);
      if (search) params.set("search", search);
      if (serviceType !== "all") params.set("serviceType", serviceType);
      if (paidFrom) params.set("paidFrom", paidFrom);
      if (paidTo) params.set("paidTo", paidTo);
      const res = await fetch(`/api/admin/invoices?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
  });

  const serviceTypeOptions: string[] = data?.serviceTypes || [];
  const hasActiveFilters = !!search || serviceType !== "all" || !!paidFrom || !!paidTo;
  const clearFilters = () => { setSearchInput(""); setSearch(""); setServiceType("all"); setPaidFrom(""); setPaidTo(""); };

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
        <p className="text-sm text-muted-foreground mt-1">Track all parent payments and provider payouts</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="GoStork Fees Earned"  value={formatCents(stats.totalGoStorkFees)}    icon={TrendingUp}    />
        <StatCard label="Total Collected"       value={formatCents(stats.totalRevenue)}         icon={DollarSign}    />
        <StatCard label="Provider Payouts Sent" value={formatCents(stats.totalProviderPayouts)} icon={CheckCircle2}  />
        <StatCard label="Pending"               value={formatCents(stats.pendingAmount)}        icon={Clock}         sub="Awaiting payment" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => { setSearchParams({ tab: t.key }, { replace: true }); setPage(1); }}
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

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs text-muted-foreground mb-1 block">Search</label>
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

        <div className="min-w-[160px]">
          <label className="text-xs text-muted-foreground mb-1 block">Service Type</label>
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

        <div className="min-w-[150px]">
          <label className="text-xs text-muted-foreground mb-1 block">Paid From</label>
          <Input type="date" value={paidFrom} onChange={e => setPaidFrom(e.target.value)} data-testid="billing-paid-from" />
        </div>

        <div className="min-w-[150px]">
          <label className="text-xs text-muted-foreground mb-1 block">Paid To</label>
          <Input type="date" value={paidTo} onChange={e => setPaidTo(e.target.value)} data-testid="billing-paid-to" />
        </div>

        {hasActiveFilters && (
          <Button variant="outline" size="sm" onClick={clearFilters} className="gap-1.5" data-testid="billing-clear-filters">
            <X className="w-3.5 h-3.5" /> Clear
          </Button>
        )}
      </div>

      {/* Invoice table */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data?.invoices?.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <AlertCircle className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No invoices found</p>
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
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
                    <td className="px-4 py-3"><InvoiceStatusBadge status={inv.status} /></td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{new Date(inv.createdAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      {expandedId === inv.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedId === inv.id && (
                    <tr key={`${inv.id}-detail`} className="bg-muted/10">
                      <td colSpan={9} className="px-6 py-5">
                        <div className="grid md:grid-cols-2 gap-6">
                          {/* Details */}
                          <div className="space-y-3 text-sm">
                            <h3 className="font-semibold">Invoice Details</h3>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-muted-foreground">
                              <span>Invoice ID</span><span className="font-mono text-xs">{inv.id}</span>
                              <span>Session ID</span><span className="font-mono text-xs">{inv.sessionId}</span>
                              {inv.description && <><span>Description</span><span>{inv.description}</span></>}
                              {inv.paidAt && <><span>Paid At</span><span>{new Date(inv.paidAt).toLocaleString()}</span></>}
                              {inv.payoutInitiatedAt && <><span>Payout Initiated</span><span>{new Date(inv.payoutInitiatedAt).toLocaleString()}</span></>}
                              {inv.payoutCompletedAt && <><span>Payout Completed</span><span>{new Date(inv.payoutCompletedAt).toLocaleString()}</span></>}
                              {inv.manualOverride && <><span>Override</span><span className="text-orange-500">Manual</span></>}
                              {inv.adminNotes && <><span>Notes</span><span>{inv.adminNotes}</span></>}
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="space-y-3">
                            <h3 className="text-sm font-semibold">Actions</h3>

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
                              <p className="text-sm text-muted-foreground">Payout initiated - awaiting confirmation</p>
                            )}

                            {inv.status === "PAID" && inv.payoutCompletedAt && (
                              <p className="text-sm" style={{ color: "hsl(var(--brand-success))" }}>Payout complete</p>
                            )}

                            <a
                              href={`/chat?session=${inv.sessionId}`}
                              className="text-sm underline text-muted-foreground"
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
            <div className="flex items-center justify-between px-4 py-3 border-t text-sm text-muted-foreground">
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
