/**
 * One card for all three consultation consent gates.
 *
 *   consult_preliminary_ack    - an agency consultation is the preliminary step
 *                                toward a match call with THIS profile, not an
 *                                info call. Parent-private (the agency's name
 *                                is still masked at this point).
 *   match_call_attendance_ack  - both intended parents must attend the match
 *                                call.
 *   match_call_decision_ack    - the 24-hour decision window and the match
 *                                deposit, with the real figure when we have it.
 *
 * All three are the same interaction - read this, tick it, move on - so they
 * are one component driven by uiCardData rather than three near-copies.
 *
 * The provider sees a read-only variant of the two match-call gates
 * deliberately: they are the ones refused at propose-call-times, and being
 * told "no" with no visible cause is exactly how the IP-form gate used to
 * feel. The preliminary card never reaches them at all.
 *
 * Answered state comes from three sources, most reliable first: the live
 * status re-query (so a stale card in scrollback is never actionable), the
 * DB-persisted acknowledgedAt, then optimistic local state.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Users, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { chipBase, chatBubbleStyle } from "@/components/chat/chip-styles";

export type ConsentGate = "PRELIMINARY_STEP" | "BOTH_PARENTS" | "DECISION_WINDOW";

export interface DepositSnapshot {
  source: "QUOTE" | "COST_SHEET" | "NONE";
  label: string | null;
  minCents: number | null;
  maxCents: number | null;
  triggerLabel: string | null;
  payToLabel: string | null;
  isRefundable: boolean | null;
  refundNote: string | null;
  depositAtClearance: boolean;
}

export interface ConsentAckData {
  gate: ConsentGate;
  providerId: string;
  providerDisplayName?: string | null;
  subjectLabel?: string | null;
  subjectProfileId?: string | null;
  subjectType?: string | null;
  partnerFirstName?: string | null;
  requiredBecause?: string | null;
  deposit?: DepositSnapshot | null;
  policyText?: string | null;
  providerContent?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedByName?: string | null;
}

interface ConsentAckCardProps {
  data: ConsentAckData;
  messageId: string;
  sessionId: string;
  messageContent: string;
  viewerRole?: "parent" | "provider";
  positiveChipStyle?: React.CSSProperties;
}

const GATE_ICON = {
  PRELIMINARY_STEP: CalendarClock,
  BOTH_PARENTS: Users,
  DECISION_WINDOW: Clock,
} as const;

const GATE_BUTTON_LABEL = {
  PRELIMINARY_STEP: "I understand",
  BOTH_PARENTS: "We'll both be there",
  DECISION_WINDOW: "Got it",
} as const;

const GATE_BANNER = {
  PRELIMINARY_STEP: "Next step after this call: a match call",
  BOTH_PARENTS: "Both parents required",
  DECISION_WINDOW: "24-hour decision window",
} as const;

function formatAmount(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** "$8,000", or "$8,000 - $12,000" when the sheet states a range. */
function depositAmountLabel(d: DepositSnapshot): string | null {
  if (d.minCents == null && d.maxCents == null) return null;
  const min = d.minCents ?? d.maxCents!;
  const max = d.maxCents ?? d.minCents!;
  return min === max ? formatAmount(min) : `${formatAmount(min)} - ${formatAmount(max)}`;
}

