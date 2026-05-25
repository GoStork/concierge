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
  if (responded || !isParent) {
    const wasYes = response === "yes" || (alreadyAnswered && data.answered !== "no");
    return (
      <div
        className="rounded-xl px-4 py-3 max-w-sm text-sm"
        style={{
          backgroundColor: brandColor ? `${brandColor}14` : "hsl(var(--background))",
          border: brandColor ? `1px solid ${brandColor}33` : "1px solid hsl(var(--border))",
        }}
      >
        <p className="text-muted-foreground">{messageContent}</p>
        {wasYes ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle className="w-3.5 h-3.5" />
            Ready to move forward - invoice coming shortly.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">No problem - take your time. We'll follow up with you soon.</p>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-xl overflow-hidden max-w-sm"
      style={{
        backgroundColor: brandColor ? `${brandColor}14` : "hsl(var(--background))",
        border: brandColor ? `1px solid ${brandColor}33` : "1px solid hsl(var(--border))",
      }}
    >
      {data.isMatchCall && data.dueAt && (
        <div className="px-4 py-2 flex items-center gap-2 text-xs font-medium border-b" style={{ background: "hsl(var(--brand-warning) / 0.1)", color: "hsl(var(--brand-warning))" }}>
          <Clock className="w-3.5 h-3.5" />
          <span>24-hour hold - surrogate reserved for you</span>
        </div>
      )}
      <div className="px-4 py-4 space-y-4">
        <p className="text-sm">{messageContent}</p>
        <div className="flex gap-2">
          <Button
            disabled={confirmMutation.isPending}
            onClick={() => confirmMutation.mutate()}
            className="flex-1"
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
          >
            {confirmMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
            ) : (
              <ThumbsUp className="w-3.5 h-3.5 mr-1.5" />
            )}
            {data.buttonLabel}
          </Button>
          <Button variant="outline" className="flex-1" onClick={handleNotYet}>
            Not Yet
          </Button>
        </div>
      </div>
    </div>
  );
}
