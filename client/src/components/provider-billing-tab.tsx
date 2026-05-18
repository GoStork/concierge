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
  const [flatAmount, setFlatAmount] = useState("");      // dollars
  const [percentage, setPercentage] = useState("");      // e.g. "10"
  const [notes, setNotes] = useState("");
  const [depositMilestone, setDepositMilestone] = useState<"AT_MATCH" | "AT_CLEARANCE">("AT_MATCH");
  const [averageClearanceDays, setAverageClearanceDays] = useState("21");

  useEffect(() => {
    if (feeConfig) {
      setFeeType(feeConfig.feeType || "PERCENTAGE");
      setFlatAmount(feeConfig.flatAmount ? String(Number(feeConfig.flatAmount) / 100) : "");
      setPercentage(feeConfig.percentage ? String(feeConfig.percentage) : "");
      setNotes(feeConfig.notes || "");
    }
  }, [feeConfig]);

  // ── Save fee config ─────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        feeType,
        notes,
        flatAmount: feeType === "FLAT" ? Math.round(parseFloat(flatAmount) * 100) : null,
        percentage: feeType === "PERCENTAGE" ? parseFloat(percentage) : null,
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
            <p className="text-xs text-muted-foreground">GoStork keeps this % of the parent's payment amount</p>
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
