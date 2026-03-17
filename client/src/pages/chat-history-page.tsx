import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { Loader2, MessageCircle, Plus, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatSession {
  id: string;
  title: string | null;
  status: string;
  matchmakerId: string | null;
  matchmakerName: string | null;
  matchmakerAvatar: string | null;
  matchmakerTitle: string | null;
  providerId: string | null;
  providerName: string | null;
  providerLogo: string | null;
  providerJoinedAt: string | null;
  humanRequested: boolean;
  lastMessage: string | null;
  lastMessageAt: string;
  lastMessageSenderType: string | null;
  createdAt: string;
  updatedAt: string;
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function truncateMessage(msg: string, maxLen = 80): string {
  const cleaned = msg.replace(/\[\[.*?\]\]/g, "").replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen) + "...";
}

export default function ChatHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: brandSettings } = useBrandSettings();
  const brandColor = brandSettings?.primaryColor || "#004D4D";

  const { data: sessions, isLoading } = useQuery<ChatSession[]>({
    queryKey: ["/api/my/chat-sessions"],
    enabled: !!user,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]" data-testid="chat-history-loading">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const allSessions = sessions || [];
  const providerConversations = allSessions.filter(s => s.providerJoinedAt && s.providerName);
  const providerSessionIds = new Set(providerConversations.map(s => s.id));
  const evaConversations = allSessions.filter(s => !providerSessionIds.has(s.id));

  return (
    <div className="max-w-lg mx-auto px-4 pt-6 pb-24" data-testid="chat-history-page">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold" data-testid="text-chat-history-title">
          Chats
        </h1>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 p-0 rounded-full"
          onClick={() => navigate("/matchmaker-selection")}
          data-testid="btn-new-chat"
          title="New conversation"
        >
          <Plus className="w-5 h-5" />
        </Button>
      </div>

      {(!sessions || sessions.length === 0) && (
        <div className="flex flex-col items-center justify-center py-16 text-center" data-testid="chat-history-empty">
          <MessageCircle className="w-12 h-12 text-muted-foreground mb-4" />
          <h2 className="font-display text-lg font-semibold mb-2">No conversations yet</h2>
          <p className="text-muted-foreground text-sm mb-6">
            Start a conversation with your AI concierge to get personalized fertility guidance.
          </p>
          <Button
            onClick={() => navigate("/matchmaker-selection")}
            data-testid="btn-start-first-chat"
            style={{ backgroundColor: brandColor }}
            className="text-white"
          >
            Start a Conversation
          </Button>
        </div>
      )}

      {evaConversations.length > 0 && (
        <div className="mb-6" data-testid="section-eva-chats">
          {evaConversations.map((session) => (
            <button
              key={session.id}
              className="w-full flex items-center gap-3 px-3 py-4 rounded-xl hover:bg-muted/50 transition-colors text-left border-b border-border/30 last:border-b-0"
              onClick={() => {
                const params = new URLSearchParams();
                if (session.matchmakerId) params.set("matchmaker", session.matchmakerId);
                params.set("session", session.id);
                navigate(`/concierge?${params.toString()}`);
              }}
              data-testid={`chat-session-${session.id}`}
            >
              {session.matchmakerAvatar ? (
                <img
                  src={session.matchmakerAvatar}
                  alt={session.matchmakerName || "Eva"}
                  className="w-12 h-12 rounded-full object-cover border flex-shrink-0"
                />
              ) : (
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center text-white text-lg font-bold flex-shrink-0"
                  style={{ backgroundColor: brandColor }}
                >
                  {(session.matchmakerName || "E").charAt(0)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate" data-testid={`text-session-name-${session.id}`}>
                    {session.matchmakerName || "Eva"}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {formatTimeAgo(session.lastMessageAt)}
                  </span>
                </div>
                {session.matchmakerTitle && (
                  <span className="text-xs text-muted-foreground">{session.matchmakerTitle}</span>
                )}
                {session.lastMessage && (
                  <p className="text-sm text-muted-foreground truncate mt-0.5" data-testid={`text-last-message-${session.id}`}>
                    {truncateMessage(session.lastMessage)}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {providerConversations.length > 0 && (
        <div data-testid="section-provider-chats">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-3 mb-2">
            Provider Conversations
          </h3>
          {providerConversations.map((session) => (
            <button
              key={session.id}
              className="w-full flex items-center gap-3 px-3 py-4 rounded-xl hover:bg-muted/50 transition-colors text-left border-b border-border/30 last:border-b-0"
              onClick={() => {
                const params = new URLSearchParams();
                if (session.matchmakerId) params.set("matchmaker", session.matchmakerId);
                params.set("session", session.id);
                navigate(`/concierge?${params.toString()}`);
              }}
              data-testid={`chat-session-provider-${session.id}`}
            >
              {session.providerLogo ? (
                <img
                  src={session.providerLogo}
                  alt={session.providerName || "Provider"}
                  className="w-12 h-12 rounded-full object-cover border flex-shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-full flex items-center justify-center bg-muted text-muted-foreground flex-shrink-0">
                  <Building2 className="w-5 h-5" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm truncate">
                    {session.providerName}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {formatTimeAgo(session.lastMessageAt)}
                  </span>
                </div>
                {session.lastMessage && (
                  <p className="text-sm text-muted-foreground truncate mt-0.5">
                    {truncateMessage(session.lastMessage)}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
