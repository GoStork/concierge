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
 */

import type React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ThumbsUp, Clock, Loader2, CheckCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface ReadinessPromptData {
  bookingId?: string;
  providerName: string;
  providerType: string;
  isMatchCall: boolean;
  dueAt?: string | null;
  buttonLabel: string;
  yesAction: string;
  noAction: string;
  answered?: "yes" | "no"; // DB-persisted
}

interface ReadinessPromptCardProps {
  data: ReadinessPromptData;
  messageId: string;
  sessionId: string;
  messageContent: string;
  isParent?: boolean;
  isAnswered?: boolean; // derived from message history by the parent component
  brandColor?: string;
}

/** Persist answered state to DB so data.answered is correct on next load */
async function markAnswered(messageId: string, answer: "yes" | "no") {
  await fetch("/api/billing/readiness-prompt-respond", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ messageId, answer }),
  });
}

export function ReadinessPromptCard({ data, messageId, sessionId, messageContent, isParent = true, isAnswered, brandColor }: ReadinessPromptCardProps) {
  // Priority: isAnswered (history-based) > data.answered (DB flag) > local state
  const alreadyAnswered = isAnswered ?? !!data.answered;
  const [responded, setResponded] = useState(alreadyAnswered);
  const [response, setResponse] = useState<"yes" | "no" | null>(
    alreadyAnswered ? (data.answered === "no" ? "no" : "yes") : null
  );

  const queryClient = useQueryClient();

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await markAnswered(messageId, "yes");
      const res = await fetch("/api/billing/parent-confirm-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) throw new Error("Failed to confirm");
      return res.json();
    },
    onSuccess: () => {
      setResponded(true);
      setResponse("yes");
      // Refresh messages so the "Thank you" system message appears and
      // the isAnswered derivation picks it up on the next render
      queryClient.invalidateQueries({ queryKey: [`/api/ai-concierge/session/${sessionId}/messages`] });
    },
  });

  const handleNotYet = async () => {
    setResponded(true);
    setResponse("no");
    markAnswered(messageId, "no").catch(() => {});
  };

  // Show disabled / confirmed state
  const bubbleStyle: React.CSSProperties = {
    fontSize: "var(--chat-bubble-font-size, 14px)",
    lineHeight: "var(--chat-bubble-line-height, 1.35)",
    borderRadius: "var(--chat-bubble-radius, 20px)",
    paddingLeft: "var(--chat-bubble-px, 16px)",
    paddingRight: "var(--chat-bubble-px, 16px)",
    paddingTop: "var(--chat-bubble-py, 11px)",
    paddingBottom: "var(--chat-bubble-py, 11px)",
    maxWidth: "var(--chat-bubble-max-width, 85%)",
    backgroundColor: brandColor ? `${brandColor}14` : "hsl(var(--background))",
    border: brandColor ? `1px solid ${brandColor}33` : "1px solid hsl(var(--border))",
  };

  if (responded || !isParent) {
    const wasYes = response === "yes" || (alreadyAnswered && data.answered !== "no");
    return (
      <div style={bubbleStyle}>
        <p className="text-muted-foreground">{messageContent}</p>
        {wasYes ? (
          <p className="mt-2 flex items-center gap-1.5 font-medium" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle className="w-3.5 h-3.5" />
            Ready to move forward - invoice coming shortly.
          </p>
        ) : (
          <p className="mt-2 text-muted-foreground">No problem - take your time. We'll follow up with you soon.</p>
        )}
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
      <div style={{ padding: "var(--chat-bubble-py, 11px) var(--chat-bubble-px, 16px)" }} className="space-y-4">
        <p>{messageContent}</p>
        <div className="flex gap-2">
          <Button
            disabled={confirmMutation.isPending}
            onClick={() => confirmMutation.mutate()}
            className="flex-1"
          >
            {confirmMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
            ) : (
              <ThumbsUp className="w-3.5 h-3.5 mr-1.5" />
            )}
            {data.buttonLabel}
          </Button>
          <Button variant="secondary" className="flex-1" onClick={handleNotYet}>
            Not Yet
          </Button>
        </div>
      </div>
    </div>
  );
}