export function ConsentAckCard({
  data,
  messageId,
  sessionId,
  messageContent,
  viewerRole = "parent",
  positiveChipStyle,
}: ConsentAckCardProps) {
  const queryClient = useQueryClient();
  const [acknowledgedAt, setAcknowledgedAt] = useState<string | null>(data.acknowledgedAt ?? null);
  const [saving, setSaving] = useState(false);
  const isProvider = viewerRole === "provider";
  const Icon = GATE_ICON[data.gate] ?? Check;

  // Re-query the live gate state so a card left in scrollback never offers a
  // button for something already satisfied (e.g. the partner ticked it on
  // their own login).
  useEffect(() => {
    if (isProvider || acknowledgedAt || !data.providerId) return;
    const intent = data.gate === "PRELIMINARY_STEP" ? "CONSULTATION" : "MATCH_CALL";
    const params = new URLSearchParams({ providerId: data.providerId, intent });
    if (data.subjectProfileId) params.set("subjectProfileId", data.subjectProfileId);
    if (data.subjectType) params.set("subjectType", data.subjectType);
    let cancelled = false;
    fetch(`/api/consultation-gates/status?${params.toString()}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (cancelled || !s) return;
        const stillMissing =
          intent === "MATCH_CALL"
            ? (s.missing || []).includes(data.gate)
            : s.preliminaryAck?.allowed === false;
        if (!stillMissing) setAcknowledgedAt(new Date().toISOString());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isProvider, acknowledgedAt, data.providerId, data.gate, data.subjectProfileId, data.subjectType]);

  const handleAcknowledge = async () => {
    if (saving) return;
    setSaving(true);
    // Optimistic: the tick is the whole interaction, so it must feel instant.
    const optimistic = new Date().toISOString();
    setAcknowledgedAt(optimistic);
    try {
      const res = await fetch("/api/consultation-gates/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          gate: data.gate,
          providerId: data.providerId,
          subjectProfileId: data.subjectProfileId ?? null,
          subjectType: data.subjectType ?? null,
          sessionId,
          messageId,
        }),
      });
      if (!res.ok) throw new Error(`Acknowledge failed (${res.status})`);
      queryClient.invalidateQueries({ queryKey: [`/api/ai-concierge/session/${sessionId}/messages`] });
    } catch (e) {
      // Roll back rather than pretending it saved - the provider's booking
      // still 409s and a green tick would make that inexplicable.
      setAcknowledgedAt(null);
      console.error("[consent-ack]", e);
    } finally {
      setSaving(false);
    }
  };

  const body = isProvider ? data.providerContent || messageContent : messageContent;
  const deposit = data.deposit;
  const amount = deposit && deposit.source !== "NONE" ? depositAmountLabel(deposit) : null;

  if (acknowledgedAt) {
    return (
      <div style={chatBubbleStyle}>
        <p>{body}</p>
        <div
          className="flex items-center gap-2 mt-2 font-medium"
          style={{ fontSize: "var(--chat-bubble-font-size, 12px)", color: "hsl(var(--brand-success))" }}
        >
          <Check className="w-3.5 h-3.5" />
          <span>
            Confirmed{data.acknowledgedByName ? ` by ${data.acknowledgedByName}` : ""}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...chatBubbleStyle, padding: 0, overflow: "hidden" }}>
      <div
        className="flex items-center gap-2 font-medium border-b"
        style={{
          padding: "8px var(--chat-bubble-px, 16px)",
          fontSize: "var(--chat-bubble-font-size, 12px)",
          background: "hsl(var(--accent) / 0.12)",
          color: "hsl(var(--accent))",
        }}
      >
        <Icon className="w-3.5 h-3.5 shrink-0" />
        <span>{GATE_BANNER[data.gate]}</span>
      </div>

      <div style={{ padding: "var(--chat-bubble-py, 11px) var(--chat-bubble-px, 16px)" }} className="space-y-3">
        <p>{body}</p>

        {data.gate === "DECISION_WINDOW" && deposit && (
          <div
            className="rounded-md"
            style={{
              background: "hsl(var(--secondary))",
              color: "hsl(var(--secondary-foreground))",
              padding: "10px 12px",
              borderRadius: "var(--radius, 8px)",
              fontSize: "var(--chat-bubble-font-size, 13px)",
            }}
          >
            {amount ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{deposit.label || "Match deposit"}</span>
                  <span className="font-semibold">{amount}</span>
                </div>
                {deposit.payToLabel && (
                  <div className="opacity-80 mt-1">Paid to {deposit.payToLabel}</div>
                )}
                {deposit.triggerLabel && (
                  <div className="opacity-80 mt-1">{deposit.triggerLabel}</div>
                )}
                {deposit.isRefundable === false && (
                  <div className="opacity-80 mt-1">
                    Non-refundable{deposit.refundNote ? ` - ${deposit.refundNote}` : ""}
                  </div>
                )}
              </>
            ) : (
              // Never invent a figure. An honest "ask them" beats a plausible
              // number on the biggest financial decision these parents make.
              <div className="opacity-80">
                {data.policyText || "Your agency confirms the exact deposit amount before the call."}
              </div>
            )}
          </div>
        )}

        {!isProvider && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={handleAcknowledge}
              className="transition-all hover:opacity-90 font-medium"
              style={{
                ...chipBase,
                ...(positiveChipStyle ?? {
                  backgroundColor: "hsl(var(--primary))",
                  color: "hsl(var(--primary-foreground))",
                  border: "none",
                }),
              }}
              data-testid={`consent-ack-${data.gate.toLowerCase()}`}
            >
              <Check className="shrink-0" style={{ width: "13px", height: "13px", marginRight: "5px" }} />
              {GATE_BUTTON_LABEL[data.gate]}
            </Button>
          </div>
        )}

        {isProvider && (
          <div
            className="font-medium"
            style={{ fontSize: "var(--chat-bubble-font-size, 12px)", color: "hsl(var(--brand-warning))" }}
          >
            Waiting on the parents
          </div>
        )}
      </div>
    </div>
  );
}

/** The three uiCardTypes this component renders. */
export const CONSENT_ACK_CARD_TYPES = [
  "consult_preliminary_ack",
  "match_call_attendance_ack",
  "match_call_decision_ack",
] as const;
