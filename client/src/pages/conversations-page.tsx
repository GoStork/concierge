import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ArrowLeft, MessageSquare, Send, User, Loader2, FileText, X,
  MapPin, Mail, CheckCircle2, UserPlus, Shield, ThumbsUp, ThumbsDown,
  Search, Sparkles, Building2, ChevronDown, MessageCircle, Clock,
  CalendarDays, Video, Paperclip, Download, ExternalLink, Image as ImageIcon,
  Crown, Users, CalendarClock, Check, Maximize, Minimize,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { hasProviderRole } from "@shared/roles";
import { useAppDispatch } from "@/store";
import { setHideBottomNav } from "@/store/uiSlice";
import { deriveChatPalette } from "@/lib/chat-palette";
import ConciergeChatPage from "@/pages/concierge-chat-page";
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
  messageCount: number;
  lastMessage: string | null;
  lastMessageAt: string;
  createdAt: string;
  pendingQuestions: number;
}

interface SessionMessage {
  id: string;
  role: string;
  content: string;
  senderType: string;
  senderName: string | null;
  createdAt: string;
  uiCardType?: string;
  uiCardData?: any;
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
    photoUrl: string | null;
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
  title: string | null;
  messages: SessionMessage[];
}

function chatDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(dateStr).toLocaleDateString();
}

function truncateMessage(msg: string, maxLen = 60): string {
  const cleaned = msg.replace(/\[\[.*?\]\]/g, "").replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen) + "...";
}

function getProfileUrlSlug(type: string): string {
  const t = type.toLowerCase();
  if (t === "surrogate") return "surrogate";
  if (t === "egg donor") return "eggdonor";
  if (t === "sperm donor") return "spermdonor";
  return "surrogate";
}

