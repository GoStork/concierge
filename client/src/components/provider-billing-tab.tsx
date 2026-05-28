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

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatMoneyCents } from "@/lib/format-money";
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
            <p className="text-xs text-muted-foreground mt-1">
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
                  className="px-4 py-2 rounded-full border text-sm font-medium transition-colors"
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
                  className="px-4 py-2 rounded-full border text-sm font-medium transition-colors"
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
            <p className="text-sm text-muted-foreground">
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
            <h3 className="font-semibold">{isProviderMode ? "Payments received" : "Invoice History"}</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isProviderMode
                ? `${invoices.length} invoice${invoices.length !== 1 ? "s" : ""} - GoStork transfers your share to your bank when the parent pays.`
                : `${invoices.length} invoice${invoices.length !== 1 ? "s" : ""} for this provider`}
            </p>
          </div>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Parent</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Service</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Amount paid</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">GoStork fee</th>
                  {isProviderMode && (
                    <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Your payout</th>
                  )}
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Status</th>
                  {isProviderMode && (
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Transfer</th>
                  )}
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Date</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv: any) => {
                  // Payout status: green if the Stripe transfer ID is set
                  // (money moved), red if a failure was recorded, otherwise
                  // "pending" for paid invoices and "-" for unpaid ones.
                  let transferLabel = "-";
                  let transferColor = "hsl(var(--muted-foreground))";
                  if (inv.stripeTransferId) {
                    transferLabel = "Sent";
                    transferColor = "hsl(var(--brand-success))";
                  } else if (inv.payoutFailedAt) {
                    transferLabel = "Failed";
                    transferColor = "hsl(var(--destructive))";
                  } else if (inv.status === "PAID") {
                    transferLabel = "Pending";
                    transferColor = "hsl(var(--brand-warning))";
                  }
                  return (
                    <tr key={inv.id} className="border-b last:border-0 hover:bg-muted/10">
                      <td className="px-4 py-2.5">{inv.parentUser?.name || inv.parentUser?.email || "Parent"}</td>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{inv.serviceType?.replace(/_/g, " ").toLowerCase() || "-"}</td>
                      <td className="px-4 py-2.5 text-right font-medium">{formatCents(inv.serviceAmount, inv.currency)}</td>
                      <td className="px-4 py-2.5 text-right" style={{ color: "hsl(var(--brand-success))" }}>{formatCents(inv.referralFeeAmount, inv.currency)}</td>
                      {isProviderMode && (
                        <td className="px-4 py-2.5 text-right font-medium">{formatCents(inv.providerPayoutAmount, inv.currency)}</td>
                      )}
                      <td className="px-4 py-2.5"><InvoiceStatusBadge status={inv.status} /></td>
                      {isProviderMode && (
                        <td className="px-4 py-2.5 text-xs font-medium" style={{ color: transferColor }}>{transferLabel}</td>
                      )}
                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{new Date(inv.paidAt || inv.createdAt).toLocaleDateString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Empty state for providers - so they don't see a blank tab if they
          haven't been paid yet. Admin view hides this; admins see other
          providers' rows globally and don't need a per-empty hint. */}
      {invoices.length === 0 && isProviderMode && (
        <section className="space-y-3">
          <h3 className="font-semibold">Payments received</h3>
          <div className="rounded-xl border p-6 bg-secondary/40 text-sm text-muted-foreground">
            No payments yet. When a parent pays an invoice for one of your services, you'll see it here along with the amount GoStork transferred to your bank.
          </div>
        </section>
      )}
    </div>
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
          <p className="text-xs text-muted-foreground mt-0.5">
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
                <p className="text-xs text-muted-foreground">
                  {cfg
                    ? `${cfg.feeType === "PERCENTAGE" ? `GoStork: ${Number(cfg.percentage)}%` : `GoStork: ${formatCents(Number(cfg.flatAmount) || 0)} flat`}`
                    : "Not configured"}
                </p>
                {cfg && (
                  <p className="text-[11px] text-muted-foreground">
                    Parent pays: {cfg.parentPaysBasis === "TOTAL_COST"
                      ? "Total Quoted Cost"
                      : `Default ${cfg.defaultServiceAmount ? formatCents(Number(cfg.defaultServiceAmount)) : "(none)"}`}
                  </p>
                )}
              </div>
              <Input
                type="number"
                min="0"
                step="500"
                placeholder="Sample Total Quoted Cost ($)"
                value={quotedTotals[st] || ""}
                onChange={e => setQuotedTotals(prev => ({ ...prev, [st]: e.target.value }))}
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
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Payment Split Preview (Combined)</p>
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
