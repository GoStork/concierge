/**
 * /chat/:sessionId -> resolves to the canonical /chat/:entityId/:subjectId.
 *
 * Used by post-payment success redirects (Stripe sends parents to
 * `/chat/<invoice.sessionId>` after payment) and any other place that only
 * has a session id on hand. Looks up the session via the existing
 * /api/my/chat-sessions list and replaces the URL in-place so the back
 * button doesn't return to this resolver.
 */
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

interface MySession {
  id: string;
  providerId?: string | null;
  subjectProfileId?: string | null;
  // Provider-side sessions have a userId instead of providerId; same field
  // semantics as buildChatUrl in conversations-page.tsx.
  userId?: string | null;
}

export default function ChatSessionRedirect() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const { data: sessions, isLoading, isError } = useQuery<MySession[]>({
    queryKey: ["/api/my/chat-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/my/chat-sessions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load chat sessions");
      return res.json();
    },
  });

  useEffect(() => {
    if (!sessionId || isLoading) return;
    if (isError || !sessions) {
      navigate("/chat", { replace: true });
      return;
    }
    const match = sessions.find(s => s.id === sessionId);
    if (!match) {
      navigate("/chat", { replace: true });
      return;
    }
    const entityId = match.providerId || match.userId;
    const subjectId = match.subjectProfileId || match.id;
    if (entityId) {
      navigate(`/chat/${entityId}/${subjectId}`, { replace: true });
    } else {
      navigate("/chat", { replace: true });
    }
  }, [sessionId, sessions, isLoading, isError, navigate]);

  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
    </div>
  );
}
