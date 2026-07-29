import { useState, useRef, useEffect, useMemo } from "react";
import { JourneyTimelineCard } from "@/components/journey/journey-timeline-card";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { useAppDispatch } from "@/store";
import { setHideBottomNav } from "@/store/uiSlice";
import { getPhotoSrc } from "@/lib/profile-utils";
import { deriveChatPalette } from "@/lib/chat-palette";
import { DonorStatusPill, getDonorStatusStyle, isMarketplaceProfileSubject } from "@/lib/donor-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MessageStatus } from "@/components/ui/message-status";
import {
  ArrowLeft, ChevronRight, Headphones, MessageCircle, User, Clock, CheckCircle2, Loader2, UserPlus, LogOut, Trash2, Video, Sparkles, Brain, ChevronDown,
} from "lucide-react";
import {
  timeAgo,
  truncateMessage,
  ConversationsShell,
  ChatMessageList,
  ChatInputBar,
  ExpertSenderLabel,
  ChatProfileSidebar,
  ChatHeaderContextPanel,
  InlineVideoOverlay,
  ChatBookingCard,
  type SessionDetail,
  type FilterTab,
} from "@/components/chat";
import { SubjectProfileCard, ProviderProfileCard } from "@/components/profile-cards";
import { ConciergeMemoryTab } from "@/components/concierge-memory-tab";
import { useToast } from "@/hooks/use-toast";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { AgreementSidebarSection } from "@/components/chat/agreement-sidebar-section";
import { CostSheetSidebarSection } from "@/components/chat/cost-sheet-sidebar-section";
import { InvoiceSidebarSection } from "@/components/chat/invoice-sidebar-section";
import { ContactReleaseSection } from "@/components/chat/contact-release-section";

interface SessionSummary {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
  status: string;
  sessionType: string;
  humanRequested: boolean;
  humanJoinedAt: string | null;
  humanConcludedAt: string | null;
  providerId: string | null;
  providerName: string | null;
  providerLogo: string | null;
  providerJoinedAt: string | null;
  title: string | null;
  profilePhotoUrl: string | null;
  subjectProfileId: string | null;
  subjectType: string | null;
  messageCount: number;
  lastMessage: string | null;
  lastMessageAt: string;
  lastMessageSenderType: string | null;
  unreadCount: number;
  createdAt: string;
  profileAvailable: boolean | null;
  profileStatus: string | null;
}

