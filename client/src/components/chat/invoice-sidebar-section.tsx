import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DollarSign, Loader2, Send, ChevronDown, ChevronUp, AlertCircle, X, Plus, Trash2 } from "lucide-react";

// Line-item editor types - mirrors the server enum.
type LineServiceType = "SURROGACY" | "EGG_DONATION" | "SPERM_DONATION" | "IVF_CLINIC" | "OTHER";
interface LineItemDraft {
  // Stable per-row key so React keeps focus when the array reorders.
  key: string;
  serviceType: LineServiceType;
  description: string;
  amountInput: string; // dollars as the user types, parsed on send
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

interface InvoiceSidebarSectionProps {
  sessionId: string | null;
  brandColor: string;
  readOnly?: boolean;
  sessionQueryKey?: string;
  /** When true, render in inline-above-composer mode (form always open, X to close). */
  embedded?: boolean;
  onClose?: () => void;
}

interface PreviewResponse {
  feeType: "FLAT" | "PERCENTAGE";
  percentage: number | null;
  flatAmount: number | null;
  parentPaysBasis: "DEFAULT_FIRST_PAYMENT" | "TOTAL_COST";
  currency: string;
  feeBasisCents: number;
  parentPaysCents: number;
  referralFeeAmount: number;
  providerPayoutAmount: number;
}

interface ProviderQuoteRow {
  id: string;
  totalCostCents: number;
  supersededAt: string | null;
  createdAt: string;
}

function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
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

  const updateLine = (key: string, patch: Partial<LineItemDraft>) => {
    setLineItems(prev => prev.map(li => (li.key === key ? { ...li, ...patch } : li)));
  };
  const removeLine = (key: string) => {
    setLineItems(prev => (prev.length === 1 ? prev : prev.filter(li => li.key !== key)));
  };
  const addLine = () => {
    setLineItems(prev => [...prev, newLine("SURROGACY")]);
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
  }, [sessionId, activeQuote?.id, activeQuote?.totalCostCents, overrideInput, defaultPrefilled, totalLineCents]);

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
                {lineItems.map((li, idx) => (
                  <div
                    key={li.key}
                    className="rounded-md border bg-background p-2 space-y-1.5"
                  >
                    <div className="flex items-center gap-1.5">
                      <select
                        value={li.serviceType}
                        onChange={e => updateLine(li.key, { serviceType: e.target.value as LineServiceType })}
                        className="flex-1 h-8 text-xs rounded border bg-background px-2"
                        data-testid={`line-${idx}-type`}
                      >
                        {(Object.keys(LINE_TYPE_LABELS) as LineServiceType[]).map(k => (
                          <option key={k} value={k}>{LINE_TYPE_LABELS[k]}</option>
                        ))}
                      </select>
                      <div className="relative w-28">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                        <Input
                          type="number"
                          min="0"
                          step="100"
                          inputMode="decimal"
                          placeholder="0"
                          value={li.amountInput}
                          onChange={e => updateLine(li.key, { amountInput: e.target.value })}
                          className="h-8 text-xs pl-5"
                          data-testid={`line-${idx}-amount`}
                        />
                      </div>
                      {lineItems.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeLine(li.key)}
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          aria-label="Remove line"
                          data-testid={`line-${idx}-remove`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                    <Input
                      placeholder="Description (optional)"
                      value={li.description}
                      onChange={e => updateLine(li.key, { description: e.target.value })}
                      className="h-8 text-xs"
                      data-testid={`line-${idx}-description`}
                    />
                  </div>
                ))}
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
                  <div className="flex justify-between" style={{ color: "hsl(var(--brand-success))" }}>
                    <span>GoStork keeps ({preview.feeType === "PERCENTAGE" ? `${preview.percentage}%` : "flat"})</span>
                    <span className="font-semibold">{formatCents(preview.referralFeeAmount, preview.currency)}</span>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <span>You receive</span>
                    <span>{formatCents(preview.providerPayoutAmount, preview.currency)}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {error && <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{error}</p>}

          <Button
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !activeQuote || !hasUsableLines}
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
