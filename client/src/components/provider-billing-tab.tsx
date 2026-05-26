/**
 * Provider billing tab - shown in admin provider edit page at ?tab=billing
 * Allows setting referral fee config and viewing invoice history for a provider.
 * For surrogacy agencies: also shows depositMilestone and averageClearanceDays settings.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Loader2, Save, DollarSign, Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InvoiceStatusBadge } from "./invoice-status-badge";

function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

interface ProviderBillingTabProps {
  providerId: string;
  providerTypeName?: string;
}

export function ProviderBillingTab({ providerId, providerTypeName = "" }: ProviderBillingTabProps) {
  const queryClient = useQueryClient();
  const isSurrogacy = providerTypeName === "Surrogacy Agency";

  // ── Load existing fee config ────────────────────────────────────────────
  const { data: feeConfig, isLoading: loadingConfig } = useQuery<any>({
    queryKey: ["/api/admin/provider-fee-config", providerId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/providers/${providerId}/fee-config`, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to load fee config");
      return res.json();
    },
  });

  // ── Load provider invoices ───────────────────────────────────────────────
  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/invoices", providerId],
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

  useEffect(() => {
    if (feeConfig) {
      setFeeType(feeConfig.feeType || "PERCENTAGE");
      setFlatAmount(feeConfig.flatAmount ? String(Number(feeConfig.flatAmount) / 100) : "");
      setPercentage(feeConfig.percentage ? String(feeConfig.percentage) : "");
      setDefaultServiceAmount(feeConfig.defaultServiceAmount ? String(Number(feeConfig.defaultServiceAmount) / 100) : "");
      setParentPaysBasis(feeConfig.parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT");
      setNotes(feeConfig.notes || "");
    }
  }, [feeConfig]);

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
        isActive: true,
      };

      if (isSurrogacy) {
        body.depositMilestone = depositMilestone;
        body.averageClearanceDays = parseInt(averageClearanceDays, 10) || 21;
      }

      const res = await fetch(`/api/admin/providers/${providerId}/fee-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/provider-fee-config", providerId] });
    },
  });

  if (loadingConfig) return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-8 max-w-xl">

      {/* Fee configuration */}
      <section className="space-y-4">
        <div>
          <h3 className="font-semibold">Referral Fee Configuration</h3>
          <p className="text-sm text-muted-foreground mt-0.5">How GoStork's referral fee is calculated for this provider</p>
        </div>

        {/* Fee type toggle */}
        <div className="space-y-2">
          <Label>Fee Type</Label>
          <div className="flex gap-2">
            <button
              onClick={() => setFeeType("PERCENTAGE")}
              className="flex-1 flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors"
              style={{
                background: feeType === "PERCENTAGE" ? "hsl(var(--primary))" : "transparent",
                color: feeType === "PERCENTAGE" ? "hsl(var(--primary-foreground))" : "hsl(var(--foreground))",
                borderColor: feeType === "PERCENTAGE" ? "hsl(var(--primary))" : "hsl(var(--border))",
              }}
            >
              <Percent className="w-4 h-4" /> Percentage
            </button>
            <button
              onClick={() => setFeeType("FLAT")}
              className="flex-1 flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors"
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
        <div className="pt-1">
          <h4 className="text-sm font-semibold">GoStork Referral Fee</h4>
        </div>
        {feeType === "PERCENTAGE" ? (
          <div className="space-y-1.5">
            <Label>Percentage (%)</Label>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              placeholder="e.g. 10"
              value={percentage}
              onChange={e => setPercentage(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">GoStork keeps this % of the Total Quoted Cost the provider sends the parent</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>Flat Amount ($)</Label>
            <Input
              type="number"
              min="0"
              step="50"
              placeholder="e.g. 500"
              value={flatAmount}
              onChange={e => setFlatAmount(e.target.value)}
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
