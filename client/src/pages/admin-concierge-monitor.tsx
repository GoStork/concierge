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
  Headphones, MessageCircle, User, AlertTriangle, Clock, CheckCircle2, Loader2,
} from "lucide-react";
import {
  timeAgo,
  ConversationsShell,
  ChatMessageList,
  ChatInputBar,
  ExpertSenderLabel,
  ChatProfileSidebar,
  type SessionDetail,
} from "@/components/chat";

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

export default function AdminConciergeMonitor() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const brandColor = brand?.primaryColor || "#004D4D";
  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionIdFromUrl = searchParams.get("sessionId");
  const [selectedSessionId, _setSelectedSessionId] = useState<string | null>(sessionIdFromUrl);
  const setSelectedSessionId = (id: string | null) => {
    _setSelectedSessionId(id);
    if (id) {
      setSearchParams({ sessionId: id }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  };
  const [uploading, setUploading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

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
    const t3 = setTimeout(() => { scrollToEnd(); scrollDone.current = true; }, 800);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [sessionDetailQuery.data?.messages?.length, selectedSessionId]);

  const sessions = sessionsQuery.data || [];
  const detail = sessionDetailQuery.data;

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
              {s.humanRequested && !s.humanJoinedAt && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] text-[10px] font-bold uppercase flex-shrink-0" data-testid={`badge-escalated-${s.id}`}>
                  <AlertTriangle className="w-2.5 h-2.5" />
                  Needs Human
                </span>
              )}
              {s.humanJoinedAt && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[10px] font-bold uppercase flex-shrink-0">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Human Active
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
          <div className="text-right flex-shrink-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              {timeAgo(s.lastMessageAt)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{s.messageCount} msgs</div>
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

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0">
          {/* Message list - reuses shared component */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="admin-chat-messages">
            <ChatMessageList
              ref={chatEndRef}
              messages={detail.messages}
              brandColor={brandColor}
              chatPalette={chatPalette}
              borderRadius={brand?.borderRadius ?? 1}
              viewerRole="admin"
              isOwnMessage={(msg) => msg.senderType === "human"}
              nameLabel={(msg) => {
                if (msg.role === "user") return null;
                if (msg.senderType === "human") return msg.senderName || "GoStork Expert";
                if (msg.senderType === "provider") return msg.senderName || "Provider";
                if (msg.senderType === "system") return "Eva";
                return "AI";
              }}
              msgTestIdPrefix="monitor-msg"
            />
          </div>

          {/* Input bar - reuses shared component */}
          <ChatInputBar
            onSend={handleSend}
            isLoading={sendMessageMutation.isPending}
            isUploading={uploading}
            brandColor={brandColor}
            placeholder="Type a message as GoStork Expert..."
            senderLabel={<ExpertSenderLabel adminName={(user as any)?.name || "Admin"} />}
            enableFileUpload
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
        <span className="text-sm font-medium text-muted-foreground">Concierge Monitor</span>
      }
    />
  );
}
