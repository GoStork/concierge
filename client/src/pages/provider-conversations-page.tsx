import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, MessageSquare, Send, User, Clock, Loader2, FileText,
  MapPin, Mail, CheckCircle2, UserPlus, Shield, ThumbsUp, ThumbsDown,
} from "lucide-react";
import { hasProviderRole } from "@shared/roles";

interface SessionSummary {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
  status: string;
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
  providerId: string | null;
  providerJoinedAt: string | null;
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

export default function ProviderConversationsPage() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const brandColor = brand?.primaryColor || "#004D4D";
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  const roles: string[] = (user as any)?.roles || [];
  const isProvider = hasProviderRole(roles) || (roles.includes("GOSTORK_ADMIN") && !!(user as any)?.providerId);
  if (!isProvider) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground" data-testid="provider-conversations-unauthorized">
        You don't have permission to access this page.
      </div>
    );
  }

  const sessionsQuery = useQuery<SessionSummary[]>({
    queryKey: ["/api/provider/concierge-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/provider/concierge-sessions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const sessionDetailQuery = useQuery<SessionDetail>({
    queryKey: ["/api/provider/concierge-sessions", selectedSessionId],
    queryFn: async () => {
      const res = await fetch(`/api/provider/concierge-sessions/${selectedSessionId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!selectedSessionId,
    refetchInterval: 5000,
  });

  const joinMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to join");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ sessionId, content }: { sessionId: string; content: string }) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/message`, {
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
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
  });

  const consultationStatusMutation = useMutation({
    mutationFn: async ({ sessionId, status }: { sessionId: string; status: string }) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/consultation-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
  });

  const generateAgreementMutation = useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      const res = await fetch("/api/agreements/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to generate agreement" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
    },
  });

  const sessions = sessionsQuery.data || [];
  const detail = sessionDetailQuery.data;
  const profile = detail?.user?.parentAccount?.intendedParentProfile;
  const hasJoined = !!detail?.providerJoinedAt;

  const handleSendReply = () => {
    if (!replyText.trim() || !selectedSessionId) return;
    sendMessageMutation.mutate({ sessionId: selectedSessionId, content: replyText.trim() });
  };

  if (selectedSessionId && detail) {
    return (
      <div className="flex flex-col h-[calc(100vh-64px)]" data-testid="provider-conversations-detail">
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
              <img src={detail.user.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
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
          {hasJoined ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium" data-testid="badge-provider-joined">
              <CheckCircle2 className="w-3 h-3" />
              Joined
            </div>
          ) : (
            <Button
              size="sm"
              className="h-8 text-xs text-white gap-1"
              style={{ backgroundColor: brandColor }}
              onClick={() => joinMutation.mutate(selectedSessionId)}
              disabled={joinMutation.isPending}
              data-testid="btn-join-conversation"
            >
              {joinMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
              Join Conversation
            </Button>
          )}
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 flex flex-col">
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="provider-chat-messages">
              {detail.messages.map((msg, i) => (
                <div key={msg.id}>
                  {msg.role === "assistant" && msg.senderType === "human" && (
                    <div className="flex items-center gap-1.5 mb-1 ml-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white bg-slate-600">
                        GoStork Expert
                      </div>
                      {msg.senderName && <span className="text-[11px] text-muted-foreground">{msg.senderName}</span>}
                    </div>
                  )}
                  {msg.role === "assistant" && msg.senderType === "provider" && (
                    <div className="flex items-center gap-1.5 mb-1 ml-1">
                      <div
                        className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full text-white"
                        style={{ backgroundColor: brandColor }}
                      >
                        Agency Expert
                      </div>
                      {msg.senderName && <span className="text-[11px] text-muted-foreground">{msg.senderName}</span>}
                    </div>
                  )}
                  {msg.role === "assistant" && msg.senderType === "system" && (
                    <div className="flex items-center gap-1.5 mb-1 ml-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-violet-600 text-white">
                        Eva
                      </div>
                    </div>
                  )}
                  <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "bg-blue-100 text-blue-900"
                          : msg.senderType === "provider"
                          ? "text-foreground border-2"
                          : msg.senderType === "human"
                          ? "bg-slate-100 text-foreground"
                          : msg.senderType === "system"
                          ? "bg-violet-50 text-violet-900 border border-violet-200"
                          : "bg-muted text-foreground"
                      }`}
                      style={
                        msg.senderType === "provider"
                          ? { borderColor: brandColor, backgroundColor: `${brandColor}08` }
                          : undefined
                      }
                      data-testid={`provider-msg-${i}`}
                    >
                      {msg.content}
                    </div>
                  </div>
                  <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} mt-0.5`}>
                    <span className="text-[10px] text-muted-foreground">
                      {msg.role === "user" ? "Parent" : msg.senderType === "provider" ? "You" : msg.senderType === "human" ? "GoStork" : msg.senderType === "system" ? "System" : "AI"} · {timeAgo(msg.createdAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {hasJoined ? (
              <div className="border-t px-4 py-3 bg-background" data-testid="provider-reply-area">
                <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                  <Shield className="w-3 h-3" />
                  <span>Sending as <strong className="text-foreground">Agency Expert</strong></span>
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Type a message to the parent..."
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
                    data-testid="input-provider-message"
                  />
                  <Button
                    size="sm"
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || sendMessageMutation.isPending}
                    className="h-10 px-4 text-white"
                    style={{ backgroundColor: brandColor }}
                    data-testid="btn-send-provider-message"
                  >
                    {sendMessageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="border-t px-4 py-4 bg-muted/30 text-center" data-testid="provider-join-prompt">
                <p className="text-sm text-muted-foreground mb-2">Join this conversation to start chatting with the parent</p>
                <Button
                  size="sm"
                  className="text-white gap-1"
                  style={{ backgroundColor: brandColor }}
                  onClick={() => joinMutation.mutate(selectedSessionId)}
                  disabled={joinMutation.isPending}
                  data-testid="btn-join-conversation-bottom"
                >
                  {joinMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                  Join Conversation
                </Button>
              </div>
            )}
          </div>

          <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden md:block" data-testid="provider-sidebar">
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
              )}
            </div>

            {hasJoined && (
              <div className="border-t pt-4 mt-4" data-testid="consultation-status-section">
                <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Consultation Status</h4>
                <div className="space-y-2">
                  <Button
                    size="sm"
                    className="w-full text-white gap-1.5 text-xs"
                    style={{ backgroundColor: "var(--brand-success, #22c55e)" }}
                    onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId, status: "READY_FOR_MATCH" })}
                    disabled={consultationStatusMutation.isPending}
                    data-testid="btn-ready-for-match"
                  >
                    {consultationStatusMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
                    Completed — Ready for Match
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-1.5 text-xs border-destructive text-destructive hover:bg-destructive hover:text-white"
                    onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId, status: "NOT_A_FIT" })}
                    disabled={consultationStatusMutation.isPending}
                    data-testid="btn-not-a-fit"
                  >
                    {consultationStatusMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsDown className="w-3 h-3" />}
                    Completed — Not a Fit
                  </Button>
                </div>
              </div>
            )}

            {hasJoined && (
              <div className="border-t pt-4 mt-4" data-testid="agreement-section">
                <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Agreement</h4>
                <Button
                  size="sm"
                  className="w-full gap-1.5 text-xs"
                  style={{ backgroundColor: brandColor }}
                  onClick={() => {
                    if (selectedSessionId) {
                      generateAgreementMutation.mutate({ sessionId: selectedSessionId });
                    }
                  }}
                  disabled={generateAgreementMutation.isPending}
                  data-testid="btn-generate-agreement"
                >
                  {generateAgreementMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                  Generate & Send Agreement
                </Button>
                {generateAgreementMutation.isError && (
                  <p className="text-xs text-destructive mt-1.5" data-testid="text-agreement-error">
                    {(generateAgreementMutation.error as Error)?.message || "Failed to generate agreement"}
                  </p>
                )}
                {generateAgreementMutation.isSuccess && (
                  <p className="text-xs text-green-600 mt-1.5" data-testid="text-agreement-success">
                    Agreement sent successfully
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto" data-testid="provider-conversations-page">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: "var(--font-display)" }}>Live Conversations</h1>
        <p className="text-muted-foreground text-sm mt-1">Chat with prospective parents who are interested in your services</p>
      </div>

      {sessionsQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <MessageSquare className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No conversations yet</p>
            <p className="text-xs text-muted-foreground mt-1">When parents request a consultation, their conversations will appear here</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => (
            <Card
              key={s.id}
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={() => setSelectedSessionId(s.id)}
              data-testid={`provider-session-card-${s.id}`}
            >
              <CardContent className="py-4 px-5">
                <div className="flex items-start gap-3">
                  {s.userAvatar ? (
                    <img src={s.userAvatar} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-5 h-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{s.userName || "Unknown"}</span>
                      {s.providerJoinedAt ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-[10px] font-bold uppercase">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          Joined
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase">
                          <UserPlus className="w-2.5 h-2.5" />
                          New
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{s.userEmail}</p>
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
                      data-testid={`btn-view-chat-${s.id}`}
                    >
                      <MessageSquare className="w-3 h-3 mr-1" />
                      {s.providerJoinedAt ? "View Chat" : "Join Chat"}
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