export default function AdminConciergeMonitor() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const brandColor = brand?.primaryColor || "#004D4D";
  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);
  const [searchParams, setSearchParams] = useSearchParams();
  const lastChatKey = user ? `lastAdminChatSessionId:${(user as any).id}` : null;
  // Use the URL as the single source of truth - no separate useState needed.
  // This means the browser back button automatically works: when the URL changes,
  // selectedSessionId updates and the component re-renders to show the list.
  const selectedSessionId = searchParams.get("sessionId");
  const setSelectedSessionId = (id: string | null) => {
    if (id) {
      if (lastChatKey) localStorage.setItem(lastChatKey, id);
      // Push a new history entry so the browser back button returns to the list,
      // preserving any active filters in the URL.
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set("sessionId", id);
        return next;
      });
    } else {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete("sessionId");
        return next;
      }, { replace: true });
    }
  };
  const [uploading, setUploading] = useState(false);
  const [inlineVideoBookingId, setInlineVideoBookingId] = useState<string | null>(null);
  const activeFilter = ((searchParams.get("filter") as FilterTab) === "unread" ? "unread" : "all") as FilterTab;
  const searchQuery = searchParams.get("q") || "";
  const setActiveFilter = (v: FilterTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (v === "all") next.delete("filter");
      else next.set("filter", v);
      return next;
    }, { replace: true });
  };
  const setSearchQuery = (v: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (!v) next.delete("q");
      else next.set("q", v);
      return next;
    }, { replace: true });
  };
  type AdminInlinePanel = null | "costSheet" | "invoice" | "agreement";
  const [adminInlinePanel, setAdminInlinePanel] = useState<AdminInlinePanel>(null);
  const [adminHeaderPanelOpen, setAdminHeaderPanelOpen] = useState(false);
  useEffect(() => { setAdminHeaderPanelOpen(false); }, [selectedSessionId]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // Hide the bottom nav on mobile when a session is open so it doesn't cover the chat input bar
  useEffect(() => {
    dispatch(setHideBottomNav(!!selectedSessionId));
    return () => { dispatch(setHideBottomNav(false)); };
  }, [selectedSessionId, dispatch]);

  const roles: string[] = (user as any)?.roles || [];
  const isAdmin = roles.includes("GOSTORK_ADMIN");
  const canToggleTestData = isAdmin || roles.includes("GOSTORK_DEVELOPER");
  if (!isAdmin && !roles.includes("GOSTORK_CONCIERGE")) {
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

  const sessionCalendarSlugQuery = useQuery<{ slug: string | null; memberName: string | null }>({
    queryKey: ["/api/chat-session", selectedSessionId, "provider-calendar-slug"],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${selectedSessionId}/provider-calendar-slug`, { credentials: "include" });
      if (!res.ok) return { slug: null, memberName: null };
      return res.json();
    },
    enabled: !!selectedSessionId,
    staleTime: 60000,
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
      const { dismiss } = toast({ title: "All chats reset", description: `Deleted ${data.deleted.sessions} sessions, ${data.deleted.bookings} bookings, ${data.deleted.parentProfiles} parent profiles` });
      setTimeout(dismiss, 1000);
      queryClient.invalidateQueries();
    },
    onError: (err: any) => {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleTestFlagMutation = useMutation({
    mutationFn: async ({ sessionId, isTestData }: { sessionId: string; isTestData: boolean }) => {
      const res = await fetch(`/api/admin/chat-sessions/${sessionId}/test-flag`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isTestData }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Failed to update test flag");
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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

  // Mark parent messages as read when admin opens a session.
  // Optimistically clear the session's unreadCount so the top-nav Concierge badge
  // and the sidebar row badge update instantly, instead of waiting for the server
  // roundtrip + the next refetch cycle.
  useEffect(() => {
    if (!selectedSessionId) return;
    queryClient.setQueryData<any[]>(["/api/admin/concierge-sessions"], (old) =>
      old?.map(s => s.id === selectedSessionId ? { ...s, unreadCount: 0 } : s)
    );
    fetch(`/api/chat-sessions/${selectedSessionId}/read`, { method: "POST", credentials: "include" })
      .then(() => queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] }))
      .catch(() => {});
  }, [selectedSessionId, queryClient]);

  // Auto-restore last viewed session on initial page load only.
  // The ref prevents the restore from re-firing when the browser back button returns to this page.
  const autoRestored = useRef(false);
  useEffect(() => {
    if (autoRestored.current) return;
    if (!lastChatKey) return;
    if (selectedSessionId) return;
    if (sessionsQuery.isLoading || !sessionsQuery.data) return;
    const storedId = localStorage.getItem(lastChatKey);
    if (!storedId) return;
    const exists = sessionsQuery.data.some(s => s.id === storedId);
    if (exists) {
      autoRestored.current = true;
      setSelectedSessionId(storedId);
    }
  }, [lastChatKey, selectedSessionId, sessionsQuery.isLoading, sessionsQuery.data]);

  const allSessions = [...(sessionsQuery.data || [])].sort((a, b) =>
    new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );

  // Online presence for every parent visible in the sidebar. Polls
  // /api/online-status every 10s the same way agencies see Online on
  // their parent rows. The endpoint is auth-only (no role check) so
  // admins get the same data.
  const onlineParentUserIds = useMemo(
    () => [...new Set(allSessions.map(s => s.userId).filter(Boolean))],
    [allSessions],
  );
  const { statuses: onlineStatuses } = useOnlineStatus(onlineParentUserIds, []);

  const matchesAdminTab = (s: SessionSummary) => {
    if (activeFilter === "unread") return (s.unreadCount || 0) > 0;
    return true;
  };
  const sessions = allSessions.filter(s =>
    matchesAdminTab(s) && (
      !searchQuery ||
      (s.userName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.userEmail || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.providerName || "").toLowerCase().includes(searchQuery.toLowerCase())
    )
  );
  const detail = sessionDetailQuery.data;
  const detailAiName = detail
    ? (detail.matchmakerName || brand?.matchmakers?.find((m: any) => m.id === detail.matchmakerId)?.name || null)
    : null;

  const handleSend = async (text: string, files: File[]) => {
    if (!selectedSessionId) return;
    if (files.length > 0) {
      setUploading(true);
      try {
        // Upload all files first
        const uploaded: Array<{ originalName?: string; [k: string]: any }> = [];
        for (const file of files) {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: formData });
          if (!res.ok) throw new Error("Upload failed");
          uploaded.push(await res.json());
        }

        // Merge text with the FIRST file so the message text renders before the
        // attachment card on the receiving side. Additional files go as separate
        // placeholder messages after it.
        const firstFile = uploaded[0];
        const firstContent = text?.trim()
          ? text.trim()
          : firstFile.originalName ? `Shared a file: ${firstFile.originalName}` : "Shared a file";
        await sendMessageMutation.mutateAsync({
          sessionId: selectedSessionId,
          content: firstContent,
          uiCardType: "attachment",
          uiCardData: firstFile,
        });

        for (let i = 1; i < uploaded.length; i++) {
          const f = uploaded[i];
          await sendMessageMutation.mutateAsync({
            sessionId: selectedSessionId,
            content: f.originalName ? `Shared a file: ${f.originalName}` : "Shared a file",
            uiCardType: "attachment",
            uiCardData: f,
          });
        }
      } catch {
        alert("Failed to upload file. Please try again.");
        setUploading(false);
        return;
      }
      setUploading(false);
      return;
    }
    // Text-only message
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
            bookingUrl: `${window.location.origin}/book/${slug}`,
            iframeEnabled: true,
            memberBookingSlug: slug,
            memberName: adminName,
            // Embed admin's userId so session bookings endpoint can find their bookings
            providerUserId: (user as any)?.id,
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

  // Group sessions by parent userId, matching the agency provider view layout.
  // Each parent group renders a header divider with the parent name, then each
  // session below (AI-only or 3-way with a provider) as its own chat-row entry.
  const parentGroups: Record<string, SessionSummary[]> = {};
  for (const s of sessions) {
    const key = s.userId;
    if (!parentGroups[key]) parentGroups[key] = [];
    parentGroups[key].push(s);
  }
  // Sort groups: most recent activity first
  const sortedGroupEntries = Object.entries(parentGroups).sort((a, b) => {
    const aLatest = Math.max(...a[1].map(s => new Date(s.lastMessageAt).getTime()));
    const bLatest = Math.max(...b[1].map(s => new Date(s.lastMessageAt).getTime()));
    return bLatest - aLatest;
  });
  // Within each group, sort sessions: most recent first
  for (const [, groupSessions] of sortedGroupEntries) {
    groupSessions.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
  }

  const sidebarItems = sessions.length > 0 ? (
    <>
      {sortedGroupEntries.map(([parentUserId, groupSessions]) => {
        const first = groupSessions[0];
        return (
          <div key={parentUserId} data-testid={`parent-group-${parentUserId}`}>
            {/* Section header - parent name (secondary-color pill, consistent with provider view) */}
            <div className="mx-4 mt-3 mb-2 px-3 py-1.5 rounded-[var(--radius)] flex items-center gap-2 bg-secondary/40">
              <div className="w-4 h-4 rounded-full flex-shrink-0 overflow-hidden bg-background flex items-center justify-center">
                {first.userAvatar ? (
                  <img src={getPhotoSrc(first.userAvatar) || undefined} alt="" className="w-4 h-4 object-cover" />
                ) : (
                  <User className="w-3 h-3 text-muted-foreground" />
                )}
              </div>
              <span className="text-xs font-medium truncate flex-1 text-foreground/80">
                {first.userName || "Prospective Parent"}
              </span>
              {onlineStatuses[first.userId] && (
                <span className="text-[10px] font-medium text-[hsl(var(--brand-success))]">Online</span>
              )}
              <span className="t-helper">
                {groupSessions.length} {groupSessions.length === 1 ? "chat" : "chats"}
              </span>
            </div>
            {/* Per-session rows - one entry per conversation (AI-only or 3-way) */}
            {groupSessions.map(s => {
              const sUnread = s.unreadCount || 0;
              const needsJoin = s.humanRequested && (!s.humanJoinedAt || !!s.humanConcludedAt);
              const badgeCount = needsJoin ? Math.max(1, sUnread) : sUnread;
              const isProviderThread = !!s.providerId || !!s.providerName;
              const photoSrc = getPhotoSrc(s.profilePhotoUrl);
              // For AI-only threads the parent picked a specific matchmaker
              // persona (e.g. "Ariel", "Adam"). Show that name+photo instead of
              // a generic "AI Concierge" + sparkle icon. Provider threads
              // continue to identify by provider name.
              const matchmakerAvatarSrc = (s as any).matchmakerAvatar ? getPhotoSrc((s as any).matchmakerAvatar) : null;
              const matchmakerName = (s as any).matchmakerName as string | null | undefined;
              const rowTitle = s.title
                || (isProviderThread ? (s.providerName || "Provider chat") : (matchmakerName || "AI Concierge"));
              return (
                <button
                  key={s.id}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left border-b border-border/10"
                  style={selectedSessionId === s.id ? { backgroundColor: `${brandColor}15` } : undefined}
                  onClick={() => setSelectedSessionId(s.id)}
                  data-testid={`session-card-${s.id}`}
                >
                  <div className="w-12 h-12 rounded-full flex-shrink-0 relative">
                    <div className="w-full h-full rounded-full overflow-hidden">
                      {photoSrc ? (
                        <img
                          src={photoSrc}
                          alt={rowTitle}
                          className="w-12 h-12 rounded-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                        />
                      ) : s.providerLogo ? (
                        <img
                          src={getPhotoSrc(s.providerLogo) || undefined}
                          alt={s.providerName || ""}
                          className="w-12 h-12 rounded-full object-contain p-1 bg-background border"
                        />
                      ) : isProviderThread ? (
                        <div
                          className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground text-xs font-bold"
                          style={{ backgroundColor: brandColor }}
                        >
                          {(s.providerName || rowTitle).charAt(0).toUpperCase()}
                        </div>
                      ) : matchmakerAvatarSrc ? (
                        <img
                          src={matchmakerAvatarSrc}
                          alt={matchmakerName || rowTitle}
                          className="w-12 h-12 rounded-full object-cover"
                        />
                      ) : matchmakerName ? (
                        <div
                          className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold"
                          style={{ backgroundColor: brandColor }}
                        >
                          {matchmakerName.charAt(0).toUpperCase()}
                        </div>
                      ) : (
                        <div className="w-12 h-12 rounded-full flex items-center justify-center bg-secondary/60">
                          <Sparkles className="w-5 h-5" style={{ color: brandColor }} />
                        </div>
                      )}
                    </div>
                    {s.subjectProfileId && isMarketplaceProfileSubject(s.subjectType, s.profileStatus) && (() => {
                      const dotStyle = getDonorStatusStyle(s.profileStatus);
                      return (
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-background ${dotStyle?.dotClassName || "bg-muted-foreground/50"}`}
                          title={dotStyle?.description || "Profile no longer in marketplace"}
                        />
                      );
                    })()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium text-sm font-ui truncate">{rowTitle}</span>
                        {s.subjectProfileId && <DonorStatusPill status={s.profileStatus} />}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className={`text-[11px] ${sUnread > 0 ? "font-semibold" : "text-muted-foreground"}`} style={sUnread > 0 ? { color: brandColor } : undefined}>{timeAgo(s.lastMessageAt)}</span>
                        {badgeCount > 0 && (
                          <span className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1" style={{ backgroundColor: brandColor }}>
                            {badgeCount > 99 ? "99+" : badgeCount}
                          </span>
                        )}
                      </div>
                    </div>
                    {isProviderThread && s.providerName && s.title && (
                      <p className="t-helper truncate mt-0.5">via {s.providerName}</p>
                    )}
                    {s.lastMessage && (
                      <p className="t-helper truncate mt-0.5 flex items-center gap-1">
                        {s.lastMessageSenderType === "human" && (
                          <MessageStatus deliveredAt={null} readAt={null} brandColor={brandColor} className="flex-shrink-0" />
                        )}
                        <span className="truncate">{truncateMessage(s.lastMessage)}</span>
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  ) : null;

  // Look up the lightweight summary for the selected session so we can render
  // the same subject thumbnail / "re: …" subtitle the provider view uses.
  const selectedSummary = selectedSessionId ? sessions.find(s => s.id === selectedSessionId) : null;

  // Journey-ladder match status (reuses the provider parent-contacts
  // endpoint, admin-permitted): Matched / Deposit Paid / Agreement Signed
  // instead of the coarse Connected / Call Booked once the journey advances.
  const monitorProviderId = (selectedSummary as any)?.providerId || (detail as any)?.providerId || null;
  const adminContactsQuery = useQuery<any[]>({
    queryKey: [`/api/providers/${monitorProviderId}/parent-contacts`],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${monitorProviderId}/parent-contacts`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!monitorProviderId,
    staleTime: 15_000,
  });
  const journeyMatchStatus = (() => {
    const row = (adminContactsQuery.data || []).find((r: any) => r.sessionId === selectedSessionId);
    const labels: Record<string, string> = {
      CONSULTATION_BOOKED: "Call Booked",
      PROVIDER_CONNECTED: "Connected",
      MATCH_CALL: "Match Call",
      MATCHED: "Matched",
      DEPOSIT_PAID: "Invoice Paid",
      AGREEMENT_SIGNED: "Agreement Signed",
      HANDED_OFF: "Handed Off",
    };
    return row?.matchStatus ? labels[row.matchStatus] || null : null;
  })();

  // Build detail content when a session is selected
  // Only render the full chat once BOTH session detail and bookings are ready.
  // This prevents the booking card from popping in after messages are already shown.
  const detailContent = (detail && !sessionBookingsQuery.isLoading) ? (
    <div className="flex h-full overflow-hidden" data-testid="concierge-monitor-detail">
      <div className="flex flex-col flex-1 min-h-0">
      {/* Chat header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-background shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 md:hidden"
          onClick={() => setSelectedSessionId(null)}
          data-testid="btn-back-to-sessions"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <button
          type="button"
          onClick={() => setAdminHeaderPanelOpen(o => !o)}
          aria-expanded={adminHeaderPanelOpen}
          aria-controls="admin-header-context-panel"
          className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-[var(--radius)] -mx-1 px-1 py-1 lg:cursor-default active:bg-muted/40 lg:active:bg-transparent"
          data-testid="btn-admin-header-context"
        >
          <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden bg-muted">
            {detail.user.photoUrl ? (
              <img src={getPhotoSrc(detail.user.photoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                <User className="w-5 h-5 text-muted-foreground" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm font-ui truncate">{detail.user.name || "Prospective Parent"}</span>
              {onlineStatuses[detail.user.id] && (
                <span className="w-2 h-2 rounded-full bg-[hsl(var(--brand-success))] flex-shrink-0" aria-label="Parent online" />
              )}
            </div>
            {(() => {
              // "re:" line identifies what the chat is about. Priority:
              //   1. specific subject (donor/surrogate profile) → its photo + name
              //   2. provider thread → provider logo + name
              //   3. AI-only thread → the matchmaker persona the parent picked
              const headerMatchmakerAvatar = detail.matchmakerAvatar
                ? getPhotoSrc(detail.matchmakerAvatar) || detail.matchmakerAvatar
                : null;
              const headerMatchmakerName = detailAiName;
              const subjectAvatar = selectedSummary?.profilePhotoUrl
                ? (getPhotoSrc(selectedSummary.profilePhotoUrl) || undefined)
                : selectedSummary?.providerLogo
                ? (getPhotoSrc(selectedSummary.providerLogo) || undefined)
                : headerMatchmakerAvatar || undefined;
              const subjectLabel = detail.title
                || selectedSummary?.title
                || selectedSummary?.providerName
                || headerMatchmakerName
                || null;
              if (!subjectLabel) {
                return <p className="t-helper truncate">{detail.user.email}</p>;
              }
              return (
                <div className="flex items-center gap-1 mt-0.5 min-w-0">
                  <span className="t-helper flex-shrink-0">re:</span>
                  {subjectAvatar ? (
                    <img src={subjectAvatar} alt="" className={`w-3.5 h-3.5 rounded-full flex-shrink-0 bg-background border ${!selectedSummary?.profilePhotoUrl && selectedSummary?.providerLogo ? "object-contain" : "object-cover"}`} />
                  ) : headerMatchmakerName ? (
                    <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-primary-foreground flex-shrink-0" style={{ backgroundColor: brandColor, fontSize: "8px", fontWeight: 700 }}>
                      {headerMatchmakerName.charAt(0).toUpperCase()}
                    </div>
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                      <Sparkles className="w-2 h-2" style={{ color: brandColor }} />
                    </div>
                  )}
                  <span className="t-helper truncate" data-testid="admin-subject-label">
                    {subjectLabel}
                  </span>
                  {selectedSummary?.subjectProfileId && <DonorStatusPill status={selectedSummary.profileStatus} />}
                </div>
              );
            })()}
          </div>
          <ChevronRight
            className="w-4 h-4 text-muted-foreground flex-shrink-0 lg:hidden"
            aria-hidden
          />
        </button>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0"
            style={{ color: "white", backgroundColor: brandColor }}
            onClick={handleAdminVideo}
            aria-label="Video call"
            data-testid="btn-admin-video"
          >
            <Video className="!w-4 !h-4 sm:!w-5 sm:!h-5" strokeWidth={2.25} />
          </Button>
          {(!detail.humanJoinedAt || !!(detail as any).humanConcludedAt) && (
            <Button
              size="sm"
              onClick={() => joinSessionMutation.mutate(selectedSessionId!)}
              disabled={joinSessionMutation.isPending}
              className="h-9 w-9 sm:w-auto p-0 sm:px-4 rounded-full text-xs text-primary-foreground gap-0 sm:gap-1.5 flex-shrink-0"
              style={{ backgroundColor: brandColor }}
              aria-label="Join Chat"
              title="Join Chat"
              data-testid="btn-join-group-chat"
            >
              {joinSessionMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">Join Chat</span>
            </Button>
          )}
          {detail.humanJoinedAt && !(detail as any).humanConcludedAt && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => exitSessionMutation.mutate(selectedSessionId!)}
              disabled={exitSessionMutation.isPending}
              className="h-9 w-9 sm:h-9 sm:w-auto p-0 sm:px-3 rounded-full sm:rounded-md gap-0 sm:gap-1.5 text-xs flex-shrink-0"
              aria-label="Exit Chat"
              title="Exit Chat"
              data-testid="btn-exit-human"
            >
              {exitSessionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
              <span className="hidden sm:inline">Exit Chat</span>
            </Button>
          )}
          {canToggleTestData && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => toggleTestFlagMutation.mutate({ sessionId: selectedSessionId!, isTestData: !(detail as any).isTestData })}
              disabled={toggleTestFlagMutation.isPending}
              className={`hidden sm:inline-flex gap-1.5 text-xs ${(detail as any).isTestData ? "border-amber-400 text-amber-600" : "text-muted-foreground"}`}
              title={(detail as any).isTestData ? "Unmark as test session" : "Mark as test session"}
            >
              {(detail as any).isTestData ? "Test Session" : "Mark as Test"}
            </Button>
          )}
        </div>
      </div>

      <ChatHeaderContextPanel
        open={adminHeaderPanelOpen}
        onClose={() => setAdminHeaderPanelOpen(false)}
        role="admin"
        brandColor={brandColor}
        user={detail.user}
        matchStatus={
          journeyMatchStatus
            ? { label: journeyMatchStatus, tone: "success" }
            : detail.providerJoinedAt
            ? { label: "Connected", tone: "success" }
            : selectedSummary?.status === "CONSULTATION_BOOKED" || detail.status === "CONSULTATION_BOOKED"
            ? { label: "Call Booked", tone: "success" }
            : { label: "AI Concierge", tone: "neutral" }
        }
        subject={
          selectedSummary?.subjectProfileId
            ? {
                providerId: selectedSummary.providerId ?? null,
                subjectProfileId: selectedSummary.subjectProfileId,
                subjectType: selectedSummary.subjectType ?? null,
                fallbackPhotoUrl: selectedSummary.profilePhotoUrl,
                fallbackLabel: selectedSummary.title,
              }
            : null
        }
        provider={
          selectedSummary?.providerId
            ? {
                id: selectedSummary.providerId,
                name: selectedSummary.providerName ?? null,
                logoUrl: selectedSummary.providerLogo,
                calendar: sessionCalendarSlugQuery.data?.slug ? {
                  slug: sessionCalendarSlugQuery.data.slug,
                  memberName: sessionCalendarSlugQuery.data.memberName,
                  existingBooking:
                    (sessionBookingsQuery.data || []).find((b: any) =>
                      b.providerUser?.provider?.id === selectedSummary.providerId ||
                      b.providerId === selectedSummary.providerId
                    ) ?? (sessionBookingsQuery.data || [])[0] ?? undefined,
                  consultationMeta: {
                    aiSessionId: selectedSessionId ?? undefined,
                    providerId: selectedSummary.providerId,
                    profileLabel: selectedSummary.title,
                    profilePhotoUrl: selectedSummary.profilePhotoUrl,
                    subjectProfileId: selectedSummary.subjectProfileId,
                    subjectType: selectedSummary.subjectType,
                  },
                  onBehalfOf: detail.user?.email ? {
                    name: detail.user.name || "Parent",
                    email: detail.user.email,
                    phone: detail.user.mobileNumber,
                  } : null,
                } : null,
              }
            : null
        }
        testId="admin-header-context-panel"
      />

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
              sessionId={selectedSessionId}
              isOwnMessage={(msg) => msg.senderType === "human"}
              nameLabel={(msg) => {
                if (msg.role === "user") return null;
                if (msg.senderType === "human") return msg.senderName || "GoStork Expert";
                if (msg.senderType === "provider") return msg.senderName || "Provider";
                return detailAiName || "AI";
              }}
              msgAvatarUrl={(msg) => {
                if (msg.role === "assistant" || (msg.role !== "user" && msg.senderType !== "human")) {
                  const mm = brand?.matchmakers?.find((m: any) => m.id === detail.matchmakerId);
                  const avatar = mm?.avatarUrl || detail.matchmakerAvatar;
                  if (avatar) return getPhotoSrc(avatar) || avatar;
                }
                if (msg.role === "user") return getPhotoSrc((detail.user as any)?.photoUrl) || null;
                return null;
              }}
              aiAvatarUrl={(() => {
                const mm = brand?.matchmakers?.find((m: any) => m.id === detail.matchmakerId);
                const avatar = mm?.avatarUrl || detail.matchmakerAvatar;
                return avatar ? (getPhotoSrc(avatar) || avatar) : null;
              })()}
              aiName={detailAiName || undefined}
              msgAvatarInitial={(msg) => {
                // Parent name is hidden above the bubble in admin view (already
                // shown in the right panel), but we still want real initials in
                // the avatar instead of a generic "?".
                if (msg.role === "user") {
                  const name = msg.senderName || detail.user?.name || detail.user?.email || "";
                  const parts = name.trim().split(/\s+/).filter(Boolean);
                  if (!parts.length) return null;
                  const first = parts[0].charAt(0);
                  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
                  return (first + last).toUpperCase() || null;
                }
                return null;
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
                  className="h-9 px-4 rounded-full text-xs text-primary-foreground gap-1.5 flex-shrink-0"
                  style={{ backgroundColor: brandColor }}
                  data-testid="btn-join-inline"
                >
                  {joinSessionMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                  Join Chat
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
            onMeetingClick={handleAdminCalendar}
            onCostSheetClick={() => setAdminInlinePanel("costSheet")}
            onInvoiceClick={() => setAdminInlinePanel("invoice")}
            // Agreement is read-only for admin (only providers can generate), so omit the tile.
            inlinePanel={
              adminInlinePanel === "costSheet" ? (
                <CostSheetSidebarSection
                  key={`cs-embed-${selectedSessionId || "none"}`}
                  sessionId={selectedSessionId}
                  brandColor={brandColor}
                  sessionQueryKey="/api/admin/concierge-sessions"
                  embedded
                  onClose={() => setAdminInlinePanel(null)}
                  subjectType={selectedSummary?.subjectType ?? null}
                  subjectProfileId={selectedSummary?.subjectProfileId ?? null}
                  providerId={selectedSummary?.providerId ?? null}
                />
              ) : adminInlinePanel === "invoice" ? (
                <InvoiceSidebarSection
                  key={`inv-embed-${selectedSessionId || "none"}`}
                  sessionId={selectedSessionId}
                  brandColor={brandColor}
                  sessionQueryKey="/api/admin/concierge-sessions"
                  embedded
                  onClose={() => setAdminInlinePanel(null)}
                />
              ) : undefined
            }
            testIdPrefix="expert"
          />
        </div>
      </div>{/* end header + messages column */}

        {/* Profile sidebar - reuses shared component */}
        {(() => {
          const bookings = sessionBookingsQuery.data || [];
          // Only show bookings where the current admin is the host - never show provider-parent meetings
          const activeBookings = bookings.filter((b: any) =>
            b.providerUserId === (user as any)?.id && (
              b.status === "PENDING" ||
              (b.status === "CONFIRMED" && new Date() < new Date(new Date(b.scheduledAt).getTime() + (b.duration || 30) * 60 * 1000))
            )
          );
          const status = detail.status;
          const matchBadge = (() => {
            // Prefer the journey ladder (Match Call / Matched / Deposit Paid /
            // Agreement Signed) computed server-side per session - the raw
            // session status stalls at CONSULTATION_BOOKED/PROVIDER_CONNECTED
            // long after the journey has moved on.
            if (journeyMatchStatus) {
              return { label: journeyMatchStatus, className: "bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]", icon: <CheckCircle2 className="w-3 h-3" /> };
            }
            switch (status) {
              case "PROVIDER_CONNECTED":
                return { label: "Connected", className: "bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]", icon: <CheckCircle2 className="w-3 h-3" /> };
              case "CONSULTATION_BOOKED":
                return { label: "Call Booked", className: "bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]", icon: <CheckCircle2 className="w-3 h-3" /> };
              case "READY_FOR_MATCH":
                return { label: "Ready for Match", className: "bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]", icon: <CheckCircle2 className="w-3 h-3" /> };
              case "NOT_A_FIT":
                return { label: "Not a Fit", className: "bg-destructive/10 text-destructive", icon: <MessageCircle className="w-3 h-3" /> };
              default:
                return { label: "Active", className: "bg-muted text-muted-foreground", icon: <MessageCircle className="w-3 h-3" /> };
            }
          })();
          return (
            <ChatProfileSidebar
              user={detail.user}
              brandColor={brandColor}
              isOnline={!!onlineStatuses[detail.user.id]}
              testId="concierge-monitor-profile"
              topSections={
                <div className="border-b pb-4 mb-4" data-testid="match-status-section">
                  <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Journey</h4>
                  <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium w-fit mb-3 ${matchBadge.className}`} data-testid="badge-match-status">
                    {matchBadge.icon}
                    {matchBadge.label}
                  </div>
                  {/* Provider threads scope the money/terminal rungs to this chat;
                      Eva sessions (no providerId) keep the full relationship view. */}
                  <JourneyTimelineCard parentUserId={detail.user.id} providerId={monitorProviderId} sessionId={monitorProviderId ? selectedSessionId : undefined} showEvents />
                </div>
              }
              extraSections={
                <>
                  {/* Gate B control. Lives here because this is the only admin
                      surface with a (provider, parent) PAIR in context - the
                      billing page is org-scoped and has no parent. */}
                  <ContactReleaseSection
                    providerId={monitorProviderId}
                    parentAccountId={detail.user.parentAccountId || detail.user.id}
                  />
                  {/* What Eva knows: the session's rolling summary (exactly what is
                      injected into Eva's prompt) + the account's durable memory,
                      editable in place so a bad extraction can be fixed mid-monitor.
                      This is the takeover briefing - the human starts from the same
                      picture Eva had. */}
                  <EvaKnowledgePanel
                    historySummary={detail.historySummary}
                    parentAccountId={detail.user.parentAccountId || detail.user.id}
                  />
                  {activeBookings.length > 0 && (
                    <div className="border-t pt-4 mt-4" data-testid="panel-concierge-call-section">
                      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>GoStork Concierge Call</h4>
                      <div className="space-y-2">
                        {activeBookings.map((b: any) => (
                          <ChatBookingCard
                            key={b.id}
                            booking={b}
                            onUpdate={() => sessionBookingsQuery.refetch()}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <SubjectProfileCard
                    providerId={selectedSummary?.providerId}
                    subjectProfileId={selectedSummary?.subjectProfileId}
                    subjectType={selectedSummary?.subjectType}
                    fallbackPhotoUrl={selectedSummary?.profilePhotoUrl}
                    fallbackLabel={selectedSummary?.title}
                    profileAvailable={selectedSummary?.profileAvailable}
                    profileStatus={selectedSummary?.profileStatus}
                    brandColor={brandColor}
                    heading={
                      (selectedSummary?.subjectType || "").toLowerCase() === "surrogate" ? "Interested Surrogate"
                        : (selectedSummary?.subjectType || "").toLowerCase().includes("sperm") ? "Interested Sperm Donor"
                        : "Interested Egg Donor"
                    }
                    withSeparator
                    testId="admin-subject-profile-card"
                  />
                  {selectedSummary?.providerId && (
                    <div className="border-t pt-4 mt-4" data-testid="admin-provider-section">
                      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Provider</h4>
                      <ProviderProfileCard
                        providerId={selectedSummary.providerId}
                        providerName={selectedSummary.providerName ?? null}
                        providerLogo={selectedSummary.providerLogo}
                        brandColor={brandColor}
                        calendar={sessionCalendarSlugQuery.data?.slug ? {
                          slug: sessionCalendarSlugQuery.data.slug,
                          memberName: sessionCalendarSlugQuery.data.memberName,
                          existingBooking:
                            (sessionBookingsQuery.data || []).find((b: any) =>
                              b.providerUser?.provider?.id === selectedSummary.providerId ||
                              b.providerId === selectedSummary.providerId
                            ) ?? (sessionBookingsQuery.data || [])[0] ?? undefined,
                          consultationMeta: {
                            aiSessionId: selectedSessionId ?? undefined,
                            providerId: selectedSummary.providerId,
                            profileLabel: selectedSummary.title,
                            profilePhotoUrl: selectedSummary.profilePhotoUrl,
                            subjectProfileId: selectedSummary.subjectProfileId,
                            subjectType: selectedSummary.subjectType,
                          },
                          onBehalfOf: detail.user?.email ? {
                            name: detail.user.name || "Parent",
                            email: detail.user.email,
                            phone: detail.user.mobileNumber,
                          } : null,
                        } : null}
                        testId="admin-provider-profile-card"
                      />
                    </div>
                  )}
                  {/* Cost Sheet / Invoice / Agreement sections moved into the + drawer above the composer */}
                </>
              }
            />
          );
        })()}
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
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      headerAction={
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => resetAllChatsMutation.mutate()}
          disabled={resetAllChatsMutation.isPending}
        >
          {resetAllChatsMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Trash2 className="w-3.5 h-3.5 mr-1" />}
          Delete Chats
        </Button>
      }
    />
  );
}

