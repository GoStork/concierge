import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DollarSign, Loader2, Send, ChevronDown, ChevronUp, AlertCircle } from "lucide-react";

interface InvoiceSidebarSectionProps {
  sessionId: string | null;
  brandColor: string;
  readOnly?: boolean;
  sessionQueryKey?: string;
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
}: InvoiceSidebarSectionProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [overrideInput, setOverrideInput] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    const overrideCents = overrideInput ? Math.round(parseFloat(overrideInput) * 100) : undefined;
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
        }
      } catch (err: any) {
        setPreviewError(err?.message || "Preview failed");
      }
    }, 350);
    return () => clearTimeout(t);
  }, [sessionId, activeQuote?.id, activeQuote?.totalCostCents, overrideInput]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No session");
      const body: any = {};
      if (overrideInput) {
        const cents = Math.round(parseFloat(overrideInput) * 100);
        if (!Number.isFinite(cents) || cents <= 0) throw new Error("Enter a valid override amount");
        body.parentPaysOverrideCents = cents;
      }
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
      setError(null);
      setExpanded(false);
      if (sessionQueryKey && sessionId) {
        queryClient.invalidateQueries({ queryKey: [sessionQueryKey, sessionId] });
      }
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
        {!disabled && (
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
            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                Override Parent-Pays ($) <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                type="number"
                min="0"
                step="100"
                placeholder="leave blank to use the basis from billing settings"
                value={overrideInput}
                onChange={e => setOverrideInput(e.target.value)}
              />
            </div>
          )}

          {activeQuote && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Description (optional)</label>
              <Input
                placeholder="e.g. First milestone deposit"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </div>
          )}

          {/* Preview */}
          {preview && !blockedReason && (
            <div className="rounded-md border p-2.5 text-xs space-y-1" style={{ background: "hsl(var(--background))" }}>
              <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">Invoice Preview</p>
              <div className="flex justify-between">
                <span>Parent pays</span>
                <span className="font-semibold">{formatCents(preview.parentPaysCents, preview.currency)}</span>
              </div>
              <div className="flex justify-between" style={{ color: "hsl(var(--brand-success))" }}>
                <span>GoStork keeps ({preview.feeType === "PERCENTAGE" ? `${preview.percentage}%` : "flat"})</span>
                <span className="font-semibold">{formatCents(preview.referralFeeAmount, preview.currency)}</span>
              </div>
              <div className="flex justify-between border-t pt-1 font-semibold">
                <span>You receive</span>
                <span>{formatCents(preview.providerPayoutAmount, preview.currency)}</span>
              </div>
            </div>
          )}

          {error && <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{error}</p>}

          <Button
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !activeQuote}
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
