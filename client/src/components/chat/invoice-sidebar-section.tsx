import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DollarSign, Loader2, Send, ChevronDown, ChevronUp, AlertCircle, X, Plus, Trash2 } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

/**
 * Render an error string with the literal "Billing tab" replaced by a Link
 * to the provider Billing page. Server-generated billing errors use the
 * phrase "in the Billing tab" - turning that into a one-click jump removes
 * a step the agency would otherwise have to do manually.
 */
function BillingLinkedMessage({ text }: { text: string }) {
  if (!/Billing tab/i.test(text)) return <>{text}</>;
  const parts = text.split(/(Billing tab)/i);
  return (
    <>
      {parts.map((part, i) =>
        /^Billing tab$/i.test(part) ? (
          <Link
            key={i}
            to="/account/billing"
            className="underline underline-offset-2 font-semibold hover:opacity-80"
            style={{ color: "hsl(var(--primary))" }}
            data-testid="link-billing-tab"
          >
            {part}
          </Link>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// Line-item editor types - mirrors the server enum.
type LineServiceType = "SURROGACY" | "EGG_DONATION" | "SPERM_DONATION" | "IVF_CLINIC" | "OTHER";
interface LineItemDraft {
  // Stable per-row key so React keeps focus when the array reorders.
  key: string;
  serviceType: LineServiceType;
  description: string;
  // Amount per line is derived (not user-editable) from the provider's
  // configured Default First Payment for the chosen service. Stored here
  // as a dollar string so the existing preview/send code keeps working.
  amountInput: string;
}
const LINE_TYPE_LABELS: Record<LineServiceType, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
  OTHER: "Other",
};
let lineKeyCounter = 0;
function newLine(serviceType: LineServiceType = "SURROGACY"): LineItemDraft {
  return { key: `line-${++lineKeyCounter}`, serviceType, description: "", amountInput: "" };
}

interface ProviderFeeConfig {
  serviceType: LineServiceType;
  defaultServiceAmount: number | null; // cents
}
interface ProviderEnabledService {
  serviceType: LineServiceType;
  providerTypeName: string;
}
interface ProviderFeeConfigsResponse {
  configs: ProviderFeeConfig[];
  // Services the provider is enabled to offer (APPROVED ProviderService rows).
  // The dropdown should show every entry here regardless of whether a
  // ReferralFeeConfig has been set - unconfigured services surface a
  // "contact GoStork admin" warning instead of being hidden.
  services: ProviderEnabledService[];
}

interface InvoiceSidebarSectionProps {
  sessionId: string | null;
  brandColor: string;
  readOnly?: boolean;
  sessionQueryKey?: string;
  /** When true, render in inline-above-composer mode (form always open, X to close). */
  embedded?: boolean;
  onClose?: () => void;
}

interface PreviewLine {
  serviceType: string;
  serviceTypeLabel: string;
  amountCents: number;
  referralFeeAmount: number;
  providerPayoutAmount: number;
  feeType: "FLAT" | "PERCENTAGE";
  percentage: number | null;
  flatAmount: number | null;
}
interface PreviewResponse {
  // Single-service legacy shape
  multiService?: boolean;
  feeType?: "FLAT" | "PERCENTAGE";
  percentage?: number | null;
  flatAmount?: number | null;
  parentPaysBasis?: "DEFAULT_FIRST_PAYMENT" | "TOTAL_COST";
  currency: string;
  feeBasisCents: number;
  parentPaysCents: number;
  referralFeeAmount: number;
  providerPayoutAmount: number;
  // Multi-service shape (when lineItems passed)
  lines?: PreviewLine[];
}

interface ProviderQuoteRow {
  id: string;
  totalCostCents: number;
  supersededAt: string | null;
  createdAt: string;
}

export function InvoiceSidebarSection({
  sessionId,
  brandColor,
  readOnly = false,
  sessionQueryKey,
  embedded = false,
  onClose,
}: InvoiceSidebarSectionProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(embedded);
  const [overrideInput, setOverrideInput] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the override field has been seeded with the default basis
  // amount from billing settings. Once seeded, the user's edits take over.
  const [defaultPrefilled, setDefaultPrefilled] = useState(false);
  // Itemized lines. Agency starts with one row; can add/remove. When any line
  // has a positive amount, the invoice is sent as itemized and the "Parent
  // Pays" override is ignored. Empty lines (no amount) are filtered out.
  const [lineItems, setLineItems] = useState<LineItemDraft[]>(() => [newLine("SURROGACY")]);

  const totalLineCents = lineItems.reduce((sum, li) => {
    const v = parseFloat(li.amountInput);
    return Number.isFinite(v) && v > 0 ? sum + Math.round(v * 100) : sum;
  }, 0);
  const hasUsableLines = lineItems.some(li => parseFloat(li.amountInput) > 0);
  // Send is blocked when any line item targets a service the provider hasn't
  // configured a ReferralFeeConfig for - the server would 400 anyway, and the
  // agency would lose the rest of their itemization on the error round-trip.

  // Provider fee configs - used to auto-fill each line's Default First Payment
  // when the agency picks a service type. The agency can still override the
  // amount manually; once they do, switching the service type no longer
  // overwrites their value.
  const { data: feeConfigsData } = useQuery<ProviderFeeConfigsResponse>({
    queryKey: ["/api/provider/fee-configs"],
    queryFn: async () => {
      const res = await fetch("/api/provider/fee-configs", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load provider fee configs");
      return res.json();
    },
  });
  const defaultDollarsForService = (st: LineServiceType): string => {
    const cfg = feeConfigsData?.configs.find(c => c.serviceType === st);
    const cents = cfg?.defaultServiceAmount ?? null;
    if (!cents || cents <= 0) return "";
    const dollars = cents / 100;
    return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
  };

  // Service types the agency is enabled to offer (APPROVED ProviderService
  // rows). The dropdown lists exactly these - a service the provider doesn't
  // offer is never an option. A service that's enabled but has no
  // ReferralFeeConfig yet IS still shown, but surfaces a "contact GoStork
  // admin" warning when picked (server would 400 on send otherwise).
  const enabledServiceTypes: LineServiceType[] = feeConfigsData?.services
    ? feeConfigsData.services
        .map(s => s.serviceType)
        .filter((st): st is LineServiceType => st in LINE_TYPE_LABELS)
    : (Object.keys(LINE_TYPE_LABELS) as LineServiceType[]);
  const enabledKey = enabledServiceTypes.join("|");
  const configuredServiceSet = new Set<LineServiceType>(
    feeConfigsData?.configs.map(c => c.serviceType).filter(
      (st): st is LineServiceType => st in LINE_TYPE_LABELS,
    ) ?? [],
  );
  const isServiceConfigured = (st: LineServiceType) => configuredServiceSet.has(st);

  // If configs load AFTER the initial line was mounted (or admin removes a
  // service), snap any line whose serviceType is no longer enabled onto the
  // first enabled type so the dropdown stays consistent.
  useEffect(() => {
    if (!feeConfigsData || enabledServiceTypes.length === 0) return;
    const enabledSet = new Set(enabledServiceTypes);
    setLineItems(prev => {
      let changed = false;
      const next = prev.map(li => {
        if (enabledSet.has(li.serviceType)) return li;
        changed = true;
        const nextType = enabledServiceTypes[0];
        return { ...li, serviceType: nextType, amountInput: defaultDollarsForService(nextType) };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledKey, feeConfigsData]);

  // Whenever the fee configs change, refresh every line's amount from its
  // service's Default First Payment. The amount is not user-editable - if
  // the agency wants a different value they have to update billing settings.
  useEffect(() => {
    if (!feeConfigsData) return;
    setLineItems(prev =>
      prev.map(li => ({ ...li, amountInput: defaultDollarsForService(li.serviceType) })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feeConfigsData]);

  const updateLine = (key: string, patch: Partial<LineItemDraft>) => {
    setLineItems(prev => prev.map(li => (li.key === key ? { ...li, ...patch } : li)));
  };
  const onLineServiceChange = (key: string, serviceType: LineServiceType) => {
    setLineItems(prev =>
      prev.map(li =>
        li.key === key
          ? { ...li, serviceType, amountInput: defaultDollarsForService(serviceType) }
          : li,
      ),
    );
  };
  const removeLine = (key: string) => {
    setLineItems(prev => (prev.length === 1 ? prev : prev.filter(li => li.key !== key)));
  };
  const addLine = () => {
    setLineItems(prev => {
      const seedType = enabledServiceTypes[0] ?? "SURROGACY";
      const next = newLine(seedType);
      next.amountInput = defaultDollarsForService(seedType);
      return [...prev, next];
    });
  };

  // Latest active quote (used to drive the preview).
  const { data: quotesData } = useQuery<{ quotes: ProviderQuoteRow[] }>({
    queryKey: ["/api/sessions/cost-sheets", sessionId],
    queryFn: async () => {
      if (!sessionId) return { quotes: [] };
      const res = await fetch(`/api/sessions/${sessionId}/cost-sheets`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: !!sessionId,
  });
  const activeQuote = quotesData?.quotes?.find(q => !q.supersededAt) || null;

  // Preview based on either the active quote's total or the manual override.
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !activeQuote) {
      setPreview(null);
      return;
    }
    // When the agency has typed real line items, drive the preview from the
    // line-items sum (acts as parentPaysOverride) so GoStork's fee is
    // computed against what the agency is actually billing. Otherwise fall
    // back to the old override-input behavior so the form still shows a
    // sensible preview before any line is filled in.
    const overrideCents = totalLineCents > 0
      ? totalLineCents
      : overrideInput
        ? Math.round(parseFloat(overrideInput) * 100)
        : undefined;
    // When the agency has typed real line items with positive amounts, send
    // them to the preview so each line is priced against its own service's
    // ReferralFeeConfig (mirroring how createInvoice computes the real fee).
    const previewLines = totalLineCents > 0
      ? lineItems
          .filter(li => parseFloat(li.amountInput) > 0)
          .map(li => ({
            serviceType: li.serviceType,
            amountCents: Math.round(parseFloat(li.amountInput) * 100),
          }))
      : undefined;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/billing/invoice-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            sessionId,
            totalCostCents: activeQuote.totalCostCents,
            parentPaysOverrideCents: overrideCents,
            ...(previewLines ? { lineItems: previewLines } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setPreview(null);
          setPreviewError(data?.message || "Preview failed");
        } else {
          setPreview(data);
          setPreviewError(null);
          // First preview load (no override yet) - seed the input with the
          // basis-derived parent-pays amount from billing settings so the
          // agency sees what the parent will be charged by default. They
          // can still edit it to override.
          if (!defaultPrefilled && !overrideInput && data?.parentPaysCents) {
            const dollars = data.parentPaysCents / 100;
            const formatted = Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
            setOverrideInput(formatted);
            setDefaultPrefilled(true);
          }
        }
      } catch (err: any) {
        setPreviewError(err?.message || "Preview failed");
      }
    }, 350);
    return () => clearTimeout(t);
  }, [
    sessionId,
    activeQuote?.id,
    activeQuote?.totalCostCents,
    overrideInput,
    defaultPrefilled,
    totalLineCents,
    // Re-run when the service-type of any line changes so multi-service
    // previews update without waiting on an amount change.
    lineItems.map(li => `${li.serviceType}:${li.amountInput}`).join("|"),
  ]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No session");
      const body: any = {};

      // Itemized path: collect non-empty lines, validate, and send them. The
      // server sums them to derive the parent-pays amount; the override is
      // ignored when line items are present.
      const cleanedLines = lineItems
        .map(li => {
          const v = parseFloat(li.amountInput);
          if (!Number.isFinite(v) || v <= 0) return null;
          return {
            serviceType: li.serviceType,
            description: li.description.trim() || null,
            amountCents: Math.round(v * 100),
          };
        })
        .filter(Boolean) as Array<{ serviceType: string; description: string | null; amountCents: number }>;
      if (cleanedLines.length === 0) {
        throw new Error("Add at least one line item with a positive amount");
      }
      body.lineItems = cleanedLines;
      if (description.trim()) body.description = description.trim();

      const res = await fetch(`/api/sessions/${sessionId}/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to send invoice");
      return data;
    },
    onSuccess: () => {
      setOverrideInput("");
      setDescription("");
      setLineItems([newLine("SURROGACY")]);
      setError(null);
      setExpanded(false);
      if (sessionQueryKey && sessionId) {
        queryClient.invalidateQueries({ queryKey: [sessionQueryKey, sessionId] });
      }
      if (embedded) onClose?.();
    },
    onError: (err: any) => setError(err?.message || "Send failed"),
  });

  const disabled = readOnly || !sessionId;
  const blockedReason = previewError;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4" style={{ color: brandColor }} />
          <h3 className="text-sm font-semibold">Invoice</h3>
        </div>
        {!disabled && !embedded && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(e => !e)}
            className="h-7 px-2 text-xs"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3.5 h-3.5 mr-1" /> Hide
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5 mr-1" /> Send Invoice
              </>
            )}
          </Button>
        )}
        {embedded && onClose && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0 shrink-0"
            aria-label="Close"
            data-testid="btn-close-invoice"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {expanded && !disabled && (
        <div className="rounded-lg border p-3 space-y-3" style={{ background: "hsl(var(--muted) / 0.4)" }}>
          {!activeQuote && (
            <div
              className="rounded-md border p-2.5 text-xs flex items-start gap-2"
              style={{ background: "hsl(var(--background))", borderColor: "hsl(var(--brand-warning) / 0.4)" }}
            >
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-warning))" }} />
              <span>
                No cost sheet has been sent yet. Send a cost sheet first - the invoice math depends on the quoted total.
              </span>
            </div>
          )}

          {activeQuote && (
            <div className="text-xs text-muted-foreground">
              Active quote: <span className="font-medium text-foreground">{formatCents(activeQuote.totalCostCents)}</span>
            </div>
          )}

          {activeQuote && (
            <div className="space-y-2">
              <label className="text-xs font-medium block">Line items</label>
              <div className="space-y-2">
                {lineItems.map((li, idx) => {
                  const configured = isServiceConfigured(li.serviceType);
                  return (
                  <div
                    key={li.key}
                    className="rounded-md border bg-background p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <select
                        value={li.serviceType}
                        onChange={e => onLineServiceChange(li.key, e.target.value as LineServiceType)}
                        className="h-8 text-xs rounded border bg-background px-2 w-36 shrink-0"
                        data-testid={`line-${idx}-type`}
                      >
                        {enabledServiceTypes.map(k => (
                          <option key={k} value={k}>{LINE_TYPE_LABELS[k]}</option>
                        ))}
                      </select>
                      <Input
                        placeholder="Description (optional)"
                        value={li.description}
                        onChange={e => updateLine(li.key, { description: e.target.value })}
                        className="h-8 text-xs flex-1 min-w-0"
                        data-testid={`line-${idx}-description`}
                      />
                      {/* Amount is read-only - sourced from the provider's
                          Default First Payment for this service. To change,
                          update the Billing settings for the service. */}
                      <div
                        className="h-8 w-28 shrink-0 flex items-center justify-end rounded border bg-muted/40 px-2 text-xs font-medium tabular-nums"
                        title="Set by Default First Payment in Billing settings - not editable per invoice"
                        data-testid={`line-${idx}-amount`}
                      >
                        {parseFloat(li.amountInput) > 0
                          ? formatCents(Math.round(parseFloat(li.amountInput) * 100))
                          : <span className="text-muted-foreground font-normal">No default</span>}
                      </div>
                      {lineItems.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeLine(li.key)}
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                          aria-label="Remove line"
                          data-testid={`line-${idx}-remove`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                    {!configured && (
                      <p
                        className="text-[11px] mt-1.5 flex items-start gap-1"
                        style={{ color: "hsl(var(--brand-warning))" }}
                        data-testid={`line-${idx}-unconfigured-warning`}
                      >
                        <AlertCircle className="w-3 h-3 mt-px shrink-0" />
                        <span>
                          {LINE_TYPE_LABELS[li.serviceType]} has no Referral Fee Configuration yet.
                          Contact your GoStork admin to configure it before sending this invoice.
                        </span>
                      </p>
                    )}
                  </div>
                  );
                })}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addLine}
                className="h-7 px-2 text-xs gap-1"
                style={{ color: brandColor }}
                data-testid="btn-add-line-item"
              >
                <Plus className="w-3.5 h-3.5" />
                Add line item
              </Button>
            </div>
          )}

          {/* Invoice preview - itemized lines, sub-total, GoStork fee, total */}
          {activeQuote && hasUsableLines && (
            <div className="rounded-md border p-2.5 text-xs space-y-1" style={{ background: "hsl(var(--background))" }}>
              <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">Invoice Preview</p>
              {lineItems
                .filter(li => parseFloat(li.amountInput) > 0)
                .map((li, idx) => (
                  <div key={li.key} className="flex justify-between gap-2">
                    <span className="truncate">
                      {LINE_TYPE_LABELS[li.serviceType]}
                      {li.description.trim() ? ` - ${li.description.trim()}` : ""}
                    </span>
                    <span className="font-medium shrink-0">
                      {formatCents(Math.round(parseFloat(li.amountInput) * 100))}
                    </span>
                  </div>
                ))}
              <div className="flex justify-between border-t pt-1 font-semibold">
                <span>Parent pays (total)</span>
                <span>{formatCents(totalLineCents)}</span>
              </div>
              {preview && (
                <>
                  {preview.lines && preview.lines.length > 0 ? (
                    // Multi-service preview: break out GoStork's fee per line so
                    // the agency sees which line drove which fee.
                    preview.lines.map((ln, idx) => (
                      <div
                        key={`${ln.serviceType}-${idx}`}
                        className="flex justify-between pl-3"
                        style={{ color: "hsl(var(--brand-success))" }}
                      >
                        <span>
                          GoStork keeps - {ln.serviceTypeLabel} ({ln.feeType === "PERCENTAGE" ? `${ln.percentage}%` : "flat"})
                        </span>
                        <span className="font-semibold">{formatCents(ln.referralFeeAmount, preview.currency)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="flex justify-between" style={{ color: "hsl(var(--brand-success))" }}>
                      <span>GoStork keeps ({preview.feeType === "PERCENTAGE" ? `${preview.percentage}%` : "flat"})</span>
                      <span className="font-semibold">{formatCents(preview.referralFeeAmount, preview.currency)}</span>
                    </div>
                  )}
                  {preview.lines && preview.lines.length > 1 && (
                    <div className="flex justify-between border-t pt-1" style={{ color: "hsl(var(--brand-success))" }}>
                      <span>GoStork keeps (total)</span>
                      <span className="font-semibold">{formatCents(preview.referralFeeAmount, preview.currency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold">
                    <span>You receive</span>
                    <span>{formatCents(preview.providerPayoutAmount, preview.currency)}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Preview error banner - shows when the server rejects the live
              fee preview so the agency knows WHY the breakdown disappeared
              instead of just seeing an empty preview. Most common cause:
              admin hasn't added a ReferralFeeConfig for one of the picked
              services. */}
          {activeQuote && hasUsableLines && previewError && (
            <div
              className="rounded-md border p-2.5 text-xs flex items-start gap-2"
              style={{ background: "hsl(var(--background))", borderColor: "hsl(var(--brand-error) / 0.4)", color: "hsl(var(--brand-error))" }}
              data-testid="invoice-preview-error"
            >
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span><BillingLinkedMessage text={previewError} /></span>
            </div>
          )}

          {error && (
            <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>
              <BillingLinkedMessage text={error} />
            </p>
          )}

          <Button
            onClick={() => sendMutation.mutate()}
            disabled={
              sendMutation.isPending ||
              !activeQuote ||
              !hasUsableLines ||
              !!previewError ||
              lineItems.some(li => !isServiceConfigured(li.serviceType))
            }
            className="w-full"
            style={{ background: brandColor, color: "white", borderRadius: "var(--radius)" }}
          >
            {sendMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5 mr-2" />
            )}
            Send Invoice to Parent
          </Button>
        </div>
      )}
    </div>
  );
}
