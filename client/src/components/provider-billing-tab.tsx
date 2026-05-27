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
 *   2. Billing Identity (Legal Name, Tax ID, W-9) - provider-wide, never
 *      per-service.
 *   3. Invoice History (admin-only).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Loader2, FileText, Send, Download, Check, ExternalLink, ChevronDown, ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoneyCents } from "@/lib/format-money";
import { InvoiceStatusBadge } from "./invoice-status-badge";
import { W9TemplateConfig } from "./w9-template-config";
import {
  ReferralFeeConfigSection,
  LINE_SERVICE_LABELS,
  LINE_SERVICE_TYPES,
  type LineServiceType,
  type ReferralFeeConfigPayload,
} from "./referral-fee-config-section";

interface W9Status {
  templateConfigured: boolean;
  templateNeedsFields?: boolean;
  templateName: string | null;
  w9Id: string | null;
  status: "NOT_SENT" | "SENT" | "COMPLETED" | "ERROR";
  requestedAt: string | null;
  completedAt: string | null;
}

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
  const brandUrl = `/api/brand/provider/${providerId}`;

  // ── Load fee configs + enabled services ─────────────────────────────────
  const { data: feeData, isLoading: loadingConfigs } = useQuery<FeeConfigsResponse>({
    queryKey: [feeListUrl],
    queryFn: async () => {
      const res = await fetch(feeListUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load fee configs");
      return res.json();
    },
  });

  // ── Load brand settings (legalName + taxId live here) ────────────────────
  const { data: brandSettings } = useQuery<any>({
    queryKey: [brandUrl],
    queryFn: async () => {
      const res = await fetch(brandUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load brand settings");
      return res.json();
    },
  });

  // ── Load provider invoices (admin-only) ─────────────────────────────────
  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/invoices", providerId],
    enabled: !isProviderMode,
    queryFn: async () => {
      const res = await fetch(`/api/admin/invoices?providerId=${providerId}&pageSize=50`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      const d = await res.json();
      return d.invoices || [];
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

  // ── Billing Identity form state ─────────────────────────────────────────
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [showW9Setup, setShowW9Setup] = useState(false);

  useEffect(() => {
    if (brandSettings) {
      setLegalName(brandSettings.legalName || "");
      setTaxId(brandSettings.taxId || "");
    }
  }, [brandSettings]);

  const saveIdentityMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(brandUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          legalName: legalName.trim() || null,
          taxId: taxId.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to save billing identity");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [brandUrl] }),
  });

  // ── W-9 status + actions ──────────────────────────────────────────────────
  const navigate = useNavigate();
  const w9GetUrl = isProviderMode ? "/api/provider/w9" : `/api/admin/providers/${providerId}/w9`;
  const { data: w9, isLoading: w9Loading } = useQuery<W9Status>({
    queryKey: [w9GetUrl],
    queryFn: async () => {
      const res = await fetch(w9GetUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load W-9 status");
      return res.json();
    },
  });

  useEffect(() => {
    if (!isProviderMode && w9?.templateNeedsFields) setShowW9Setup(true);
  }, [w9?.templateNeedsFields, isProviderMode]);

  const w9SendMutation = useMutation({
    mutationFn: async (force?: boolean) => {
      const res = await fetch(`/api/admin/providers/${providerId}/w9/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ force: !!force }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to send W-9 request");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [w9GetUrl] }),
  });

  const w9FillMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provider/w9/fill`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to open W-9");
      return res.json();
    },
    onSuccess: (data: { w9Id: string }) => {
      queryClient.invalidateQueries({ queryKey: [w9GetUrl] });
      if (data?.w9Id) navigate(`/w9/${data.w9Id}`);
    },
  });

  const w9ResubmitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provider/w9/resubmit`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to start a new W-9");
      return res.json();
    },
    onSuccess: (data: { w9Id: string }) => {
      queryClient.invalidateQueries({ queryKey: [w9GetUrl] });
      if (data?.w9Id) navigate(`/w9/${data.w9Id}`);
    },
  });

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

      {/* Billing Identity - provider-wide, not per-service */}
      <section className="space-y-4 rounded-xl border p-5 bg-secondary/30">
        <div>
          <h3 className="font-semibold">Billing Identity</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Required before invoices can be sent. Used on the receipt PDF parents download for FSA / HSA / insurance reimbursement.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Legal Name <span style={{ color: "hsl(var(--brand-error))" }}>*</span></Label>
          <Input
            placeholder="e.g. Eggceptional Fertility LLC"
            value={legalName}
            onChange={e => setLegalName(e.target.value)}
            data-testid="input-legal-name"
          />
          <p className="text-xs text-muted-foreground">
            Full legal entity name shown in the &quot;Issued By&quot; block on payment receipts. Falls back to the Company Name when blank.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Tax ID / EIN <span style={{ color: "hsl(var(--brand-error))" }}>*</span></Label>
          <Input
            placeholder="e.g. 12-3456789"
            value={taxId}
            onChange={e => setTaxId(e.target.value)}
            data-testid="input-tax-id"
          />
          <p className="text-xs text-muted-foreground">
            Shown in the receipt footer so parents can submit it for reimbursement.
          </p>
        </div>

        {/* W-9 record */}
        <div className="space-y-1.5">
          <Label>W-9 <span style={{ color: "hsl(var(--brand-error))" }}>*</span></Label>
          <div className="flex items-center gap-3 rounded-[var(--radius)] border p-3 bg-background">
            <FileText className="w-4 h-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">W-9 Form</p>
              <p className="text-xs text-muted-foreground">
                {w9Loading ? "Loading..."
                  : !w9?.templateConfigured && w9?.templateNeedsFields ? (isProviderMode ? "Not available yet" : "Template uploaded - assign signature field to finish setup")
                  : !w9?.templateConfigured ? (isProviderMode ? "Not available yet" : "No W-9 template configured")
                  : w9.status === "COMPLETED" ? `Completed${w9.completedAt ? ` ${new Date(w9.completedAt).toLocaleDateString()}` : ""}`
                  : w9.status === "SENT" ? (isProviderMode ? "Awaiting your signature" : "Sent - awaiting signature")
                  : w9.status === "ERROR" ? "Something went wrong - try again"
                  : (isProviderMode ? "Ready to fill out" : "Not sent yet")}
              </p>
            </div>

            {w9?.status === "COMPLETED" && w9.w9Id && (
              <div className="flex items-center gap-2 shrink-0">
                <span className="flex items-center gap-1 text-xs font-medium" style={{ color: "hsl(var(--brand-success))" }}>
                  <Check className="w-3.5 h-3.5" /> Completed
                </span>
                <Button variant="ghost" size="sm" onClick={() => navigate(`/w9/${w9.w9Id}`)} title="View">
                  <ExternalLink className="w-4 h-4" />
                </Button>
                <a
                  href={`/api/w9/${w9.w9Id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Download"
                  className="inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius)] hover:bg-muted"
                >
                  <Download className="w-4 h-4" />
                </a>
                {isProviderMode && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={w9ResubmitMutation.isPending}
                    onClick={() => w9ResubmitMutation.mutate()}
                    title="Submit a new W-9"
                  >
                    {w9ResubmitMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}
                    Submit new W-9
                  </Button>
                )}
                {!isProviderMode && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={w9SendMutation.isPending}
                    onClick={() => {
                      if (window.confirm("Request a new W-9 from this provider? The current signed W-9 will no longer be the active version (it stays in PandaDoc's archive for record-keeping).")) {
                        w9SendMutation.mutate(true);
                      }
                    }}
                    title="Ask the provider to fill out a new W-9"
                  >
                    {w9SendMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                    Request new W-9
                  </Button>
                )}
              </div>
            )}

            {!isProviderMode && w9?.templateConfigured && w9.status !== "COMPLETED" && (
              <div className="flex items-center gap-2 shrink-0">
                {w9.status === "SENT" && w9.w9Id && (
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/w9/${w9.w9Id}`)} title="View">
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={w9SendMutation.isPending}
                  onClick={() => w9SendMutation.mutate(false)}
                >
                  {w9SendMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                  {w9.status === "SENT" ? "Resend" : "Send W-9 request"}
                </Button>
              </div>
            )}
            {!isProviderMode && !w9?.templateConfigured && !w9Loading && (
              <Button
                type="button"
                variant={w9?.templateNeedsFields ? "default" : "outline"}
                size="sm"
                onClick={() => setShowW9Setup(s => !s)}
                className="shrink-0"
                style={w9?.templateNeedsFields ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" } : undefined}
              >
                {showW9Setup ? <ChevronUp className="w-4 h-4 mr-2" /> : <ChevronDown className="w-4 h-4 mr-2" />}
                {showW9Setup ? "Hide template setup" : w9?.templateNeedsFields ? "Configure signature field" : "Set up template"}
              </Button>
            )}
            {!isProviderMode && w9?.templateConfigured && !w9Loading && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowW9Setup(s => !s)}
                className="shrink-0 text-muted-foreground"
                title={showW9Setup ? "Hide template setup" : "Edit W-9 template"}
              >
                {showW9Setup ? <ChevronUp className="w-4 h-4 mr-1.5" /> : <ChevronDown className="w-4 h-4 mr-1.5" />}
                {showW9Setup ? "Hide template" : "Edit template"}
              </Button>
            )}
            {isProviderMode && w9?.templateConfigured && w9.status !== "COMPLETED" && (
              <Button
                size="sm"
                disabled={w9FillMutation.isPending}
                onClick={() => w9FillMutation.mutate()}
                style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
                className="shrink-0"
              >
                {w9FillMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}
                Fill out W-9
              </Button>
            )}
          </div>
          {w9SendMutation.isError && (
            <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{(w9SendMutation.error as Error).message}</p>
          )}
          {w9FillMutation.isError && (
            <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{(w9FillMutation.error as Error).message}</p>
          )}
          {w9ResubmitMutation.isError && (
            <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{(w9ResubmitMutation.error as Error).message}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {isProviderMode
              ? "Complete and sign your W-9 - GoStork needs it before any payouts can be processed."
              : "Send the W-9 to the agency to fill and sign, or download it once completed."}
          </p>

          {!isProviderMode && showW9Setup && (
            <div className="pt-2">
              <W9TemplateConfig onChange={() => queryClient.invalidateQueries({ queryKey: [w9GetUrl] })} />
            </div>
          )}
        </div>

        {saveIdentityMutation.isError && (
          <p className="text-sm" style={{ color: "hsl(var(--brand-error))" }}>
            {(saveIdentityMutation.error as Error).message}
          </p>
        )}
        {saveIdentityMutation.isSuccess && (
          <p className="text-sm" style={{ color: "hsl(var(--brand-success))" }}>Billing Identity saved</p>
        )}
        <Button
          disabled={saveIdentityMutation.isPending}
          onClick={() => saveIdentityMutation.mutate()}
          style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
        >
          {saveIdentityMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Save Billing Identity
        </Button>
      </section>

      {/* Invoice history */}
      {invoices.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="font-semibold">Invoice History</h3>
            <p className="text-sm text-muted-foreground mt-0.5">{invoices.length} invoice{invoices.length !== 1 ? "s" : ""} for this provider</p>
          </div>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Parent</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Amount</th>
                  <th className="text-right px-4 py-2.5 font-medium text-muted-foreground text-xs">Fee</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium text-muted-foreground text-xs">Date</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv: any) => (
                  <tr key={inv.id} className="border-b last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-2.5">{inv.parentUser?.name || inv.parentUser?.email}</td>
                    <td className="px-4 py-2.5 text-right font-medium">{formatCents(inv.serviceAmount, inv.currency)}</td>
                    <td className="px-4 py-2.5 text-right" style={{ color: "hsl(var(--brand-success))" }}>{formatCents(inv.referralFeeAmount, inv.currency)}</td>
                    <td className="px-4 py-2.5"><InvoiceStatusBadge status={inv.status} /></td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">{new Date(inv.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
