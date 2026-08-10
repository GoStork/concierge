import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { formatMoneyDollars } from "@/lib/format-money";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFieldLabel } from "@/lib/format-label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AMOUNT_BASIS_OPTIONS,
  PAY_TO_OPTIONS,
  PAYMENT_TRIGGERS,
  formatTiming,
  formatTrancheAmount,
  payToLabel,
} from "@shared/payment-schedule";
import {
  CalendarClock,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Check,
  AlertTriangle,
  Info,
} from "lucide-react";

/**
 * Payment schedule (installment plan) editor for one cost sheet.
 *
 * Three states, one component:
 *   1. No schedule       - the uploaded document stated no payment timing, so
 *                          the provider builds one from scratch off a starter
 *                          scaffold shaped by their service type.
 *   2. AI proposed       - parsed from the document, provider-only until
 *                          reviewed. Every field is editable and the provider
 *                          must confirm before parents ever see it.
 *   3. Provider-owned    - confirmed or authored. Still fully editable.
 *
 * A schedule never contributes to any total. It is a view over money already
 * captured as line items, which is what makes it safe to record payment rows
 * that (in most real sheets) restate the same money.
 */

interface ScheduleItem {
  id: string;
  category: string;
  key: string;
  minValue: number | null;
  maxValue: number | null;
  isIncluded: boolean;
  isTier: boolean;
}

interface TrancheDraft {
  /** Client-only key so rows stay stable across reorders before they're saved. */
  uid: string;
  name: string;
  triggerType: string;
  triggerLabel: string;
  offsetDays: number | null;
  offsetBasis: string;
  offsetDirection: string;
  minValueCents: number | null;
  maxValueCents: number | null;
  amountBasis: string;
  payTo: string;
  payToLabel: string;
  isRefundable: boolean | null;
  refundNote: string;
  notes: string;
  itemIds: string[];
}

interface ScheduleResponse {
  sheetId: string;
  scheduleSource: string | null;
  isParentVisible: boolean;
  paymentTerms: Record<string, any> | null;
  tranches: Array<any>;
  items: ScheduleItem[];
  reconciliation: {
    verdict: string;
    trancheTotalCents: number;
    programTotalCents: number;
    coverage: number;
    message: string;
  };
}

let uidCounter = 0;
const nextUid = () => `t${++uidCounter}`;

const centsToDollars = (c: number | null | undefined): string =>
  c == null ? "" : String(Math.round(c) / 100);
