import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";
import { deriveChatPalette } from "@/lib/chat-palette";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Headphones, MessageCircle, User, Clock, CheckCircle2, Loader2, UserPlus, LogOut, Trash2,
} from "lucide-react";
import {
  timeAgo,
  ConversationsShell,
  ChatMessageList,
  ChatInputBar,
  ExpertSenderLabel,
  ChatProfileSidebar,
  InlineVideoOverlay,
  type SessionDetail,
} from "@/components/chat";
import { useToast } from "@/hooks/use-toast";

interface SessionSummary {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
  status: string;
  humanRequested: boolean;
  humanJoinedAt: string | null;
  humanConcludedAt: string | null;
  providerId: string | null;
  providerName: string | null;
  providerLogo: string | null;
  providerJoinedAt: string | null;
  messageCount: number;
  lastMessage: string | null;
  lastMessageAt: string;
  unreadCount: number;
  createdAt: string;
}

export default function AdminConciergeMonitor() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const brandColor = brand?.primaryColor || "#004D4D";
  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionIdFromUrl = searchParams.get("sessionId");
  const lastChatKey = user ? `lastAdminChatSessionId:${(user as any).id}` : null;
  const [selectedSessionId, _setSelectedSessionId] = useState<string | null>(sessionIdFromUrl);
  const setSelectedSessionId = (id: string | null) => {
    _setSelectedSessionId(id);
    if (id) {
      if (lastChatKey) localStorage.setItem(lastChatKey, id);
      setSearchParams({ sessionId: id }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  };
  const [uploading, setUploading] = useState(false);
  const [inlineVideoBookingId, setInlineVideoBookingId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

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

  const sessionBookingsQuery = useQuery<any[]>({
    queryKey: ["/api/chat-session/bookings", selectedSessionId],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${selectedSessionId}/bookings`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedSessionId,
    refetchInterval: 15000,
  });

  const joinSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/admin/concierge-sessions/${sessionId}/join`, {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Failed to join");
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to join", description: err.message, variant: "destructive" });
    },
  });

  const exitSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/admin/concierge-sessions/${sessionId}/exit-human`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to exit");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] });
      toast({ title: "Support session concluded", description: "The AI concierge has resumed." });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: async ({ sessionId, content, uiCardType, uiCardData }: { sessionId: string; content: string; uiCardType?: string; uiCardData?: any }) => {
      const res = await fetch(`/api/admin/concierge-sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content, uiCardType, uiCardData }),
      });
      if (!res.ok) throw new Error("Failed to send");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] });
    },
  });

  const resetAllChatsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/reset-all-chats", {
        method: "DELETE",
        credentials: "include",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Reset failed");
      return body;
    },
    onSuccess: (data) => {
      toast({ title: "All chats reset", description: `Deleted ${data.deleted.sessions} sessions, ${data.deleted.bookings} bookings, ${data.deleted.parentProfiles} parent profiles` });
      queryClient.invalidateQueries();
    },
    onError: (err: any) => {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    },
  });

  // Auto-scroll to bottom on new messages
  const scrollDone = useRef(false);
  useEffect(() => {
    scrollDone.current = false;
    const scrollToEnd = () => {
      if (chatEndRef.current) {
        const container = chatEndRef.current.closest('[data-testid="admin-chat-messages"]');
        if (container) container.scrollTop = container.scrollHeight;
      }
    };
    scrollToEnd();
    const t1 = setTimeout(scrollToEnd, 150);
    const t2 = setTimeout(scrollToEnd, 400);
    const t3 = setTimeout(scrollToEnd, 800);
    const t4 = setTimeout(() => { scrollToEnd(); scrollDone.current = true; }, 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, [sessionDetailQuery.data?.messages?.length, selectedSessionId]);

  // Mark parent messages as read when admin opens a session
  useEffect(() => {
    if (!selectedSessionId) return;
    fetch(`/api/chat-sessions/${selectedSessionId}/read`, { method: "POST", credentials: "include" })
      .then(() => queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] }))
      .catch(() => {});
  }, [selectedSessionId]);

  // Auto-restore last viewed session when landing on the page with no selection
  useEffect(() => {
    if (!lastChatKey) return;
    if (selectedSessionId || sessionIdFromUrl) return;
    if (sessionsQuery.isLoading || !sessionsQuery.data) return;
    const storedId = localStorage.getItem(lastChatKey);
    if (!storedId) return;
    const exists = sessionsQuery.data.some(s => s.id === storedId);
    if (exists) {
      setSelectedSessionId(storedId);
    }
  }, [lastChatKey, selectedSessionId, sessionIdFromUrl, sessionsQuery.isLoading, sessionsQuery.data]);

  const sessions = sessionsQuery.data || [];
  const detail = sessionDetailQuery.data;
  const detailAiName = detail
    ? (detail.matchmakerName || brand?.matchmakers?.find((m: any) => m.id === detail.matchmakerId)?.name || null)
    : null;

  const handleSend = async (text: string, files: File[]) => {
    if (!selectedSessionId) return;
    // Upload files first
    if (files.length > 0) {
      setUploading(true);
      try {
        for (const file of files) {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: formData });
          if (!res.ok) throw new Error("Upload failed");
          const data = await res.json();
          await sendMessageMutation.mutateAsync({
            sessionId: selectedSessionId,
            content: data.originalName ? `Shared a file: ${data.originalName}` : "Shared a file",
            uiCardType: "attachment",
            uiCardData: data,
          });
        }
      } catch {
        alert("Failed to upload file. Please try again.");
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    // Send text message
    if (text) {
      sendMessageMutation.mutate({ sessionId: selectedSessionId, content: text });
    }
  };

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "video-call-ended") setInlineVideoBookingId(null);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleAdminCalendar = async () => {
    if (!selectedSessionId) return;
    try {
      const res = await fetch("/api/admin/calendar-slug", { credentials: "include" });
      const { slug } = await res.json();
      if (!slug) {
        toast({ title: "Calendar not configured", description: "Set up your booking calendar in Settings first.", variant: "destructive" });
        return;
      }
      const adminName = (user as any)?.name || "GoStork Expert";
      sendMessageMutation.mutate({
        sessionId: selectedSessionId,
        content: "I've shared my calendar - pick a time that works for you!",
        uiCardType: "rich",
        uiCardData: {
          consultationCard: {
            providerName: "GoStork",
            providerLogo: null,
            bookingUrl: `/book/${slug}`,
            iframeEnabled: true,
            memberBookingSlug: slug,
            memberName: adminName,
          },
        },
      });
    } catch {
      toast({ title: "Failed to load calendar", variant: "destructive" });
    }
  };

  const handleAdminVideo = async () => {
    if (!selectedSessionId) return;
    try {
      const res = await fetch("/api/video/chat-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId: selectedSessionId }),
      });
      if (!res.ok) throw new Error("Failed to create video booking");
      const { bookingId } = await res.json();
      setInlineVideoBookingId(bookingId);
    } catch {
      toast({ title: "Failed to create video room", variant: "destructive" });
    }
  };

  // Build sidebar items - session list
  const sidebarItems = sessions.length > 0 ? (
    <div className="divide-y divide-border/20">
      {sessions.map((s) => (
        <button
          key={s.id}
          className={`w-full flex items-start gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left ${selectedSessionId === s.id ? "bg-muted/70" : ""}`}
          onClick={() => setSelectedSessionId(s.id)}
          data-testid={`session-card-${s.id}`}
        >
          {s.userAvatar ? (
            <img src={getPhotoSrc(s.userAvatar) || undefined} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
              <User className="w-5 h-5 text-muted-foreground" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm truncate">{s.userName || "Unknown"}</span>
              {s.humanRequested && (!s.humanJoinedAt || !!s.humanConcludedAt) && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase flex-shrink-0" style={{ backgroundColor: `${brandColor}15`, color: brandColor }} data-testid={`badge-escalated-${s.id}`}>
                  <UserPlus className="w-2.5 h-2.5" />
                  Ready to Join
                </span>
              )}
              {s.humanJoinedAt && !s.humanConcludedAt && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[10px] font-bold uppercase flex-shrink-0">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Active
                </span>
              )}
              {s.providerJoinedAt && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[10px] font-bold uppercase flex-shrink-0" data-testid={`badge-provider-active-${s.id}`}>
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Provider Active
                </span>
              )}
              {s.providerId && !s.providerJoinedAt && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--accent))]/15 text-[hsl(var(--accent))] text-[10px] font-bold uppercase flex-shrink-0">
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
          <div className="text-right flex-shrink-0 flex flex-col items-end gap-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              {timeAgo(s.lastMessageAt)}
            </div>
            {(() => {
              const needsJoin = s.humanRequested && (!s.humanJoinedAt || !!s.humanConcludedAt);
              const count = needsJoin ? Math.max(1, s.unreadCount || 0) : (s.unreadCount || 0);
              return count > 0 ? (
                <span className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold px-1 text-primary-foreground" style={{ backgroundColor: 'hsl(var(--primary))' }}>
                  {count > 99 ? "99+" : count}
                </span>
              ) : (
                <div className="text-xs text-muted-foreground">{s.messageCount} msgs</div>
              );
            })()}
          </div>
        </button>
      ))}
    </div>
  ) : null;

  // Build detail content when a session is selected
  const detailContent = detail ? (
    <div className="flex flex-col h-full" data-testid="concierge-monitor-detail">
      {/* Chat header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-background shrink-0">
        <div className="flex items-center gap-2 flex-1">
          {detail.user.photoUrl ? (
            <img src={getPhotoSrc(detail.user.photoUrl) || undefined} alt="" className="w-8 h-8 rounded-full object-cover" />
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
        <div className="ml-auto flex items-center gap-2">
          {(!detail.humanJoinedAt || !!(detail as any).humanConcludedAt) && (
            <Button
              size="sm"
              onClick={() => joinSessionMutation.mutate(selectedSessionId!)}
              disabled={joinSessionMutation.isPending}
              className="gap-1.5 text-xs"
              data-testid="btn-join-group-chat"
            >
              {joinSessionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
              {detail.humanRequested ? "Join Group Chat" : "Join Chat"}
            </Button>
          )}
          {detail.humanJoinedAt && !(detail as any).humanConcludedAt && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => exitSessionMutation.mutate(selectedSessionId!)}
              disabled={exitSessionMutation.isPending}
              className="gap-1.5 text-xs"
              data-testid="btn-exit-human"
            >
              {exitSessionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
              Exit Chat
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0">
          {/* Message list - reuses shared component */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="admin-chat-messages">
            <ChatMessageList
              ref={chatEndRef}
              messages={detail.messages}
              bookings={sessionBookingsQuery.data}
              brandColor={brandColor}
              chatPalette={chatPalette}
              borderRadius={brand?.borderRadius ?? 1}
              viewerRole="admin"
              isOwnMessage={(msg) => msg.senderType === "human"}
              nameLabel={(msg) => {
                if (msg.role === "user") return null;
                if (msg.senderType === "human") return msg.senderName || "GoStork Expert";
                if (msg.senderType === "provider") return msg.senderName || "Provider";
                return detailAiName || "AI";
              }}
              onBookingUpdate={() => sessionBookingsQuery.refetch()}
              msgTestIdPrefix="monitor-msg"
            />
          </div>

          {/* Inline join request card - shown when parent has requested a human */}
          {detail.humanRequested && (!detail.humanJoinedAt || !!(detail as any).humanConcludedAt) && (
            <div className="px-4 py-2 shrink-0">
              <div className="rounded-xl border p-3 flex items-center gap-3" style={{ backgroundColor: `${brandColor}10`, borderColor: `${brandColor}30` }}>
                <MessageCircle className="w-4 h-4 flex-shrink-0" style={{ color: brandColor }} />
                <p className="flex-1 text-sm font-medium" style={{ color: brandColor }}>
                  {detail.user.name || detail.user.email} is asking for you to join the chat
                </p>
                <Button
                  size="sm"
                  onClick={() => joinSessionMutation.mutate(selectedSessionId!)}
                  disabled={joinSessionMutation.isPending}
                  className="gap-1.5 text-xs flex-shrink-0"
                  data-testid="btn-join-inline"
                >
                  {joinSessionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                  Join Group Chat
                </Button>
              </div>
            </div>
          )}

          {/* Input bar - reuses shared component */}
          {inlineVideoBookingId && (
            <InlineVideoOverlay
              bookingId={inlineVideoBookingId}
              onClose={() => setInlineVideoBookingId(null)}
            />
          )}
          <ChatInputBar
            onSend={handleSend}
            isLoading={sendMessageMutation.isPending}
            isUploading={uploading}
            brandColor={brandColor}
            placeholder="Type a message as GoStork Expert..."
            senderLabel={<ExpertSenderLabel adminName={(user as any)?.name || "Admin"} />}
            enableFileUpload
            onCalendarClick={handleAdminCalendar}
            onVideoClick={handleAdminVideo}
            testIdPrefix="expert"
          />
        </div>

        {/* Profile sidebar - reuses shared component */}
        <ChatProfileSidebar
          user={detail.user}
          brandColor={brandColor}
          testId="concierge-monitor-profile"
        />
      </div>
    </div>
  ) : selectedSessionId ? (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  ) : null;

  return (
    <ConversationsShell
      hasSelection={!!selectedSessionId}
      onBack={() => setSelectedSessionId(null)}
      isLoading={sessionsQuery.isLoading}
      sidebarItems={sidebarItems}
      emptyMessage="No active AI conversations right now"
      detailContent={detailContent}
      brandColor={brandColor}
      headerAction={
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => {
            if (window.confirm("Delete ALL chats, meetings, agreements, and parent profiles? This cannot be undone.")) {
              resetAllChatsMutation.mutate();
            }
          }}
          disabled={resetAllChatsMutation.isPending}
        >
          {resetAllChatsMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Trash2 className="w-3.5 h-3.5 mr-1" />}
          Delete Chats
        </Button>
      }
    />
  );
}
