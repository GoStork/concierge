/**
 * Provider billing tab - shown in admin provider edit page at ?tab=billing
 * and in the provider self-service /account/billing page.
 *
 * Layout (top to bottom):
 *   1. Service-pills row + Combined preview tab. Each pill maps to one
 *      LineServiceType the provider is enabled for (SURROGACY / EGG_DONATION
 *      / SPERM_DONATION / IVF_CLINIC / OTHER). Selecting a pill mounts a
 *      ReferralFeeConfigSection for that (provider, serviceType) pair.
 *      Selecting "Combined" renders a multi-line invoice preview that sums
 *      every configured service's fee against admin-typed sample amounts.
 *   2. Invoice History (admin-only).
 *
 * Legal Name + Tax ID + W-9 live on the new /account/legal-identity tab
 * (ProviderLegalIdentity model). This tab is now purely referral fees +
 * invoice history.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { Loader2, CheckCircle2, Undo2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { formatMoneyCents } from "@/lib/format-money";
import { formatDateTime } from "@/lib/format-date";
import { derivePayoutStatus } from "@/lib/payout-status";
import { InvoiceStatusBadge } from "./invoice-status-badge";
import {
  ReferralFeeConfigSection,
  LINE_SERVICE_LABELS,
  LINE_SERVICE_TYPES,
  type LineServiceType,
  type ReferralFeeConfigPayload,
} from "./referral-fee-config-section";

interface FeeConfigsResponse {
  configs: ReferralFeeConfigPayload[];
  services: Array<{ serviceType: LineServiceType; providerTypeName: string }>;
  provider: {
    depositMilestone: "AT_MATCH" | "AT_CLEARANCE" | null;
    averageClearanceDays: number | null;
  };
}

const formatCents = formatMoneyCents;

interface ProviderBillingTabProps {
  providerId: string;
  /** Unused now but kept for backwards compatibility with existing callers. */
  providerTypeName?: string;
  /** "admin" - GoStork admin. "provider" - provider editing own row. */
  mode?: "admin" | "provider";
}

type TabKey = LineServiceType | "COMBINED";

