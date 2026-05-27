/**
 * Provider billing tab - shown in admin provider edit page at ?tab=billing
 * Allows setting referral fee config and viewing invoice history for a provider.
 * For surrogacy agencies: also shows depositMilestone and averageClearanceDays settings.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Save, DollarSign, Percent, FileText, Send, Download, Check, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InvoiceStatusBadge } from "./invoice-status-badge";
import { W9TemplateConfig } from "./w9-template-config";

interface W9Status {
  templateConfigured: boolean;
  templateNeedsFields?: boolean;
  templateName: string | null;
  w9Id: string | null;
  status: "NOT_SENT" | "SENT" | "COMPLETED" | "ERROR";
  requestedAt: string | null;
  completedAt: string | null;
}

function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

interface ProviderBillingTabProps {
  providerId: string;
  providerTypeName?: string;
  /**
   * "admin" - GoStork admin editing any provider. Full edit rights.
   * "provider" - Provider editing their own row. GoStork referral fee
   *   economics (feeType/percentage/flatAmount) are read-only.
   */
  mode?: "admin" | "provider";
}

export function ProviderBillingTab({ providerId, providerTypeName = "", mode = "admin" }: ProviderBillingTabProps) {
  const queryClient = useQueryClient();
  const isSurrogacy = providerTypeName === "Surrogacy Agency";
  const isProviderMode = mode === "provider";
  const feeConfigGetUrl = isProviderMode
    ? `/api/provider/fee-config`
    : `/api/admin/providers/${providerId}/fee-config`;
  const feeConfigPutUrl = feeConfigGetUrl;
  const brandGetUrl = isProviderMode
    ? `/api/brand/provider/${providerId}`
    : `/api/brand/provider/${providerId}`;
  const brandPutUrl = brandGetUrl;

  // ── Load existing fee config ────────────────────────────────────────────
  const { data: feeConfig, isLoading: loadingConfig } = useQuery<any>({
    queryKey: [feeConfigGetUrl],
    queryFn: async () => {
      const res = await fetch(feeConfigGetUrl, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to load fee config");
      return res.json();
    },
  });

  // ── Load brand settings (legalName + taxId live here) ────────────────────
  const { data: brandSettings } = useQuery<any>({
    queryKey: [brandGetUrl],
    queryFn: async () => {
      const res = await fetch(brandGetUrl, { credentials: "include" });
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

  // ── Form state ──────────────────────────────────────────────────────────
  const [feeType, setFeeType] = useState<"FLAT" | "PERCENTAGE">("PERCENTAGE");
  const [flatAmount, setFlatAmount] = useState("");            // dollars
  const [percentage, setPercentage] = useState("");            // e.g. "10"
  const [defaultServiceAmount, setDefaultServiceAmount] = useState(""); // dollars
  const [parentPaysBasis, setParentPaysBasis] = useState<"DEFAULT_FIRST_PAYMENT" | "TOTAL_COST">("DEFAULT_FIRST_PAYMENT");
  const [sampleTotalCost, setSampleTotalCost] = useState(""); // dollars - drives the preview's feeBasis
  const [notes, setNotes] = useState("");
  const [depositMilestone, setDepositMilestone] = useState<"AT_MATCH" | "AT_CLEARANCE">("AT_MATCH");
  const [averageClearanceDays, setAverageClearanceDays] = useState("21");
  const [showW9Setup, setShowW9Setup] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");

  useEffect(() => {
    if (feeConfig) {
      setFeeType(feeConfig.feeType || "PERCENTAGE");
      setFlatAmount(feeConfig.flatAmount ? String(Number(feeConfig.flatAmount) / 100) : "");
      setPercentage(feeConfig.percentage ? String(feeConfig.percentage) : "");
      setDefaultServiceAmount(feeConfig.defaultServiceAmount ? String(Number(feeConfig.defaultServiceAmount) / 100) : "");
      setParentPaysBasis(feeConfig.parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT");
      setSampleTotalCost(feeConfig.sampleTotalCostCents ? String(Number(feeConfig.sampleTotalCostCents) / 100) : "");
      setNotes(feeConfig.notes || "");
    }
  }, [feeConfig]);

  useEffect(() => {
    if (brandSettings) {
      setLegalName(brandSettings.legalName || "");
      setTaxId(brandSettings.taxId || "");
    }
  }, [brandSettings]);


  // ── Live split preview ───────────────────────────────────────────────────
  // The fee basis is the Sample Total Quoted Cost (what the % is taken from).
  // The parent-pays amount is either that same total or the Default First Payment.
  const previewBasisCents = Math.round((parseFloat(sampleTotalCost) || 0) * 100);
  const previewDefaultCents = Math.round((parseFloat(defaultServiceAmount) || 0) * 100);
  const previewParentPaysCents = parentPaysBasis === "TOTAL_COST" ? previewBasisCents : previewDefaultCents;
  const previewFeeCents = feeType === "FLAT"
    ? Math.round((parseFloat(flatAmount) || 0) * 100)
    : Math.round(previewBasisCents * ((parseFloat(percentage) || 0) / 100));
  const clampedFee = Math.min(previewFeeCents, previewParentPaysCents);
  const previewPayoutCents = Math.max(0, previewParentPaysCents - clampedFee);
  const showPreview =
    previewParentPaysCents > 0 &&
    (feeType === "FLAT" ? parseFloat(flatAmount) > 0 : parseFloat(percentage) > 0 && previewBasisCents > 0);

  // ── Save fee config ─────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        feeType,
        notes,
        flatAmount: feeType === "FLAT" ? Math.round(parseFloat(flatAmount) * 100) : null,
        percentage: feeType === "PERCENTAGE" ? parseFloat(percentage) : null,
        defaultServiceAmount: defaultServiceAmount ? Math.round(parseFloat(defaultServiceAmount) * 100) : null,
        parentPaysBasis,
        sampleTotalCostCents: sampleTotalCost ? Math.round(parseFloat(sampleTotalCost) * 100) : null,
        isActive: true,
      };

      if (isSurrogacy) {
        body.depositMilestone = depositMilestone;
        body.averageClearanceDays = parseInt(averageClearanceDays, 10) || 21;
      }

      const res = await fetch(feeConfigPutUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to save");

      // Persist billing identity fields (legalName + taxId) on the same Save click.
      // These live on ProviderBrandSettings so the receipt PDF generator can read them.
      const brandRes = await fetch(brandPutUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          legalName: legalName.trim() || null,
          taxId: taxId.trim() || null,
        }),
      });
      if (!brandRes.ok) throw new Error((await brandRes.json().catch(() => ({}))).message || "Failed to save billing identity");

      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [feeConfigGetUrl] });
      queryClient.invalidateQueries({ queryKey: [brandGetUrl] });
    },
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

  // Auto-open the setup panel when admin loads the page and the template is
  // half-configured (file uploaded but signature field not yet assigned).
  // Fires once per mount; user can still collapse it with the toggle.
  useEffect(() => {
    if (!isProviderMode && w9?.templateNeedsFields) {
      setShowW9Setup(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w9?.templateNeedsFields, isProviderMode]);

  // Admin sends the W-9 request to the agency. Pass force=true to wipe an
  // existing (typically COMPLETED) row and issue a fresh signing request -
  // used when something was wrong with the previously signed W-9.
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

  // Provider self-initiates filling the W-9, then opens the signing page.
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

  // Provider asks to start over - wipes the existing PandaDoc doc and generates
  // a fresh one from the current template. Used after a completed signing if
  // the provider needs to fix details (legal name, EIN, address).
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

  if (loadingConfig) return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-8">

      {/* Fee configuration */}
      <section className="space-y-4">
        <div>
          <h3 className="font-semibold">Referral Fee Configuration</h3>
          <p className="text-sm text-muted-foreground mt-0.5">How GoStork's referral fee is calculated for this provider</p>
        </div>

        {/* Fee type toggle */}
        <div className="space-y-2">
          <Label>
            GoStork Referral Fee Type
            {isProviderMode && <span className="text-xs text-muted-foreground ml-2 font-normal">(set by GoStork)</span>}
          </Label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isProviderMode}
              onClick={() => !isProviderMode && setFeeType("PERCENTAGE")}
              className="flex-1 flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70"
              style={{
                background: feeType === "PERCENTAGE" ? "hsl(var(--primary))" : "transparent",
                color: feeType === "PERCENTAGE" ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
                borderColor: feeType === "PERCENTAGE" ? "hsl(var(--primary))" : "hsl(var(--border))",
              }}
            >
              <Percent className="w-4 h-4" /> Percentage From Total
            </button>
            <button
              type="button"
              disabled={isProviderMode}
              onClick={() => !isProviderMode && setFeeType("FLAT")}
              className="flex-1 flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70"
              style={{
                background: feeType === "FLAT" ? "hsl(var(--primary))" : "transparent",
                color: feeType === "FLAT" ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
                borderColor: feeType === "FLAT" ? "hsl(var(--primary))" : "hsl(var(--border))",
              }}
            >
              <DollarSign className="w-4 h-4" /> Flat Amount
            </button>
          </div>
        </div>

        {/* Fee amount input */}
        {feeType === "PERCENTAGE" ? (
          <div className="space-y-1.5">
            <Label>
              GoStork Referral Percentage (%)
              {isProviderMode && <span className="text-xs text-muted-foreground ml-2 font-normal">(set by GoStork)</span>}
            </Label>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              placeholder="e.g. 10"
              value={percentage}
              onChange={e => setPercentage(e.target.value)}
              disabled={isProviderMode}
            />
            <p className="text-xs text-muted-foreground">GoStork keeps this % of the Total Quoted Cost the provider sends the parent</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>
              Flat Amount ($)
              {isProviderMode && <span className="text-xs text-muted-foreground ml-2 font-normal">(set by GoStork)</span>}
            </Label>
            <Input
              type="number"
              min="0"
              step="50"
              placeholder="e.g. 500"
              value={flatAmount}
              onChange={e => setFlatAmount(e.target.value)}
              disabled={isProviderMode}
            />
            <p className="text-xs text-muted-foreground">GoStork keeps this fixed dollar amount regardless of service cost</p>
          </div>
        )}

        {/* Parent-pays basis toggle */}
        <div className="space-y-2">
          <Label>Parent Pays Basis</Label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setParentPaysBasis("DEFAULT_FIRST_PAYMENT")}
              className="flex-1 rounded-lg border py-2.5 text-sm font-medium transition-colors"
              style={{
                background: parentPaysBasis === "DEFAULT_FIRST_PAYMENT" ? "hsl(var(--primary))" : "transparent",
                color: parentPaysBasis === "DEFAULT_FIRST_PAYMENT" ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
                borderColor: parentPaysBasis === "DEFAULT_FIRST_PAYMENT" ? "hsl(var(--primary))" : "hsl(var(--border))",
              }}
            >
              Default First Payment
            </button>
            <button
              type="button"
              onClick={() => setParentPaysBasis("TOTAL_COST")}
              className="flex-1 rounded-lg border py-2.5 text-sm font-medium transition-colors"
              style={{
                background: parentPaysBasis === "TOTAL_COST" ? "hsl(var(--primary))" : "transparent",
                color: parentPaysBasis === "TOTAL_COST" ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
                borderColor: parentPaysBasis === "TOTAL_COST" ? "hsl(var(--primary))" : "hsl(var(--border))",
              }}
            >
              Total Quoted Cost
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {parentPaysBasis === "TOTAL_COST"
              ? "Each invoice charges the parent the full Total Quoted Cost from the provider's cost sheet."
              : "Each invoice charges the parent the Default First Payment (below). The provider can still send a cost sheet that drives the GoStork % calculation."}
          </p>
        </div>

        {/* Default first payment */}
        <div className="space-y-1.5">
          <Label>Default First Payment ($) <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Input
            type="number"
            min="0"
            step="100"
            placeholder="e.g. 10000"
            value={defaultServiceAmount}
            onChange={e => setDefaultServiceAmount(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            The standard amount collected from the parent. Pre-fills the invoice - admin or agency can override per invoice.
          </p>
        </div>

        {/* Sample Total Quoted Cost (drives preview when basis = TOTAL_COST or fee = PERCENTAGE) */}
        <div className="space-y-1.5">
          <Label>Sample Total Quoted Cost ($) <span className="text-muted-foreground font-normal">(preview only)</span></Label>
          <Input
            type="number"
            min="0"
            step="500"
            placeholder="e.g. 25000"
            value={sampleTotalCost}
            onChange={e => setSampleTotalCost(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Pretend the provider quoted this total - the preview below shows the resulting invoice split.
          </p>
        </div>

        {/* Live split preview */}
        {showPreview && (
          <div className="rounded-lg border p-4 space-y-2" style={{ background: "hsl(var(--muted) / 0.4)" }}>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Payment Split Preview</p>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Total quoted cost</span>
                <span>{formatCents(previewBasisCents)}</span>
              </div>
              <div className="flex justify-between">
                <span>Parent pays</span>
                <span className="font-semibold">{formatCents(previewParentPaysCents)}</span>
              </div>
              <div className="flex justify-between" style={{ color: "hsl(var(--brand-success))" }}>
                <span>GoStork keeps ({feeType === "PERCENTAGE" ? `${percentage}%` : "flat"})</span>
                <span className="font-semibold">{formatCents(clampedFee)}</span>
              </div>
              <div className="flex justify-between border-t pt-1.5 font-semibold">
                <span>Provider receives</span>
                <span>{formatCents(previewPayoutCents)}</span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1">
              Parent-pays basis: {parentPaysBasis === "TOTAL_COST" ? "Total Quoted Cost" : "Default First Payment"}
            </p>
          </div>
        )}

        {/* Surrogacy-specific settings */}
        {isSurrogacy && (
          <div className="space-y-4 border-t pt-4">
            <div>
              <h4 className="text-sm font-medium">Surrogacy Deposit Trigger</h4>
              <p className="text-xs text-muted-foreground mt-0.5">When should GoStork request the parent's deposit?</p>
            </div>
            <div className="space-y-2">
              {[
                { value: "AT_MATCH", label: "Immediately after Match Call", desc: "Parent pays deposit within 24h of the match call. Standard flow." },
                { value: "AT_CLEARANCE", label: "After medical clearance (AI Escrow)", desc: "Card is authorized (held) after the match call, but only charged after the surrogate passes medical screening. Best for agencies whose surrogates require clearance before commitment." },
              ].map(opt => (
                <label
                  key={opt.value}
                  className="flex gap-3 cursor-pointer rounded-lg border px-4 py-3 transition-colors"
                  style={{ borderColor: depositMilestone === opt.value ? "hsl(var(--primary))" : "hsl(var(--border))", background: depositMilestone === opt.value ? "hsl(var(--primary) / 0.05)" : "transparent" }}
                >
                  <input
                    type="radio"
                    name="depositMilestone"
                    value={opt.value}
                    checked={depositMilestone === opt.value}
                    onChange={() => setDepositMilestone(opt.value as any)}
                    className="mt-0.5 shrink-0"
                  />
                  <div>
                    <p className="text-sm font-medium">{opt.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>

            {depositMilestone === "AT_CLEARANCE" && (
              <div className="space-y-1.5">
                <Label>Average Days to Medical Clearance</Label>
                <Input
                  type="number"
                  min="1"
                  max="90"
                  value={averageClearanceDays}
                  onChange={e => setAverageClearanceDays(e.target.value)}
                  placeholder="21"
                />
                <p className="text-xs text-muted-foreground">
                  Used to schedule AI check-in messages. GoStork will reach out to the parent around days {Math.max(1, parseInt(averageClearanceDays || "21") - 7)}, {averageClearanceDays}, and {parseInt(averageClearanceDays || "21") + 7}.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Billing Identity - Legal Name, Tax ID, and W-9. All required before
            any invoice (manual or automatic) can be sent for this provider. */}
        <div className="space-y-4 rounded-xl border p-5 bg-secondary/30">
          <div>
            <h4 className="text-sm font-medium">Billing Identity</h4>
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

              {/* Completed - both modes can view + download */}
              {w9?.status === "COMPLETED" && w9.w9Id && (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="flex items-center gap-1 text-xs font-medium" style={{ color: "hsl(var(--brand-success))" }}>
                    <Check className="w-3.5 h-3.5" /> Completed
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/w9/${w9.w9Id}`)} title="View">
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                  <a href={`/api/w9/${w9.w9Id}/download`} target="_blank" rel="noopener noreferrer" title="Download"
                    className="inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius)] hover:bg-muted">
                    <Download className="w-4 h-4" />
                  </a>
                  {/* Provider can always start over - fixes typos, address changes, or
                      re-signs after admin updated the template. */}
                  {isProviderMode && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={w9ResubmitMutation.isPending}
                      onClick={() => w9ResubmitMutation.mutate()}
                      title="Submit a new W-9"
                    >
                      {w9ResubmitMutation.isPending
                        ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        : <FileText className="w-4 h-4 mr-2" />}
                      Submit new W-9
                    </Button>
                  )}
                  {/* Admin can request a new W-9 if something was wrong with the
                      signed copy (wrong legal name, EIN, address). Wipes the
                      completed row and re-emails the provider with a fresh
                      signing link. */}
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
                      {w9SendMutation.isPending
                        ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        : <Send className="w-4 h-4 mr-2" />}
                      Request new W-9
                    </Button>
                  )}
                </div>
              )}

              {/* Admin actions */}
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
                    onClick={() => w9SendMutation.mutate()}
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
                  {showW9Setup
                    ? "Hide template setup"
                    : w9?.templateNeedsFields ? "Configure signature field" : "Set up template"}
                </Button>
              )}

              {/* Admin: always allow editing/replacing the template, even when
                  fully configured. Small ghost button so it doesn't compete
                  with the primary Send/Resend action. */}
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

              {/* Provider actions */}
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

            {/* Inline W-9 template setup (admin only) */}
            {!isProviderMode && showW9Setup && (
              <div className="pt-2">
                <W9TemplateConfig onChange={() => queryClient.invalidateQueries({ queryKey: [w9GetUrl] })} />
              </div>
            )}
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-1.5">
          <Label>Internal Notes (optional)</Label>
          <Input
            placeholder="e.g. Custom rate agreed on 2026-05-01"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        {saveMutation.isError && (
          <p className="text-sm" style={{ color: "hsl(var(--brand-error))" }}>
            {(saveMutation.error as Error).message}
          </p>
        )}

        {saveMutation.isSuccess && (
          <p className="text-sm" style={{ color: "hsl(var(--brand-success))" }}>Fee configuration saved</p>
        )}

        <Button
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
        >
          {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Configuration
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