/**
 * "What Eva knows" - the takeover briefing. Shows the session's rolling
 * summary (the exact context injected into Eva's prompt each turn) and the
 * family's durable concierge memory, editable in place via the shared
 * ConciergeMemoryTab admin variant. Collapsed by default so the sidebar
 * stays scannable; no modal per design rules.
 */
function EvaKnowledgePanel({ historySummary, parentAccountId }: { historySummary?: string | null; parentAccountId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b pb-4 mb-4" data-testid="eva-knowledge-panel">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
        data-testid="btn-toggle-eva-knowledge"
      >
        <h4 className="font-semibold text-sm flex items-center gap-1.5" style={{ fontFamily: "var(--font-display)" }}>
          <Brain className="w-4 h-4 text-primary" /> What Eva knows
        </h4>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-3 space-y-4">
          <div>
            <p className="t-micro-label mb-1">Session summary</p>
            {historySummary ? (
              <p className="text-xs text-foreground whitespace-pre-wrap bg-secondary/50 rounded-md p-2.5" data-testid="text-history-summary">
                {historySummary}
              </p>
            ) : (
              <p className="t-helper">
                No rolling summary yet - it starts once the conversation is long enough to fold (about 28 turns).
              </p>
            )}
          </div>
          <div>
            <p className="t-micro-label mb-1">Family memory</p>
            <ConciergeMemoryTab admin={{ parentAccountId }} />
          </div>
        </div>
      )}
    </div>
  );
}
