import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Receipt, Loader2, Paperclip, Send, ChevronDown, ChevronUp, X, Plus, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  /**
   * Session subject info, used to auto-prefill Total Cost from the linked
   * donor's per-vial price (sperm donor) or per-egg-lot price (egg bank).
   * Only applies in embedded mode.
   */
  subjectType?: string | null;
  subjectProfileId?: string | null;
  providerId?: string | null;
  /**
   * When the provider opens this panel from an existing cost-sheet card in
   * the chat ("Edit & Resend"), the prior quote's values seed the form so
   * they can tweak and resend. Posting creates a new quote that supersedes
   * the previous one server-side, mirroring a fresh send.
   */
  initialTotalCostCents?: number | null;
  initialNotes?: string | null;
}

type VialType = "ICI" | "IUI" | "IVF";

interface VialOption {
  /** Full cost-sheet item label, e.g. "ICI Premium" or "IUI Platinum". */
  label: string;
  /** Vial family for downstream unit labels ("vial(s)" stays the same regardless). */
  family: VialType;
  cost: number;
  /** Optional descriptor from the cost sheet item ("Washed, >=20 Million Motile..."). */
  comment?: string | null;
}

function familyFromLabel(label: string): VialType {
  const up = label.toUpperCase();
  if (up.startsWith("ICI")) return "ICI";
  if (up.startsWith("IUI")) return "IUI";
  return "IVF";
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
  subjectType,
  subjectProfileId,
  providerId,
  initialTotalCostCents,
  initialNotes,
}: CostSheetSidebarSectionProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(embedded);
  const [totalCostInput, setTotalCostInput] = useState(
    typeof initialTotalCostCents === "number" && initialTotalCostCents > 0
      ? String(initialTotalCostCents / 100)
      : "",
  );
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Sperm donors get a multi-line builder: each line picks one vial option
  // (e.g. "ICI Premium") + a quantity. Egg donors keep a single qty stepper
  // since there is only ever one per-lot price.
  const [vialLines, setVialLines] = useState<Array<{ id: string; label: string; quantity: number }>>([]);
  const [eggQuantity, setEggQuantity] = useState<number>(1);
  // Once the provider types in Total Cost directly, the picker stops driving it.
  // Edit-mode (seeded from an existing quote) starts manually-edited so the
  // donor unit-price effect never overrides the seeded total.
  const hasInitialTotal =
    typeof initialTotalCostCents === "number" && initialTotalCostCents > 0;
  const [manuallyEdited, setManuallyEdited] = useState(hasInitialTotal);
  const [linesSeeded, setLinesSeeded] = useState(hasInitialTotal);
  const nextLineId = () => `line-${Math.random().toString(36).slice(2, 9)}`;

  const subjectTypeLower = (subjectType || "").toLowerCase();
  const isSpermDonor = embedded && subjectTypeLower.includes("sperm") && !!providerId && !!subjectProfileId;
  const isEggDonor = embedded && !isSpermDonor && subjectTypeLower.includes("donor") && !!providerId && !!subjectProfileId;

  const { data: donorData } = useQuery<any>({
    queryKey: [
      "cost-sheet-prefill",
      isSpermDonor ? "sperm-donor" : isEggDonor ? "egg-donor" : "none",
      providerId,
      subjectProfileId,
    ],
    queryFn: async () => {
      if (!providerId || !subjectProfileId) return null;
      const path = isSpermDonor
        ? `/api/providers/${providerId}/sperm-donors/${subjectProfileId}`
        : `/api/providers/${providerId}/egg-donors/${subjectProfileId}`;
      const res = await fetch(path, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: isSpermDonor || isEggDonor,
    staleTime: 300_000,
  });

  // Build the full vial-option list. Prefer the server-enriched `vialCosts`
  // array (one entry per matching cost-sheet line, e.g. "ICI Premium" +
  // "ICI Platinum"). Fall back to the collapsed per-family min costs for
  // older payloads.
  const vialOptions: VialOption[] = (() => {
    if (!isSpermDonor || !donorData) return [];
    const rawList: Array<{ label?: string; cost?: number; comment?: string | null }> = Array.isArray(donorData.vialCosts)
      ? donorData.vialCosts
      : [];
    const fromList = rawList
      .filter(v => typeof v?.cost === "number" && v.cost > 0 && typeof v.label === "string")
      .map<VialOption>(v => ({
        label: v.label!,
        family: familyFromLabel(v.label!),
        cost: v.cost!,
        comment: v.comment ?? null,
      }));
    if (fromList.length > 0) return fromList;
    const fallback: VialOption[] = [];
    if (typeof donorData.iciCost === "number" && donorData.iciCost > 0) fallback.push({ label: "ICI", family: "ICI", cost: donorData.iciCost });
    if (typeof donorData.iuiCost === "number" && donorData.iuiCost > 0) fallback.push({ label: "IUI", family: "IUI", cost: donorData.iuiCost });
    if (typeof donorData.ivfCost === "number" && donorData.ivfCost > 0) fallback.push({ label: "IVF", family: "IVF", cost: donorData.ivfCost });
    return fallback;
  })();
  const eggLotCost: number | null = isEggDonor && typeof donorData?.eggLotCost === "number" && donorData.eggLotCost > 0
    ? donorData.eggLotCost
    : null;

  // Aggregate sperm-line totals (sum of cost × qty across all lines) and
  // total vials (sum of qty). Lines whose label no longer matches any
  // vialOption contribute 0 - they show a "Select vial type" placeholder.
  const linesTotal = vialLines.reduce((sum, line) => {
    const opt = vialOptions.find(o => o.label === line.label);
    return sum + (opt ? opt.cost * Math.max(1, line.quantity) : 0);
  }, 0);
  const linesQtyTotal = vialLines.reduce((sum, line) => sum + Math.max(1, line.quantity), 0);

  const pickerTotalDollars: number | null = isSpermDonor
    ? (vialLines.length > 0 && linesTotal > 0 ? linesTotal : null)
    : (eggLotCost != null ? eggLotCost * Math.max(1, eggQuantity) : null);
  const pickerQtyTotal: number = isSpermDonor ? Math.max(1, linesQtyTotal) : Math.max(1, eggQuantity);
  const hasPrefill = pickerTotalDollars != null;

  // Seed one default line (cheapest vial @ qty 1) the first time vial options
  // arrive for a fresh form (no initial total). Edit-mode keeps lines empty
  // so the seeded Total Cost stays untouched.
  useEffect(() => {
    if (!isSpermDonor || linesSeeded || vialLines.length > 0 || vialOptions.length === 0) return;
    const cheapest = vialOptions.reduce((best, v) => (v.cost < best.cost ? v : best), vialOptions[0]);
    setVialLines([{ id: nextLineId(), label: cheapest.label, quantity: 1 }]);
    setLinesSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpermDonor, vialOptions.map(v => v.label).join("|"), linesSeeded, vialLines.length]);

  // Whenever picker state changes (lines, qty), keep Total Cost in sync -
  // unless the provider has manually overridden it by typing in the textbox.
  useEffect(() => {
    if (!embedded || manuallyEdited || pickerTotalDollars == null) return;
    setTotalCostInput(String(pickerTotalDollars));
  }, [embedded, manuallyEdited, pickerTotalDollars]);

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
        // Picker-driven totals carry their unit count; manually-typed totals
        // are flat fees of quantity 1 regardless of any prior picker state.
        const effectiveQty = !manuallyEdited && hasPrefill ? pickerQtyTotal : 1;
        const res = await fetch("/api/billing/invoice-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ sessionId, totalCostCents: cents, quantity: effectiveQty }),
        });
        const text = await res.text();
        let data: any = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          setPreview(null);
          setPreviewError(
            `Preview failed (HTTP ${res.status}). The server did not return JSON - log in again if your session expired, or check the server logs.`,
          );
          return;
        }
        if (!res.ok) {
          setPreview(null);
          setPreviewError(data?.message || `Preview failed (HTTP ${res.status})`);
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
  }, [totalCostInput, sessionId, pickerQtyTotal, manuallyEdited, hasPrefill]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No session");
      const cents = Math.round(parseFloat(totalCostInput) * 100);
      if (!Number.isFinite(cents) || cents <= 0) throw new Error("Enter a valid total cost");

      const form = new FormData();
      form.append("totalCostCents", String(cents));
      const effectiveQty = !manuallyEdited && hasPrefill ? pickerQtyTotal : 1;
      form.append("quantity", String(effectiveQty));

      // Build a human-readable breakdown of the line items so the parent
      // (and the chat history) see what the total is made of. Prepended to
      // any free-text note the provider typed.
      let combinedNotes = "";
      // Also build a STRUCTURED line-item array so the invoice sidebar can
      // pre-fill itself with the same rows (instead of one collapsed line).
      // Shape mirrors what the invoice endpoint accepts: serviceType +
      // description + amountCents. Each picker line maps to one row.
      const structuredLines: Array<{
        serviceType: "SPERM_DONATION" | "EGG_DONATION";
        label: string;
        quantity: number;
        unitCostCents: number;
        amountCents: number;
        description: string;
      }> = [];
      if (isSpermDonor && vialLines.length > 0 && !manuallyEdited) {
        const lineSummaries = vialLines
          .map(line => {
            const opt = vialOptions.find(o => o.label === line.label);
            if (!opt) return null;
            const qty = Math.max(1, line.quantity);
            const lineAmount = opt.cost * qty;
            structuredLines.push({
              serviceType: "SPERM_DONATION",
              label: opt.label,
              quantity: qty,
              unitCostCents: opt.cost * 100,
              amountCents: lineAmount * 100,
              description: `${qty} × ${opt.label} @ $${opt.cost.toLocaleString()}`,
            });
            return `${qty} × ${opt.label} @ $${opt.cost.toLocaleString()} = $${lineAmount.toLocaleString()}`;
          })
          .filter((s): s is string => s !== null);
        if (lineSummaries.length > 0) combinedNotes = lineSummaries.join("\n");
      } else if (isEggDonor && eggLotCost != null && !manuallyEdited) {
        const qty = Math.max(1, eggQuantity);
        const lineAmount = eggLotCost * qty;
        structuredLines.push({
          serviceType: "EGG_DONATION",
          label: "Egg Lot",
          quantity: qty,
          unitCostCents: eggLotCost * 100,
          amountCents: lineAmount * 100,
          description: `${qty} × Egg Lot @ $${eggLotCost.toLocaleString()}`,
        });
        combinedNotes = `${qty} × Egg Lot @ $${eggLotCost.toLocaleString()} = $${lineAmount.toLocaleString()}`;
      }
      if (notes.trim()) combinedNotes = combinedNotes ? `${combinedNotes}\n\n${notes.trim()}` : notes.trim();
      if (combinedNotes) form.append("notes", combinedNotes);
      if (structuredLines.length > 0) form.append("lineItems", JSON.stringify(structuredLines));
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
      setManuallyEdited(false);
      setLinesSeeded(false);
      setVialLines([]);
      setEggQuantity(1);
      queryClient.invalidateQueries({ queryKey: ["/api/sessions/cost-sheets", sessionId] });
      if (sessionQueryKey && sessionId) {
        queryClient.invalidateQueries({ queryKey: [sessionQueryKey, sessionId] });
      }
      if (embedded) onClose?.();
    },
    onError: (err: any) => setError(err?.message || "Send failed"),
  });

  const disabled = readOnly || !sessionId;

  // Any explicit picker interaction (add/remove line, qty change, egg stepper)
  // un-mutes the sync effect so Total Cost re-derives from the picker.
  const touchPicker = () => setManuallyEdited(false);

  const addVialLine = () => {
    touchPicker();
    const cheapest = vialOptions.length > 0
      ? vialOptions.reduce((best, v) => (v.cost < best.cost ? v : best), vialOptions[0])
      : null;
    setVialLines(prev => [...prev, { id: nextLineId(), label: cheapest?.label ?? "", quantity: 1 }]);
  };
  const updateVialLine = (id: string, patch: Partial<{ label: string; quantity: number }>) => {
    touchPicker();
    setVialLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  };
  const removeVialLine = (id: string) => {
    touchPicker();
    setVialLines(prev => prev.filter(l => l.id !== id));
  };

  const unitLabel = isSpermDonor ? "vial" : "egg lot";
  const unitLabelPlural = isSpermDonor ? "vials" : "egg lots";

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
          {/* Sperm: multi-line builder. One row per vial type + quantity. */}
          {isSpermDonor && vialOptions.length > 0 && (
            <div
              className="rounded-md border p-2.5 space-y-2"
              style={{ background: "hsl(var(--secondary) / 0.5)" }}
            >
              <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">
                Vial pricing on file
              </p>

              {vialLines.length === 0 && (
                <p className="text-xs text-muted-foreground">No line items yet. Add one to build the cost sheet.</p>
              )}

              <div className="space-y-2">
                {vialLines.map(line => {
                  const opt = vialOptions.find(o => o.label === line.label) ?? null;
                  const qty = Math.max(1, line.quantity);
                  const lineSubtotal = opt ? opt.cost * qty : 0;
                  return (
                    <div
                      key={line.id}
                      className="rounded-md border p-2 space-y-1.5"
                      style={{ background: "hsl(var(--background))" }}
                      data-testid={`cost-line-${line.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <Select
                          value={line.label || undefined}
                          onValueChange={v => updateVialLine(line.id, { label: v })}
                        >
                          <SelectTrigger className="h-8 text-xs flex-1" data-testid={`select-vial-${line.id}`}>
                            <SelectValue placeholder="Select vial type" />
                          </SelectTrigger>
                          <SelectContent>
                            {vialOptions.map(o => (
                              <SelectItem key={o.label} value={o.label} className="text-xs">
                                {o.label} - ${o.cost.toLocaleString()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => updateVialLine(line.id, { quantity: Math.max(1, qty - 1) })}
                            aria-label="Decrease vial count"
                            data-testid={`btn-line-qty-minus-${line.id}`}
                          >
                            -
                          </Button>
                          <span className="text-sm font-semibold w-6 text-center" data-testid={`text-line-qty-${line.id}`}>
                            {qty}
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => updateVialLine(line.id, { quantity: qty + 1 })}
                            aria-label="Increase vial count"
                            data-testid={`btn-line-qty-plus-${line.id}`}
                          >
                            +
                          </Button>
                        </div>

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 shrink-0"
                          onClick={() => removeVialLine(line.id)}
                          aria-label="Remove line"
                          data-testid={`btn-line-remove-${line.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>

                      {opt && (
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>{qty} × ${opt.cost.toLocaleString()}</span>
                          <span className="font-semibold text-foreground">${lineSubtotal.toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addVialLine}
                className="w-full h-8 text-xs"
                data-testid="btn-add-cost-line"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Add line
              </Button>

              {vialLines.length > 0 && linesTotal > 0 && (
                <div className="flex items-center justify-between border-t pt-2 text-sm">
                  <span className="font-medium">Total ({linesQtyTotal} {linesQtyTotal === 1 ? "vial" : "vials"})</span>
                  <span className="font-semibold">${linesTotal.toLocaleString()}</span>
                </div>
              )}
            </div>
          )}

          {/* Eggs: single per-lot price + qty stepper. */}
          {isEggDonor && eggLotCost != null && (
            <div
              className="rounded-md border p-2.5 space-y-2"
              style={{ background: "hsl(var(--secondary) / 0.5)" }}
            >
              <p className="font-medium text-muted-foreground uppercase tracking-wide text-[10px]">
                Egg lot pricing on file
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs">Per egg lot: ${eggLotCost.toLocaleString()}</span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => { touchPicker(); setEggQuantity(q => Math.max(1, q - 1)); }}
                    aria-label={`Decrease ${unitLabel} count`}
                    data-testid="btn-prefill-qty-minus"
                  >
                    -
                  </Button>
                  <span className="text-sm font-semibold w-6 text-center" data-testid="text-prefill-qty">
                    {eggQuantity}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => { touchPicker(); setEggQuantity(q => q + 1); }}
                    aria-label={`Increase ${unitLabel} count`}
                    data-testid="btn-prefill-qty-plus"
                  >
                    +
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {eggQuantity} × ${eggLotCost.toLocaleString()} = ${(eggLotCost * eggQuantity).toLocaleString()}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium">Total Cost ($)</label>
            <NumberInput
              placeholder="e.g. 25000"
              value={totalCostInput}
              onChange={v => { setTotalCostInput(v); setManuallyEdited(true); }}
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
