import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Headphones, MessageCircle, Send, User, AlertTriangle, Clock, CheckCircle2, Loader2, MapPin, Mail } from "lucide-react";

interface SessionSummary {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
  status: string;
  humanRequested: boolean;
  humanJoinedAt: string | null;
  providerId: string | null;
  providerName: string | null;
  providerLogo: string | null;
  providerJoinedAt: string | null;
  messageCount: number;
  lastMessage: string | null;
  lastMessageAt: string;
  createdAt: string;
}

interface SessionMessage {
  id: string;
  role: string;
  content: string;
  senderType: string;
  senderName: string | null;
  createdAt: string;
}

interface SessionDetail {
  id: string;
  userId: string;
  status: string;
  humanRequested: boolean;
  humanJoinedAt: string | null;
  humanAgentId: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    city: string | null;
    state: string | null;
    parentAccount?: {
      intendedParentProfile?: {
        journeyStage: string | null;
        eggSource: string | null;
        spermSource: string | null;
        carrier: string | null;
        hasEmbryos: boolean | null;
        embryoCount: number | null;
      } | null;
    } | null;
  };
  messages: SessionMessage[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function AdminConciergeMonitor() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const brandColor = brand?.primaryColor || "#004D4D";
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  const roles: string[] = (user as any)?.roles || [];
  const isAdmin = roles.includes("GOSTORK_ADMIN");
  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground" data-testid="concierge-monitor-unauthorized">
        You don't have permission to access this page.
      </div>
    );
  }

  const sessionsQuery = useQuery<SessionSummary[]>({
    queryKey: ["/api/admin/concierge-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/admin/concierge-sessions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const sessionDetailQuery = useQuery<SessionDetail>({
    queryKey: ["/api/admin/concierge-sessions", selectedSessionId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/concierge-sessions/${selectedSessionId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!selectedSessionId,
    refetchInterval: 5000,
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ sessionId, content }: { sessionId: string; content: string }) => {
      const res = await fetch(`/api/admin/concierge-sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("Failed to send");
      return res.json();
    },
    onSuccess: () => {
      setReplyText("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] });
    },
  });

  const sessions = sessionsQuery.data || [];
  const detail = sessionDetailQuery.data;
  const profile = detail?.user?.parentAccount?.intendedParentProfile;

  const handleSendReply = () => {
    if (!replyText.trim() || !selectedSessionId) return;
    sendMessageMutation.mutate({ sessionId: selectedSessionId, content: replyText.trim() });
  };

  if (selectedSessionId && detail) {
    return (
      <div className="flex flex-col h-[calc(100vh-64px)]" data-testid="concierge-monitor-detail">
        <div className="flex items-center gap-3 px-4 py-3 border-b bg-background">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setSelectedSessionId(null)}
            data-testid="btn-back-to-sessions"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2 flex-1">
            {detail.user.avatarUrl ? (
              <img src={getPhotoSrc(detail.user.avatarUrl) || undefined} alt="" className="w-8 h-8 rounded-full object-cover" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
            )}
            <div>
              <h3 className="font-semibold text-sm">{detail.user.name || "Unknown"}</h3>
              <p className="text-xs text-muted-foreground">{detail.user.email}</p>
            </div>
          </div>
          {detail.humanRequested && !detail.humanJoinedAt && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] text-xs font-medium" data-testid="badge-awaiting-human">
              <AlertTriangle className="w-3 h-3" />
              Awaiting Human
            </div>
          )}
          {detail.humanJoinedAt && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))] text-xs font-medium" data-testid="badge-human-joined">
              <CheckCircle2 className="w-3 h-3" />
              Human Joined
            </div>
          )}
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 flex flex-col">
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="concierge-monitor-messages">
              {detail.messages.map((msg, i) => (
                <div key={msg.id}>
                  {msg.role === "assistant" && msg.senderType === "human" && (
                    <div className="flex items-center gap-1.5 mb-1 ml-1">
                      <div
                        className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white"
                        style={{ backgroundColor: brandColor }}
                      >
                        GoStork Expert
                      </div>
                      {msg.senderName && (
                        <span className="text-[11px] text-muted-foreground">{msg.senderName}</span>
                      )}
                    </div>
                  )}
                  {msg.role === "assistant" && msg.senderType === "provider" && (
                    <div className="flex items-center gap-1.5 mb-1 ml-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white bg-[hsl(var(--brand-success))]">
                        Provider
                      </div>
                      {msg.senderName && (
                        <span className="text-[11px] text-muted-foreground">{msg.senderName}</span>
                      )}
                    </div>
                  )}
                  {msg.role === "assistant" && msg.senderType === "system" && (
                    <div className="flex items-center gap-1.5 mb-1 ml-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[hsl(var(--accent))] text-white">
                        Eva
                      </div>
                    </div>
                  )}
                  <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "text-white"
                          : msg.senderType === "human"
                          ? "text-foreground border-2"
                          : msg.senderType === "provider"
                          ? "text-foreground border-2 border-[hsl(var(--brand-success))]/30"
                          : msg.senderType === "system"
                          ? "bg-[hsl(var(--accent))]/10 text-[hsl(var(--accent))] border border-[hsl(var(--accent))]/30"
                          : "bg-muted text-foreground"
                      }`}
                      style={
                        msg.role === "user"
                          ? { backgroundColor: brandColor }
                          : msg.senderType === "human"
                          ? { borderColor: brandColor, backgroundColor: `${brandColor}08` }
                          : msg.senderType === "provider"
                          ? { backgroundColor: "#ecfdf508" }
                          : undefined
                      }
                      data-testid={`monitor-msg-${i}`}
                    >
                      {msg.content}
                    </div>
                  </div>
                  <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} mt-0.5`}>
                    <span className="text-[10px] text-muted-foreground">
                      {msg.role === "user" ? "Parent" : msg.senderType === "human" ? "Human" : msg.senderType === "provider" ? "Provider" : msg.senderType === "system" ? "System" : "AI"} · {timeAgo(msg.createdAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t px-4 py-3 bg-background" data-testid="concierge-monitor-reply">
              <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                <Headphones className="w-3 h-3" />
                <span>Sending as <strong className="text-foreground">GoStork Expert</strong> — {(user as any)?.name || "Admin"}</span>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Type a message as GoStork Expert..."
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendReply();
                    }
                  }}
                  disabled={sendMessageMutation.isPending}
                  className="flex-1"
                  data-testid="input-expert-message"
                />
                <Button
                  size="sm"
                  onClick={handleSendReply}
                  disabled={!replyText.trim() || sendMessageMutation.isPending}
                  className="h-10 px-4 text-white"
                  style={{ backgroundColor: brandColor }}
                  data-testid="btn-send-expert-message"
                >
                  {sendMessageMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>

          <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden md:block" data-testid="concierge-monitor-profile">
            <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Parent Profile</h4>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm">{detail.user.name || "—"}</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm truncate">{detail.user.email}</span>
              </div>
              {(detail.user.city || detail.user.state) && (
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm">{[detail.user.city, detail.user.state].filter(Boolean).join(", ")}</span>
                </div>
              )}
              {profile && (
                <>
                  <div className="border-t pt-3 mt-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Journey Details</p>
                    <div className="space-y-1.5">
                      {profile.journeyStage && (
                        <div className="text-sm"><span className="text-muted-foreground">Stage:</span> {profile.journeyStage}</div>
                      )}
                      {profile.eggSource && (
                        <div className="text-sm"><span className="text-muted-foreground">Egg Source:</span> {profile.eggSource}</div>
                      )}
                      {profile.spermSource && (
                        <div className="text-sm"><span className="text-muted-foreground">Sperm Source:</span> {profile.spermSource}</div>
                      )}
                      {profile.carrier && (
                        <div className="text-sm"><span className="text-muted-foreground">Carrier:</span> {profile.carrier}</div>
                      )}
                      {profile.hasEmbryos !== null && (
                        <div className="text-sm"><span className="text-muted-foreground">Embryos:</span> {profile.hasEmbryos ? `Yes (${profile.embryoCount || "??"})` : "No"}</div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto" data-testid="concierge-monitor-page">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-display)" }}>Concierge Command Center</h1>
        <p className="text-muted-foreground text-sm mt-1">Monitor active AI conversations and join as a human concierge</p>
      </div>

      {sessionsQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <MessageCircle className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No active AI conversations right now</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => (
            <Card
              key={s.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => setSelectedSessionId(s.id)}
              data-testid={`session-card-${s.id}`}
            >
              <CardContent className="py-4 px-5">
                <div className="flex items-start gap-3">
                  {s.userAvatar ? (
                    <img src={getPhotoSrc(s.userAvatar) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-5 h-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{s.userName || "Unknown"}</span>
                      {s.humanRequested && !s.humanJoinedAt && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] text-[10px] font-bold uppercase" data-testid={`badge-escalated-${s.id}`}>
                          <AlertTriangle className="w-2.5 h-2.5" />
                          Needs Human
                        </span>
                      )}
                      {s.humanJoinedAt && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[10px] font-bold uppercase">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          Human Active
                        </span>
                      )}
                      {s.providerJoinedAt && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[10px] font-bold uppercase" data-testid={`badge-provider-active-${s.id}`}>
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          Provider Active
                        </span>
                      )}
                      {s.providerId && !s.providerJoinedAt && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--accent))]/15 text-[hsl(var(--accent))] text-[10px] font-bold uppercase">
                          Provider Assigned
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{s.userEmail}</p>
                    {s.providerName && (
                      <p className="text-xs text-[hsl(var(--brand-success))] mt-0.5">Provider: {s.providerName}</p>
                    )}
                    {s.lastMessage && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">{s.lastMessage}</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="w-3 h-3" />
                      {timeAgo(s.lastMessageAt)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{s.messageCount} msgs</div>
                    <Button
                      size="sm"
                      className="mt-2 h-7 text-xs text-white"
                      style={{ backgroundColor: brandColor }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedSessionId(s.id);
                      }}
                      data-testid={`btn-join-chat-${s.id}`}
                    >
                      <Headphones className="w-3 h-3 mr-1" />
                      Join Chat
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
