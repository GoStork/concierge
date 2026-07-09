/**
 * /chat/:sessionId -> resolves to the canonical /chat/:entityId/:subjectId.
 *
 * Used by post-payment success redirects (Stripe sends parents to
 * `/chat/<invoice.sessionId>` after payment) and the Home dashboards'
 * deep links (work queue / cost sheets). Role-aware: parents resolve via
 * their own session list; PROVIDERS resolve via the provider inbox -
 * /api/my/chat-sessions only returns sessions the user owns as a parent,
 * so a provider lookup there always missed and dumped them on /chat with
 * the ?msg= deep link lost. Replaces the URL in-place so the back button
 * doesn't return to this resolver, and preserves the query string.
 */
import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { hasProviderRole } from "@shared/roles";

interface ResolvableSession {
  id: string;
  providerId?: string | null;
  subjectProfileId?: string | null;
  // Provider-side sessions: the entity in the canonical URL is the PARENT.
  userId?: string | null;
}

export default function ChatSessionRedirect() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  // Preserve query params (?msg=... deep links from the Home dashboards)
  const { search } = useLocation();
  const { user } = useAuth();
  const isProvider = hasProviderRole((user as any)?.roles || []);

  const endpoint = isProvider ? "/api/provider/concierge-sessions" : "/api/my/chat-sessions";
  const { data: sessions, isLoading, isError } = useQuery<ResolvableSession[]>({
    queryKey: [endpoint, "session-redirect"],
    queryFn: async () => {
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load chat sessions");
      return res.json();
    },
    enabled: !!user,
  });

  useEffect(() => {
    if (!sessionId || isLoading || !user) return;
    if (isError || !sessions) {
      navigate("/chat", { replace: true });
      return;
    }
    const match = sessions.find(s => s.id === sessionId);
    if (!match) {
      navigate("/chat", { replace: true });
      return;
    }
    const entityId = isProvider ? match.userId : (match.providerId || match.userId);
    const subjectId = match.subjectProfileId || match.id;
    if (entityId) {
      navigate(`/chat/${entityId}/${subjectId}${search || ""}`, { replace: true });
    } else {
      navigate("/chat", { replace: true });
    }
  }, [sessionId, sessions, isLoading, isError, navigate, search, isProvider, user]);

  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
    </div>
  );
}
