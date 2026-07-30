/**
 * In-chat readiness prompt card.
 * Rendered when a chat message has uiCardType === "readiness_prompt".
 * Shown after a video call ends - asks parent if they're ready to move forward.
 *
 * Answered state is derived from two sources (most reliable first):
 *  1. isAnswered prop - computed by the parent from the message history
 *     ("Thank you" system message after this card = already answered).
 *  2. data.answered - DB-persisted flag written by the PATCH endpoint.
 * Local useState is only used for optimistic updates within the current session.
 *
 * When a button is clicked, onAnswer(text) is called so the answer appears as a
 * regular user message and the AI responds naturally - no inline confirmation text.
 */

import type React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ThumbsUp, Clock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { chipBase } from "@/components/chat/chip-styles";

interface ReadinessPromptData {
  bookingId?: string;
  providerName: string;
  providerType: string;
  isMatchCall: boolean;
  dueAt?: string | null;
  buttonLabel: string;
  yesAction: string;
  noAction: string;
  answered?: "yes" | "no" | "later"; // DB-persisted
}

interface ReadinessPromptCardProps {
  data: ReadinessPromptData;
  messageId: string;
  sessionId: string;
  messageContent: string;
  isParent?: boolean;
  isAnswered?: boolean; // derived from message history by the parent component
  brandColor?: string;
  positiveChipStyle?: React.CSSProperties;
  declineChipStyle?: React.CSSProperties;
  onAnswer?: (text: string) => void;
  onYesReady?: (text: string) => void; // bypasses LLM, streams fixed confirmation
}

// Shared with consent-ack-card.tsx so a card button and a quick-reply chip
// stay the same control - see components/chat/chip-styles.ts.

/** Persist answered state to DB so data.answered is correct on next load */
async function markAnswered(messageId: string, answer: "yes" | "no" | "later") {
  await fetch("/api/billing/readiness-prompt-respond", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ messageId, answer }),
  });
}

export function ReadinessPromptCard({ data, messageId, sessionId, messageContent, isParent = true, isAnswered, brandColor, positiveChipStyle, declineChipStyle, onAnswer, onYesReady }: ReadinessPromptCardProps) {
  // Priority: isAnswered (history-based) > data.answered (DB flag) > local state
  const alreadyAnswered = isAnswered ?? !!data.answered;
  const [responded, setResponded] = useState(alreadyAnswered);

  const queryClient = useQueryClient();

  const handleYesReady = () => {
    setResponded(true);
    // onYesReady sends with a fixed server reply (bypasses LLM); fall back to onAnswer
    if (onYesReady) {
      onYesReady(data.buttonLabel);
    } else {
      onAnswer?.(data.buttonLabel);
    }
    // Billing runs in background
    markAnswered(messageId, "yes").catch(() => {});
    fetch("/api/billing/parent-confirm-ready", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId }),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: [`/api/ai-concierge/session/${sessionId}/messages`] }))
      .catch(() => {});
  };

  const handleNotYet = () => {
    setResponded(true);
    // The server posts Eva's blocker follow-up question and relays a
    // provider-only heads-up note; invalidate so both appear.
    markAnswered(messageId, "no")
      .then(() => queryClient.invalidateQueries({ queryKey: [`/api/ai-concierge/session/${sessionId}/messages`] }))
      .catch(() => {});
  };

  const handleNeedMoreTime = () => {
    setResponded(true);
    // The server stamps a 12h remindAt and posts Eva's "take your time" ack;
    // the scheduler re-asks once when the time passes.
    markAnswered(messageId, "later")
      .then(() => queryClient.invalidateQueries({ queryKey: [`/api/ai-concierge/session/${sessionId}/messages`] }))
      .catch(() => {});
  };

  const bubbleStyle: React.CSSProperties = {
    fontSize: "var(--chat-bubble-font-size, 14px)",
    lineHeight: "var(--chat-bubble-line-height, 1.35)",
    borderRadius: "var(--chat-bubble-radius, 20px)",
    paddingLeft: "var(--chat-bubble-px, 16px)",
    paddingRight: "var(--chat-bubble-px, 16px)",
    paddingTop: "var(--chat-bubble-py, 11px)",
    paddingBottom: "var(--chat-bubble-py, 11px)",
    maxWidth: "var(--chat-bubble-max-width, 85%)",
    backgroundColor: "var(--chat-bubble-ai-bg)",
    color: "var(--chat-bubble-ai-fg)",
    border: "1px solid var(--chat-bubble-ai-border)",
  };

  // Answered state: show question text only, buttons gone, AI reply comes as a chat message
  if (responded || !isParent) {
    return (
      <div style={bubbleStyle}>
        <p>{messageContent}</p>
      </div>
    );
  }

  return (
    <div style={{ ...bubbleStyle, padding: 0, overflow: "hidden" }}>
      {data.isMatchCall && data.dueAt && (
        <div
          className="flex items-center gap-2 font-medium border-b"
          style={{
            padding: "8px var(--chat-bubble-px, 16px)",
            fontSize: "var(--chat-bubble-font-size, 12px)",
            background: "hsl(var(--brand-warning) / 0.1)",
            color: "hsl(var(--brand-warning))",
          }}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>24-hour hold - surrogate reserved for you</span>
        </div>
      )}
      <div style={{ padding: "var(--chat-bubble-py, 11px) var(--chat-bubble-px, 16px)" }} className="space-y-3">
        <p>{messageContent}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={handleYesReady}
            className="transition-all hover:opacity-90 font-medium"
            style={{ ...chipBase, ...(positiveChipStyle ?? { backgroundColor: brandColor ?? "#004D4D", color: "#ffffff", border: "none" }) }}
          >
            <ThumbsUp className="shrink-0" style={{ width: "13px", height: "13px", marginRight: "5px" }} />
            {data.buttonLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="transition-all hover:opacity-90 font-medium"
            style={{ ...chipBase, ...(declineChipStyle ?? { backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))", border: "none" }) }}
            onClick={handleNeedMoreTime}
            data-testid="readiness-need-more-time"
          >
            <Clock className="shrink-0" style={{ width: "13px", height: "13px", marginRight: "5px" }} />
            Need more time
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="transition-all hover:opacity-90 font-medium"
            style={{ ...chipBase, ...(declineChipStyle ?? { backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))", border: "none" }) }}
            onClick={handleNotYet}
            data-testid="readiness-not-yet"
          >
            Not Yet
          </Button>
        </div>
      </div>
    </div>
  );
}
