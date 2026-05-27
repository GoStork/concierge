import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Receipt, Loader2, Paperclip, Send, ChevronDown, ChevronUp, X } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

interface CostSheetSidebarSectionProps {
  sessionId: string | null;
  brandColor: string;
  readOnly?: boolean;
  /** Query key to invalidate after sending so the session detail refreshes. */
  sessionQueryKey?: string;
  /**
   * When true, render in "form-only" mode for inline use above the chat
   * composer: no collapse toggle, form always open, X button calls onClose.
   * History is hidden (the chat already shows sent cost sheets).
   */
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
  costSheetFileUrl: string | null;
  costSheetFileName: string | null;
  notes: string | null;
  source: string;
  supersededAt: string | null;
  createdAt: string;
}

export function CostSheetSidebarSection({
  sessionId,
  brandColor,
  readOnly = false,
  sessionQueryKey,
  embedded = false,
  onClose,
}: CostSheetSidebarSectionProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(embedded);
  const [totalCostInput, setTotalCostInput] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Load history of past quotes for this session.
  const { data: quotesData } = useQuery<{ quotes: ProviderQuoteRow[] }>({
    queryKey: ["/api/sessions/cost-sheets", sessionId],
    queryFn: async () => {
      if (!sessionId) return { quotes: [] };
      const res = await fetch(`/api/sessions/${sessionId}/cost-sheets`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cost sheets");
      return res.json();
    },
    enabled: !!sessionId,
  });
  const quotes = quotesData?.quotes || [];

  // Debounced live preview as the provider types a total cost.
  useEffect(() => {
    if (!sessionId) return;
    const cents = Math.round(parseFloat(totalCostInput) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await fetch("/api/billing/invoice-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ sessionId, totalCostCents: cents }),
        });
        const data = await res.json();
        if (!res.ok) {
          setPreview(null);
          setPreviewError(data?.message || "Preview failed");
        } else {
          setPreview(data);
        }
      } catch (err: any) {
        setPreviewError(err?.message || "Preview failed");
      } finally {
        setPreviewLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [totalCostInput, sessionId]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No session");
      const cents = Math.round(parseFloat(totalCostInput) * 100);
      if (!Number.isFinite(cents) || cents <= 0) throw new Error("Enter a valid total cost");

      const form = new FormData();
      form.append("totalCostCents", String(cents));
      if (notes.trim()) form.append("notes", notes.trim());
      if (file) form.append("file", file);

      const res = await fetch(`/api/sessions/${sessionId}/cost-sheet`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to send cost sheet");
      return data;
    },
    onSuccess: () => {
      setTotalCostInput("");
      setNotes("");
      setFile(null);
      setError(null);
      setExpanded(false);
      queryClient.invalidateQueries({ queryKey: ["/api/sessions/cost-sheets", sessionId] });
      if (sessionQueryKey && sessionId) {
        queryClient.invalidateQueries({ queryKey: [sessionQueryKey, sessionId] });
      }
      if (embedded) onClose?.();
    },
    onError: (err: any) => setError(err?.message || "Send failed"),
  });

  const disabled = readOnly || !sessionId;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="w-4 h-4" style={{ color: brandColor }} />
          <h3 className="text-sm font-semibold">{embedded ? "Send Cost Sheet" : "Cost Sheets"}</h3>
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
                <ChevronDown className="w-3.5 h-3.5 mr-1" /> Send Cost Sheet
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
            data-testid="btn-close-cost-sheet"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      {/* Send form */}
      {expanded && !disabled && (
        <div
          className="rounded-lg border p-3 space-y-3"
          style={{ background: "hsl(var(--muted) / 0.4)" }}
        >
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Total Cost ($)</label>
            <Input
              type="number"
              min="0"
              step="50"
              placeholder="e.g. 25000"
              value={totalCostInput}
              onChange={e => setTotalCostInput(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Cost Sheet File (optional)</label>
            <div className="flex items-center gap-2">
              <Input
                type="file"
                accept=".pdf,.csv,.txt,.docx,.xlsx,.png,.jpg,.jpeg"
                onChange={e => setFile(e.target.files?.[0] || null)}
                className="text-xs file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
              />
              {file && <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Notes (optional)</label>
            <Textarea
              placeholder="Any context the parent should know..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              className="text-sm"
            />
          </div>

          {/* Live invoice preview */}
          {(preview || previewLoading || previewError) && (
            <div className="rounded-md border p-2.5 text-xs space-y-1" style={{ background: "hsl(var(--background))" }}>
              <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">
                Future Invoice Preview
              </p>
              {previewLoading && <p className="text-muted-foreground">Calculating...</p>}
              {previewError && <p style={{ color: "hsl(var(--brand-error))" }}>{previewError}</p>}
              {preview && !previewError && (
                <>
                  <div className="flex justify-between">
                    <span>Parent pays</span>
                    <span className="font-semibold">{formatCents(preview.parentPaysCents, preview.currency)}</span>
                  </div>
                  <div className="flex justify-between" style={{ color: "hsl(var(--brand-success))" }}>
                    <span>
                      GoStork keeps ({preview.feeType === "PERCENTAGE" ? `${preview.percentage}%` : "flat"})
                    </span>
                    <span className="font-semibold">{formatCents(preview.referralFeeAmount, preview.currency)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-1 font-semibold">
                    <span>You receive</span>
                    <span>{formatCents(preview.providerPayoutAmount, preview.currency)}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground pt-1">
                    Parent-pays basis: {preview.parentPaysBasis === "TOTAL_COST" ? "Total Quoted Cost" : "Default First Payment"}
                  </p>
                </>
              )}
            </div>
          )}

          {error && <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{error}</p>}

          <Button
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !parseFloat(totalCostInput)}
            className="w-full"
            style={{ background: brandColor, color: "white", borderRadius: "var(--radius)" }}
          >
            {sendMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5 mr-2" />
            )}
            Send to Parent
          </Button>
        </div>
      )}

      {/* History - hidden in embedded mode (chat already shows sent cost sheets) */}
      {!embedded && quotes.length > 0 && (
        <div className="space-y-1.5">
          {quotes.map(q => (
            <div
              key={q.id}
              className="rounded-md border p-2 text-xs space-y-0.5"
              style={{
                background: q.supersededAt ? "hsl(var(--muted) / 0.3)" : "hsl(var(--background))",
                opacity: q.supersededAt ? 0.7 : 1,
              }}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{formatCents(q.totalCostCents)}</span>
                {q.supersededAt ? (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Superseded</span>
                ) : (
                  <span
                    className="text-[10px] uppercase tracking-wide font-medium"
                    style={{ color: "hsl(var(--brand-success))" }}
                  >
                    Current
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>{new Date(q.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                {q.costSheetFileUrl && sessionId && (
                  <a
                    href={`/api/sessions/${sessionId}/cost-sheets/${q.id}/file`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline flex items-center gap-1"
                  >
                    <Paperclip className="w-3 h-3" /> {q.costSheetFileName || "File"}
                  </a>
                )}
              </div>
              {q.notes && <p className="text-muted-foreground italic">{q.notes}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
