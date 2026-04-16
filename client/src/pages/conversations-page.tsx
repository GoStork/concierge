import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageStatus } from "@/components/ui/message-status";
import { OnlineIndicator } from "@/components/ui/online-indicator";
import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  ArrowLeft, MessageSquare, User, Loader2, FileText, X,
  CheckCircle2, UserPlus, Shield, ThumbsUp, ThumbsDown,
  Sparkles, Building2, ChevronDown, MessageCircle,
  CalendarDays, Video, Trash2, Headphones,
  // Used by legacy dead code pending removal
  CalendarClock, Check, Clock, Crown, Download, ExternalLink, Paperclip, Send,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { hasProviderRole } from "@shared/roles";
import { useAppDispatch } from "@/store";
import { setHideBottomNav } from "@/store/uiSlice";
import { deriveChatPalette } from "@/lib/chat-palette";
import { format } from "date-fns";
import ConciergeChatPage, { ParentChatSidePanel, type ParentSidePanelData } from "@/pages/concierge-chat-page";
// Legacy imports for dead code pending removal
import { SwipeDeckCard, type TabSection } from "@/components/marketplace/swipe-deck-card";
import {
  mapDatabaseDonorToSwipeProfile,
  mapDatabaseSurrogateToSwipeProfile,
  mapDatabaseSpermDonorToSwipeProfile,
  buildTitle,
  buildStatusLabel,
  getPhotoList,
  getSurrogateTabs,
  getDonorTabs,
} from "@/components/marketplace/swipe-mappers";
import { InlineSuggestTimeForm, getProfileUrlSlug } from "@/components/chat";
import {
  timeAgo,
  truncateMessage,
  ConversationsShell,
  InlineVideoOverlay,
  ChatMessageList,
  ChatInputBar,
  WhisperDisclaimer,
  ChatProfileSidebar,
  type FilterTab,
} from "@/components/chat";

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
  profilePhotoUrl: string | null;
  subjectProfileId: string | null;
  subjectType: string | null;
  providerJoinedAt: string | null;
  humanRequested: boolean;
  humanJoinedAt: string | null;
  humanConcludedAt: string | null;
  lastMessage: string | null;
  lastMessageAt: string;
  lastMessageSenderType: string | null;
  lastMessageRole: string | null;
  lastMessageDeliveredAt: string | null;
  lastMessageReadAt: string | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ProviderSession {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userAvatar: string | null;
  status: string;
  sessionType: string;
  providerJoinedAt: string | null;
  providerName: string | null;
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
  pendingQuestions: number;
}

import type { SessionDetail } from "@/components/chat";

// Sub-components (InlineSuggestTimeForm, InlineBookingNotification, WhisperProfileCard,
// SpecialMessageCard, InlineVideoOverlay, ConversationsShell, ChatMessageList, ChatInputBar,
// ChatProfileSidebar) extracted to @/components/chat/

/* Dead code: InlineBookingNotification, WhisperProfileCard, SpecialMessageCard
   extracted to @/components/chat/ - these local copies will be removed in a follow-up cleanup */
function _InlineBookingNotification_DEAD({ booking, brandColor, onUpdate }: { booking: any; brandColor: string; onUpdate: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showSuggestForm, setShowSuggestForm] = useState(false);
  const isProvider = booking?.providerUserId === user?.id;
  const isPending = booking?.status === "PENDING";
  const isConfirmed = booking?.status === "CONFIRMED";
  const isCancelled = booking?.status === "CANCELLED";
  const isRescheduled = booking?.status === "RESCHEDULED";

  const confirmMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/confirm`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" as any });
      onUpdate();
    },
  });

  const declineMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/calendar/bookings/${booking.id}/decline`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" as any });
      onUpdate();
    },
  });

  if (!booking) return null;
  const start = new Date(booking.scheduledAt);
  const providerName = booking.providerUser?.name || "Provider";
  const orgName = booking.providerUser?.provider?.name || "";

  const members = booking.parentAccountMembers || [];
  const attendees = members.length > 0
    ? members
    : booking.parentUser
    ? [booking.parentUser]
    : [];

  return (
    <div className="mx-auto max-w-[85%] my-3" data-testid={`inline-booking-card-${booking.id}`}>
      <div
        className="bg-card border border-border overflow-hidden"
        style={{ borderRadius: "var(--container-radius, 0.5rem)" }}
      >
        <div className="p-1.5" style={{ backgroundColor: brandColor }}>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <CalendarClock className="w-4 h-4 text-primary-foreground" />
            <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
              {orgName ? `${orgName} Consultation Call` : "Consultation Call"}
            </span>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
              isConfirmed
                ? "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))]"
                : isPending
                ? "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))]"
                : isCancelled
                ? "bg-destructive/10 text-destructive"
                : isRescheduled
                ? "bg-muted text-muted-foreground"
                : "bg-muted text-foreground"
            }`}>
              {isPending ? "Pending Approval" : isCancelled ? "Cancelled" : isRescheduled ? "Rescheduled" : booking.status}
            </span>
          </div>

          <div className="bg-muted/40 rounded-[var(--radius)] p-3 space-y-2.5 border border-border">
            <div className="flex items-center gap-2 text-sm">
              <CalendarClock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{format(start, "EEEE, MMMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{format(start, "h:mm a")} ({booking.duration} min)</span>
            </div>
          </div>

          <div className="bg-muted/40 rounded-[var(--radius)] p-3 border border-border">
            <div className="flex items-center gap-2 mb-2">
              <Crown className="w-3.5 h-3.5" style={{ color: brandColor }} />
              <span className="text-xs font-semibold">Participants</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm pl-1">
                <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: `${brandColor}1A` }}>
                  <Crown className="w-3 h-3" style={{ color: brandColor }} />
                </div>
                <span className="font-medium text-xs">{providerName}</span>
                <span className="text-xs text-muted-foreground">(Host)</span>
              </div>
              {attendees.map((a: any) => (
                <div key={a.id || a.email} className="flex items-center gap-2 text-sm pl-1">
                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3 text-primary" />
                  </div>
                  <span className="font-medium text-xs">{a.name || a.email}</span>
                  {a.email && a.name && <span className="text-xs text-muted-foreground">({a.email})</span>}
                </div>
              ))}
            </div>
          </div>

          {isPending && isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">This meeting request needs your confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">Requested by {booking.attendeeName || booking.parentUser?.name || "a parent"}.</p>
            </div>
          )}

          {isPending && !isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">Awaiting provider confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">We'll send you an email once {providerName} confirms your booking.</p>
            </div>
          )}

          {isConfirmed && (
            <div className="bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-success))]">Meeting confirmed</p>
              <p className="text-[11px] text-[hsl(var(--brand-success))] mt-0.5">This meeting has been confirmed. You'll receive a reminder before it starts.</p>
            </div>
          )}

          {isCancelled && (
            <div className="bg-destructive/5 border border-destructive/20 rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-destructive">Meeting cancelled</p>
              <p className="text-[11px] text-destructive/80 mt-0.5">This meeting has been cancelled by the parent.</p>
            </div>
          )}

          {isRescheduled && (
            <div className="bg-muted/60 border border-border rounded-[var(--radius)] p-3">
              <p className="text-xs font-medium text-muted-foreground">Meeting rescheduled</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">This meeting was rescheduled. A new booking has been created.</p>
            </div>
          )}

          {showSuggestForm && isPending && isProvider && (
            <div className="border border-border/50 rounded-[var(--radius)] p-3 space-y-2">
              <p className="text-sm font-medium">Suggest a new time</p>
              <InlineSuggestTimeForm
                bookingId={booking.id}
                onCancel={() => setShowSuggestForm(false)}
                onSuccess={() => { setShowSuggestForm(false); onUpdate(); }}
              />
            </div>
          )}
        </div>

        {isPending && isProvider && !showSuggestForm && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t bg-muted/20">
            <Button size="sm" onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} className="gap-1 text-xs" data-testid="button-confirm-booking-inline">
              {confirmMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Confirm
            </Button>
            <Button size="sm" variant="outline" className="text-destructive gap-1 text-xs" onClick={() => declineMutation.mutate()} disabled={confirmMutation.isPending || declineMutation.isPending} data-testid="button-decline-booking-inline">
              {declineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              Decline
            </Button>
            <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => setShowSuggestForm(true)} data-testid="button-suggest-new-time-inline">
              <CalendarClock className="w-3.5 h-3.5" /> New Time
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function WhisperProfileCard({ card, brandColor }: { card: any; brandColor: string }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!card?.ownerProviderId || !card?.providerId) { setLoading(false); return; }
    const t = (card.type || "").toLowerCase();
    const endpoint = t === "surrogate" ? "surrogates" : t === "egg donor" ? "egg-donors" : t === "sperm donor" ? "sperm-donors" : "surrogates";
    fetch(`/api/providers/${card.ownerProviderId}/${endpoint}/${card.providerId}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setProfile(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [card?.ownerProviderId, card?.providerId, card?.type]);

  if (loading) {
    return (
      <div className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center mb-2">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profile) {
    const t = (card.type || "").toLowerCase();
    const isSurrogate = t === "surrogate";
    const swipeProfile = isSurrogate
      ? mapDatabaseSurrogateToSwipeProfile(profile)
      : t === "sperm donor"
        ? mapDatabaseSpermDonorToSwipeProfile(profile)
        : mapDatabaseDonorToSwipeProfile(profile);
    const photos = getPhotoList(swipeProfile);
    const title = buildTitle(swipeProfile);
    const statusLabel = buildStatusLabel(swipeProfile);
    const baseTabs = isSurrogate ? getSurrogateTabs(swipeProfile, []) : getDonorTabs(swipeProfile, []);
    const reasons = card.reasons || [];
    const tabs: TabSection[] = reasons.length > 0
      ? [{ layoutType: "matched_bubbles" as const, title: `Matched ${reasons.length} Preference${reasons.length !== 1 ? "s" : ""}`, items: reasons.map((r: string) => ({ label: r, value: "" })) }, ...baseTabs]
      : baseTabs;

    return (
      <div className="w-full max-w-sm aspect-[3/4] mb-2" data-testid={`whisper-profile-card-${card.providerId}`}>
        <SwipeDeckCard
          id={card.providerId}
          photos={photos}
          title={title}
          statusLabel={statusLabel}
          isExperienced={swipeProfile.isExperienced}
          isPremium={swipeProfile.isPremium}
          tabs={tabs}
          disableSwipe
          chatMode
          readOnly
          onPass={() => {}}
          onSave={() => {}}
          onViewFullProfile={() => {
            if (card.ownerProviderId) {
              const slug = getProfileUrlSlug(card.type);
              navigate(`/${slug}/${card.ownerProviderId}/${card.providerId}`, {
                state: {
                  fromChat: true,
                  matchReasons: card.reasons || [],
                  chatPath: window.location.pathname + window.location.search,
                },
              });
            }
          }}
        />
      </div>
    );
  }

  if (card?.photo) {
    return (
      <div className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted relative mb-2" data-testid={`whisper-profile-card-${card.providerId}`}>
        <img src={getPhotoSrc(card.photo) || undefined} alt={card.name} className="w-full h-full object-cover" />
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 pb-6 px-4">
          <h3 className="text-white font-heading text-xl leading-tight">{card.name}</h3>
          {card.location && <p className="text-white/70 text-sm mt-1">{card.location}</p>}
        </div>
      </div>
    );
  }

  return null;
}