export function ProviderBillingTab({ providerId, mode = "admin" }: ProviderBillingTabProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isProviderMode = mode === "provider";

  const feeListUrl = isProviderMode
    ? `/api/provider/fee-configs`
    : `/api/admin/providers/${providerId}/fee-configs`;

  // ── Load fee configs + enabled services ─────────────────────────────────
  const { data: feeData, isLoading: loadingConfigs } = useQuery<FeeConfigsResponse>({
    queryKey: [feeListUrl],
    queryFn: async () => {
      const res = await fetch(feeListUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load fee configs");
      return res.json();
    },
  });

  // ── Load invoices ───────────────────────────────────────────────────────
  // Admin hits the admin list (paginated, can see all providers). Provider
  // hits their own scoped endpoint - server enforces the provider can only
  // see invoices for their own providerId so no leakage possible.
  const invoicesUrl = isProviderMode
    ? "/api/provider/invoices"
    : `/api/admin/invoices?providerId=${providerId}&pageSize=50`;
  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: [invoicesUrl],
    queryFn: async () => {
      const res = await fetch(invoicesUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      const d = await res.json();
      // Admin endpoint wraps in { invoices: [...] }, provider endpoint
      // returns the array directly.
      return Array.isArray(d) ? d : (d.invoices || []);
    },
    refetchOnWindowFocus: true,
    refetchInterval: 15000,
  });

  // ── Tabs ────────────────────────────────────────────────────────────────
  // The set of tabs is the union of (a) services the provider is enabled
  // for and (b) services that already have a config row. The latter handles
  // the edge case of a config persisting after a ProviderService is removed
  // - admin still needs to see it to delete or edit.
  const enabledServices = useMemo<LineServiceType[]>(() => {
    if (!feeData) return [];
    const set = new Set<LineServiceType>();
    feeData.services.forEach(s => set.add(s.serviceType));
    feeData.configs.forEach(c => set.add(c.serviceType as LineServiceType));
    // Stable order: follow LINE_SERVICE_TYPES order
    return LINE_SERVICE_TYPES.filter(t => set.has(t));
  }, [feeData]);

  const [activeTab, setActiveTab] = useState<TabKey>("COMBINED");
  // When the configs land, jump to the first service tab if Combined is the
  // default and there's only one service (no point showing Combined alone).
  useEffect(() => {
    if (!feeData) return;
    if (enabledServices.length === 1) setActiveTab(enabledServices[0]);
    else if (enabledServices.length > 1) setActiveTab(prev => (prev === "COMBINED" ? enabledServices[0] : prev));
  }, [feeData, enabledServices.length]);

  const configByService = useMemo(() => {
    const map = new Map<LineServiceType, ReferralFeeConfigPayload>();
    feeData?.configs.forEach(c => map.set(c.serviceType as LineServiceType, c));
    return map;
  }, [feeData]);

  if (loadingConfigs) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Service tabs */}
      <section className="space-y-4">
        {/* Top-level heading - always shown, no service suffix */}
        <h3 className="font-semibold">Referral Fee Configuration</h3>

        {enabledServices.length === 0 ? (
          <div className="rounded-lg border p-6 bg-secondary/40">
            <p className="text-sm font-medium">No services enabled yet</p>
            <p className="t-helper mt-1">
              This provider has no APPROVED services. Approve a service in the Profile tab before configuring referral fees.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {enabledServices.map(st => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setActiveTab(st)}
                  className="px-4 py-2 rounded-full border text-sm font-medium transition-colors bg-card"
                  style={{
                    background: activeTab === st ? "hsl(var(--primary))" : "hsl(var(--secondary))",
                    color: activeTab === st ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
                    borderColor: activeTab === st ? "hsl(var(--primary))" : "hsl(var(--border))",
                  }}
                  data-testid={`tab-fee-${st.toLowerCase()}`}
                >
                  {LINE_SERVICE_LABELS[st]}
                  {!configByService.has(st) && (
                    <span className="ml-1.5 text-[10px] uppercase opacity-70">(unconfigured)</span>
                  )}
                </button>
              ))}
              {enabledServices.length > 1 && (
                <button
                  type="button"
                  onClick={() => setActiveTab("COMBINED")}
                  className="px-4 py-2 rounded-full border text-sm font-medium transition-colors bg-card"
                  style={{
                    background: activeTab === "COMBINED" ? "hsl(var(--accent))" : "hsl(var(--secondary))",
                    color: activeTab === "COMBINED" ? "hsl(var(--accent-foreground))" : "hsl(var(--foreground))",
                    borderColor: activeTab === "COMBINED" ? "hsl(var(--accent))" : "hsl(var(--border))",
                  }}
                  data-testid="tab-fee-combined"
                >
                  Combined Preview
                </button>
              )}
            </div>

            {/* Active-tab description - sits between pills and form body */}
            <p className="t-helper">
              {activeTab === "COMBINED"
                ? "What the parent's multi-line invoice will look like across every configured service. Type a sample Total Quoted Cost per service to see the breakdown."
                : `How GoStork's referral fee is calculated for the ${LINE_SERVICE_LABELS[activeTab as LineServiceType].toLowerCase()} service.`}
            </p>

            {/* Active tab body */}
            {activeTab === "COMBINED" ? (
              <CombinedPreview
                services={enabledServices}
                configByService={configByService}
              />
            ) : (
              <ReferralFeeConfigSection
                providerId={providerId}
                serviceType={activeTab as LineServiceType}
                initialConfig={configByService.get(activeTab as LineServiceType) ?? null}
                mode={mode}
                showSurrogacyExtras={activeTab === "SURROGACY"}
                initialDepositMilestone={feeData?.provider.depositMilestone ?? "AT_MATCH"}
                initialAverageClearanceDays={feeData?.provider.averageClearanceDays ?? 21}
                onSaved={() => queryClient.invalidateQueries({ queryKey: [feeListUrl] })}
              />
            )}
          </>
        )}
      </section>


      {/* Invoice history.
          Provider view (mode=provider) is framed as "Payments received" and
          includes a "Your payout" column + a payout-transfer status badge so
          the agency can see exactly which paid invoices have actually moved
          money to their connected Stripe account. Admin view keeps the
          original framing ("Invoice History") and columns. */}
      {invoices.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="font-semibold">{isProviderMode ? "Payments received" : "Invoice history"}</h3>
            <p className="t-helper mt-0.5">
              {isProviderMode
                ? `${invoices.length} invoice${invoices.length !== 1 ? "s" : ""} - GoStork transfers your share to your bank when the parent pays.`
                : `${invoices.length} invoice${invoices.length !== 1 ? "s" : ""} for this provider - full money flow from parent payment through GoStork to the provider's bank.`}
            </p>
          </div>
          <div className="rounded-xl border overflow-hidden bg-card">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Parent</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Service</th>
                  <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">Amount paid</th>
                  <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">GoStork fee</th>
                  <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">{isProviderMode ? "Your payout" : "Provider payout"}</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Parent paid GoStork</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">{isProviderMode ? "GoStork paid you" : "GoStork paid provider"}</th>
                  <th className="t-helper text-left px-4 py-2.5 whitespace-nowrap">Date</th>
                  {!isProviderMode && (
                    <th className="t-helper text-right px-4 py-2.5 whitespace-nowrap">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv: any) => {
                  // Payout status: derived from a single shared helper so the
                  // Billing tab and Payouts history table stay in lockstep.
                  // Five terminal states (Received / Failed at bank / Failed
                  // / Sent / Pending), color + tooltip baked in.
                  const status = derivePayoutStatus(inv);
                  // Rows are clickable in both modes - opens the invoice
                  // document in a new tab (PDF receipt for paid, HTML
                  // payment-request for everything else). The document
                  // endpoint accepts an explicit providerId for admins.
                  const documentUrl = isProviderMode
                    ? `/api/provider/invoices/${inv.id}/document`
                    : `/api/provider/invoices/${inv.id}/document?providerId=${providerId}`;
                  // The parent cell opens the parent profile instead - it
                  // stops propagation so the row's invoice click doesn't fire.
                  const parentUserId = inv.parentUser?.id || inv.parentUserId;
                  const parentLabel = inv.parentUser?.name || inv.parentUser?.email || "Parent";
                  return (
                    <tr
                      key={inv.id}
                      className="border-b last:border-0 hover:bg-muted/10 cursor-pointer"
                      onClick={() => window.open(documentUrl, "_blank", "noopener,noreferrer")}
                      title={inv.status === "PAID" ? "Open receipt PDF" : "Open invoice document"}
                    >
                      <td className="px-4 py-2.5">
                        {parentUserId ? (
                          <button
                            type="button"
                            className="text-primary font-medium hover:underline text-left"
                            title="Open parent profile"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/parents/${parentUserId}`);
                            }}
                          >
                            {parentLabel}
                          </button>
                        ) : parentLabel}
                      </td>
                      <td className="t-helper px-4 py-2.5">{inv.serviceType?.replace(/_/g, " ").toLowerCase() || "-"}</td>
                      <td className="px-4 py-2.5 text-right font-medium">{formatCents(inv.serviceAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-right" style={{ color: "hsl(var(--brand-success))" }}>{formatCents(inv.referralFeeAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-right font-medium">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5">
                        <InvoiceStatusBadge status={inv.status} medicalClearanceStatus={inv.medicalClearanceStatus} />
                      </td>
                      <td className="px-4 py-2.5 text-xs font-medium whitespace-nowrap" style={{ color: status.color }}>
                        <span title={status.tooltip} className="cursor-help underline decoration-dotted underline-offset-2 inline-flex items-center gap-1">
                          {status.isReceived && <CheckCircle2 className="w-3.5 h-3.5" />}
                          {status.label}
                        </span>
                        {inv.payoutReversalAtRisk && !inv.payoutReversalRecoupedAt && (
                          <div
                            className="text-[10px] mt-1 inline-flex items-center gap-1"
                            style={{ color: "hsl(var(--brand-warning))" }}
                            title="The provider's bank already received this payout when admin refunded the parent. Stripe is recouping from the provider's negative Connect balance (no pull from their bank). GoStork's monitor will clear this once the Connect balance is no longer negative."
                          >
                            <AlertCircle className="w-3 h-3" />
                            Recoupment pending
                          </div>
                        )}
                      </td>
                      <td className="t-helper px-4 py-2.5 whitespace-nowrap">{formatDateTime(inv.paidAt || inv.createdAt)}</td>
                      {!isProviderMode && (
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          {(inv.status === "PAID" || inv.status === "PARTIALLY_REFUNDED") && (
                            <RefundButton invoice={inv} onRefunded={() => queryClient.invalidateQueries({ queryKey: [invoicesUrl] })} />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </section>
      )}

      {/* Empty state for providers - so they don't see a blank tab if they
          haven't been paid yet. Admin view hides this; admins see other
          providers' rows globally and don't need a per-empty hint. */}
      {invoices.length === 0 && isProviderMode && (
        <section className="space-y-3">
          <h3 className="font-semibold">Payments received</h3>
          <div className="t-helper rounded-xl border p-6 bg-secondary/40">
            No payments yet. When a parent pays an invoice for one of your services, you'll see it here along with the amount GoStork transferred to your bank.
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Admin: Refund button + confirmation dialog ────────────────────────────
//
// Per-row Refund control shown only in admin view. Full refund by default
// (matches the existing "remaining refundable" amount); admin can type a
// smaller number for a partial refund. Reason maps to Stripe's enum so the
// refund object on Stripe carries it. Form is rendered in the GoStork bottom
// drawer pattern (matches save bar / confirm bar visual).
//
// On confirm:
//   POST /api/admin/invoices/:id/refund -> Stripe refunds.create -> Stripe
//   fires charge.refunded async -> our webhook handler updates DB + reverses
//   provider's proportional share. The mutation invalidates the invoices
//   query so the row's status badge flips to Refunded / Partially refunded
//   on the next poll.
function RefundButton({ invoice, onRefunded }: { invoice: any; onRefunded: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // Amount + reason live in the dialog. Defaults derived from invoice when
  // the dialog opens so the admin sees the maximum refundable amount.
  const alreadyRefunded = invoice.refundedAmount || 0;
  const remainingCents = (invoice.serviceAmount || 0) - alreadyRefunded;
  const providerPayoutCents = invoice.providerPayoutAmount || 0;
  const referralFeeCents = invoice.referralFeeAmount || 0;
  const providerShareRemaining = Math.max(0, providerPayoutCents - (invoice.payoutReversedAmount || 0));
  const [amountDollars, setAmountDollars] = useState((remainingCents / 100).toFixed(2));
  const [reason, setReason] = useState<"requested_by_customer" | "duplicate" | "fraudulent" | "other">("requested_by_customer");
  const [mode, setMode] = useState<"proportional" | "keep_platform_fee">("proportional");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live preview of how the entered refund splits between provider clawback
  // and GoStork fee write-off, given the current mode.
  const parsedDollars = parseFloat(amountDollars);
  const amountCentsPreview = isFinite(parsedDollars) && parsedDollars > 0 ? Math.round(parsedDollars * 100) : 0;
  let providerClawbackPreview = 0;
  let gostorkAbsorbedPreview = 0;
  if (amountCentsPreview > 0 && invoice.serviceAmount > 0) {
    if (mode === "keep_platform_fee") {
      providerClawbackPreview = Math.min(amountCentsPreview, providerPayoutCents);
      gostorkAbsorbedPreview = 0;
    } else {
      providerClawbackPreview = Math.round(providerPayoutCents * (amountCentsPreview / invoice.serviceAmount));
      gostorkAbsorbedPreview = amountCentsPreview - providerClawbackPreview;
    }
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const dollars = parseFloat(amountDollars);
      if (!isFinite(dollars) || dollars <= 0) throw new Error("Enter a refund amount greater than 0");
      const amountCents = Math.round(dollars * 100);
      if (amountCents > remainingCents) throw new Error(`Refund amount exceeds remaining refundable balance (${formatMoneyCents(remainingCents)})`);
      if (mode === "keep_platform_fee" && amountCents > providerShareRemaining) {
        throw new Error(`Refund of ${formatMoneyCents(amountCents)} exceeds provider's remaining share (${formatMoneyCents(providerShareRemaining)}) under Keep GoStork fee mode.`);
      }
      const res = await fetch(`/api/admin/invoices/${invoice.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amountCents, reason, mode, notes: notes.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message || "Refund failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      setOpen(false);
      toast({
        title: "Refund initiated",
        description: "Stripe is processing the refund. The status will update within a few seconds.",
      });
      onRefunded();
    },
    onError: (e: any) => setError(e?.message || "Refund failed"),
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={(e) => { e.stopPropagation(); setOpen(true); setError(null); }}
        style={{ borderColor: "hsl(var(--brand-error) / 0.5)", color: "hsl(var(--brand-error))" }}
      >
        <Undo2 className="w-3.5 h-3.5 mr-1.5" />
        Refund
      </Button>
      {/* Portal to <body>: this button lives inside a table cell, and a
          `position: fixed` element inside any transformed/filtered ancestor
          gets its containing block hijacked - the drawer then positions and
          sizes against that ancestor instead of the viewport (shifted right,
          clipped copy, overlapping cards). Body-level rendering matches how
          the shared save/confirm bars mount at the app root. */}
      {open && createPortal(
        <>
          <div
            className="fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[1px]"
            onClick={() => !mutation.isPending && setOpen(false)}
          />
          <div
            className={cn(
              "fixed bottom-0 left-0 right-0 z-50 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-background/95 backdrop-blur border-t shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.12)]",
              "max-h-[85vh] overflow-y-auto",
            )}
            role="dialog"
            aria-modal="true"
          >
            <div className="max-w-3xl mx-auto space-y-3">
              <div>
                <div className="font-display text-lg font-semibold text-foreground">Refund this invoice?</div>
                <p className="t-helper">
                  The parent will be refunded via Stripe (5-10 business days back to their card). The provider's
                  share will be reversed proportionally from their payout. This cannot be undone from here -
                  additional refunds against the same invoice are allowed up to the original amount.
                </p>
              </div>
              {invoice.bankPayoutCompletedAt && (
            <div className="rounded-md border p-3 flex items-start gap-2 bg-card" style={{ borderColor: "hsl(var(--brand-warning) / 0.5)", background: "hsl(var(--brand-warning) / 0.08)" }}>
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-warning))" }} />
              <div className="text-xs space-y-1">
                <p className="font-medium" style={{ color: "hsl(var(--brand-warning))" }}>This payout already landed in the provider's bank</p>
                <p className="text-muted-foreground">
                  Stripe does <strong>not</strong> pull from the provider's bank account directly. The reversal creates a negative balance on their Stripe Connect account that recoups from future incoming transfers. If the provider has no upcoming volume, GoStork may need to coordinate manual repayment.
                </p>
                {mode === "keep_platform_fee" && (
                  <p className="text-muted-foreground">
                    <strong>Risk is amplified in "Keep GoStork fee" mode</strong> - the entire refund comes off the provider's share, so the negative balance to recoup will be larger.
                  </p>
                )}
                <p className="text-muted-foreground">
                  GoStork will track this and clear the flag automatically once the Connect balance is no longer negative.
                </p>
              </div>
            </div>
          )}
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Refund amount (USD)</Label>
                <NumberInput
                  value={amountDollars}
                  onChange={setAmountDollars}
                />
                <p className="t-helper">
                  Max refundable: {formatMoneyCents(remainingCents)}
                  {alreadyRefunded > 0 && ` (${formatMoneyCents(alreadyRefunded)} already refunded)`}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Reason</Label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value as any)}
                  className="h-10 rounded-md border bg-background px-3 text-sm w-full"
                >
                  <option value="requested_by_customer">Requested by customer</option>
                  <option value="duplicate">Duplicate charge</option>
                  <option value="fraudulent">Fraudulent</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Refund mode</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMode("proportional")}
                  className="text-left rounded-lg border p-3 transition-colors bg-card"
                  style={{
                    background: mode === "proportional" ? "hsl(var(--primary) / 0.05)" : "hsl(var(--card))",
                    borderColor: mode === "proportional" ? "hsl(var(--primary))" : "hsl(var(--border))",
                  }}
                >
                  <p className="text-sm font-medium">Proportional</p>
                  <p className="t-helper mt-0.5">
                    GoStork fee refunded proportionally. Use for goodwill, fraud, duplicate charge.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("keep_platform_fee")}
                  className="text-left rounded-lg border p-3 transition-colors bg-card"
                  style={{
                    background: mode === "keep_platform_fee" ? "hsl(var(--primary) / 0.05)" : "hsl(var(--card))",
                    borderColor: mode === "keep_platform_fee" ? "hsl(var(--primary))" : "hsl(var(--border))",
                  }}
                >
                  <p className="text-sm font-medium">Keep GoStork fee</p>
                  <p className="t-helper mt-0.5">
                    Refund comes entirely from provider's share. GoStork fee preserved. Use for Guarantee scenarios.
                  </p>
                </button>
              </div>
            </div>
            {amountCentsPreview > 0 && (
              <div className="rounded-md border bg-secondary/40 p-3 text-xs space-y-1">
                <p className="font-medium text-sm mb-1">Money split preview</p>
                <div className="flex justify-between"><span className="text-muted-foreground">Refunded to parent</span><span>{formatMoneyCents(amountCentsPreview)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Reversed from provider</span><span>{formatMoneyCents(providerClawbackPreview)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">GoStork absorbed</span><span>{formatMoneyCents(gostorkAbsorbedPreview)}</span></div>
                <div className="border-t pt-1 mt-1 text-muted-foreground">
                  Original split: provider {formatMoneyCents(providerPayoutCents)} + GoStork fee {formatMoneyCents(referralFeeCents)} = {formatMoneyCents(invoice.serviceAmount)}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Internal notes (optional)</Label>
              <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Why are we issuing this refund?" />
              <p className="t-helper">Stored on the invoice for the audit trail. Not shown to the parent.</p>
            </div>
            {error && (
              <div className="rounded-lg border p-3 flex items-start gap-2 bg-card" style={{ borderColor: "hsl(var(--brand-error) / 0.4)", background: "hsl(var(--brand-error) / 0.05)" }}>
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-error))" }} />
                <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{error}</p>
              </div>
            )}
          </div>
              <div className="flex items-center justify-end gap-2 pt-2 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={mutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => mutation.mutate()}
                  disabled={mutation.isPending}
                >
                  {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Refund
                </Button>
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

// ─── Combined Preview ──────────────────────────────────────────────────────
//
// Shows what a multi-line invoice would look like across all configured
// services. Admin types a sample amount per line, and the preview sums them
// into a single Parent Pays total with a per-line GoStork fee breakdown.
// Each line uses its own service's configured fee type/percentage/flat -
// exactly mirroring the per-line fee computation in createInvoice.

interface CombinedPreviewProps {
  services: LineServiceType[];
  configByService: Map<LineServiceType, ReferralFeeConfigPayload>;
}

function CombinedPreview({ services, configByService }: CombinedPreviewProps) {
  // One row per enabled service; the admin types a SAMPLE TOTAL QUOTED COST
  // for each service (same semantic as the per-service preview's
  // "Sample Total Quoted Cost" field). What the parent actually pays for
  // that service is derived from its parentPaysBasis:
  //   DEFAULT_FIRST_PAYMENT -> the service's defaultServiceAmount
  //   TOTAL_COST            -> the sample quoted cost itself
  // GoStork's fee per line then comes from that service's feeType/percentage/
  // flatAmount applied against the quoted total (the fee basis).
  const initialQuotedTotals = useMemo(() => {
    const out: Record<LineServiceType, string> = {} as any;
    services.forEach(st => {
      const cfg = configByService.get(st);
      if (cfg?.sampleTotalCostCents) out[st] = String(cfg.sampleTotalCostCents / 100);
      else out[st] = "";
    });
    return out;
  }, [services, configByService]);

  const [quotedTotals, setQuotedTotals] = useState<Record<LineServiceType, string>>(initialQuotedTotals);
  useEffect(() => setQuotedTotals(initialQuotedTotals), [initialQuotedTotals]);

  // Per-line math (mirrors BillingService.computeFee + parentPays resolution
  // in createInvoice).
  const lines = services.map(st => {
    const cfg = configByService.get(st);
    const quotedCents = Math.round((parseFloat(quotedTotals[st] || "") || 0) * 100);
    if (!cfg) {
      return {
        serviceType: st,
        configured: false as const,
        quotedCents,
        parentPaysCents: 0,
        feeCents: 0,
        payoutCents: 0,
      };
    }
    const defaultCents = cfg.defaultServiceAmount ? Math.round(Number(cfg.defaultServiceAmount)) : 0;
    const parentPaysCents = cfg.parentPaysBasis === "TOTAL_COST" ? quotedCents : defaultCents;
    let feeCents = 0;
    if (cfg.feeType === "FLAT") {
      feeCents = Math.round(Number(cfg.flatAmount) || 0);
    } else if (cfg.feeType === "PERCENTAGE") {
      feeCents = Math.round(quotedCents * ((Number(cfg.percentage) || 0) / 100));
    }
    feeCents = Math.min(feeCents, parentPaysCents);
    return {
      serviceType: st,
      configured: true as const,
      cfg,
      quotedCents,
      parentPaysCents,
      feeCents,
      payoutCents: parentPaysCents - feeCents,
    };
  });

  const quotedTotal = lines.reduce((s, l) => s + l.quotedCents, 0);
  const parentPaysTotal = lines.reduce((s, l) => s + l.parentPaysCents, 0);
  const feeTotal = lines.reduce((s, l) => s + l.feeCents, 0);
  const payoutTotal = parentPaysTotal - feeTotal;

  const hasAnyAmount = quotedTotal > 0;
  const missingConfigs = lines.filter(l => !l.configured).map(l => LINE_SERVICE_LABELS[l.serviceType]);

  return (
    <section className="space-y-4">
      {missingConfigs.length > 0 && (
        <div className="rounded-lg border p-3 bg-accent/20 text-sm">
          <p className="font-medium">Missing configuration</p>
          <p className="t-helper mt-0.5">
            {missingConfigs.join(", ")} {missingConfigs.length === 1 ? "has" : "have"} no Referral Fee Configuration yet.
            Invoices that include {missingConfigs.length === 1 ? "this service" : "these services"} will be rejected until configured.
          </p>
        </div>
      )}

      {/* Per-line Sample Total Quoted Cost inputs */}
      <div className="space-y-3">
        {services.map(st => {
          const cfg = configByService.get(st);
          return (
            <div key={st} className="flex items-center gap-3">
              <div className="w-44 shrink-0">
                <p className="text-sm font-medium">{LINE_SERVICE_LABELS[st]}</p>
                <p className="t-helper">
                  {cfg
                    ? `${cfg.feeType === "PERCENTAGE" ? `GoStork: ${Number(cfg.percentage)}%` : `GoStork: ${formatCents(Number(cfg.flatAmount) || 0)} flat`}`
                    : "Not configured"}
                </p>
                {cfg && (
                  <p className="t-helper">
                    Parent pays: {cfg.parentPaysBasis === "TOTAL_COST"
                      ? "Total Quoted Cost"
                      : `Default ${cfg.defaultServiceAmount ? formatCents(Number(cfg.defaultServiceAmount)) : "(none)"}`}
                  </p>
                )}
              </div>
              <NumberInput
                placeholder="Sample Total Quoted Cost ($)"
                value={quotedTotals[st] || ""}
                onChange={v => setQuotedTotals(prev => ({ ...prev, [st]: v }))}
                className="flex-1"
              />
            </div>
          );
        })}
      </div>

      {/* Combined split - mirrors the per-service preview shape:
          Total quoted cost / Parent pays / GoStork keeps / Provider receives */}
      {hasAnyAmount && (
        <div className="rounded-lg border p-4 space-y-2 bg-secondary/40">
          <p className="t-micro-label">Payment Split Preview (Combined)</p>
          <div className="space-y-1.5 text-sm">
            {/* Total quoted cost - per line + grand total */}
            {lines.filter(l => l.quotedCents > 0).map(l => (
              <div key={`quote-${l.serviceType}`} className="flex justify-between text-muted-foreground pl-3">
                <span>{LINE_SERVICE_LABELS[l.serviceType]}</span>
                <span>{formatCents(l.quotedCents)}</span>
              </div>
            ))}
            <div className="flex justify-between text-muted-foreground border-t pt-1.5">
              <span>Total quoted cost</span>
              <span>{formatCents(quotedTotal)}</span>
            </div>

            {/* Parent pays - per line + grand total */}
            {lines.filter(l => l.configured && l.parentPaysCents > 0).map(l => (
              <div key={`pay-${l.serviceType}`} className="flex justify-between pl-3">
                <span>
                  Parent pays - {LINE_SERVICE_LABELS[l.serviceType]}
                  {l.configured && l.cfg ? ` (${l.cfg.parentPaysBasis === "TOTAL_COST" ? "total" : "default"})` : ""}
                </span>
                <span>{formatCents(l.parentPaysCents)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t pt-1.5 font-semibold">
              <span>Parent pays (total)</span>
              <span>{formatCents(parentPaysTotal)}</span>
            </div>

            {/* GoStork keeps - per line + grand total */}
            {lines.filter(l => l.configured && l.parentPaysCents > 0).map(l => (
              <div key={`fee-${l.serviceType}`} className="flex justify-between pl-3" style={{ color: "hsl(var(--brand-success))" }}>
                <span>
                  GoStork keeps - {LINE_SERVICE_LABELS[l.serviceType]}
                  {l.configured && l.cfg ? ` (${l.cfg.feeType === "PERCENTAGE" ? `${Number(l.cfg.percentage)}%` : "flat"})` : ""}
                </span>
                <span className="font-semibold">{formatCents(l.feeCents)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t pt-1.5" style={{ color: "hsl(var(--brand-success))" }}>
              <span className="font-semibold">GoStork keeps (total)</span>
              <span className="font-semibold">{formatCents(feeTotal)}</span>
            </div>

            {/* Provider receives - grand total only */}
            <div className="flex justify-between border-t pt-1.5 font-semibold">
              <span>Provider receives</span>
              <span>{formatCents(payoutTotal)}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
