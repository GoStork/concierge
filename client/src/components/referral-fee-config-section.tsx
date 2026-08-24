/**
 * One Referral Fee Configuration block for a specific (provider, serviceType)
 * pair. Lifted out of provider-billing-tab.tsx so the same UI can be reused
 * across multiple per-service tabs in the admin/provider billing page.
 *
 * Owns:
 *  - Form state for fee type, flat/percentage, parent-pays basis,
 *    default first payment, sample total quoted cost, notes
 *  - Live payment-split preview
 *  - Surrogacy-only deposit milestone + clearance days (rendered only when
 *    serviceType === "SURROGACY")
 *  - Save mutation that PUTs to /api/{admin|provider}/.../fee-configs/:serviceType
 *
 * Does NOT own: Billing Identity (Legal Name / Tax ID / W-9). Those live at
 * the provider level and stay in provider-billing-tab.tsx.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Loader2, Save, DollarSign, Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SaveBar } from "@/components/ui/save-bar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { formatMoneyCents } from "@/lib/format-money";

export const LINE_SERVICE_TYPES = ["SURROGACY", "EGG_DONATION", "SPERM_DONATION", "IVF_CLINIC", "OTHER"] as const;
export type LineServiceType = typeof LINE_SERVICE_TYPES[number];
export const LINE_SERVICE_LABELS: Record<LineServiceType, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
  OTHER: "Other",
};

export interface ReferralFeeConfigPayload {
  id?: string;
  serviceType: LineServiceType;
  feeType: "FLAT" | "PERCENTAGE";
  flatAmount: number | null;        // cents
  percentage: number | null;        // e.g. 5.0
  defaultServiceAmount: number | null; // cents
  parentPaysBasis: "DEFAULT_FIRST_PAYMENT" | "TOTAL_COST";
  sampleTotalCostCents: number | null;
  isActive: boolean;
}

const formatCents = formatMoneyCents;

interface ReferralFeeConfigSectionProps {
  providerId: string;
  serviceType: LineServiceType;
  /** Existing config from the server, or null if this service has no config yet. */
  initialConfig: ReferralFeeConfigPayload | null;
  /** "admin" | "provider" - provider mode locks GoStork referral fee economics. */
  mode: "admin" | "provider";
  /** When true, render surrogacy-only settings (deposit milestone, clearance days). */
  showSurrogacyExtras?: boolean;
  /** Initial values for surrogacy extras (only used when showSurrogacyExtras). */
  initialDepositMilestone?: "AT_MATCH" | "AT_CLEARANCE";
  initialAverageClearanceDays?: number | null;
  /** Called after a successful save so the parent can refetch the configs list. */
  onSaved?: () => void;
}