function SpecialMessageCard({ msg, brandColor, viewerRole, onOpenInlineVideo }: { msg: any; brandColor: string; viewerRole?: "provider" | "parent"; onOpenInlineVideo?: (bookingId: string) => void }) {
  const data = msg.uiCardData as any;
  if (!data) return null;

  if (msg.uiCardType === "attachment") {
    const isImage = data.mimeType?.startsWith("image/");
    const fileUrl = getPhotoSrc(data.url) || data.url;
    return (
      <div className="mt-1" data-testid="attachment-card">
        {isImage ? (
          <a href={fileUrl} target="_blank" rel="noopener noreferrer">
            <img src={fileUrl} alt={data.originalName} className="max-w-[240px] rounded-[var(--radius)] border" />
          </a>
        ) : (
          <a
            href={fileUrl}
            download={data.originalName}
            className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] border bg-background hover:bg-muted transition-colors"
          >
            <FileText className="w-5 h-5 shrink-0" style={{ color: brandColor }} />
            <span className="text-sm font-medium truncate">{data.originalName || "File"}</span>
            <Download className="w-4 h-4 shrink-0 text-muted-foreground" />
          </a>
        )}
      </div>
    );
  }

  if (msg.uiCardType === "video_invite") {
    const isProviderViewer = viewerRole === "provider";
    const videoBookingId = data.bookingId;
    if (!videoBookingId) {
      return (
        <div className="mt-1" data-testid="video-invite-card">
          <div className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-muted/50 w-full text-left opacity-60" style={{ borderColor: brandColor }}>
            <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground/70 shrink-0" style={{ backgroundColor: brandColor }}>
              <Video className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-muted-foreground">Video Call Ended</p>
              <p className="text-xs text-muted-foreground">This call session has expired</p>
            </div>
          </div>
        </div>
      );
    }
    const handleVideoClick = (e: React.MouseEvent) => {
      e.preventDefault();
      if (onOpenInlineVideo) {
        onOpenInlineVideo(videoBookingId);
      }
    };
    return (
      <div className="mt-1" data-testid="video-invite-card">
        <button
          onClick={handleVideoClick}
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors cursor-pointer w-full text-left"
          style={{ borderColor: brandColor }}
          data-testid="button-video-invite"
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <Video className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{isProviderViewer ? "Start Video Call" : "Join Video Call"}</p>
            <p className="text-xs text-muted-foreground">{isProviderViewer ? "Click to start the video consultation" : "Click to join the video consultation"}</p>
          </div>
          <Video className="w-4 h-4 text-muted-foreground shrink-0" />
        </button>
      </div>
    );
  }

  if (msg.uiCardType === "calendar_share") {
    return (
      <div className="mt-1" data-testid="calendar-share-card">
        <a
          href={data.bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
          style={{ borderColor: brandColor }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <CalendarDays className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Book a Meeting</p>
            <p className="text-xs text-muted-foreground">{data.memberName ? `Schedule with ${data.memberName}` : "Pick a time that works for you"}</p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>
      </div>
    );
  }

  return null;
}
/* DEAD_CODE_BLOCK_END */

export default function ConversationsPage() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const navigate = useNavigate();
  const { entityId: urlEntityId, subjectId: urlSubjectId } = useParams<{ entityId?: string; subjectId?: string }>();
  const [searchParams] = useSearchParams();
  const isConciergeUrl = window.location.pathname === "/chat/concierge" || window.location.pathname === "/concierge";
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const brandColor = brand?.primaryColor || "#004D4D";
  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const roles: string[] = (user as any)?.roles || [];
  const isParent = roles.includes("PARENT") && !roles.some((r: string) => ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"].includes(r)) && !hasProviderRole(roles);
  const isProvider = hasProviderRole(roles) || (roles.includes("GOSTORK_ADMIN") && !!(user as any)?.providerId);
  const showConcierge = brand?.enableAiConcierge !== false;
  const isAdmin = roles.includes("GOSTORK_ADMIN");
  const { toast } = useToast();

  const resetAllChatsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/admin/reset-all-chats");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "All chats reset", description: `Deleted ${data.deleted.sessions} sessions, ${data.deleted.bookings} bookings, ${data.deleted.parentProfiles} parent profiles` });
      queryClient.invalidateQueries();
    },
    onError: (err: any) => {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    },
  });

  const myDisplayName = useMemo(() => {
    const u = user as any;
    if (!u?.name) return "";
    const parts = u.name.trim().split(/\s+/);
    return parts.length >= 2
      ? `${parts[0]} ${parts[parts.length - 1][0]}.`
      : parts[0] || "";
  }, [user]);

  // Helper: build chat URL from session data
  const buildChatUrl = (session: ChatSession | ProviderSession | null): string => {
    if (!session) return "/chat";
    // AI concierge sessions - use the same "isProviderThread" logic as the sidebar:
    // a session is a concierge-only session if it has a matchmakerId and has NOT yet
    // had the provider join (providerJoinedAt null, status not CONSULTATION_BOOKED/PROVIDER_JOINED).
    // Note: providerId may be set on concierge sessions (for whisper/silent passthrough) but
    // that alone does NOT make it a provider thread.
    if ("matchmakerId" in session && session.matchmakerId) {
      const cs = session as ChatSession;
      const isProviderThread = !!cs.providerJoinedAt || cs.status === "CONSULTATION_BOOKED" || cs.status === "PROVIDER_JOINED";
      if (!isProviderThread) {
        return `/chat/concierge?session=${session.id}`;
      }
    }
    // Provider chat sessions - use providerId + subjectProfileId
    const entityId = isProvider ? (session as ProviderSession).userId : (session as ChatSession).providerId;
    const subjectId = session.subjectProfileId;
    if (entityId && subjectId) return `/chat/${entityId}/${subjectId}`;
    if (entityId) return `/chat/${entityId}/${session.id}`;
    return "/chat";
  };

  const lastChatKey = user ? `lastChatUrl:${(user as any).id}` : null;

  const [selectedSessionId, _setSelectedSessionId] = useState<string | null>(null);
  const setSelectedSessionId = (id: string | null, session?: ChatSession | ProviderSession | null) => {
    _setSelectedSessionId(id);
    generateAgreementMutation.reset();
    setPanelShowSuggestForm(false);
    const url = session ? buildChatUrl(session) : "/chat";
    if (lastChatKey && url !== "/chat") localStorage.setItem(lastChatKey, url);
    navigate(url, { replace: true });
  };
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [replyText, setReplyText] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});

  useEffect(() => {
    dispatch(setHideBottomNav(!!selectedSessionId));
    return () => { dispatch(setHideBottomNav(false)); };
  }, [selectedSessionId, dispatch]);

  const parentSessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["/api/my/chat-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/my/chat-sessions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch chat sessions");
      return res.json();
    },
    enabled: isParent && !!user,
    refetchInterval: 10000,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const providerSessionsQuery = useQuery<ProviderSession[]>({
    queryKey: ["/api/provider/concierge-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/provider/concierge-sessions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: isProvider && !!user,
    refetchInterval: 10000,
    staleTime: 0,
    refetchOnMount: "always",
  });

  // Resolve provider selectedSessionId from URL params when sessions load
  useEffect(() => {
    if (!isProvider || !urlEntityId || !urlSubjectId) return;
    const sessions = providerSessionsQuery.data || [];
    const match = sessions.find(s => s.userId === urlEntityId && s.subjectProfileId === urlSubjectId)
      || sessions.find(s => s.userId === urlEntityId && s.id === urlSubjectId);
    if (match && selectedSessionId !== match.id) {
      _setSelectedSessionId(match.id);
    }
  }, [isProvider, urlEntityId, urlSubjectId, providerSessionsQuery.data]);

  // Auto-restore the last viewed chat when landing on /chat with no selection
  useEffect(() => {
    if (!lastChatKey) return;
    const currentPath = window.location.pathname;
    const hasUrlSelection = !!urlEntityId || !!urlSubjectId || window.location.search.includes("session=");
    if (currentPath !== "/chat" || hasUrlSelection) return;

    // Wait until the relevant session list has loaded
    const sessionsLoaded = isProvider
      ? !providerSessionsQuery.isLoading && providerSessionsQuery.data !== undefined
      : !parentSessionsQuery.isLoading && parentSessionsQuery.data !== undefined;
    if (!sessionsLoaded) return;

    const lastUrl = localStorage.getItem(lastChatKey);
    if (!lastUrl || lastUrl === "/chat") return;

    // Verify the session referenced in the stored URL still exists
    const allSessions = isProvider
      ? (providerSessionsQuery.data || [])
      : (parentSessionsQuery.data || []);
    const sessionIdMatch = lastUrl.match(/[?&]session=([^&]+)/);
    const pathIdMatch = lastUrl.match(/\/chat\/[^/]+\/([^/]+)/);
    const storedSessionId = sessionIdMatch?.[1] || pathIdMatch?.[1];
    const sessionExists = storedSessionId
      ? allSessions.some(s => s.id === storedSessionId || (s as any).subjectProfileId === storedSessionId)
      : allSessions.length > 0;

    if (sessionExists) {
      navigate(lastUrl, { replace: true });
    }
  }, [
    lastChatKey,
    isProvider,
    providerSessionsQuery.isLoading,
    providerSessionsQuery.data,
    parentSessionsQuery.isLoading,
    parentSessionsQuery.data,
    urlEntityId,
    urlSubjectId,
  ]);

  const sessionDetailQuery = useQuery<SessionDetail>({
    queryKey: ["/api/provider/concierge-sessions", selectedSessionId],
    queryFn: async () => {
      const res = await fetch(`/api/provider/concierge-sessions/${selectedSessionId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: isProvider && !!selectedSessionId,
    refetchInterval: 5000,
  });

  const sessionBookingsQuery = useQuery<any[]>({
    queryKey: ["/api/chat-session/bookings", selectedSessionId],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${selectedSessionId}/bookings`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isProvider && !!selectedSessionId,
    refetchInterval: 15000,
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
    mutationFn: async ({ sessionId, content, uiCardType, uiCardData }: { sessionId: string; content: string; uiCardType?: string; uiCardData?: any }) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content, uiCardType, uiCardData }),
      });
      if (!res.ok) throw new Error("Failed to send");
      return res.json();
    },
    onSuccess: (_data, variables) => {
      setReplyText("");
      // Optimistic sidebar update
      queryClient.setQueryData<ProviderSession[]>(["/api/provider/concierge-sessions"], (old) =>
        old?.map(s => s.id === variables.sessionId ? { ...s, lastMessage: variables.content, lastMessageAt: new Date().toISOString(), lastMessageSenderType: "provider" } : s)
      );
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
      const res = await fetch("/api/agreements/generate-from-template", {
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

  const bookingConfirmMutation = useMutation({
    mutationFn: async (bookingId: string) => {
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/confirm`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-session/bookings", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting confirmed", description: "The parent has been notified.", variant: "success" as any });
    },
  });

  const bookingDeclineMutation = useMutation({
    mutationFn: async (bookingId: string) => {
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/decline`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat-session/bookings", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "Meeting declined", description: "The parent has been notified.", variant: "success" as any });
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [providerStagedFiles, setProviderStagedFiles] = useState<File[]>([]);
  const [providerUploading, setProviderUploading] = useState(false);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = "";
    setProviderStagedFiles(prev => [...prev, ...Array.from(files)]);
  };

  const removeProviderStagedFile = (index: number) => {
    setProviderStagedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleProviderMeeting = async () => {
    if (!selectedSessionId) return;
    try {
      const res = await fetch("/api/provider/calendar-slug", { credentials: "include" });
      const { slug } = await res.json();
      if (!slug) {
        alert("You haven't set up your booking calendar yet. Go to Settings → Calendar to configure it.");
        return;
      }
      const bookingUrl = `${window.location.origin}/book/${slug}`;
      sendMessageMutation.mutate({
        sessionId: selectedSessionId,
        content: "I've shared my calendar - pick a time that works for you!",
        uiCardType: "calendar_share",
        uiCardData: { bookingUrl, slug, memberName: (user as any)?.name },
      });
    } catch {
      alert("Failed to load calendar. Please try again.");
    }
  };

  const [inlineVideoBookingId, setInlineVideoBookingId] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "video-call-ended") {
        setInlineVideoBookingId(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleProviderVideo = async () => {
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
      alert("Failed to create video room. Please try again.");
    }
  };

  const providerScrollDone = useRef(false);
  useEffect(() => {
    providerScrollDone.current = false;
    const scrollToEnd = () => {
      if (chatEndRef.current) {
        const container = chatEndRef.current.closest('[data-testid="provider-chat-messages"]');
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      }
    };
    scrollToEnd();
    const t1 = setTimeout(scrollToEnd, 150);
    const t2 = setTimeout(scrollToEnd, 400);
    const t3 = setTimeout(scrollToEnd, 800);
    const t4 = setTimeout(() => { scrollToEnd(); providerScrollDone.current = true; }, 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, [sessionDetailQuery.data?.messages?.length, sessionBookingsQuery.data?.length, selectedSessionId]);

  // Watch for layout shifts (image loads, card renders) in provider chat
  useEffect(() => {
    if (!chatEndRef.current) return;
    const container = chatEndRef.current.closest('[data-testid="provider-chat-messages"]');
    if (!container) return;

    const scrollToEnd = () => {
      if (!providerScrollDone.current) container.scrollTop = container.scrollHeight;
    };

    // MutationObserver catches card renders and image loads within the scroll window
    const mutObs = new MutationObserver(scrollToEnd);
    mutObs.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style", "class"] });

    container.addEventListener("load", scrollToEnd, true);

    // Stop after 3 seconds to avoid interfering with user scroll
    const stopTimer = setTimeout(() => {
      mutObs.disconnect();
      container.removeEventListener("load", scrollToEnd, true);
    }, 3000);

    return () => {
      mutObs.disconnect();
      container.removeEventListener("load", scrollToEnd, true);
      clearTimeout(stopTimer);
    };
  }, [sessionDetailQuery.data?.messages?.length, sessionBookingsQuery.data?.length, selectedSessionId]);

  const handleSendReply = async (text?: string, files?: File[]) => {
    const msgText = text ?? replyText.trim();
    const msgFiles = files ?? providerStagedFiles;
    if ((!msgText && msgFiles.length === 0) || !selectedSessionId) return;

    if (msgFiles.length > 0) {
      setProviderUploading(true);
      try {
        // Upload all files
        const uploadedFiles: Array<{ originalName: string; url: string; mimeType: string; size: number }> = [];
        for (const file of msgFiles) {
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: formData });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw Object.assign(new Error(errData.message || `Upload failed (${res.status})`), { isUploadError: true });
          }
          uploadedFiles.push(await res.json());
        }
        setProviderStagedFiles([]);

        // Send first file merged with text as ONE message
        const firstFile = uploadedFiles[0];
        const content = msgText || `Shared a file: ${firstFile.originalName}`;
        await sendMessageMutation.mutateAsync({
          sessionId: selectedSessionId,
          content,
          uiCardType: "attachment",
          uiCardData: firstFile,
        });

        // Additional files as separate attachment messages (no extra text)
        for (let i = 1; i < uploadedFiles.length; i++) {
          await sendMessageMutation.mutateAsync({
            sessionId: selectedSessionId,
            content: `Shared a file: ${uploadedFiles[i].originalName}`,
            uiCardType: "attachment",
            uiCardData: uploadedFiles[i],
          });
        }
      } catch (e: any) {
        alert(e?.message || "Failed to send. Please try again.");
        setProviderUploading(false);
        return;
      }
      setProviderUploading(false);
      return;
    }

    // Text-only message
    if (msgText) {
      sendMessageMutation.mutate({ sessionId: selectedSessionId, content: msgText });
    }
  };

  const parentSessions: ChatSession[] = parentSessionsQuery.data || [];
  // Resolve selected parent session from URL params
  const selectedParentSession = useMemo(() => {
    const isConciergeSession = (s: ChatSession) =>
      !!s.matchmakerId && !s.providerJoinedAt && s.status !== "CONSULTATION_BOOKED" && s.status !== "PROVIDER_JOINED";
    if (isConciergeUrl) {
      const sessionId = searchParams.get("session");
      if (sessionId) {
        // Try strict concierge-session filter first, then fall back to ID-only match.
        // The fallback prevents ConciergeChatPage from unmounting mid-conversation due to
        // a transient status change picked up by the 10-second background refetch.
        return (
          parentSessions.find(s => s.id === sessionId && isConciergeSession(s)) ||
          parentSessions.find(s => s.id === sessionId) ||
          null
        );
      }
      // Fallback: most recent concierge session (only when no ?session= param)
      return parentSessions.find(s => isConciergeSession(s)) || null;
    }
    if (urlEntityId && urlSubjectId) {
      // Match by providerId + subjectProfileId first, fallback to session id
      return parentSessions.find(s => s.providerId === urlEntityId && s.subjectProfileId === urlSubjectId)
        || parentSessions.find(s => s.providerId === urlEntityId && s.id === urlSubjectId)
        || null;
    }
    return null;
  }, [parentSessions, isConciergeUrl, urlEntityId, urlSubjectId, searchParams]);
  const setSelectedParentSession = (session: ChatSession | null) => {
    const url = session ? buildChatUrl(session) : "/chat";
    if (lastChatKey && url !== "/chat") localStorage.setItem(lastChatKey, url);
    navigate(url, { replace: true });
  };

  // When the fallback path selects a session (no ?session= in URL), immediately lock the
  // session ID into the URL. This prevents the sort-order-dependent fallback from switching
  // to a different session on each 10-second background refetch.
  useEffect(() => {
    if (!isConciergeUrl || !selectedParentSession || searchParams.get("session")) return;
    const lockedUrl = `/chat/concierge?session=${selectedParentSession.id}`;
    if (lastChatKey) localStorage.setItem(lastChatKey, lockedUrl);
    navigate(`?session=${selectedParentSession.id}`, { replace: true });
  }, [isConciergeUrl, selectedParentSession?.id, searchParams]);

  const handleParentSessionClick = (session: ChatSession) => {
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      // AI concierge chats go to dedicated concierge page on mobile
      if (session.matchmakerId && !session.providerId) {
        const params = new URLSearchParams();
        params.set("matchmaker", session.matchmakerId);
        params.set("session", session.id);
        navigate(`/concierge?${params.toString()}`);
      } else {
        // Provider chats use the same URL scheme on mobile
        navigate(buildChatUrl(session));
      }
    } else {
      setSelectedParentSession(session);
    }
  };

  // Send read receipt when opening a session + optimistically clear unread count
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = isProvider ? selectedSessionId : selectedParentSession?.id;
    if (sid) {
      // Optimistically clear unread count in both parent and provider caches
      queryClient.setQueryData<ChatSession[]>(["/api/my/chat-sessions"], (old) =>
        old?.map(s => s.id === sid ? { ...s, unreadCount: 0 } : s)
      );
      queryClient.setQueryData<ProviderSession[]>(["/api/provider/concierge-sessions"], (old) =>
        old?.map(s => s.id === sid ? { ...s, unreadCount: 0 } : s)
      );
      fetch(`/api/chat-sessions/${sid}/read`, { method: "POST", credentials: "include" }).catch(() => {});
      prevSessionRef.current = sid;
    } else if (prevSessionRef.current) {
      // User left a chat - send final read receipt and refresh session list
      const prevSid = prevSessionRef.current;
      prevSessionRef.current = null;
      fetch(`/api/chat-sessions/${prevSid}/read`, { method: "POST", credentials: "include" })
        .then(() => queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] }))
        .catch(() => {});
    }
  }, [isProvider, selectedSessionId, selectedParentSession?.id, queryClient]);

  // Reset talk-to-team escalation state and side panel when switching sessions
  useEffect(() => {
    setTalkToTeamEscalated(false);
    talkToTeamRef.current = null;
    setParentSidePanelData(null);
  }, [selectedParentSession?.id]);

  // Auto-navigate when the current concierge session transitions to a provider thread
  // (status becomes CONSULTATION_BOOKED or PROVIDER_JOINED after booking is submitted)
  useEffect(() => {
    if (!selectedParentSession || !isConciergeUrl) return;
    const isNowProviderThread =
      !!selectedParentSession.providerJoinedAt ||
      selectedParentSession.status === "CONSULTATION_BOOKED" ||
      selectedParentSession.status === "PROVIDER_JOINED";
    if (!isNowProviderThread) return;
    const targetUrl = buildChatUrl(selectedParentSession);
    if (targetUrl && targetUrl !== "/chat") {
      if (lastChatKey) localStorage.setItem(lastChatKey, targetUrl);
      navigate(targetUrl, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedParentSession?.status, selectedParentSession?.providerJoinedAt, isConciergeUrl]);

  // Immediately refetch sessions when GoStork human exits the chat
  useEffect(() => {
    const handler = () => {
      setTalkToTeamEscalated(false);
      queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
    };
    window.addEventListener("human-concluded", handler);
    return () => window.removeEventListener("human-concluded", handler);
  }, [queryClient]);

  const detail = sessionDetailQuery.data;
  const profile = detail?.user?.parentAccount?.intendedParentProfile;
  const selectedSession = (providerSessionsQuery.data || []).find(s => s.id === selectedSessionId);
  const hasJoined = !!detail?.providerJoinedAt;
  const isConsultationBooked = selectedSession?.status === "CONSULTATION_BOOKED" || detail?.status === "CONSULTATION_BOOKED";
  const isWhisperPhase = !hasJoined && !isConsultationBooked && (selectedSession?.pendingQuestions || 0) > 0;
  const canReply = hasJoined || isWhisperPhase || isConsultationBooked;

  // Online presence tracking
  const onlineProviderIds = useMemo(() => {
    if (!isParent) return [];
    return [...new Set((parentSessionsQuery.data || []).map(s => s.providerId).filter(Boolean) as string[])];
  }, [isParent, parentSessionsQuery.data]);
  const onlineUserIds = useMemo(() => {
    if (!isProvider) return [];
    const ids = (providerSessionsQuery.data || []).map(s => s.userId).filter(Boolean);
    if (detail?.user?.id) ids.push(detail.user.id);
    return [...new Set(ids)];
  }, [isProvider, providerSessionsQuery.data, detail?.user?.id]);
  const { statuses: onlineStatuses } = useOnlineStatus(onlineUserIds, onlineProviderIds);

  const [panelShowSuggestForm, setPanelShowSuggestForm] = useState(false);
  const [parentBookingOverlay, setParentBookingOverlay] = useState<{ slug: string; memberName: string } | null>(null);
  const talkToTeamRef = useRef<{ trigger: () => void; escalated: boolean } | null>(null);
  const [talkToTeamEscalated, setTalkToTeamEscalated] = useState(false);
  const [parentSidePanelData, setParentSidePanelData] = useState<ParentSidePanelData | null>(null);

  // When a booking appears while on the concierge URL, immediately navigate to the provider chat.
  // We use subjectInfo (from the consultation card already shown in chat) which has the
  // providerId and subjectProfileId needed to build the URL - no need to wait for sessions to reload.
  const prevBookingCountRef = useRef(0);
  useEffect(() => {
    const bookingCount = parentSidePanelData?.sessionBookings?.length ?? 0;
    const wasZero = prevBookingCountRef.current === 0;
    prevBookingCountRef.current = bookingCount;

    if (!wasZero || bookingCount === 0 || !isConciergeUrl) return;

    // Invalidate sessions so the provider session loads at the target URL
    queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });

    // Build the target URL directly from subjectInfo (available immediately from the consultation card)
    const providerId = parentSidePanelData!.subjectInfo?.providerId;
    const subjectProfileId = parentSidePanelData!.subjectInfo?.subjectProfileId;

    let targetUrl: string | null = null;
    if (providerId && subjectProfileId) {
      targetUrl = `/chat/${providerId}/${subjectProfileId}`;
    } else if (providerId) {
      // Fallback: try to find the session in current parentSessions
      const session = parentSessions.find(
        s => s.providerId === providerId && (
          !s.matchmakerId ||
          s.status === "CONSULTATION_BOOKED" ||
          s.status === "PROVIDER_JOINED" ||
          !!s.providerJoinedAt
        )
      );
      if (session) targetUrl = buildChatUrl(session);
    }

    if (targetUrl && targetUrl !== "/chat") {
      if (lastChatKey) localStorage.setItem(lastChatKey, targetUrl);
      navigate(targetUrl, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentSidePanelData?.sessionBookings?.length, isConciergeUrl]);

  const handleParentMeeting = async () => {
    if (!selectedParentSession) return;
    try {
      const res = await fetch(`/api/chat-session/${selectedParentSession.id}/provider-calendar-slug`, { credentials: "include" });
      const data = await res.json();
      if (data.slug) {
        setParentBookingOverlay({ slug: data.slug, memberName: data.memberName || selectedParentSession.providerName || "Provider" });
      } else {
        alert("This provider hasn't set up online scheduling yet. You can message them to arrange a meeting.");
      }
    } catch {
      alert("Failed to load calendar. Please try again.");
    }
  };

  const handleParentVideo = async () => {
    if (!selectedParentSession) return;
    try {
      const res = await fetch("/api/video/chat-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId: selectedParentSession.id }),
      });
      if (!res.ok) throw new Error("Failed");
      const { bookingId } = await res.json();
      setInlineVideoBookingId(bookingId);
    } catch {
      alert("Failed to start video call. Please try again.");
    }
  };

  if (isParent) {
    // New parent with no sessions - go straight to matchmaker selection.
    // Guards:
    // - skip if actively in a session (?session= param) to prevent transient empty refetch from navigating away
    // - skip if a specific entity URL is set (/chat/:entityId/:subjectId) - user navigated to a specific session
    // - skip while query is still fetching (isFetching covers background refetches where isLoading is already false)
    if (!parentSessionsQuery.isLoading && !parentSessionsQuery.isFetching && parentSessionsQuery.data && parentSessionsQuery.data.length === 0 && !searchParams.get("session") && !urlEntityId) {
      navigate("/matchmaker-selection", { replace: true });
      return null;
    }
    const allSessions = parentSessionsQuery.data || [];
    const isProviderThread = (s: ChatSession) =>
      s.providerJoinedAt != null ||
      s.status === "CONSULTATION_BOOKED" ||
      s.status === "PROVIDER_JOINED";
    const allEvaConversations = allSessions.filter(s => !isProviderThread(s));
    const sortedEva = [...allEvaConversations].sort((a, b) =>
      new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
    const evaConversations = sortedEva.length > 0 ? [sortedEva[0]] : [];
    const providerConversations = allSessions.filter(s => isProviderThread(s));

    const filteredEva = evaConversations.filter(s =>
      !searchQuery || (s.matchmakerName || "Eva").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.title || "").toLowerCase().includes(searchQuery.toLowerCase())
    );
    const filteredProvider = providerConversations.filter(s =>
      !searchQuery || (s.providerName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    const providerGroups: Record<string, ChatSession[]> = {};
    filteredProvider.forEach(s => {
      const key = s.providerId || "other";
      if (!providerGroups[key]) providerGroups[key] = [];
      providerGroups[key].push(s);
    });

    const toggleProvider = (id: string) => {
      setExpandedProviders(prev => ({ ...prev, [id]: !prev[id] }));
    };

    const hasParentSession = !!selectedParentSession;

    // Show left sidebar and right profile panel only when a booking exists (consultation mode).
    // AI-only chats (no booking yet) show full-width centered middle pane with no sidebars.
    // Also immediately show sidebar when the selected session is already a provider thread
    // (CONSULTATION_BOOKED / PROVIDER_JOINED) - avoids a flash of missing sidebar while the
    // inline ConciergeChatPage loads and calls onSidePanelChange for the new session.
    const parentShowSidebar =
      (selectedParentSession && isProviderThread(selectedParentSession)) ||
      (
        (parentSidePanelData?.providerInChat === true) &&
        (parentSidePanelData.sessionBookings?.length ?? 0) > 0
      );

    const hasSessions = allSessions.length > 0;
    const sidebarContent = hasSessions ? (
      <div className="pb-24">
        {filteredEva.length > 0 && (
          <div data-testid="section-concierge">
            <div
              className="mx-4 mt-3 mb-2 px-3 py-2 rounded-[var(--radius)] flex items-center gap-2"
              style={{ backgroundColor: `${brandColor}08` }}
            >
              <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
              <span className="text-xs font-semibold" style={{ color: brandColor }}>Your AI Concierge</span>
            </div>
            {filteredEva.map(session => (
              <button
                key={session.id}
                className={`w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left border-b border-border/20 ${selectedParentSession?.id === session.id ? "bg-muted/70" : ""}`}
                onClick={() => handleParentSessionClick(session)}
                data-testid={`chat-session-${session.id}`}
              >
                <div className="w-11 h-11 rounded-full flex-shrink-0 relative">
                  {session.matchmakerAvatar && (
                    <img
                      src={getPhotoSrc(session.matchmakerAvatar) || undefined}
                      alt={session.matchmakerName || ""}
                      className="w-11 h-11 rounded-full object-cover border absolute inset-0"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div
                    className="w-11 h-11 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold"
                    style={{ backgroundColor: brandColor }}
                  >
                    {(session.matchmakerName || "E").charAt(0)}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-ui truncate" style={{ fontWeight: 600 }}>{session.matchmakerName || "Eva"}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={`text-[11px] ${session.unreadCount > 0 ? "font-semibold" : "text-muted-foreground"}`} style={session.unreadCount > 0 ? { color: brandColor } : undefined}>{timeAgo(session.lastMessageAt)}</span>
                      {session.unreadCount > 0 && (
                        <span className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1" style={{ backgroundColor: brandColor }}>
                          {session.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                  {session.lastMessage && (
                    <p className="text-sm text-muted-foreground truncate mt-0.5 flex items-center gap-1">
                      {session.lastMessageRole === "user" && (
                        <MessageStatus deliveredAt={session.lastMessageDeliveredAt} readAt={session.lastMessageReadAt} brandColor={brandColor} className="flex-shrink-0" />
                      )}
                      <span className="truncate">{truncateMessage(session.lastMessage)}</span>
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {Object.keys(providerGroups).length > 0 && (
          <div className="mt-2" data-testid="section-provider-chats">
            <div className="px-4 py-2">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Provider Conversations</span>
            </div>
            {Object.entries(providerGroups).map(([providerId, sessions]) => {
              const first = sessions[0];
              const isExpanded = expandedProviders[providerId] !== false;
              return (
                <Collapsible key={providerId} open={isExpanded} onOpenChange={() => toggleProvider(providerId)}>
                  <CollapsibleTrigger className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors text-left" data-testid={`provider-group-${providerId}`}>
                    <div className="w-12 h-12 rounded-full flex-shrink-0 relative">
                      {first.providerLogo ? (
                        <img src={getPhotoSrc(first.providerLogo) || undefined} alt="" className="w-12 h-12 rounded-full object-cover border" />
                      ) : (
                        <div className="w-12 h-12 rounded-full flex items-center justify-center bg-muted text-muted-foreground">
                          <Building2 className="w-4 h-4" />
                        </div>
                      )}
                      {first.providerId && onlineStatuses[first.providerId] && <OnlineIndicator size="sm" />}
                    </div>
                    <span className="font-medium text-sm font-ui flex-1">{first.providerName}</span>
                    <span className="text-[11px] text-muted-foreground mr-1">{sessions.length}</span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {sessions.map(session => {
                      const photoSrc = getPhotoSrc(session.profilePhotoUrl);
                      return (
                        <button
                          key={session.id}
                          className="w-full flex items-center gap-3 pl-10 pr-4 py-3 hover:bg-muted/50 transition-colors text-left border-b border-border/10"
                          onClick={() => handleParentSessionClick(session)}
                          data-testid={`chat-session-provider-${session.id}`}
                        >
                          <div className="w-12 h-12 rounded-full flex-shrink-0 relative overflow-hidden">
                            {photoSrc ? (
                              <img
                                src={photoSrc}
                                alt={session.title || ""}
                                className="w-12 h-12 rounded-full object-cover"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling && ((e.target as HTMLImageElement).nextElementSibling as HTMLElement)?.style && ((e.target as HTMLImageElement).nextElementSibling as HTMLElement).style.setProperty('display', 'flex'); }}
                              />
                            ) : (
                              <div
                                className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground text-xs font-bold"
                                style={{ backgroundColor: brandColor }}
                              >
                                {(session.title || "C").charAt(0)}
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-sm font-ui truncate">{session.title || session.matchmakerName || "Conversation"}</span>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                <span className={`text-[11px] ${session.unreadCount > 0 ? "font-semibold" : "text-muted-foreground"}`} style={session.unreadCount > 0 ? { color: brandColor } : undefined}>{timeAgo(session.lastMessageAt)}</span>
                                {session.unreadCount > 0 && (
                                  <span className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1" style={{ backgroundColor: brandColor }}>
                                    {session.unreadCount}
                                  </span>
                                )}
                              </div>
                            </div>
                            {session.lastMessage && (
                              <p className="text-sm text-muted-foreground truncate mt-0.5 flex items-center gap-1">
                                {session.lastMessageRole === "user" && (
                                  <MessageStatus deliveredAt={session.lastMessageDeliveredAt} readAt={session.lastMessageReadAt} brandColor={brandColor} className="flex-shrink-0" />
                                )}
                                <span className="truncate">{truncateMessage(session.lastMessage)}</span>
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        )}
      </div>
    ) : null;

    const parentProviderJoined = !!selectedParentSession?.providerJoinedAt;
    const hasProvider = !!selectedParentSession?.providerId;
    const parentHeaderName = hasProvider
      ? (selectedParentSession!.providerName || "Provider")
      : (selectedParentSession?.matchmakerName || "AI Concierge");
    const parentHeaderAvatar = hasProvider
      ? (selectedParentSession!.providerLogo || null)
      : getPhotoSrc(selectedParentSession?.matchmakerAvatar) || null;

    const parentDetailContent = hasParentSession ? (
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Centering wrapper: constrains both header and content to max-w-3xl in AI-only mode; fills flex-1 in consultation mode */}
        <div className={`flex flex-col flex-1 min-h-0 overflow-hidden${parentShowSidebar ? "" : " max-w-3xl mx-auto w-full"}`}>
        <div className="flex items-center gap-3 px-4 py-3 border-b bg-background shrink-0" data-testid="parent-chat-header">
          <Button
            variant="ghost"
            size="sm"
            className={`h-8 w-8 p-0 ${parentShowSidebar ? "md:hidden" : ""}`}
            onClick={() => setSelectedParentSession(null)}
            data-testid="btn-back-parent-chat"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          {/* Subject photo + ID (left side, only for provider sessions with a subject) */}
          {selectedParentSession!.providerId && selectedParentSession!.title ? (
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden bg-muted">
                {selectedParentSession!.profilePhotoUrl ? (
                  <img src={getPhotoSrc(selectedParentSession!.profilePhotoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <User className="w-4 h-4 text-muted-foreground" />
                  </div>
                )}
              </div>
              <span className="font-semibold text-sm font-ui truncate" data-testid="parent-chat-subject-label">{selectedParentSession!.title}</span>
            </div>
          ) : (
            /* Concierge or no-subject: show the standard avatar */
            <div className="w-10 h-10 rounded-full flex-shrink-0 relative">
              {parentHeaderAvatar ? (
                <img src={parentHeaderAvatar} alt={parentHeaderName} className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold" style={{ backgroundColor: brandColor }}>
                  {parentHeaderName.charAt(0)}
                </div>
              )}
            </div>
          )}
          {/* Separator */}
          {selectedParentSession!.providerId && selectedParentSession!.title && (
            <span className="text-muted-foreground text-base font-medium flex-shrink-0 px-1" aria-hidden>x</span>
          )}
          {/* Provider logo + name (right side) OR concierge name */}
          {selectedParentSession!.providerId && selectedParentSession!.title ? (
            <div className="flex items-center gap-2 min-w-0">
              {parentHeaderAvatar ? (
                <img src={parentHeaderAvatar} alt={parentHeaderName} className="w-10 h-10 rounded-full object-contain flex-shrink-0 border border-border bg-white" />
              ) : (
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold flex-shrink-0" style={{ backgroundColor: brandColor }}>
                  {parentHeaderName.charAt(0)}
                </div>
              )}
              {selectedParentSession!.providerId && onlineStatuses[selectedParentSession!.providerId] && <OnlineIndicator size="md" />}
              <span className="font-semibold text-sm font-ui truncate">{parentHeaderName}</span>
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-ui" style={{ fontWeight: 600 }}>{parentHeaderName}</h2>
              <p className="text-[11px] font-ui text-muted-foreground truncate">AI Concierge Chat</p>
            </div>
          )}
          {!selectedParentSession!.providerId && (
            <div className="flex items-center gap-1 shrink-0 ml-auto">
              {selectedParentSession!.humanJoinedAt && !selectedParentSession!.humanConcludedAt ? (
                <div
                  className="inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium"
                  style={{ backgroundColor: `${brandColor}15`, color: brandColor, borderRadius: "999px" }}
                  data-testid="btn-talk-to-team"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Talking with Human</span>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1.5 h-8"
                  style={{ borderColor: `${brandColor}30`, color: brandColor, borderRadius: "999px" }}
                  onClick={async () => {
                    setTalkToTeamEscalated(true);
                    try {
                      await fetch(`/api/chat-sessions/${selectedParentSession!.id}/request-human`, {
                        method: "POST",
                        credentials: "include",
                      });
                    } catch {}
                  }}
                  disabled={talkToTeamEscalated || !!selectedParentSession!.humanRequested}
                  data-testid="btn-talk-to-team"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{(talkToTeamEscalated || selectedParentSession!.humanRequested) ? "Team Notified" : "Talk to GoStork Team"}</span>
                </Button>
              )}
            </div>
          )}
          {selectedParentSession!.providerId && (
          <div className="flex items-center gap-1 shrink-0 ml-auto">
            {selectedParentSession!.status === "PROVIDER_JOINED" && (
              selectedParentSession!.humanJoinedAt && !selectedParentSession!.humanConcludedAt ? (
                <div
                  className="inline-flex items-center gap-1.5 px-3 h-8 text-xs font-medium"
                  style={{ backgroundColor: `${brandColor}15`, color: brandColor, borderRadius: "999px" }}
                >
                  <Headphones className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Talking with Human</span>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs gap-1.5 h-8"
                  style={{ borderColor: `${brandColor}30`, color: brandColor, borderRadius: "999px" }}
                  onClick={async () => {
                    setTalkToTeamEscalated(true);
                    try {
                      await fetch(`/api/chat-sessions/${selectedParentSession!.id}/request-human`, {
                        method: "POST",
                        credentials: "include",
                      });
                    } catch {}
                  }}
                  disabled={talkToTeamEscalated || selectedParentSession!.humanRequested}
                  data-testid="btn-talk-to-team"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{(talkToTeamEscalated || selectedParentSession!.humanRequested) ? "Team Notified" : "Talk to GoStork Team"}</span>
                </Button>
              )
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 gap-1.5 font-ui text-xs"
              style={{ color: brandColor }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              onClick={handleParentMeeting}
              data-testid="btn-parent-meeting"
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Meeting</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 gap-1.5 font-ui text-xs"
              style={{ color: brandColor }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              onClick={handleParentVideo}
              data-testid="btn-parent-video"
            >
              <Video className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Video</span>
            </Button>
          </div>
          )}
        </div>
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <ConciergeChatPage
            key={selectedParentSession!.id}
            isInline
            inlineSessionId={selectedParentSession!.id}
            inlineMatchmakerId={selectedParentSession!.matchmakerId || undefined}
            externalBookingSlug={parentBookingOverlay}
            onCloseExternalBooking={() => setParentBookingOverlay(null)}
            talkToTeamRef={talkToTeamRef}
            onSidePanelChange={setParentSidePanelData}
          />
        </div>
        </div>{/* end centering wrapper */}
        {parentShowSidebar && parentSidePanelData && (
          <ParentChatSidePanel
            subjectInfo={parentSidePanelData.subjectInfo}
            subjectSections={parentSidePanelData.subjectSections}
            subjectPhotoUrl={parentSidePanelData.subjectPhotoUrl}
            providerName={parentSidePanelData.providerName}
            sessionCalendarSlug={parentSidePanelData.sessionCalendarSlug}
            sessionBookings={parentSidePanelData.sessionBookings}
            brandColor={brandColor}
          />
        )}
      </div>
    ) : null;

    return (
      <>
        <ConversationsShell
          hasSelection={!!selectedParentSession}
          onBack={() => setSelectedParentSession(null)}
          isLoading={parentSessionsQuery.isLoading}
          sidebarItems={sidebarContent}
          emptyMessage={showConcierge
            ? "Start a conversation with your AI concierge to get personalized fertility guidance."
            : "Your provider conversations will appear here."
          }
          emptyAction={showConcierge ? (
            <Button
              onClick={() => navigate("/account/concierge")}
              data-testid="btn-start-first-chat"
              style={{ backgroundColor: brandColor }}
              className="text-primary-foreground mt-4"
            >
              Choose Your AI Concierge
            </Button>
          ) : undefined}
          detailContent={parentDetailContent}
          brandColor={brandColor}
          showSidebar={parentShowSidebar}
          sidebarAlwaysVisible={parentShowSidebar}
        />
        {inlineVideoBookingId && (
          <InlineVideoOverlay
            bookingId={inlineVideoBookingId}
            onClose={() => setInlineVideoBookingId(null)}
          />
        )}
      </>
    );
  }

  if (isProvider) {
    const sessions = providerSessionsQuery.data || [];
    const filteredSessions = sessions.filter(s =>
      !searchQuery ||
      (s.userName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.userEmail || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.title || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Group sessions by parent userId
    const parentGroups: Record<string, ProviderSession[]> = {};
    filteredSessions.forEach(s => {
      const key = s.userId;
      if (!parentGroups[key]) parentGroups[key] = [];
      parentGroups[key].push(s);
    });

    // Once a parent has a PROVIDER_JOINED session, hide the anonymous whisper session (no subjectProfileId)
    // so the provider only sees the actual donor/surrogate sessions in the folder
    for (const userId of Object.keys(parentGroups)) {
      const group = parentGroups[userId];
      const hasJoined = group.some(s => s.status === "PROVIDER_JOINED");
      if (hasJoined) {
        const withProfile = group.filter(s => s.subjectProfileId);
        if (withProfile.length > 0) parentGroups[userId] = withProfile;
      }
    }

    // Sort groups: most recent first
    const sortedGroupEntries = Object.entries(parentGroups).sort((a, b) => {
      const aLatest = Math.max(...a[1].map(s => new Date(s.lastMessageAt).getTime()));
      const bLatest = Math.max(...b[1].map(s => new Date(s.lastMessageAt).getTime()));
      return bLatest - aLatest;
    });

    const toggleParent = (userId: string) => {
      setExpandedParents(prev => ({ ...prev, [userId]: !prev[userId] }));
    };

    const hasSessions = filteredSessions.length > 0;
    const sidebarContent = hasSessions ? (
      <>
        {sortedGroupEntries.map(([parentUserId, groupSessions]) => {
          const first = groupSessions[0];
          const totalUnread = groupSessions.reduce((sum, s) => {
            const unread = s.status === "CONSULTATION_BOOKED" ? Math.max(1, s.unreadCount || 0) : (s.unreadCount || 0);
            return sum + unread;
          }, 0);
          const latestMsg = groupSessions.reduce((latest, s) =>
            new Date(s.lastMessageAt).getTime() > new Date(latest.lastMessageAt).getTime() ? s : latest
          , groupSessions[0]);
          const hasOnlyOne = groupSessions.length === 1;
          const isExpanded = expandedParents[parentUserId] !== false;

          // If only one session for this parent, render it flat (no collapsible)
          if (hasOnlyOne) {
            const s = first;
            const sIsJoined = s.status === "PROVIDER_JOINED";
            const sIsBooked = s.status === "CONSULTATION_BOOKED";
            const hasPending = s.pendingQuestions > 0;
            const sUnread = sIsBooked ? Math.max(1, s.unreadCount || 0) : (s.unreadCount || 0);
            return (
              <button
                key={s.id}
                className={`w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left border-b border-border/20 ${
                  selectedSessionId === s.id ? "bg-muted/70" : ""
                } ${sIsBooked ? "bg-primary/5" : ""}`}
                onClick={() => setSelectedSessionId(s.id, s)}
                data-testid={`provider-session-${s.id}`}
              >
                <div className="w-11 h-11 rounded-full flex-shrink-0 relative">
                  {s.userAvatar ? (
                    <img src={getPhotoSrc(s.userAvatar) || undefined} alt="" className="w-11 h-11 rounded-full object-cover" />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center">
                      {sIsJoined || sIsBooked ? (
                        <User className="w-5 h-5 text-muted-foreground" />
                      ) : (
                        <Sparkles className="w-5 h-5" style={{ color: brandColor }} />
                      )}
                    </div>
                  )}
                  {onlineStatuses[s.userId] && <OnlineIndicator size="md" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-semibold text-sm font-ui truncate">{s.userName || "Prospective Parent"}</span>
                      {sIsJoined ? (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[9px] font-bold uppercase flex-shrink-0">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          Joined
                        </span>
                      ) : sIsBooked ? (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase flex-shrink-0" style={{ backgroundColor: `${brandColor}15`, color: brandColor }}>
                          <UserPlus className="w-2.5 h-2.5" />
                          Ready to Join
                        </span>
                      ) : hasPending ? (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] text-[9px] font-bold uppercase flex-shrink-0">
                          {s.pendingQuestions} pending
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[9px] font-bold uppercase flex-shrink-0">
                          <MessageCircle className="w-2.5 h-2.5" />
                          Q&A
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={`text-[11px] ${sUnread > 0 ? "font-semibold" : "text-muted-foreground"}`} style={sUnread > 0 ? { color: brandColor } : undefined}>{timeAgo(s.lastMessageAt)}</span>
                      {sUnread > 0 && (
                        <span className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1" style={{ backgroundColor: brandColor }}>
                          {sUnread}
                        </span>
                      )}
                    </div>
                  </div>
                  {s.lastMessage && (
                    <p className="text-sm text-muted-foreground truncate mt-0.5 flex items-center gap-1">
                      {s.lastMessageSenderType === "provider" && (
                        <MessageStatus deliveredAt={null} readAt={null} brandColor={brandColor} className="flex-shrink-0" />
                      )}
                      <span className="truncate">{truncateMessage(s.lastMessage)}</span>
                    </p>
                  )}
                </div>
              </button>
            );
          }

          // Multiple sessions - collapsible parent group
          return (
            <Collapsible key={parentUserId} open={isExpanded} onOpenChange={() => toggleParent(parentUserId)}>
              <CollapsibleTrigger className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors text-left border-b border-border/20" data-testid={`parent-group-${parentUserId}`}>
                <div className="w-11 h-11 rounded-full flex-shrink-0 relative">
                  {first.userAvatar ? (
                    <img src={getPhotoSrc(first.userAvatar) || undefined} alt="" className="w-11 h-11 rounded-full object-cover" />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-5 h-5 text-muted-foreground" />
                    </div>
                  )}
                  {onlineStatuses[first.userId] && <OnlineIndicator size="md" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm font-ui truncate">{first.userName || "Prospective Parent"}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={`text-[11px] ${totalUnread > 0 ? "font-semibold" : "text-muted-foreground"}`} style={totalUnread > 0 ? { color: brandColor } : undefined}>{timeAgo(latestMsg.lastMessageAt)}</span>
                      {totalUnread > 0 && (
                        <span className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1" style={{ backgroundColor: brandColor }}>
                          {totalUnread}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground truncate mt-0.5">{latestMsg.lastMessage ? truncateMessage(latestMsg.lastMessage) : ""}</p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-[11px] text-muted-foreground">{groupSessions.length}</span>
                  <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                {groupSessions.map(s => {
                  const sIsJoined = s.status === "PROVIDER_JOINED";
                  const sIsBooked = s.status === "CONSULTATION_BOOKED";
                  const hasPending = s.pendingQuestions > 0;
                  const sUnread = sIsBooked ? Math.max(1, s.unreadCount || 0) : (s.unreadCount || 0);
                  const photoSrc = getPhotoSrc(s.profilePhotoUrl);
                  return (
                    <button
                      key={s.id}
                      className={`w-full flex items-center gap-3 pl-10 pr-4 py-3 hover:bg-muted/50 transition-colors text-left border-b border-border/10 ${
                        selectedSessionId === s.id ? "bg-muted/70" : ""
                      }`}
                      onClick={() => setSelectedSessionId(s.id)}
                      data-testid={`provider-session-${s.id}`}
                    >
                      <div className="w-12 h-12 rounded-full flex-shrink-0 relative overflow-hidden">
                        {photoSrc ? (
                          <img
                            src={photoSrc}
                            alt={s.title || ""}
                            className="w-12 h-12 rounded-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        ) : (
                          <div
                            className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground text-xs font-bold"
                            style={{ backgroundColor: brandColor }}
                          >
                            {(s.title || "C").charAt(0)}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-medium text-sm font-ui truncate">{s.title || "Conversation"}</span>
                            {sIsJoined ? (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] text-[9px] font-bold uppercase flex-shrink-0">
                                <CheckCircle2 className="w-2.5 h-2.5" />
                                Joined
                              </span>
                            ) : sIsBooked ? (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase flex-shrink-0" style={{ backgroundColor: `${brandColor}15`, color: brandColor }}>
                                <UserPlus className="w-2.5 h-2.5" />
                                Ready
                              </span>
                            ) : hasPending ? (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] text-[9px] font-bold uppercase flex-shrink-0">
                                {s.pendingQuestions}
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className={`text-[11px] ${sUnread > 0 ? "font-semibold" : "text-muted-foreground"}`} style={sUnread > 0 ? { color: brandColor } : undefined}>{timeAgo(s.lastMessageAt)}</span>
                            {sUnread > 0 && (
                              <span className="min-w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1" style={{ backgroundColor: brandColor }}>
                                {sUnread}
                              </span>
                            )}
                          </div>
                        </div>
                        {s.lastMessage && (
                          <p className="text-sm text-muted-foreground truncate mt-0.5 flex items-center gap-1">
                            {s.lastMessageSenderType === "provider" && (
                              <MessageStatus deliveredAt={null} readAt={null} brandColor={brandColor} className="flex-shrink-0" />
                            )}
                            <span className="truncate">{truncateMessage(s.lastMessage)}</span>
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </>
    ) : null;

    const providerDetailContent = sessionDetailQuery.isLoading ? (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    ) : detail ? (
      <div className="flex flex-col flex-1 min-h-0">
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
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {/* Parent photo + name */}
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-10 h-10 rounded-full flex-shrink-0 relative">
                {detail.user.photoUrl ? (
                  <img src={getPhotoSrc(detail.user.photoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    {hasJoined || isConsultationBooked ? (
                      <User className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
                    )}
                  </div>
                )}
                {onlineStatuses[detail.user.id] && <OnlineIndicator size="sm" />}
              </div>
              <span className="font-semibold text-sm font-ui truncate">{detail.user.name || "Prospective Parent"}</span>
            </div>
            {/* Separator */}
            {(detail.title || selectedSession?.profilePhotoUrl) && (
              <span className="text-muted-foreground text-base font-medium flex-shrink-0 px-1" aria-hidden>x</span>
            )}
            {/* Subject photo + ID */}
            {(detail.title || selectedSession?.profilePhotoUrl) && (
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden bg-muted">
                  {selectedSession?.profilePhotoUrl ? (
                    <img src={getPhotoSrc(selectedSession.profilePhotoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                </div>
                <span className="font-semibold text-sm font-ui truncate" data-testid="provider-subject-label">{detail.title}</span>
              </div>
            )}
            {!detail.title && !hasJoined && !isConsultationBooked && (
              <p className="text-[11px] text-muted-foreground">Anonymous Q&A via AI Concierge</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 gap-1.5 font-ui text-xs"
              style={{ color: brandColor }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              onClick={handleProviderMeeting}
              data-testid="btn-provider-meeting"
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Meeting</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 gap-1.5 font-ui text-xs"
              style={{ color: brandColor }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              onClick={handleProviderVideo}
              data-testid="btn-provider-video"
            >
              <Video className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Video</span>
            </Button>
          {hasJoined ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))] text-xs font-medium" data-testid="badge-provider-joined">
              <CheckCircle2 className="w-3 h-3" />
              Joined
            </div>
          ) : isConsultationBooked ? (
            <Button
              size="sm"
              className="h-8 text-xs text-primary-foreground gap-1"
              style={{ backgroundColor: brandColor }}
              onClick={() => joinMutation.mutate(selectedSessionId!)}
              disabled={joinMutation.isPending}
              data-testid="btn-join-group-chat"
            >
              {joinMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
              Join Group Chat
            </Button>
          ) : isWhisperPhase ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[hsl(var(--brand-warning))]/10 text-[hsl(var(--brand-warning))] text-xs font-medium" data-testid="badge-pending-questions">
              <MessageCircle className="w-3 h-3" />
              {selectedSession?.pendingQuestions} pending
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted text-muted-foreground text-xs font-medium" data-testid="badge-qa">
              <MessageCircle className="w-3 h-3" />
              Q&A
            </div>
          )}
          </div>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="provider-chat-messages">
              <ChatMessageList
                ref={chatEndRef}
                messages={detail.messages}
                bookings={sessionBookingsQuery.data}
                brandColor={brandColor}
                chatPalette={chatPalette}
                borderRadius={brand?.borderRadius ?? 1}
                viewerRole="provider"
                isOwnMessage={(msg) => msg.senderType === "provider"}
                nameLabel={(msg) => {
                  const isOwn = msg.senderType === "provider";
                  if (isOwn) return null;
                  if (msg.senderType === "human") return msg.senderName || "GoStork Expert";
                  if (msg.senderType === "provider") return msg.senderName || "Agency Expert";
                  if (msg.senderType === "system") return "GoStork AI Concierge";
                  if (msg.role === "user") return msg.senderName || detail?.user?.name || "Parent";
                  return "GoStork AI Concierge";
                }}
                onOpenInlineVideo={setInlineVideoBookingId}
                onBookingUpdate={() => sessionBookingsQuery.refetch()}
                msgTestIdPrefix="provider-msg"
              />
            </div>

            {canReply ? (
              <ChatInputBar
                onSend={(text, files) => {
                  handleSendReply(text, files);
                }}
                isLoading={sendMessageMutation.isPending}
                isUploading={providerUploading}
                brandColor={brandColor}
                placeholder={hasJoined ? "Type a message to the parent..." : "Type your answer..."}
                senderLabel={!hasJoined ? <WhisperDisclaimer /> : undefined}
                enableFileUpload
                testIdPrefix="provider"
              />
            ) : isConsultationBooked ? (
              <div className="border-t px-4 py-4 bg-muted/30 text-center shrink-0" data-testid="provider-join-prompt">
                <p className="text-sm text-muted-foreground mb-2">This parent has booked a consultation. Join the group chat to communicate directly.</p>
                <Button
                  size="sm"
                  className="text-primary-foreground gap-1"
                  style={{ backgroundColor: brandColor }}
                  onClick={() => joinMutation.mutate(selectedSessionId!)}
                  disabled={joinMutation.isPending}
                  data-testid="btn-join-group-chat-bottom"
                >
                  {joinMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                  Join Group Chat
                </Button>
              </div>
            ) : (
              <div className="border-t px-4 py-4 bg-muted/30 text-center shrink-0" data-testid="provider-waiting-prompt">
                <p className="text-sm text-muted-foreground">No pending questions. When the AI concierge receives questions from this parent, they'll appear here.</p>
              </div>
            )}
          </div>

          {!hasJoined && !isConsultationBooked ? (
            <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden lg:block" data-testid="provider-sidebar">
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
                  <h4 className="font-semibold text-sm" style={{ fontFamily: "var(--font-display)" }}>AI Concierge Q&A</h4>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Questions from this prospective parent are forwarded here by the AI concierge. Your answers are relayed back - the parent's identity stays private until they schedule a consultation.
                </p>
                {selectedSession && selectedSession.pendingQuestions > 0 && (
                  <div className="rounded-[var(--radius)] p-3 bg-[hsl(var(--brand-warning))]/10 border border-[hsl(var(--brand-warning))]/20">
                    <p className="text-sm font-medium text-[hsl(var(--brand-warning))]">{selectedSession.pendingQuestions} question{selectedSession.pendingQuestions > 1 ? "s" : ""} pending</p>
                    <p className="text-xs text-muted-foreground mt-1">Reply below to answer the most recent question</p>
                  </div>
                )}
                {isConsultationBooked && (
                  <div className="rounded-[var(--radius)] p-3 bg-primary/5 border border-primary/20">
                    <p className="text-sm font-medium" style={{ color: brandColor }}>Consultation Booked</p>
                    <p className="text-xs text-muted-foreground mt-1">Click "Join Group Chat" to start communicating directly with this parent</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ChatProfileSidebar
              user={detail.user}
              brandColor={brandColor}
              testId="provider-sidebar"
              extraSections={
                <>
                  {(() => {
                    const bookings = sessionBookingsQuery.data || [];
                    const pendingBooking = bookings.find((b: any) => b.status === "PENDING");
                    const confirmedBooking = bookings.find((b: any) => b.status === "CONFIRMED" && new Date() < new Date(new Date(b.scheduledAt).getTime() + (b.duration || 30) * 60 * 1000));
                    const activeBooking = pendingBooking || confirmedBooking;
                    if (!activeBooking) return null;
                    const start = new Date(activeBooking.scheduledAt);
                    const isPending = activeBooking.status === "PENDING";
                    const isConfirmed = activeBooking.status === "CONFIRMED";
                    return (
                      <div className="border-t pt-4 mt-4" data-testid="panel-consultation-call-section">
                        <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Consultation Call</h4>
                        <div className="rounded-[var(--radius)] border border-border overflow-hidden">
                          <div className="p-2" style={{ backgroundColor: brandColor }}>
                            <div className="flex items-center gap-2 px-1">
                              <CalendarClock className="w-3.5 h-3.5 text-primary-foreground" />
                              <span className="text-primary-foreground text-[11px] font-semibold uppercase tracking-wider">
                                {isPending ? "Pending Approval" : "Confirmed"}
                              </span>
                            </div>
                          </div>
                          <div className="p-3 space-y-2 bg-card">
                            <div className="flex items-center gap-2 text-xs">
                              <CalendarClock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span>{format(start, "EEE, MMM d, yyyy")}</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span>{format(start, "h:mm a")} ({activeBooking.duration || 30} min)</span>
                            </div>
                            {isPending && (
                              <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-[var(--radius)] p-2 mt-1">
                                <p className="text-[11px] font-medium text-[hsl(var(--brand-warning))]">Needs your confirmation</p>
                                <p className="text-[10px] text-[hsl(var(--brand-warning))] mt-0.5">Requested by {activeBooking.attendeeName || activeBooking.parentUser?.name || "a parent"}.</p>
                              </div>
                            )}
                            {isConfirmed && (
                              <div className="bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] rounded-[var(--radius)] p-2 mt-1">
                                <p className="text-[11px] font-medium text-[hsl(var(--brand-success))]">Meeting confirmed</p>
                              </div>
                            )}
                          </div>
                          {isPending && panelShowSuggestForm && (
                            <div className="px-3 py-3 border-t">
                              <p className="text-xs font-medium mb-2">Suggest a new time</p>
                              <InlineSuggestTimeForm
                                bookingId={activeBooking.id}
                                onCancel={() => setPanelShowSuggestForm(false)}
                                onSuccess={() => {
                                  setPanelShowSuggestForm(false);
                                  queryClient.invalidateQueries({ queryKey: ["/api/chat-session/bookings", selectedSessionId] });
                                }}
                              />
                            </div>
                          )}
                          {isPending && !panelShowSuggestForm && (
                            <div className="flex flex-wrap gap-2 px-3 py-2.5 border-t bg-muted/20 justify-center">
                              <Button
                                size="sm"
                                className="gap-1 text-xs text-primary-foreground"
                                style={{ backgroundColor: brandColor }}
                                onClick={() => bookingConfirmMutation.mutate(activeBooking.id)}
                                disabled={bookingConfirmMutation.isPending || bookingDeclineMutation.isPending}
                                data-testid="panel-btn-confirm-booking"
                              >
                                {bookingConfirmMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                Confirm
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-destructive gap-1 text-xs"
                                onClick={() => bookingDeclineMutation.mutate(activeBooking.id)}
                                disabled={bookingConfirmMutation.isPending || bookingDeclineMutation.isPending}
                                data-testid="panel-btn-decline-booking"
                              >
                                {bookingDeclineMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                                Decline
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1 text-xs"
                                onClick={() => setPanelShowSuggestForm(true)}
                                data-testid="panel-btn-suggest-time"
                              >
                                <CalendarClock className="w-3 h-3" /> New Time
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {hasJoined && (
                    <div className="border-t pt-4 mt-4" data-testid="consultation-status-section">
                      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Consultation Status</h4>
                      <div className="space-y-2">
                        <Button
                          size="sm"
                          className="w-full text-primary-foreground gap-1.5 text-xs"
                          style={{ backgroundColor: "var(--brand-success, #22c55e)" }}
                          onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId!, status: "READY_FOR_MATCH" })}
                          disabled={consultationStatusMutation.isPending}
                          data-testid="btn-ready-for-match"
                        >
                          {consultationStatusMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
                          Completed - Ready for Match
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full gap-1.5 text-xs border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
                          onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId!, status: "NOT_A_FIT" })}
                          disabled={consultationStatusMutation.isPending}
                          data-testid="btn-not-a-fit"
                        >
                          {consultationStatusMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsDown className="w-3 h-3" />}
                          Completed - Not a Fit
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
                        onClick={() => { if (selectedSessionId) generateAgreementMutation.mutate({ sessionId: selectedSessionId }); }}
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
                        <p className="text-xs text-[hsl(var(--brand-success))] mt-1.5" data-testid="text-agreement-success">
                          Agreement sent successfully
                        </p>
                      )}
                    </div>
                  )}
                </>
              }
            />
          )}
        </div>
      </div>
    ) : null;

    return (
      <>
        <ConversationsShell
          hasSelection={!!selectedSessionId}
          onBack={() => setSelectedSessionId(null)}
          isLoading={providerSessionsQuery.isLoading}
          sidebarItems={sidebarContent}
          emptyMessage={searchQuery ? "No conversations match your search" : "No conversations yet"}
          emptyAction={!searchQuery ? (
            <p className="text-xs text-muted-foreground mt-1">When parents request a consultation, their conversations will appear here</p>
          ) : undefined}
          detailContent={providerDetailContent}
          brandColor={brandColor}
        />
        {inlineVideoBookingId && (
          <InlineVideoOverlay
            bookingId={inlineVideoBookingId}
            onClose={() => setInlineVideoBookingId(null)}
          />
        )}
      </>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-[60vh] text-muted-foreground" data-testid="conversations-no-role">
      <MessageSquare className="w-6 h-6 mr-2" />
      <span>No conversations available for your account type.</span>
    </div>
  );
}