function InlineSuggestTimeForm({ bookingId, onCancel, onSuccess }: { bookingId: string; onCancel: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [suggestDate, setSuggestDate] = useState("");
  const [suggestTime, setSuggestTime] = useState("10:00");
  const [message, setMessage] = useState("");

  const suggestMutation = useMutation({
    mutationFn: async () => {
      if (!suggestDate || !suggestTime) throw new Error("Please select a date and time");
      await apiRequest("POST", `/api/calendar/bookings/${bookingId}/suggest-time`, {
        scheduledAt: new Date(`${suggestDate}T${suggestTime}:00`).toISOString(),
        message: message || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
      toast({ title: "New time suggested", description: "The parent has been notified.", variant: "success" as any });
      onSuccess();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-2 pt-1">
      <div className="grid grid-cols-2 gap-2">
        <Input type="date" value={suggestDate} onChange={(e) => setSuggestDate(e.target.value)} data-testid="input-suggest-date-inline" className="h-8 text-xs" />
        <Input type="time" value={suggestTime} onChange={(e) => setSuggestTime(e.target.value)} data-testid="input-suggest-time-inline" className="h-8 text-xs" />
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a message (optional)"
        className="w-full text-xs rounded-md border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        rows={2}
        data-testid="input-suggest-message-inline"
      />
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-7 text-xs gap-1" onClick={() => suggestMutation.mutate()} disabled={suggestMutation.isPending || !suggestDate} data-testid="button-send-suggestion-inline">
          {suggestMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Send
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function InlineBookingNotification({ booking, brandColor, onUpdate }: { booking: any; brandColor: string; onUpdate: () => void }) {
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
            <CalendarClock className="w-4 h-4 text-white" />
            <span className="text-white text-xs font-semibold uppercase tracking-wider">
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

          <div className="bg-muted/40 rounded-xl p-3 space-y-2.5 border border-border">
            <div className="flex items-center gap-2 text-sm">
              <CalendarClock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{format(start, "EEEE, MMMM d, yyyy")}</span>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
              <span>{format(start, "h:mm a")} ({booking.duration} min)</span>
            </div>
          </div>

          <div className="bg-muted/40 rounded-xl p-3 border border-border">
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
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-xl p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">This meeting request needs your confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">Requested by {booking.attendeeName || booking.parentUser?.name || "a parent"}.</p>
            </div>
          )}

          {isPending && !isProvider && (
            <div className="bg-[hsl(var(--brand-warning)/0.08)] border border-[hsl(var(--brand-warning)/0.3)] rounded-xl p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-warning))]">Awaiting provider confirmation</p>
              <p className="text-[11px] text-[hsl(var(--brand-warning))] mt-0.5">We'll send you an email once {providerName} confirms your booking.</p>
            </div>
          )}

          {isConfirmed && (
            <div className="bg-[hsl(var(--brand-success)/0.08)] border border-[hsl(var(--brand-success)/0.3)] rounded-xl p-3">
              <p className="text-xs font-medium text-[hsl(var(--brand-success))]">Meeting confirmed</p>
              <p className="text-[11px] text-[hsl(var(--brand-success))] mt-0.5">This meeting has been confirmed. You'll receive a reminder before it starts.</p>
            </div>
          )}

          {isCancelled && (
            <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-3">
              <p className="text-xs font-medium text-destructive">Meeting cancelled</p>
              <p className="text-[11px] text-destructive/80 mt-0.5">This meeting has been cancelled by the parent.</p>
            </div>
          )}

          {isRescheduled && (
            <div className="bg-muted/60 border border-border rounded-xl p-3">
              <p className="text-xs font-medium text-muted-foreground">Meeting rescheduled</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">This meeting was rescheduled. A new booking has been created.</p>
            </div>
          )}

          {showSuggestForm && isPending && isProvider && (
            <div className="border border-border/50 rounded-xl p-3 space-y-2">
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
        <img src={card.photo} alt={card.name} className="w-full h-full object-cover" />
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 pb-6 px-4">
          <h3 className="text-white font-heading text-xl leading-tight">{card.name}</h3>
          {card.location && <p className="text-white/70 text-sm mt-1">{card.location}</p>}
        </div>
      </div>
    );
  }

  return null;
}

function SpecialMessageCard({ msg, brandColor, viewerRole, onOpenInlineVideo }: { msg: SessionMessage; brandColor: string; viewerRole?: "provider" | "parent"; onOpenInlineVideo?: (bookingId: string) => void }) {
  const data = msg.uiCardData as any;
  if (!data) return null;

  if (msg.uiCardType === "attachment") {
    const isImage = data.mimeType?.startsWith("image/");
    return (
      <div className="mt-1" data-testid="attachment-card">
        {isImage ? (
          <a href={data.url} target="_blank" rel="noopener noreferrer">
            <img src={data.url} alt={data.originalName} className="max-w-[240px] rounded-lg border" />
          </a>
        ) : (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-background hover:bg-muted transition-colors"
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
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 bg-muted/50 w-full text-left opacity-60" style={{ borderColor: brandColor }}>
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-white/70 shrink-0" style={{ backgroundColor: brandColor }}>
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
          className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 bg-background hover:bg-muted transition-colors cursor-pointer w-full text-left"
          style={{ borderColor: brandColor }}
          data-testid="button-video-invite"
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0" style={{ backgroundColor: brandColor }}>
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
          className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 bg-background hover:bg-muted transition-colors"
          style={{ borderColor: brandColor }}
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0" style={{ backgroundColor: brandColor }}>
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

function InlineVideoOverlay({ bookingId, onClose }: { bookingId: string; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!overlayRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      overlayRef.current.requestFullscreen().catch(() => {});
    }
  };

  return (
    <div
      ref={overlayRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: "hsl(var(--background))",
      }}
      data-testid="inline-video-overlay"
    >
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10001, display: "flex", gap: 4 }}>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full bg-background/80 hover:bg-background border shadow-sm"
          onClick={toggleFullscreen}
          data-testid="button-fullscreen-video"
        >
          {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 rounded-full bg-background/80 hover:bg-background border shadow-sm"
          onClick={onClose}
          data-testid="button-close-inline-video"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
      <iframe
        src={`/video/${bookingId}`}
        style={{ width: "100%", height: "100%", border: "none" }}
        allow="camera *; microphone *; autoplay *; display-capture *; fullscreen *"
        data-testid="inline-video-iframe"
      />
    </div>
  );
}

type FilterTab = "all" | "unread" | "agreements";

function ConversationsShell({
  hasSelection,
  onBack,
  isLoading,
  sidebarItems,
  emptyMessage,
  emptyAction,
  detailContent,
  brandColor,
}: {
  hasSelection: boolean;
  onBack: () => void;
  isLoading: boolean;
  sidebarItems: ReactNode;
  emptyMessage: string;
  emptyAction?: ReactNode;
  detailContent: ReactNode;
  brandColor: string;
}) {
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="flex fixed inset-0 md:static md:h-[calc(100dvh-64px)] w-full overflow-hidden" data-testid="conversations-page">
      <div className={`${hasSelection ? "hidden md:flex" : "flex"} flex-col w-full md:w-80 lg:w-96 border-r bg-background overflow-hidden`}>
        <div className="shrink-0 bg-background border-b px-4 pt-4 pb-3 space-y-3">
          <div className="flex items-center justify-between">
            <h1 className="font-display text-lg font-bold" data-testid="text-inbox-title">Conversations</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5 flex-shrink-0">
              {(["all", "unread", "agreements"] as FilterTab[]).map(tab => (
                <button
                  key={tab}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    activeFilter === tab
                      ? "text-white"
                      : "bg-muted text-muted-foreground hover:bg-muted/80"
                  }`}
                  style={activeFilter === tab ? { backgroundColor: brandColor } : undefined}
                  onClick={() => setActiveFilter(tab)}
                  data-testid={`filter-${tab}`}
                >
                  {tab === "all" ? "All" : tab === "unread" ? "Unread" : "Agreements"}
                </button>
              ))}
            </div>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-8 text-sm"
                data-testid="input-search-conversations"
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : sidebarItems ? (
            sidebarItems
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center px-6" data-testid="inbox-empty">
              <MessageSquare className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">{emptyMessage}</p>
              {emptyAction}
            </div>
          )}
        </div>
      </div>

      <div className={`${!hasSelection ? "hidden md:flex" : "flex"} flex-1 flex-col bg-background min-h-0 relative overflow-hidden`}>
        {!hasSelection ? (
          <div className="flex-1 flex items-center justify-center text-center px-8">
            <div>
              <MessageSquare className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="font-display text-lg font-semibold text-muted-foreground mb-1">Select a conversation</h3>
              <p className="text-sm text-muted-foreground">Choose a conversation from the list to view messages</p>
            </div>
          </div>
        ) : detailContent}
      </div>
    </div>
  );
}

export default function ConversationsPage() {
  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dispatch = useAppDispatch();
  const brandColor = brand?.primaryColor || "#004D4D";
  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const roles: string[] = (user as any)?.roles || [];
  const isParent = roles.includes("PARENT") && !roles.some((r: string) => ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE", "GOSTORK_DEVELOPER"].includes(r)) && !hasProviderRole(roles);
  const isProvider = hasProviderRole(roles) || (roles.includes("GOSTORK_ADMIN") && !!(user as any)?.providerId);
  const showConcierge = brand?.enableAiConcierge !== false;

  const myDisplayName = useMemo(() => {
    const u = user as any;
    if (!u?.name) return "";
    const parts = u.name.trim().split(/\s+/);
    return parts.length >= 2
      ? `${parts[0]} ${parts[parts.length - 1][0]}.`
      : parts[0] || "";
  }, [user]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterTab>("all");
  const [replyText, setReplyText] = useState("");
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});

  useEffect(() => {
    dispatch(setHideBottomNav(!!selectedSessionId));
    return () => { dispatch(setHideBottomNav(false)); };
  }, [selectedSessionId, dispatch]);

  const parentSessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["/api/my/chat-sessions"],
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: formData });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: (data) => {
      if (!selectedSessionId) return;
      sendMessageMutation.mutate({
        sessionId: selectedSessionId,
        content: data.originalName ? `Shared a file: ${data.originalName}` : "Shared a file",
        uiCardType: "attachment",
        uiCardData: data,
      });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
    e.target.value = "";
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
        content: "I've shared my calendar — pick a time that works for you!",
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

  useEffect(() => {
    if (chatEndRef.current) {
      const container = chatEndRef.current.closest('[data-testid="provider-chat-messages"]');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [sessionDetailQuery.data?.messages?.length]);

  const handleSendReply = () => {
    if (!replyText.trim() || !selectedSessionId) return;
    sendMessageMutation.mutate({ sessionId: selectedSessionId, content: replyText.trim() });
  };

  const [selectedParentSession, setSelectedParentSession] = useState<ChatSession | null>(null);

  const handleParentSessionClick = (session: ChatSession) => {
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      const params = new URLSearchParams();
      if (session.matchmakerId) params.set("matchmaker", session.matchmakerId);
      params.set("session", session.id);
      navigate(`/concierge?${params.toString()}`);
    } else {
      setSelectedParentSession(session);
    }
  };

  const detail = sessionDetailQuery.data;
  const profile = detail?.user?.parentAccount?.intendedParentProfile;
  const selectedSession = (providerSessionsQuery.data || []).find(s => s.id === selectedSessionId);
  const hasJoined = !!detail?.providerJoinedAt;
  const isConsultationBooked = selectedSession?.status === "CONSULTATION_BOOKED" || detail?.status === "CONSULTATION_BOOKED";
  const isWhisperPhase = !hasJoined && !isConsultationBooked && (selectedSession?.pendingQuestions || 0) > 0;
  const canReply = hasJoined || isWhisperPhase || isConsultationBooked;

  const [parentBookingOverlay, setParentBookingOverlay] = useState<{ slug: string; memberName: string } | null>(null);

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
    const allSessions = parentSessionsQuery.data || [];
    const isProviderThread = (s: ChatSession) =>
      (s.providerJoinedAt && s.providerName) ||
      s.status === "CONSULTATION_BOOKED" ||
      (s.providerId && s.providerName);
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

    const hasSessions = allSessions.length > 0;
    const sidebarContent = hasSessions ? (
      <div className="pb-24">
        {filteredEva.length > 0 && (
          <div data-testid="section-concierge">
            <div
              className="mx-4 mt-3 mb-2 px-3 py-2 rounded-lg flex items-center gap-2"
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
                      src={session.matchmakerAvatar}
                      alt={session.matchmakerName || ""}
                      className="w-11 h-11 rounded-full object-cover border absolute inset-0"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div
                    className="w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-bold"
                    style={{ backgroundColor: brandColor }}
                  >
                    {(session.matchmakerName || "E").charAt(0)}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-ui truncate" style={{ fontWeight: 600 }}>{session.matchmakerName || "Eva"}</span>
                    <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo(session.lastMessageAt)}</span>
                  </div>
                  {session.title && session.title !== "AI Concierge Chat" && (
                    <p className="text-xs font-medium truncate mt-0.5" style={{ color: brandColor }}>{session.title}</p>
                  )}
                  {session.lastMessage && (
                    <p className="text-sm text-muted-foreground truncate mt-0.5">{truncateMessage(session.lastMessage)}</p>
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
                    {first.providerLogo ? (
                      <img src={first.providerLogo} alt="" className="w-8 h-8 rounded-full object-cover border flex-shrink-0" />
                    ) : (
                      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-muted text-muted-foreground flex-shrink-0">
                        <Building2 className="w-4 h-4" />
                      </div>
                    )}
                    <span className="font-medium text-sm font-ui flex-1">{first.providerName}</span>
                    <span className="text-[11px] text-muted-foreground mr-1">{sessions.length}</span>
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {sessions.map(session => (
                      <button
                        key={session.id}
                        className="w-full flex items-center gap-3 pl-14 pr-4 py-3 hover:bg-muted/50 transition-colors text-left border-b border-border/10"
                        onClick={() => handleParentSessionClick(session)}
                        data-testid={`chat-session-provider-${session.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm font-ui truncate">{session.title || session.matchmakerName || "Conversation"}</span>
                            <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo(session.lastMessageAt)}</span>
                          </div>
                          {session.lastMessage && (
                            <p className="text-sm text-muted-foreground truncate mt-0.5">{truncateMessage(session.lastMessage)}</p>
                          )}
                        </div>
                      </button>
                    ))}
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
      : selectedParentSession?.matchmakerAvatar;

    const parentDetailContent = hasParentSession ? (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 px-4 py-3 border-b bg-background shrink-0" data-testid="parent-chat-header">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 md:hidden"
            onClick={() => setSelectedParentSession(null)}
            data-testid="btn-back-parent-chat"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="w-9 h-9 rounded-full flex-shrink-0 relative">
            {parentHeaderAvatar ? (
              <img
                src={parentHeaderAvatar}
                alt={parentHeaderName}
                className="w-9 h-9 rounded-full object-cover"
              />
            ) : (
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold"
                style={{ backgroundColor: brandColor }}
              >
                {parentHeaderName.charAt(0)}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-ui" style={{ fontWeight: 600 }}>
              {parentHeaderName}
            </h2>
            {selectedParentSession!.title && (
              <p className="text-[11px] font-ui text-muted-foreground truncate" data-testid="parent-chat-subject-label">
                Subject: {selectedParentSession!.title}
              </p>
            )}
          </div>
          {selectedParentSession!.providerId && (
          <div className="flex items-center gap-1 shrink-0">
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
        <ConciergeChatPage
          key={selectedParentSession!.id}
          isInline
          inlineSessionId={selectedParentSession!.id}
          inlineMatchmakerId={selectedParentSession!.matchmakerId || undefined}
          externalBookingSlug={parentBookingOverlay}
          onCloseExternalBooking={() => setParentBookingOverlay(null)}
        />
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
              className="text-white mt-4"
            >
              Choose Your AI Concierge
            </Button>
          ) : undefined}
          detailContent={parentDetailContent}
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

  if (isProvider) {
    const sessions = providerSessionsQuery.data || [];
    const filteredSessions = sessions.filter(s =>
      !searchQuery ||
      (s.userName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.userEmail || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase())
    );

    const hasSessions = filteredSessions.length > 0;
    const sidebarContent = hasSessions ? (
      <>
        {filteredSessions.map(s => {
          const sIsJoined = s.status === "PROVIDER_JOINED";
          const sIsBooked = s.status === "CONSULTATION_BOOKED";
          const hasPending = s.pendingQuestions > 0;
          return (
            <button
              key={s.id}
              className={`w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left border-b border-border/20 ${
                selectedSessionId === s.id ? "bg-muted/70" : ""
              } ${sIsBooked ? "bg-primary/5" : ""}`}
              onClick={() => setSelectedSessionId(s.id)}
              data-testid={`provider-session-${s.id}`}
            >
              {s.userAvatar ? (
                <img src={s.userAvatar} alt="" className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                  {sIsJoined || sIsBooked ? (
                    <User className="w-5 h-5 text-muted-foreground" />
                  ) : (
                    <Sparkles className="w-5 h-5" style={{ color: brandColor }} />
                  )}
                </div>
              )}
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
                  <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo(s.lastMessageAt)}</span>
                </div>
                {s.lastMessage && (
                  <p className="text-sm text-muted-foreground truncate mt-0.5">{truncateMessage(s.lastMessage)}</p>
                )}
              </div>
            </button>
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
          <div className="flex items-center gap-2 flex-1">
            {detail.user.photoUrl ? (
              <img src={detail.user.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                {hasJoined || isConsultationBooked ? (
                  <User className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
                )}
              </div>
            )}
            <div className="min-w-0">
              <h3 className="font-semibold text-sm font-ui">{detail.user.name || "Prospective Parent"}</h3>
              {detail.title ? (
                <p className="text-[11px] font-ui text-muted-foreground truncate" data-testid="provider-subject-label">
                  Subject: {detail.title}
                </p>
              ) : !hasJoined && !isConsultationBooked ? (
                <p className="text-[11px] text-muted-foreground">Anonymous Q&A via AI Concierge</p>
              ) : null}
            </div>
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
              className="h-8 text-xs text-white gap-1"
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
              {(() => {
                const allBookings = sessionBookingsQuery.data || [];
                const hasActive = allBookings.some((b: any) => b.status === "PENDING" || b.status === "CONFIRMED");
                const visibleBookings = hasActive
                  ? allBookings.filter((b: any) => b.status !== "CANCELLED" && b.status !== "DECLINED" && b.status !== "RESCHEDULED")
                  : allBookings.slice(0, 1);
                const bookingItems: Array<{ type: "booking"; booking: any; createdAt: string }> = visibleBookings.map((b: any) => ({
                  type: "booking" as const,
                  booking: b,
                  createdAt: b.createdAt || b.scheduledAt,
                }));
                const msgItems: Array<{ type: "message"; msg: any; createdAt: string }> = detail.messages.map((m: any) => ({
                  type: "message" as const,
                  msg: m,
                  createdAt: m.createdAt,
                }));
                const merged = [...msgItems, ...bookingItems].sort(
                  (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
                );
                return merged.map((item, i) => {
                  if (item.type === "booking") {
                    return (
                      <InlineBookingNotification
                        key={`booking-${item.booking.id}`}
                        booking={item.booking}
                        brandColor={brandColor}
                        onUpdate={() => sessionBookingsQuery.refetch()}
                      />
                    );
                  }
                  const msg = item.msg;
                  const msgIdx = detail.messages.indexOf(msg);
                  return (
                <div key={msg.id}>
                  {msg.createdAt && (() => {
                    const msgDate = new Date(msg.createdAt).toDateString();
                    const prevMsgItem = merged.slice(0, i).reverse().find((x) => x.type === "message");
                    const prevDate = prevMsgItem ? new Date(prevMsgItem.createdAt).toDateString() : null;
                    if (!prevDate || msgDate !== prevDate) {
                      return (
                        <div className="flex items-center justify-center my-3">
                          <span className="px-3 py-1 text-[11px] font-medium text-muted-foreground bg-muted/60 rounded-full shadow-sm">
                            {chatDateLabel(msg.createdAt)}
                          </span>
                        </div>
                      );
                    }
                    return null;
                  })()}
                  {(() => {
                    const isOwnMsg = isProvider
                      ? msg.senderType === "provider"
                      : msg.role === "user" && (!msg.senderName || msg.senderName === myDisplayName);
                    const nameLabel = isOwnMsg
                      ? (isProvider ? (msg.senderName || "You") : (myDisplayName || "You"))
                      : msg.senderType === "human"
                      ? (msg.senderName || "GoStork Expert")
                      : msg.senderType === "provider"
                      ? (msg.senderName || "Agency Expert")
                      : msg.senderType === "system"
                      ? "GoStork AI Concierge"
                      : msg.role === "user"
                      ? (msg.senderName || detail?.user?.name || "Parent")
                      : "GoStork AI Concierge";
                    if (isOwnMsg) return null;
                    return (
                      <div className="flex justify-start mb-0.5">
                        <span className="text-[11px] font-medium text-muted-foreground" data-testid={`name-label-provider-${i}`}>
                          {nameLabel}
                        </span>
                      </div>
                    );
                  })()}
                  {msg.uiCardData?.whisperMatchCard && (
                    <WhisperProfileCard card={msg.uiCardData.whisperMatchCard} brandColor={brandColor} />
                  )}
                  {(() => {
                    const isOwnMessage = isProvider
                      ? msg.senderType === "provider"
                      : msg.role === "user" && (!msg.senderName || msg.senderName === myDisplayName);
                    return (
                      <>
                        <div className={`flex ${isOwnMessage ? "justify-end" : "justify-start"}`}>
                          <div
                            className={`max-w-[75%] px-4 py-2.5 text-base leading-relaxed font-ui ${
                              isOwnMessage
                                ? "text-white"
                                : "text-foreground"
                            }`}
                            style={{
                              borderRadius: `${brand?.borderRadius ?? 1}rem`,
                              ...(isOwnMessage
                                ? { backgroundColor: brandColor }
                                : msg.role === "user"
                                ? { backgroundColor: chatPalette.partnerBg, border: `1px solid ${chatPalette.partnerBorder}` }
                                : msg.senderType === "provider"
                                ? { backgroundColor: chatPalette.expertBg, border: `1px solid ${chatPalette.expertBorder}` }
                                : msg.senderType === "human"
                                ? { backgroundColor: `${brandColor}14`, border: `1px solid ${brandColor}33` }
                                : msg.senderType === "system"
                                ? { backgroundColor: `${brandColor}14`, border: `1px solid ${brandColor}33` }
                                : { backgroundColor: `${brandColor}14`, border: `1px solid ${brandColor}33` }),
                            }}
                            data-testid={`provider-msg-${i}`}
                          >
                            <span>{msg.content}</span>
                            {msg.createdAt && (
                              <span
                                className="inline-block align-bottom ml-2 whitespace-nowrap select-none"
                                style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55, verticalAlign: "bottom", position: "relative", top: "3px" }}
                              >
                                {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                              </span>
                            )}
                          </div>
                        </div>
                        {msg.uiCardType && <SpecialMessageCard msg={msg} brandColor={brandColor} viewerRole="provider" onOpenInlineVideo={setInlineVideoBookingId} />}
                      </>
                    );
                  })()}
                </div>
                  );
                });
              })()}
              <div ref={chatEndRef} />
            </div>

            {canReply ? (
              <div className="border-t px-4 py-3 bg-background shrink-0" data-testid="provider-reply-area">
                {!hasJoined && (
                  <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                    <Shield className="w-3 h-3" />
                    <span>Your answer will be relayed to the parent by the AI concierge</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept="image/*,application/pdf,.doc,.docx,.txt"
                    capture={undefined}
                    onChange={handleFileSelect}
                    data-testid="input-provider-file"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-10 w-10 p-0 shrink-0 rounded-full"
                    style={{ color: brandColor }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${brandColor}1A`)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadMutation.isPending}
                    data-testid="btn-provider-attach"
                  >
                    {uploadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                  </Button>
                  <Input
                    placeholder={hasJoined ? "Type a message to the parent..." : "Type your answer..."}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendReply();
                      }
                    }}
                    disabled={sendMessageMutation.isPending}
                    className="flex-1 !text-base font-ui rounded-full"
                    data-testid="input-provider-message"
                  />
                  <Button
                    size="sm"
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || sendMessageMutation.isPending}
                    className="h-10 w-10 p-0 rounded-full text-white shrink-0"
                    style={{ backgroundColor: brandColor }}
                    data-testid="btn-send-provider-message"
                  >
                    {sendMessageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            ) : isConsultationBooked ? (
              <div className="border-t px-4 py-4 bg-muted/30 text-center shrink-0" data-testid="provider-join-prompt">
                <p className="text-sm text-muted-foreground mb-2">This parent has booked a consultation. Join the group chat to communicate directly.</p>
                <Button
                  size="sm"
                  className="text-white gap-1"
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

          <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden lg:block" data-testid="provider-sidebar">
            {!hasJoined && !isConsultationBooked ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
                  <h4 className="font-semibold text-sm" style={{ fontFamily: "var(--font-display)" }}>AI Concierge Q&A</h4>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Questions from this prospective parent are forwarded here by the AI concierge. Your answers are relayed back — the parent's identity stays private until they schedule a consultation.
                </p>
                {selectedSession && selectedSession.pendingQuestions > 0 && (
                  <div className="rounded-lg p-3 bg-[hsl(var(--brand-warning))]/10 border border-[hsl(var(--brand-warning))]/20">
                    <p className="text-sm font-medium text-[hsl(var(--brand-warning))]">{selectedSession.pendingQuestions} question{selectedSession.pendingQuestions > 1 ? "s" : ""} pending</p>
                    <p className="text-xs text-muted-foreground mt-1">Reply below to answer the most recent question</p>
                  </div>
                )}
                {isConsultationBooked && (
                  <div className="rounded-lg p-3 bg-primary/5 border border-primary/20">
                    <p className="text-sm font-medium" style={{ color: brandColor }}>Consultation Booked</p>
                    <p className="text-xs text-muted-foreground mt-1">Click "Join Group Chat" to start communicating directly with this parent</p>
                  </div>
                )}
              </div>
            ) : (
              <>
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
                        {profile.journeyStage && <div className="text-sm"><span className="text-muted-foreground">Stage:</span> {profile.journeyStage}</div>}
                        {profile.eggSource && <div className="text-sm"><span className="text-muted-foreground">Egg Source:</span> {profile.eggSource}</div>}
                        {profile.spermSource && <div className="text-sm"><span className="text-muted-foreground">Sperm Source:</span> {profile.spermSource}</div>}
                        {profile.carrier && <div className="text-sm"><span className="text-muted-foreground">Carrier:</span> {profile.carrier}</div>}
                        {profile.hasEmbryos !== null && <div className="text-sm"><span className="text-muted-foreground">Embryos:</span> {profile.hasEmbryos ? `Yes (${profile.embryoCount || "??"})` : "No"}</div>}
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
                        onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId!, status: "READY_FOR_MATCH" })}
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
                        onClick={() => consultationStatusMutation.mutate({ sessionId: selectedSessionId!, status: "NOT_A_FIT" })}
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
            )}
          </div>
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