const dollarsToCents = (raw: string): number | null => {
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/**
 * Server tranche -> comparable shape, with no client-only uid.
 *
 * Kept separate from toDraft because dirty-checking runs on every render:
 * routing it through toDraft would allocate a fresh uid each time, which is a
 * side effect during render.
 */
function toComparable(t: any) {
  const { uid, ...rest } = toDraft(t, "");
  return rest;
}

function toDraft(t: any, uid: string = nextUid()): TrancheDraft {
  return {
    uid,
    name: t.name ?? "",
    triggerType: t.triggerType ?? "OTHER",
    triggerLabel: t.triggerLabel ?? "",
    offsetDays: t.offsetDays ?? null,
    offsetBasis: t.offsetBasis ?? "CALENDAR",
    offsetDirection: t.offsetDirection ?? "AFTER",
    minValueCents: t.minValueCents ?? null,
    maxValueCents: t.maxValueCents ?? null,
    amountBasis: t.amountBasis ?? "STATED",
    payTo: t.payTo ?? "PROVIDER",
    payToLabel: t.payToLabel ?? "",
    isRefundable: t.isRefundable ?? null,
    refundNote: t.refundNote ?? "",
    notes: t.notes ?? "",
    itemIds: Array.isArray(t.itemPayments) ? t.itemPayments.map((p: any) => p.costItem?.id ?? p.costItemId).filter(Boolean) : [],
  };
}

function emptyDraft(seed?: Partial<TrancheDraft>): TrancheDraft {
  return {
    uid: nextUid(),
    name: "",
    triggerType: "AT_SIGNING",
    triggerLabel: "",
    offsetDays: null,
    offsetBasis: "CALENDAR",
    offsetDirection: "AFTER",
    minValueCents: null,
    maxValueCents: null,
    amountBasis: "STATED",
    payTo: "PROVIDER",
    payToLabel: "",
    isRefundable: null,
    refundNote: "",
    notes: "",
    itemIds: [],
    ...seed,
  };
}

export function PaymentScheduleEditor({
  sheetId,
  providerId,
  canEdit,
}: {
  sheetId: string;
  providerId: string;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<TrancheDraft[] | null>(null);
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [terms, setTerms] = useState<Record<string, any>>({});

  const scheduleKey = ["/api/costs/sheet", sheetId, "payment-schedule"];

  const { data, isLoading } = useQuery<ScheduleResponse>({
    queryKey: scheduleKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/costs/sheet/${sheetId}/payment-schedule`);
      return res.json();
    },
    enabled: !!sheetId,
  });

  // Seed the editable drafts from the server exactly once per load. Re-seeding
  // on every refetch would stomp on edits in progress.
  useEffect(() => {
    if (data && drafts === null) {
      setDrafts(data.tranches.map((t) => toDraft(t)));
      setTerms(data.paymentTerms ?? {});
    }
  }, [data, drafts]);

  const items = data?.items ?? [];
  const source = data?.scheduleSource ?? null;
  const isDirty = useMemo(() => {
    if (!data || drafts === null) return false;
    return JSON.stringify(data.tranches.map(toComparable)) !== JSON.stringify(drafts.map(stripUid))
      || JSON.stringify(data.paymentTerms ?? {}) !== JSON.stringify(terms);
  }, [data, drafts, terms]);

  const saveMutation = useMutation({
    mutationFn: async (payload: { source?: string }) => {
      const res = await apiRequest("PUT", `/api/costs/sheet/${sheetId}/payment-schedule`, {
        tranches: (drafts ?? []).map((d) => ({
          name: d.name,
          triggerType: d.triggerType,
          triggerLabel: d.triggerLabel || null,
          offsetDays: d.offsetDays,
          offsetBasis: d.offsetBasis,
          offsetDirection: d.offsetDirection,
          minValueCents: d.minValueCents,
          maxValueCents: d.maxValueCents,
          amountBasis: d.amountBasis,
          payTo: d.payTo,
          payToLabel: d.payToLabel || null,
          isRefundable: d.isRefundable,
          refundNote: d.refundNote || null,
          notes: d.notes || null,
          itemIds: d.itemIds,
        })),
        paymentTerms: Object.keys(terms).length > 0 ? terms : null,
        source: payload.source,
      });
      return res.json();
    },
    onSuccess: (fresh: ScheduleResponse) => {
      queryClient.setQueryData(scheduleKey, fresh);
      setDrafts(fresh.tranches.map((t) => toDraft(t)));
      setTerms(fresh.paymentTerms ?? {});
      // Deliberately does NOT invalidate the provider's cost-sheet query.
      // A schedule changes nothing that query renders - totals and badges are
      // all derived from line items - and poking that heavy, effect-laden
      // parent query from here sent the cost-sheet tab into a render loop.
      toast({ title: "Payment schedule saved", description: "Parents will see this with their cost sheet." });
    },
    onError: (err: any) => {
      toast({ title: "Could not save the schedule", description: err?.message ?? "Please try again.", variant: "destructive" });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/costs/sheet/${sheetId}/payment-schedule`);
      return res.json();
    },
    onSuccess: (fresh: ScheduleResponse) => {
      queryClient.setQueryData(scheduleKey, fresh);
      setDrafts([]);
      setTerms({});
      toast({ title: "Payment schedule removed" });
    },
  });

  const startFromScratch = async () => {
    try {
      const res = await apiRequest("GET", `/api/costs/sheet/${sheetId}/payment-schedule/starter`);
      const { tranches } = await res.json();
      const seeded = (tranches ?? []).map((t: any) =>
        emptyDraft({
          name: t.name,
          triggerType: t.triggerType,
          triggerLabel: t.triggerLabel,
          payTo: t.payTo,
        }),
      );
      setDrafts(seeded.length > 0 ? seeded : [emptyDraft({ name: "First Payment" })]);
      setExpandedUid(seeded[0]?.uid ?? null);
    } catch {
      setDrafts([emptyDraft({ name: "First Payment" })]);
    }
  };

  const update = (uid: string, patch: Partial<TrancheDraft>) =>
    setDrafts((prev) => (prev ?? []).map((d) => (d.uid === uid ? { ...d, ...patch } : d)));

  const move = (uid: string, dir: -1 | 1) =>
    setDrafts((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((d) => d.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  if (isLoading || drafts === null) {
    return (
      <Card data-testid="card-payment-schedule-loading">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="w-4 h-4" /> Payment Schedule
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  const needsReview = source === "ai_proposed";
  const hasSchedule = drafts.length > 0;

  // ---------------------------------------------------------------------
  // Empty state: the document had no payment timing. Offer to build one.
  // ---------------------------------------------------------------------
  if (!hasSchedule) {
    return (
      <Card className="border-2 border-dashed border-border bg-secondary/30" data-testid="card-payment-schedule-empty">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-primary" />
            Payment Schedule
            <Badge variant="outline" className="text-xs">Optional</Badge>
          </CardTitle>
          <p className="t-helper">
            No payment stages were found in this document. You can add them so parents know what is due and when, for example a deposit at match, then a second payment at legal clearance.
          </p>
        </CardHeader>
        {canEdit && (
          <CardContent>
            <Button variant="outline" onClick={startFromScratch} data-testid="btn-create-payment-schedule">
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Create Payment Schedule
            </Button>
          </CardContent>
        )}
      </Card>
    );
  }

  const rec = data?.reconciliation;

  return (
    <Card
      className={cn(
        "border-2",
        needsReview ? "border-brand-warning/50 bg-brand-warning/5" : "border-primary/30 bg-secondary/20",
      )}
      data-testid="card-payment-schedule"
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <CalendarClock className={cn("w-4 h-4", needsReview ? "text-brand-warning" : "text-primary")} />
          Payment Schedule
          <Badge variant="outline" className="text-xs">
            {drafts.length} payment{drafts.length === 1 ? "" : "s"}
          </Badge>
          {needsReview ? (
            <Badge className="text-xs bg-brand-warning/15 text-brand-warning border-brand-warning/30 gap-1">
              <Sparkles className="w-3 h-3" /> Read from your document
            </Badge>
          ) : data?.isParentVisible ? (
            <Badge className="text-xs bg-brand-success/15 text-brand-success border-brand-success/30 gap-1">
              <Check className="w-3 h-3" /> Visible to parents
            </Badge>
          ) : null}
        </CardTitle>
        <p className="t-helper">
          {needsReview
            ? "We read these payment stages from your cost sheet. Check them over and correct anything that is off, then confirm. Parents will not see this until you do."
            : "Parents see this alongside your cost sheet, so they know what is due and when."}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Reconciliation: what the schedule covers relative to the program. */}
        {rec && rec.verdict !== "NONE" && (
          <div
            className={cn(
              "flex items-start gap-2 p-2.5 rounded-[var(--radius)] text-sm",
              rec.verdict === "OVERSHOOT"
                ? "bg-destructive/10 text-destructive"
                : rec.verdict === "PARTITIONS_TOTAL"
                  ? "bg-brand-success/10 text-brand-success"
                  : "bg-accent/10 text-accent",
            )}
            data-testid="schedule-reconciliation"
          >
            {rec.verdict === "OVERSHOOT" ? (
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <Info className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
              <p>{rec.message}</p>
              <p className="opacity-80 text-xs mt-0.5 tabular-nums">
                Payments total {formatMoneyDollars(rec.trancheTotalCents / 100)} against a program total of{" "}
                {formatMoneyDollars(rec.programTotalCents / 100)}.
              </p>
            </div>
          </div>
        )}

        {drafts.map((d, idx) => {
          const isOpen = expandedUid === d.uid;
          const assigned = items.filter((it) => d.itemIds.includes(it.id));
          return (
            <div
              key={d.uid}
              className="rounded-[var(--radius)] border border-border bg-secondary overflow-hidden"
              data-testid={`tranche-row-${idx}`}
            >
              {/* Summary line - always visible */}
              <div className="flex items-center gap-2 p-3">
                <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center shrink-0 tabular-nums">
                  {idx + 1}
                </span>
                <button
                  type="button"
                  className="flex-1 min-w-0 text-left"
                  onClick={() => setExpandedUid(isOpen ? null : d.uid)}
                  data-testid={`tranche-toggle-${idx}`}
                >
                  <p className="font-medium text-sm truncate">{d.name || "Untitled payment"}</p>
                  <p className="t-helper truncate">
                    {formatTiming(d)} &middot; to {payToLabel(d.payTo, d.payToLabel)}
                  </p>
                </button>
                <span className="text-sm font-semibold tabular-nums shrink-0">
                  {formatTrancheAmount(d, (c) => formatMoneyDollars(c / 100))}
                </span>
                {canEdit && (
                  <div className="flex items-center shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={idx === 0}
                      onClick={() => move(d.uid, -1)} data-testid={`tranche-up-${idx}`} aria-label="Move earlier">
                      <ChevronUp className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={idx === drafts.length - 1}
                      onClick={() => move(d.uid, 1)} data-testid={`tranche-down-${idx}`} aria-label="Move later">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive"
                      onClick={() => setDrafts((prev) => (prev ?? []).filter((x) => x.uid !== d.uid))}
                      data-testid={`tranche-delete-${idx}`} aria-label="Remove payment">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )}
              </div>

              {/* Detail - inline expansion, never a dialog */}
              {isOpen && (
                <div className="border-t border-border p-3 space-y-3 bg-secondary/20">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="t-form-label">Payment name</span>
                      <Input value={d.name} disabled={!canEdit}
                        onChange={(e) => update(d.uid, { name: e.target.value })}
                        placeholder="First Deposit" className="h-8 text-sm"
                        data-testid={`tranche-name-${idx}`} />
                    </label>

                    <label className="space-y-1">
                      <span className="t-form-label">When it is due</span>
                      <Select value={d.triggerType} disabled={!canEdit}
                        onValueChange={(v) => update(d.uid, { triggerType: v })}>
                        <SelectTrigger className="h-8 text-sm" data-testid={`tranche-trigger-${idx}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_TRIGGERS.map((t) => (
                            <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>

                  <label className="space-y-1 block">
                    <span className="t-form-label">How you describe the timing to parents</span>
                    <Input value={d.triggerLabel} disabled={!canEdit}
                      onChange={(e) => update(d.uid, { triggerLabel: e.target.value })}
                      placeholder="Within 5 business days after legal clearance"
                      className="h-8 text-sm" data-testid={`tranche-trigger-label-${idx}`} />
                    <span className="t-helper">
                      Shown to parents word for word. Leave blank to use the standard wording above.
                    </span>
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="t-form-label">Amount</span>
                      <Select value={d.amountBasis} disabled={!canEdit}
                        onValueChange={(v) => update(d.uid, { amountBasis: v })}>
                        <SelectTrigger className="h-8 text-sm" data-testid={`tranche-basis-${idx}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {AMOUNT_BASIS_OPTIONS.map((a) => (
                            <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>

                    <label className="space-y-1">
                      <span className="t-form-label">Who it is paid to</span>
                      <Select value={d.payTo} disabled={!canEdit}
                        onValueChange={(v) => update(d.uid, { payTo: v })}>
                        <SelectTrigger className="h-8 text-sm" data-testid={`tranche-payto-${idx}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAY_TO_OPTIONS.map((p) => (
                            <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>

                  {d.payTo === "OTHER" && (
                    <label className="space-y-1 block">
                      <span className="t-form-label">Who receives it</span>
                      <Input value={d.payToLabel} disabled={!canEdit}
                        onChange={(e) => update(d.uid, { payToLabel: e.target.value })}
                        placeholder="Name of the company or person" className="h-8 text-sm" />
                    </label>
                  )}

                  {(d.amountBasis === "STATED" || d.amountBasis === "PERCENT_OF") && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="t-form-label">Amount (or lowest, if it varies)</span>
                        <div className="flex items-center gap-1.5">
                          <span className="t-helper">$</span>
                          <NumberInput value={centsToDollars(d.minValueCents)} disabled={!canEdit}
                            onChange={(raw) => update(d.uid, { minValueCents: dollarsToCents(raw) })}
                            placeholder="0" className="h-8 text-sm tabular-nums"
                            data-testid={`tranche-min-${idx}`} />
                        </div>
                      </label>
                      <label className="space-y-1">
                        <span className="t-form-label">Highest, if it varies</span>
                        <div className="flex items-center gap-1.5">
                          <span className="t-helper">$</span>
                          <NumberInput value={centsToDollars(d.maxValueCents)} disabled={!canEdit}
                            onChange={(raw) => update(d.uid, { maxValueCents: dollarsToCents(raw) })}
                            placeholder="Same as above" className="h-8 text-sm tabular-nums"
                            data-testid={`tranche-max-${idx}`} />
                        </div>
                      </label>
                    </div>
                  )}

                  {/* Item assignment */}
                  <div className="space-y-1.5">
                    <span className="t-form-label">What this payment covers</span>
                    <p className="t-helper">
                      Optional. Tick the line items funded by this payment so parents can see what they are paying for.
                    </p>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {items.filter((it) => it.isIncluded && !it.isTier).map((it) => {
                        const on = d.itemIds.includes(it.id);
                        return (
                          <button
                            key={it.id}
                            type="button"
                            disabled={!canEdit}
                            onClick={() =>
                              update(d.uid, {
                                itemIds: on ? d.itemIds.filter((x) => x !== it.id) : [...d.itemIds, it.id],
                              })
                            }
                            className={cn(
                              "px-2 py-1 rounded-[var(--radius)] text-xs border transition-colors",
                              on
                                ? "bg-accent text-accent-foreground border-accent"
                                : "bg-card border-border hover:border-accent/50",
                            )}
                            data-testid={`tranche-item-${idx}-${it.id}`}
                          >
                            {formatFieldLabel(it.key)}
                          </button>
                        );
                      })}
                    </div>
                    {assigned.length > 0 && (
                      <p className="t-helper tabular-nums">
                        {assigned.length} item{assigned.length === 1 ? "" : "s"} assigned
                      </p>
                    )}
                  </div>

                  <label className="space-y-1 block">
                    <span className="t-form-label">Notes for parents</span>
                    <Textarea value={d.notes} disabled={!canEdit}
                      onChange={(e) => update(d.uid, { notes: e.target.value })}
                      placeholder="Anything else parents should know about this payment"
                      className="text-sm min-h-[60px]" data-testid={`tranche-notes-${idx}`} />
                  </label>

                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={d.isRefundable === true} disabled={!canEdit}
                        onChange={(e) => update(d.uid, { isRefundable: e.target.checked ? true : null })}
                        className="accent-[hsl(var(--primary))]"
                        data-testid={`tranche-refundable-${idx}`} />
                      This payment is refundable
                    </label>
                    {d.isRefundable && (
                      <Input value={d.refundNote} disabled={!canEdit}
                        onChange={(e) => update(d.uid, { refundNote: e.target.value })}
                        placeholder="Refundable if no match is made within the agreed window"
                        className="h-8 text-sm flex-1 min-w-[220px]" />
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {canEdit && (
          <Button size="sm" variant="outline" className="w-full border-dashed"
            onClick={() => {
              const d = emptyDraft({ name: `Payment ${drafts.length + 1}` });
              setDrafts([...drafts, d]);
              setExpandedUid(d.uid);
            }}
            data-testid="btn-add-tranche">
            <Plus className="w-3.5 h-3.5 mr-1" /> Add Payment
          </Button>
        )}

        {/* Sheet-level terms - inline expandable, no dialog */}
        <div className="rounded-[var(--radius)] border border-border bg-secondary">
          <button type="button" className="w-full flex items-center justify-between p-3 text-left"
            onClick={() => setTermsOpen((v) => !v)} data-testid="btn-toggle-payment-terms">
            <span className="text-sm font-medium">Escrow and refund terms</span>
            {termsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {termsOpen && (
            <div className="border-t border-border p-3 space-y-3 bg-secondary/20">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="t-form-label">Minimum escrow balance</span>
                  <div className="flex items-center gap-1.5">
                    <span className="t-helper">$</span>
                    <NumberInput value={centsToDollars(terms.escrowFloorCents)} disabled={!canEdit}
                      onChange={(raw) => setTerms({ ...terms, escrowFloorCents: dollarsToCents(raw) })}
                      placeholder="10,000" className="h-8 text-sm tabular-nums"
                      data-testid="terms-escrow-floor" />
                  </div>
                </label>
                <label className="space-y-1">
                  <span className="t-form-label">Days to top up if it drops below</span>
                  <NumberInput value={terms.replenishDays != null ? String(terms.replenishDays) : ""} disabled={!canEdit}
                    onChange={(raw) => setTerms({ ...terms, replenishDays: raw === "" ? null : Number(raw) })}
                    placeholder="5" className="h-8 text-sm tabular-nums" data-testid="terms-replenish-days" />
                </label>
              </div>
              <label className="space-y-1 block">
                <span className="t-form-label">What happens to leftover funds</span>
                <Textarea value={terms.refundPolicy ?? ""} disabled={!canEdit}
                  onChange={(e) => setTerms({ ...terms, refundPolicy: e.target.value })}
                  placeholder="Remaining funds are returned six months after the birth"
                  className="text-sm min-h-[60px]" data-testid="terms-refund-policy" />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="t-form-label">Quote valid for (days)</span>
                  <NumberInput value={terms.quoteValidDays != null ? String(terms.quoteValidDays) : ""} disabled={!canEdit}
                    onChange={(raw) => setTerms({ ...terms, quoteValidDays: raw === "" ? null : Number(raw) })}
                    placeholder="90" className="h-8 text-sm tabular-nums" data-testid="terms-valid-days" />
                </label>
                <label className="space-y-1">
                  <span className="t-form-label">Card surcharge (%)</span>
                  <NumberInput value={terms.cardFeePercent != null ? String(terms.cardFeePercent) : ""} disabled={!canEdit}
                    onChange={(raw) => setTerms({ ...terms, cardFeePercent: raw === "" ? null : Number(raw) })}
                    placeholder="3" className="h-8 text-sm tabular-nums" data-testid="terms-card-fee" />
                </label>
              </div>
            </div>
          )}
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate({ source: source === "provider_authored" || !source ? "provider_authored" : "provider_confirmed" })}
              disabled={saveMutation.isPending || (!isDirty && !needsReview)}
              data-testid="btn-save-payment-schedule"
            >
              {saveMutation.isPending ? "Saving..." : needsReview ? "Confirm and Publish" : "Save Schedule"}
            </Button>
            {isDirty && (
              <Button size="sm" variant="ghost"
                onClick={() => { setDrafts(data!.tranches.map((t) => toDraft(t))); setTerms(data!.paymentTerms ?? {}); }}
                data-testid="btn-reset-payment-schedule">
                Discard changes
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-destructive ml-auto"
              onClick={() => clearMutation.mutate()} disabled={clearMutation.isPending}
              data-testid="btn-clear-payment-schedule">
              <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove schedule
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Drop the client-only uid so drafts can be compared to server state. */
function stripUid(d: TrancheDraft) {
  const { uid, ...rest } = d;
  return rest;
}
