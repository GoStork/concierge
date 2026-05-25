/**
 * In-chat readiness prompt card.
 * Rendered when a chat message has uiCardType === "readiness_prompt".
 * Shown after a video call ends - asks parent if they're ready to move forward.
 *
 * Answered state is persisted in uiCardData.answered (DB) so the card stays
 * disabled across page reloads. Local state is only used for optimistic updates.
 */

import { useMutation } from "@tanstack/react-query";
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
  answered?: "yes" | "no"; // persisted in DB after parent responds
}

interface ReadinessPromptCardProps {
  data: ReadinessPromptData;
  messageId: string;       // DB message ID - used to persist answered state
  sessionId: string;
  messageContent: string;
  isParent?: boolean;
}

/** Persist answered state to DB so the card stays disabled on reload */
async function markAnswered(messageId: string, answer: "yes" | "no") {
  await fetch("/api/billing/readiness-prompt-respond", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ messageId, answer }),
  });
}

export function ReadinessPromptCard({ data, messageId, sessionId, messageContent, isParent = true }: ReadinessPromptCardProps) {
  // Initialize from DB-persisted value so state survives page reloads
  const [responded, setResponded] = useState(!!data.answered);
  const [response, setResponse] = useState<"yes" | "no" | null>(data.answered ?? null);

  const confirmMutation = useMutation({
    mutationFn: async () => {
      // 1. Mark the card as answered in the DB (optimistic - do first)
      await markAnswered(messageId, "yes");
      // 2. Trigger the billing flow
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
    },
  });

  const handleNotYet = async () => {
    setResponded(true);
    setResponse("no");
    markAnswered(messageId, "no").catch(() => {}); // fire and forget
  };

  // Already answered (either from DB state or this session's interaction)
  if (responded || !isParent) {
    return (
      <div className="rounded-xl border px-4 py-3 max-w-sm text-sm" style={{ background: "hsl(var(--background))" }}>
        <p className="text-muted-foreground">{messageContent}</p>
        {(responded || data.answered) && (response === "yes" || data.answered === "yes") && (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle className="w-3.5 h-3.5" />
            Ready to move forward - invoice coming shortly.
          </p>
        )}
        {(responded || data.answered) && (response === "no" || data.answered === "no") && (
          <p className="mt-2 text-sm text-muted-foreground">No problem - take your time. We'll follow up with you soon.</p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border overflow-hidden max-w-sm" style={{ background: "hsl(var(--background))" }}>
      {/* Urgency indicator for surrogacy */}
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

          <Button
            variant="outline"
            className="flex-1"
            onClick={handleNotYet}
          >
            Not Yet
          </Button>
        </div>
      </div>
    </div>
  );
}