export function ReferralFeeConfigSection({
  providerId,
  serviceType,
  initialConfig,
  mode,
  showSurrogacyExtras = false,
  initialDepositMilestone = "AT_MATCH",
  initialAverageClearanceDays = 21,
  onSaved,
}: ReferralFeeConfigSectionProps) {
  const queryClient = useQueryClient();
  const isProviderMode = mode === "provider";

  const putUrl = isProviderMode
    ? `/api/provider/fee-configs/${serviceType}`
    : `/api/admin/providers/${providerId}/fee-configs/${serviceType}`;
  const listKey = isProviderMode
    ? "/api/provider/fee-configs"
    : `/api/admin/providers/${providerId}/fee-configs`;

  // Form state - seeded from initialConfig, falls back to sensible defaults.
  const [feeType, setFeeType] = useState<"FLAT" | "PERCENTAGE">(initialConfig?.feeType ?? "PERCENTAGE");
  const [flatAmount, setFlatAmount] = useState(initialConfig?.flatAmount ? String(initialConfig.flatAmount / 100) : "");
  const [percentage, setPercentage] = useState(initialConfig?.percentage != null ? String(initialConfig.percentage) : "");
  const [defaultServiceAmount, setDefaultServiceAmount] = useState(
    initialConfig?.defaultServiceAmount ? String(initialConfig.defaultServiceAmount / 100) : "",
  );
  const [parentPaysBasis, setParentPaysBasis] = useState<"DEFAULT_FIRST_PAYMENT" | "TOTAL_COST">(
    initialConfig?.parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT",
  );
  const [sampleTotalCost, setSampleTotalCost] = useState(
    initialConfig?.sampleTotalCostCents ? String(initialConfig.sampleTotalCostCents / 100) : "",
  );
  const [depositMilestone, setDepositMilestone] = useState<"AT_MATCH" | "AT_CLEARANCE">(initialDepositMilestone);
  const [averageClearanceDays, setAverageClearanceDays] = useState(String(initialAverageClearanceDays ?? 21));

  // Snapshot of last-saved values used to compute the dirty flag for the SaveBar.
  const buildSnapshot = () => JSON.stringify({
    feeType: initialConfig?.feeType ?? "PERCENTAGE",
    flatAmount: initialConfig?.flatAmount ? String(initialConfig.flatAmount / 100) : "",
    percentage: initialConfig?.percentage != null ? String(initialConfig.percentage) : "",
    defaultServiceAmount: initialConfig?.defaultServiceAmount ? String(initialConfig.defaultServiceAmount / 100) : "",
    parentPaysBasis: initialConfig?.parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT",
    sampleTotalCost: initialConfig?.sampleTotalCostCents ? String(initialConfig.sampleTotalCostCents / 100) : "",
    depositMilestone: initialDepositMilestone,
    averageClearanceDays: String(initialAverageClearanceDays ?? 21),
  });
  const [snapshot, setSnapshot] = useState<string>(buildSnapshot);

  const discard = () => {
    setFeeType(initialConfig?.feeType ?? "PERCENTAGE");
    setFlatAmount(initialConfig?.flatAmount ? String(initialConfig.flatAmount / 100) : "");
    setPercentage(initialConfig?.percentage != null ? String(initialConfig.percentage) : "");
    setDefaultServiceAmount(initialConfig?.defaultServiceAmount ? String(initialConfig.defaultServiceAmount / 100) : "");
    setParentPaysBasis(initialConfig?.parentPaysBasis === "TOTAL_COST" ? "TOTAL_COST" : "DEFAULT_FIRST_PAYMENT");
    setSampleTotalCost(initialConfig?.sampleTotalCostCents ? String(initialConfig.sampleTotalCostCents / 100) : "");
    setDepositMilestone(initialDepositMilestone);
    setAverageClearanceDays(String(initialAverageClearanceDays ?? 21));
  };

  // Re-seed when serviceType changes (admin switches tabs to a different service).
  useEffect(() => {
    discard();
    setSnapshot(buildSnapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceType, initialConfig?.id]);

  const currentSerialized = JSON.stringify({
    feeType, flatAmount, percentage, defaultServiceAmount, parentPaysBasis,
    sampleTotalCost, depositMilestone, averageClearanceDays,
  });
  const isDirty = currentSerialized !== snapshot;

  // Live split preview (mirrors server math in BillingService.computeFee).
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

  // Parent Pays Basis is the PROVIDER's decision (their onboarding step) -
  // the admin saves fee economics only, so the missing-amount rule never
  // blocks the admin's save.
  const defaultFirstPaymentMissing =
    isProviderMode &&
    parentPaysBasis === "DEFAULT_FIRST_PAYMENT" &&
    (!defaultServiceAmount || parseFloat(defaultServiceAmount) <= 0);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        feeType,
        flatAmount: feeType === "FLAT" ? Math.round(parseFloat(flatAmount) * 100) : null,
        percentage: feeType === "PERCENTAGE" ? parseFloat(percentage) : null,
        defaultServiceAmount:
          parentPaysBasis === "TOTAL_COST"
            ? null
            : defaultServiceAmount ? Math.round(parseFloat(defaultServiceAmount) * 100) : null,
        parentPaysBasis,
        sampleTotalCostCents: sampleTotalCost ? Math.round(parseFloat(sampleTotalCost) * 100) : null,
        isActive: true,
      };
      if (showSurrogacyExtras) {
        body.depositMilestone = depositMilestone;
        body.averageClearanceDays = parseInt(averageClearanceDays, 10) || 21;
      }
      const res = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [listKey] });
      setSnapshot(currentSerialized);
      onSaved?.();
    },
  });

  return (
    <section className="space-y-4">
      {/* GoStork Referral Fee Type + amount input grouped in an outlined box */}
      <div className="rounded-lg border p-4 space-y-4 bg-card">
        <div className="space-y-2">
          <Label>
            GoStork Referral Fee Type
            {isProviderMode && <span className="t-helper ml-2">(set by GoStork)</span>}
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            {[
              { value: "PERCENTAGE", label: "Percentage From Total", icon: <Percent className="w-3.5 h-3.5" /> },
              { value: "FLAT", label: "Flat Amount", icon: <DollarSign className="w-3.5 h-3.5" /> },
            ].map(opt => (
              <label
                key={opt.value}
                className={`flex items-center gap-2 text-sm cursor-pointer ${isProviderMode ? "cursor-not-allowed opacity-70" : ""}`}
              >
                <input
                  type="radio"
                  name={`feeType-${serviceType}`}
                  value={opt.value}
                  checked={feeType === opt.value}
                  disabled={isProviderMode}
                  onChange={() => !isProviderMode && setFeeType(opt.value as "FLAT" | "PERCENTAGE")}
                  className="accent-primary"
                />
                {opt.icon}
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {feeType === "PERCENTAGE" ? (
          <div className="space-y-1.5 max-w-md">
            <Label>
              GoStork Referral Percentage (%)
              {isProviderMode && <span className="t-helper ml-2">(set by GoStork)</span>}
            </Label>
            <NumberInput
              placeholder="e.g. 10"
              value={percentage}
              onChange={setPercentage}
              disabled={isProviderMode}
            />
            <p className="t-helper">
              GoStork keeps this % of the Total Quoted Cost the provider sends the parent for this service.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5 max-w-md">
            <Label>
              Flat Amount ($)
              {isProviderMode && <span className="t-helper ml-2">(set by GoStork)</span>}
            </Label>
            <NumberInput
              placeholder="e.g. 500"
              value={flatAmount}
              onChange={setFlatAmount}
              disabled={isProviderMode}
            />
            <p className="t-helper">
              GoStork keeps this fixed dollar amount regardless of service cost.
            </p>
          </div>
        )}
      </div>

      {/* Parent Pays Basis is ultimately the PROVIDER's decision (part of
          their onboarding), but it stays fully editable here too - the admin
          can fill it in when the answer is already known. It is only REQUIRED
          on the provider side; the admin can save the fee economics alone. */}
      <div className="rounded-lg border p-4 space-y-3 bg-card">
        <Label>
          Parent Pays Basis
          {!isProviderMode && <span className="t-helper ml-2 font-normal">(the provider's call - optional here, they set it during onboarding)</span>}
        </Label>
        <div className="space-y-2">
          {/* Total Quoted Cost option */}
          <label
            className="flex items-center gap-2 text-sm cursor-pointer"
          >
            <input
              type="radio"
              name={`parentPaysBasis-${serviceType}`}
              value="TOTAL_COST"
              checked={parentPaysBasis === "TOTAL_COST"}
              onChange={() => setParentPaysBasis("TOTAL_COST")}
              className="accent-primary"
            />
            Total Quoted Cost
          </label>

          {/* Default First Payment option + inline amount */}
          <label
            className="flex items-start gap-2 text-sm cursor-pointer"
          >
            <input
              type="radio"
              name={`parentPaysBasis-${serviceType}`}
              value="DEFAULT_FIRST_PAYMENT"
              checked={parentPaysBasis === "DEFAULT_FIRST_PAYMENT"}
              onChange={() => setParentPaysBasis("DEFAULT_FIRST_PAYMENT")}
              className="accent-primary mt-1"
            />
            <div className="flex-1 space-y-2">
              <span>Default First Payment ($)</span>
              {parentPaysBasis === "DEFAULT_FIRST_PAYMENT" && (
                <div className="space-y-1.5 max-w-md">
                  <NumberInput
                    placeholder="e.g. 10,000"
                    value={defaultServiceAmount}
                    onChange={setDefaultServiceAmount}
                    required={isProviderMode}
                    aria-invalid={defaultFirstPaymentMissing}
                  />
                  <p className="t-helper">
                    The standard amount collected from the parent. Pre-fills the invoice - admin or agency can override per invoice.
                  </p>
                  {defaultFirstPaymentMissing && (
                    <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>
                      Default First Payment amount is required when this option is selected.
                    </p>
                  )}
                </div>
              )}
            </div>
          </label>
        </div>
        <p className="t-helper">
          {parentPaysBasis === "TOTAL_COST"
            ? "Each invoice charges the parent the full Total Quoted Cost from the provider's cost sheet."
            : "Each invoice charges the parent the Default First Payment above. The provider can still send a cost sheet that drives the GoStork % calculation."}
        </p>
      </div>

      {/* Sample Total Quoted Cost (drives preview when basis = TOTAL_COST or
          fee = PERCENTAGE). The input and its live preview share one white
          card - they are a single what-if tool, not two loose blocks. */}
      <div className="rounded-lg border bg-card p-4 space-y-4 max-w-md">
      <div className="space-y-1.5">
        <Label>Sample Total Quoted Cost ($) <span className="text-muted-foreground font-normal">(preview only)</span></Label>
        <NumberInput
          placeholder="e.g. 25,000"
          value={sampleTotalCost}
          onChange={setSampleTotalCost}
        />
        <p className="t-helper">
          Pretend the provider quoted this total - the preview below shows the resulting invoice split for this service.
        </p>
      </div>

      {/* Live split preview */}
      {showPreview && (
        <div className="rounded-lg border p-4 space-y-2 bg-secondary/40">
          <p className="t-micro-label">Payment Split Preview</p>
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
          <p className="t-helper pt-1">
            Parent-pays basis: {parentPaysBasis === "TOTAL_COST" ? "Total Quoted Cost" : "Default First Payment"}
          </p>
        </div>
      )}
      </div>

      {/* Surrogacy-specific settings */}
      {showSurrogacyExtras && (
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div>
            <h4 className="text-sm font-medium">Surrogacy Deposit Trigger</h4>
            <p className="t-helper mt-0.5">When should GoStork request the parent's deposit?</p>
          </div>
          <div className="space-y-2">
            {[
              { value: "AT_MATCH", label: "Immediately after Match Call", desc: "Parent pays deposit within 24h of the match call. Standard flow." },
              { value: "AT_CLEARANCE", label: "After medical clearance (AI Escrow)", desc: "Card is authorized (held) after the match call, but only charged after the surrogate passes medical screening. Best for agencies whose surrogates require clearance before commitment." },
            ].map(opt => (
              <label
                key={opt.value}
                className="flex gap-3 cursor-pointer rounded-lg border px-4 py-3 transition-colors bg-card"
                style={{
                  borderColor: depositMilestone === opt.value ? "hsl(var(--primary))" : "hsl(var(--border))",
                  background: depositMilestone === opt.value ? "hsl(var(--primary) / 0.05)" : "transparent",
                }}
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
                  <p className="t-helper mt-0.5">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>

          {depositMilestone === "AT_CLEARANCE" && (
            <div className="space-y-1.5">
              <Label>Average Days to Medical Clearance</Label>
              <NumberInput
                allowDecimal={false}
                value={averageClearanceDays}
                onChange={setAverageClearanceDays}
                placeholder="21"
              />
              <p className="t-helper">
                Used to schedule AI check-in messages. GoStork will reach out to the parent around days{" "}
                {Math.max(1, parseInt(averageClearanceDays || "21") - 7)}, {averageClearanceDays}, and{" "}
                {parseInt(averageClearanceDays || "21") + 7}.
              </p>
            </div>
          )}
        </div>
      )}

      {saveMutation.isError && (
        <p className="text-sm" style={{ color: "hsl(var(--brand-error))" }}>
          {(saveMutation.error as Error).message}
        </p>
      )}
      {saveMutation.isSuccess && (
        <p className="text-sm" style={{ color: "hsl(var(--brand-success))" }}>
          {LINE_SERVICE_LABELS[serviceType]} fee configuration saved
        </p>
      )}

      <SaveBar
        visible={isDirty}
        position="fixed"
        testId={`referral-fee-save-bar-${serviceType.toLowerCase()}`}
        discardLabel="Discard"
        saveLabel={`Save ${LINE_SERVICE_LABELS[serviceType]} Configuration`}
        saving={saveMutation.isPending}
        saveDisabled={defaultFirstPaymentMissing}
        onDiscard={discard}
        onSave={() => saveMutation.mutate()}
      />
    </section>
  );
}
