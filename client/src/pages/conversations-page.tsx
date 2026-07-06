import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";
import { AttachmentMessageCard } from "@/components/chat/attachment-message-card";
import { formatMoneyCents } from "@/lib/format-money";
import { formatLocationDisplay } from "@/lib/format-location";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-bar";
import { MessageStatus } from "@/components/ui/message-status";
import { OnlineIndicator } from "@/components/ui/online-indicator";
import { useOnlineStatus } from "@/hooks/use-online-status";
import {
  ArrowLeft, MessageSquare, User, Loader2, FileText, X,
  CheckCircle2, ChevronRight, ChevronDown, ChevronUp, Shield, ThumbsUp, ThumbsDown,
  Sparkles, Building2, MessageCircle, Heart, CornerRightDown,
  CalendarDays, Video, Trash2, Headphones, HelpCircle,
  // Used by legacy dead code pending removal
  CalendarClock, Check, Clock, Crown, Download, ExternalLink, Paperclip, PenLine, Send,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { hasProviderRole } from "@shared/roles";
import { useAppDispatch } from "@/store";
import { setHideBottomNav } from "@/store/uiSlice";
import { deriveChatPalette } from "@/lib/chat-palette";
import { DonorStatusPill, getDonorStatusStyle } from "@/lib/donor-status";
import { useMarketplaceViewContext, recordProfileView } from "@/lib/profile-views";
import { format } from "date-fns";
import ConciergeChatPage, { ParentChatSidePanel, type ParentSidePanelData } from "@/pages/concierge-chat-page";
import { AgreementSidebarSection } from "@/components/chat/agreement-sidebar-section";
import { CostSheetSidebarSection } from "@/components/chat/cost-sheet-sidebar-section";
import { InvoiceSidebarSection } from "@/components/chat/invoice-sidebar-section";
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
import { getProfileUrlSlug, InlineSuggestTimeForm } from "@/components/chat";
import {
  timeAgo,
  truncateMessage,
  ConversationsShell,
  InlineVideoOverlay,
  ChatMessageList,
  ChatInputBar,
  WhisperDisclaimer,
  ChatProfileSidebar,
  ChatBookingCard,
  ChatHeaderContextPanel,
  type ChatHeaderMatchStatus,
  type FilterTab,
} from "@/components/chat";
import { SubjectProfileCard } from "@/components/profile-cards";

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
  profileAvailable: boolean | null;
  profileStatus: string | null;
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
  oldestPendingAt: string | null;
  pendingMaxAgeMinutes: number;
  pendingNudgeCount: number;
  profileAvailable: boolean | null;
  profileStatus: string | null;
}

import type { SessionDetail } from "@/components/chat";
import { InvoiceCard } from "@/components/invoice-card";
import { ReadinessPromptCard } from "@/components/readiness-prompt-card";
import { ClearanceTrackerCard } from "@/components/clearance-tracker-card";

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
  const { viewedIds, previousVisitAt } = useMarketplaceViewContext();
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

  // A whisper-card render means the AI surfaced this profile to the parent
  // - count it as a view so the marketplace "New" badge clears next time.
  useEffect(() => {
    if (!profile?.id) return;
    const t = (card?.type || "").toLowerCase();
    const profileType: "egg-donor" | "surrogate" | "sperm-donor" =
      t === "surrogate" ? "surrogate" : t === "sperm donor" ? "sperm-donor" : "egg-donor";
    recordProfileView(profile.id, profileType);
  }, [profile?.id, card?.type]);

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
    const statusLabel = buildStatusLabel(swipeProfile, viewedIds, previousVisitAt);
    const baseTabs = isSurrogate ? getSurrogateTabs(swipeProfile, []) : getDonorTabs(swipeProfile, [], t === "sperm donor");
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
          donorStatus={swipeProfile.donorStatus}
          frozenLotStatus={swipeProfile.frozenLotStatus}
          isExperienced={swipeProfile.isExperienced}
          isPremium={swipeProfile.isPremium}
          sponsored={swipeProfile.sponsored}
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
          {card.location && <p className="text-white/70 text-sm mt-1">{formatLocationDisplay(card.location)}</p>}
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
    return <AttachmentMessageCard data={data} />;
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
            <p className="text-xs text-muted-foreground">
              {data.providerName === "GoStork"
                ? `Schedule GoStork Concierge Call with ${data.memberName || "GoStork Team"}`
                : data.memberName ? `Schedule with ${data.memberName}` : "Pick a time that works for you"}
            </p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>
      </div>
    );
  }

  // Sent-but-not-yet-signed agreement (mirrors the parent's chat view).
  // Provider sees the same card the parent sees so the agency knows
  // exactly what the parent is looking at and at what stage. Click
  // navigates to the agreement detail page.
  if (msg.uiCardType === "agreement") {
    const agreementCard = data.agreementCard || data;
    const agreementId: string | null = agreementCard.agreementId || null;
    const status: string = agreementCard.status || "SENT";
    const providerName: string = data.providerName || "the provider";
    const statusLabel = status === "SIGNED" ? "Signed" : status === "VIEWED" ? "Opened" : "Sent for signature";
    return (
      <div className="mt-1" data-testid="agreement-card">
        <a
          href={agreementId ? `/agreements/${agreementId}` : "#"}
          className="block rounded-[var(--radius)] border-2 bg-background overflow-hidden max-w-md hover:bg-muted transition-colors"
          style={{ borderColor: brandColor }}
        >
          <div className="p-1.5" style={{ backgroundColor: brandColor }}>
            <div className="flex items-center gap-2 px-3 py-1.5">
              <FileText className="w-4 h-4 text-primary-foreground" />
              <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
                Agreement Ready to Sign
              </span>
            </div>
          </div>
          <div className="px-4 py-3 space-y-1">
            <p className="text-sm font-semibold">Agreement from {providerName}</p>
            <p className="text-xs text-muted-foreground">{statusLabel}</p>
          </div>
          <div className="border-t px-4 py-2.5 bg-muted/30 flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: brandColor }}>
              <PenLine className="inline w-3.5 h-3.5 mr-1" />
              Review & Sign
            </span>
            <ExternalLink className="w-4 h-4 text-muted-foreground" />
          </div>
        </a>
      </div>
    );
  }

  if (msg.uiCardType === "agreement_signed") {
    return (
      <div className="mt-1">
        <a
          href={data.agreementId ? `/agreements/${data.agreementId}` : "#"}
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
          style={{ borderColor: brandColor }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Agreement Fully Signed</p>
            <p className="text-xs text-muted-foreground">Tap to view and download the signed agreement</p>
          </div>
          <Download className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>
      </div>
    );
  }

  if (msg.uiCardType === "invoice") {
    return (
      <div className="mt-1">
        <InvoiceCard data={data} isParent={viewerRole === "parent"} />
      </div>
    );
  }

  if (msg.uiCardType === "cost_sheet") {
    const totalCents: number = data.totalCostCents ?? 0;
    const fileUrl: string | null = data.costSheetFileUrl || null;
    const fileName: string | null = data.costSheetFileName || null;
    const providerName: string = data.providerName || "Your provider";
    const notes: string | null = data.notes || null;
    const sentAt: string | null = data.sentAt || null;
    const totalFormatted = formatMoneyCents(totalCents);
    return (
      <div className="mt-1" data-testid="cost-sheet-card">
        <div
          className="rounded-[var(--radius)] border-2 bg-background overflow-hidden max-w-md"
          style={{ borderColor: brandColor }}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
              <FileText className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Cost Sheet from {providerName}</p>
              <p className="text-xs text-muted-foreground">
                Total quoted cost
                {sentAt ? ` - ${new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
              </p>
            </div>
            <p className="text-lg font-bold shrink-0" style={{ color: brandColor }}>{totalFormatted}</p>
          </div>
          {(fileUrl || notes) && (
            <div className="border-t px-4 py-2.5 space-y-2 bg-muted/30">
              {fileUrl && (
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs hover:underline"
                  style={{ color: brandColor }}
                >
                  <Download className="w-3.5 h-3.5" />
                  {fileName || "Open cost sheet"}
                </a>
              )}
              {notes && <p className="text-xs text-muted-foreground italic">{notes}</p>}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (msg.uiCardType === "readiness_prompt") {
    return (
      <div className="mt-1">
        <ReadinessPromptCard
          data={data}
          sessionId={msg.sessionId}
          messageContent={msg.content}
          isParent={viewerRole === "parent"}
        />
      </div>
    );
  }

  if (msg.uiCardType === "clearance_tracker") {
    return (
      <div className="mt-1">
        <ClearanceTrackerCard data={data} isParent={viewerRole === "parent"} />
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
  const [searchParams, setSearchParams] = useSearchParams();
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
  const confirm = useConfirm();

  const resetAllChatsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/admin/reset-all-chats");
      return res.json();
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
    // had the provider join (providerJoinedAt null, status not CONSULTATION_BOOKED/PROVIDER_CONNECTED).
    // Note: providerId may be set on concierge sessions (for whisper/silent passthrough) but
    // that alone does NOT make it a provider thread.
    if ("matchmakerId" in session && session.matchmakerId) {
      const cs = session as ChatSession;
      const isProviderThread = !!cs.providerJoinedAt || cs.status === "CONSULTATION_BOOKED" || cs.status === "PROVIDER_CONNECTED";
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
    let url = session ? buildChatUrl(session) : "/chat";
    if (lastChatKey && url !== "/chat") localStorage.setItem(lastChatKey, url);
    // Preserve list filter params (filter, q) across path changes so back nav restores them.
    const preserved = new URLSearchParams();
    const curFilter = searchParams.get("filter");
    const curQ = searchParams.get("q");
    if (curFilter) preserved.set("filter", curFilter);
    if (curQ) preserved.set("q", curQ);
    if (preserved.toString()) {
      const [base, existing] = url.split("?");
      const merged = new URLSearchParams(existing || "");
      preserved.forEach((v, k) => merged.set(k, v));
      url = `${base}?${merged.toString()}`;
    }
    // Push when selecting a session so the browser back button returns to the list.
    // Replace only when clearing the selection (navigating back to /chat).
    navigate(url, { replace: !session });
  };
  const searchQuery = searchParams.get("q") || "";
  const activeFilter = ((searchParams.get("filter") as FilterTab) === "unread" ? "unread" : "all") as FilterTab;
  const setSearchQuery = (v: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (!v) next.delete("q");
      else next.set("q", v);
      return next;
    }, { replace: true });
  };
  const setActiveFilter = (v: FilterTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (v === "all") next.delete("filter");
      else next.set("filter", v);
      return next;
    }, { replace: true });
  };
  const [replyText, setReplyText] = useState("");


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

  // Clear provider selection when the browser back button returns to /chat (no URL params)
  useEffect(() => {
    if (!isProvider) return;
    if (!urlEntityId && !urlSubjectId && selectedSessionId) {
      _setSelectedSessionId(null);
    }
  }, [isProvider, urlEntityId, urlSubjectId]);

  // Auto-restore the last viewed chat when landing on /chat with no selection.
  // Only fires once per component mount so the browser back button doesn't re-trigger it.
  const autoRestored = useRef(false);
  useEffect(() => {
    if (autoRestored.current) return;
    // Mobile lands on the inbox list (a separate full screen), so don't auto-open
    // the last conversation - that would skip the inbox straight into (usually) the
    // AI concierge. Desktop is master-detail (inbox + pane), so restoring is fine.
    if (window.innerWidth < 768) return;
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
      autoRestored.current = true;
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
      // The legacy oldest-first whisper-answer path can fire here too (when the
      // provider types in the main composer with no targeted silentQueryId).
      // Refresh the per-session whispers list so the panel doesn't show a
      // ghost question after it's been answered via this route.
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId, "pending-whispers"] });
    },
  });

  // Per-session pending whisper questions surfaced in the right-side AI
  // Concierge Q&A panel. Each row is independently answerable - the provider
  // no longer has to guess which question the main composer is replying to.
  type PendingWhisper = { id: string; questionText: string; createdAt: string; ageMinutes: number; nudgeCount: number };
  const pendingWhispersQuery = useQuery<PendingWhisper[]>({
    queryKey: ["/api/provider/concierge-sessions", selectedSessionId, "pending-whispers"],
    queryFn: async () => {
      if (!selectedSessionId) return [];
      const res = await fetch(`/api/provider/concierge-sessions/${selectedSessionId}/pending-whispers`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: isProvider && !!selectedSessionId,
    refetchInterval: 30000,
  });

  // Per-question draft text. Keyed by silentQueryId so multiple unanswered
  // questions on the same session each have their own independent input.
  const [whisperDrafts, setWhisperDrafts] = useState<Record<string, string>>({});
  const [whisperPendingId, setWhisperPendingId] = useState<string | null>(null);
  // Mobile-only collapse state for the inline Q&A panel - so a provider who
  // can't answer right now can dismiss the panel and still see the chat.
  // Resets to expanded when switching sessions so a new question on a
  // different session can't get silently hidden by a prior dismissal.
  const [whispersPanelCollapsedMobile, setWhispersPanelCollapsedMobile] = useState(false);
  useEffect(() => {
    setWhispersPanelCollapsedMobile(false);
  }, [selectedSessionId]);

  const answerWhisperMutation = useMutation({
    mutationFn: async ({ sessionId, silentQueryId, content }: { sessionId: string; silentQueryId: string; content: string }) => {
      const res = await fetch(`/api/provider/concierge-sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content, silentQueryId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to send answer");
      }
      return res.json();
    },
    onMutate: ({ silentQueryId }) => {
      setWhisperPendingId(silentQueryId);
    },
    onSuccess: (_data, vars) => {
      // Drop the answered question from the panel list immediately.
      queryClient.setQueryData<PendingWhisper[]>(
        ["/api/provider/concierge-sessions", vars.sessionId, "pending-whispers"],
        (old) => (old || []).filter(q => q.id !== vars.silentQueryId),
      );
      // Clear the per-question draft.
      setWhisperDrafts(prev => {
        const next = { ...prev };
        delete next[vars.silentQueryId];
        return next;
      });
      // Refresh the sessions list so the top-bar Chats badge drops.
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", vars.sessionId] });
    },
    onError: (e: any) => {
      toast({ title: "Failed to send", description: e?.message || "Try again", variant: "destructive" });
    },
    onSettled: () => {
      setWhisperPendingId(null);
    },
  });

  // Per-session whisper Q&A card content. Built once and rendered in two
  // places: inline below the warning banner on mobile/tablet (the right-side
  // sidebar is hidden at < lg, so without this the provider only sees a
  // banner pointing at a panel that doesn't exist on their screen), and in
  // the right-side ChatProfileSidebar / pre-booking sidebar on desktop.
  const whispersPanel = (() => {
    const pendingWhispers = pendingWhispersQuery.data || [];
    return (
      <div className="space-y-3" data-testid="whisper-questions-panel">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
          <h4 className="font-semibold text-sm" style={{ fontFamily: "var(--font-display)" }}>AI Concierge Q&A</h4>
          {pendingWhispers.length > 0 && (
            <span
              className="ml-auto min-w-[20px] h-[20px] rounded-full flex items-center justify-center text-[10px] font-bold text-primary-foreground px-1.5"
              style={{ backgroundColor: brandColor }}
              data-testid="whisper-pending-count"
            >
              {pendingWhispers.length}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Questions from this parent forwarded by the AI concierge. Your answer is relayed back - the parent's identity stays private until they schedule a consultation.
        </p>
        {pendingWhispers.length === 0 ? (
          <p className="text-xs text-muted-foreground italic" data-testid="no-pending-whispers">
            No pending questions. New questions from this parent will appear here.
          </p>
        ) : (
          pendingWhispers.map((q) => {
            const ageMin = q.ageMinutes || 0;
            const isOverdue = ageMin >= 24 * 60;
            const isApproaching = !isOverdue && ageMin >= 2 * 60;
            const tint = isOverdue
              ? "bg-accent/15 border-accent/40 text-accent-foreground"
              : isApproaching
                ? "bg-[hsl(var(--brand-warning))]/10 border-[hsl(var(--brand-warning))]/30 text-[hsl(var(--brand-warning))]"
                : "bg-[hsl(var(--brand-success))]/10 border-[hsl(var(--brand-success))]/30 text-[hsl(var(--brand-success))]";
            const ageLabel = ageMin < 60
              ? `${ageMin}m`
              : ageMin < 24 * 60
                ? `${Math.floor(ageMin / 60)}h`
                : `${Math.floor(ageMin / 1440)}d`;
            const draft = whisperDrafts[q.id] || "";
            const isPending = whisperPendingId === q.id;
            return (
              <div
                key={q.id}
                className="rounded-[var(--radius)] border border-border bg-background p-3 space-y-2.5"
                data-testid={`whisper-question-${q.id}`}
              >
                <div className="flex items-start gap-2">
                  <HelpCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: brandColor }} />
                  <p className="text-sm leading-snug flex-1 break-words font-medium">{q.questionText}</p>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${tint}`}>
                    {ageLabel} ago{isOverdue ? " - SLA breached" : ""}
                  </span>
                  {q.nudgeCount > 0 && (
                    <span className="text-[10px] text-muted-foreground">Nudged {q.nudgeCount}x</span>
                  )}
                </div>
                <Textarea
                  value={draft}
                  onChange={(e) => setWhisperDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="Type your answer to this question..."
                  className="min-h-[64px] text-sm resize-none"
                  disabled={isPending}
                  data-testid={`whisper-answer-input-${q.id}`}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!draft.trim() || isPending || !selectedSessionId}
                    onClick={() =>
                      answerWhisperMutation.mutate({
                        sessionId: selectedSessionId!,
                        silentQueryId: q.id,
                        content: draft.trim(),
                      })
                    }
                    style={{ backgroundColor: brandColor }}
                    className="text-primary-foreground gap-1.5 text-xs"
                    data-testid={`whisper-answer-send-${q.id}`}
                  >
                    {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    Send to parent
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    );
  })();

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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [providerStagedFiles, setProviderStagedFiles] = useState<File[]>([]);
  const [providerUploading, setProviderUploading] = useState(false);
  type ProviderInlinePanel = null | "costSheet" | "invoice" | "agreement";
  const [providerInlinePanel, setProviderInlinePanel] = useState<ProviderInlinePanel>(null);
  // Seeded by "Edit & Resend" on a sent cost-sheet card; cleared when the
  // panel closes so the next "Send Cost Sheet" click starts blank.
  const [costSheetEditPrefill, setCostSheetEditPrefill] = useState<{ totalCostCents: number; notes: string | null } | null>(null);
  // Phase 2 unification: the "+ -> Cost Sheet" button and "Edit & Resend"
  // both run the SAME draft engine as the booking auto-draft, dropping
  // approval cards in the chat. The legacy manual form only opens as a
  // fallback when no cost sheet matches this session's context.
  const generateCostSheetDraftsMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await apiRequest("POST", `/api/sessions/${sessionId}/cost-sheet-draft/generate`, {});
      return (await res.json()) as { status: "drafted" | "skipped"; reason?: string };
    },
    onSuccess: (result, sessionId) => {
      if (result.status === "drafted") {
        toast({ title: "Cost sheet drafted", description: "Review the draft card(s) below and Approve & Send." });
        queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
      } else if (
        // Only fall back to the legacy manual form when the provider
        // genuinely has NOTHING to auto-draft from. Other skip reasons
        // (already-pending, zero totals) are transient states the draft
        // cards themselves communicate.
        result.reason === "no_matching_approved_sheets" ||
        result.reason === "no_matching_subtypes" ||
        result.reason === "no_parent_account" ||
        result.reason === "no_intended_parent_profile"
      ) {
        toast({ title: "No matching cost sheet found", description: "Opening the manual form instead." });
        setCostSheetEditPrefill(null);
        setProviderInlinePanel("costSheet");
      } else {
        toast({ title: "Nothing new to draft", description: result.reason ? `Reason: ${result.reason}` : undefined });
        queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
      }
    },
    onError: (err: any) => {
      toast({ title: "Failed to draft cost sheet", description: err?.message || "Try again.", variant: "destructive" });
    },
  });
  // Seeded by "Edit & Resend" on a sent invoice card. The invoice panel reads
  // these to pre-fill the form and cancels this invoice on successful resend.
  const [invoiceEditPrefill, setInvoiceEditPrefill] = useState<{
    invoiceId: string;
    lineItems: Array<{ serviceType: any; description: string | null; amountCents: number }>;
    description: string | null;
  } | null>(null);
  // Per-invoice mutation pending flag so the card's buttons disable only on
  // the row that's currently being cancelled/edited.
  const [invoiceActionPendingId, setInvoiceActionPendingId] = useState<string | null>(null);
  // Same idea for the cost-sheet Cancel button.
  const [costSheetActionPendingId, setCostSheetActionPendingId] = useState<string | null>(null);
  const [providerHeaderPanelOpen, setProviderHeaderPanelOpen] = useState(false);
  const [parentHeaderPanelOpen, setParentHeaderPanelOpen] = useState(false);

  useEffect(() => {
    setProviderHeaderPanelOpen(false);
    setParentHeaderPanelOpen(false);
  }, [selectedSessionId]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = "";
    setProviderStagedFiles(prev => [...prev, ...Array.from(files)]);
  };

  const removeProviderStagedFile = (index: number) => {
    setProviderStagedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Provider clicks "Cancel Invoice" on an in-chat invoice card. Opens the
  // brand confirm bar; on confirm, POSTs to the cancel endpoint. The server
  // updates the chat card's uiCardData.status to CANCELLED and posts a system
  // note, so a session refetch is enough to reflect both.
  const cancelInvoiceFromCard = useCallback(async ({ invoiceId }: { invoiceId: string }) => {
    if (!selectedSessionId) return;
    const ok = await confirm({
      title: "Cancel this invoice?",
      message: "The parent will no longer be able to pay this invoice. You can send a revised invoice afterward.",
      confirmLabel: "Cancel invoice",
      cancelLabel: "Keep it",
      tone: "destructive",
    });
    if (ok) await runCancelInvoice(invoiceId);
  }, [selectedSessionId, confirm]);

  const runCancelInvoice = useCallback(async (invoiceId: string) => {
    if (!selectedSessionId) return;
    setInvoiceActionPendingId(invoiceId);
    try {
      const res = await fetch(
        `/api/sessions/${selectedSessionId}/invoices/${invoiceId}/cancel`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to cancel invoice");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
    } catch (err: any) {
      alert(err?.message || "Failed to cancel invoice");
    } finally {
      setInvoiceActionPendingId(null);
    }
  }, [selectedSessionId, queryClient]);

  // Provider clicks "Edit & Resend" on an in-chat invoice card. Fetches the
  // invoice (for its line items + description), seeds the prefill state, and
  // opens the invoice panel. The panel cancels the old invoice on successful
  // resend so the parent never sees two pending invoices at once.
  const editInvoiceFromCard = useCallback(async ({ invoiceId }: { invoiceId: string }) => {
    if (!selectedSessionId) return;
    setInvoiceActionPendingId(invoiceId);
    try {
      const res = await fetch(
        `/api/sessions/${selectedSessionId}/invoices/${invoiceId}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to load invoice");
      }
      const { invoice } = await res.json();
      const lineItems = (invoice?.lineItems || []).map((li: any) => ({
        serviceType: li.serviceType,
        description: li.description,
        amountCents: li.amountCents,
      }));
      setInvoiceEditPrefill({
        invoiceId: invoice.id,
        lineItems,
        description: invoice.description || null,
      });
      setProviderInlinePanel("invoice");
    } catch (err: any) {
      alert(err?.message || "Failed to load invoice");
    } finally {
      setInvoiceActionPendingId(null);
    }
  }, [selectedSessionId]);

  // Provider clicks "Cancel" on an in-chat cost-sheet card. Opens the brand
  // confirm bar; confirmation runs the cancel POST below.
  const cancelCostSheetFromCard = useCallback(async ({ quoteId }: { quoteId: string }) => {
    if (!selectedSessionId) return;
    const ok = await confirm({
      title: "Cancel this cost sheet?",
      message: "The parent will see this cost sheet as cancelled, and a new invoice will require a fresh cost sheet first.",
      confirmLabel: "Cancel cost sheet",
      cancelLabel: "Keep it",
      tone: "destructive",
    });
    if (ok) await runCancelCostSheet(quoteId);
  }, [selectedSessionId, confirm]);

  const runCancelCostSheet = useCallback(async (quoteId: string) => {
    if (!selectedSessionId) return;
    setCostSheetActionPendingId(quoteId);
    try {
      const res = await fetch(
        `/api/sessions/${selectedSessionId}/cost-sheets/${quoteId}/cancel`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || "Failed to cancel cost sheet");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions/cost-sheets", selectedSessionId] });
    } catch (err: any) {
      alert(err?.message || "Failed to cancel cost sheet");
    } finally {
      setCostSheetActionPendingId(null);
    }
  }, [selectedSessionId, queryClient]);

  const handleProviderMeeting = async () => {
    if (!selectedSessionId) return;
    try {
      const [slugRes, connectionsRes] = await Promise.all([
        fetch("/api/provider/calendar-slug", { credentials: "include" }),
        fetch("/api/calendar/connections", { credentials: "include" }),
      ]);
      const { slug } = await slugRes.json();
      const connections: any[] = await connectionsRes.json();
      if (!slug || !connections?.length) {
        navigate("/account/calendar?connect=true");
        return;
      }
      sendMessageMutation.mutate({
        sessionId: selectedSessionId,
        content: "I've shared my calendar - pick a time that works for you!",
        uiCardType: "rich",
        uiCardData: {
          consultationCard: {
            memberBookingSlug: slug,
            memberName: (user as any)?.name,
            bookingUrl: `${window.location.origin}/book/${slug}`,
            providerId: (user as any)?.providerId,
          },
        },
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
      !!s.matchmakerId && !s.providerJoinedAt && s.status !== "CONSULTATION_BOOKED" && s.status !== "PROVIDER_CONNECTED";
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

  useEffect(() => {
    dispatch(setHideBottomNav(!!selectedSessionId || !!selectedParentSession));
    return () => { dispatch(setHideBottomNav(false)); };
  }, [selectedSessionId, selectedParentSession, dispatch]);

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
  // (status becomes CONSULTATION_BOOKED or PROVIDER_CONNECTED after booking is submitted)
  useEffect(() => {
    if (!selectedParentSession || !isConciergeUrl) return;
    const isNowProviderThread =
      !!selectedParentSession.providerJoinedAt ||
      selectedParentSession.status === "CONSULTATION_BOOKED" ||
      selectedParentSession.status === "PROVIDER_CONNECTED";
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

  const [parentBookingOverlay, setParentBookingOverlay] = useState<{ slug: string; memberName: string } | null>(null);
  const talkToTeamRef = useRef<{ trigger: () => void; escalated: boolean } | null>(null);
  const [talkToTeamEscalated, setTalkToTeamEscalated] = useState(false);
  const [parentSidePanelData, setParentSidePanelData] = useState<ParentSidePanelData | null>(null);

  // Called directly by InlineBookingCalendar's onSuccess - fires exactly once when a booking
  // is confirmed. This is more reliable than polling sessionBookings for a count change.
  const handleBookingConfirmed = useCallback((meta: { providerId?: string; subjectProfileId?: string | null }) => {
    queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });

    let targetUrl: string | null = null;
    if (meta.providerId && meta.subjectProfileId) {
      targetUrl = `/chat/${meta.providerId}/${meta.subjectProfileId}`;
    } else if (meta.providerId) {
      const session = parentSessions.find(
        s => s.providerId === meta.providerId && (
          !s.matchmakerId ||
          s.status === "CONSULTATION_BOOKED" ||
          s.status === "PROVIDER_CONNECTED" ||
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
  }, [parentSessions, lastChatKey]);

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
      s.status === "PROVIDER_CONNECTED";
    const allEvaConversations = allSessions.filter(s => !isProviderThread(s));
    const sortedEva = [...allEvaConversations].sort((a, b) =>
      new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
    );
    const evaConversations = sortedEva.length > 0 ? [sortedEva[0]] : [];
    const providerConversations = allSessions
      .filter(s => isProviderThread(s))
      .sort((a, b) => new Date(b.lastMessageAt || b.updatedAt).getTime() - new Date(a.lastMessageAt || a.updatedAt).getTime());

    const matchesTab = (s: ChatSession) => {
      if (activeFilter === "unread") return (s.unreadCount || 0) > 0;
      return true;
    };
    const filteredEva = evaConversations.filter(s =>
      matchesTab(s) && (
        !searchQuery || (s.matchmakerName || "AI Concierge").toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.title || "").toLowerCase().includes(searchQuery.toLowerCase())
      )
    );
    const filteredProvider = providerConversations.filter(s =>
      matchesTab(s) && (
        !searchQuery || (s.providerName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase())
      )
    );

    const providerGroups: Record<string, ChatSession[]> = {};
    filteredProvider.forEach(s => {
      const key = s.providerId || "other";
      if (!providerGroups[key]) providerGroups[key] = [];
      providerGroups[key].push(s);
    });

    const hasParentSession = !!selectedParentSession;

    // Right profile panel: show only when actively in a provider session with booking data.
    const parentShowRightPanel =
      (selectedParentSession && isProviderThread(selectedParentSession)) ||
      (
        (parentSidePanelData?.providerInChat === true) &&
        (parentSidePanelData.sessionBookings?.length ?? 0) > 0
      );

    // Left sessions sidebar: once the parent has ever been connected to a provider (any
    // provider thread exists), always keep the sidebar visible on desktop so the layout
    // stays 3-column. Parents with only an AI concierge session still get the full-width
    // centered concierge view (sidebar hidden) until their first provider connection.
    const hasAnyProviderSession = providerConversations.length > 0;
    const parentShowLeftSidebar = !!(parentShowRightPanel || hasAnyProviderSession);

    // Legacy alias used by the centering wrapper and ConversationsShell props below.
    const parentShowSidebar = parentShowLeftSidebar;

    const hasSessions = allSessions.length > 0;
    const sidebarContent = hasSessions ? (
      <div>
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
                className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 transition-colors text-left border-b border-border/20"
                style={selectedParentSession?.id === session.id ? { backgroundColor: `${brandColor}15` } : undefined}
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
                    {(session.matchmakerName || "AI").charAt(0)}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-ui truncate" style={{ fontWeight: 600 }}>{session.matchmakerName || "AI Concierge"}</span>
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
          <div className="mt-3" data-testid="section-provider-chats">
            <div className="px-4 pt-3 pb-1 flex items-center gap-2">
              <Heart className="w-4 h-4 fill-current" style={{ color: brandColor }} />
              <h2 className="font-display text-base font-bold text-foreground">Your Matches</h2>
              <svg
                width="20"
                height="30"
                viewBox="0 0 20 30"
                fill="none"
                aria-hidden
                style={{ color: brandColor, opacity: 0.6 }}
              >
                <path d="M3 14 Q 14 17, 14 26" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" fill="none" />
                <path d="M10 23 L 14 27 L 18 23" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </div>
            {Object.entries(providerGroups).map(([providerId, sessions]) => {
              const first = sessions[0];
              return (
                <div key={providerId} data-testid={`provider-group-${providerId}`}>
                  {/* Section header - agency name (neutral pill, distinct from AI Concierge brand pill) */}
                  <div className="mx-4 mt-3 mb-2 px-3 py-1.5 rounded-[var(--radius)] flex items-center gap-2 bg-secondary/40">
                    <div className="w-4 h-4 rounded flex-shrink-0 overflow-hidden bg-background flex items-center justify-center">
                      {first.providerLogo ? (
                        <img src={getPhotoSrc(first.providerLogo) || undefined} alt="" className="w-4 h-4 object-contain" />
                      ) : (
                        <Building2 className="w-3 h-3 text-muted-foreground" />
                      )}
                    </div>
                    <span className="text-xs font-medium truncate flex-1 text-foreground/80">
                      {first.providerName}
                    </span>
                    {first.providerId && onlineStatuses[first.providerId] && (
                      <span className="text-[10px] font-medium text-[hsl(var(--brand-success))]">Online</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {sessions.length} {sessions.length === 1 ? "match" : "matches"}
                    </span>
                  </div>
                  {/* Donor/surrogate rows - flat, full-width chat rows */}
                  {sessions.map(session => {
                    const photoSrc = getPhotoSrc(session.profilePhotoUrl);
                    return (
                      <button
                        key={session.id}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left border-b border-border/10"
                        style={selectedParentSession?.id === session.id ? { backgroundColor: `${brandColor}15` } : undefined}
                        onClick={() => handleParentSessionClick(session)}
                        data-testid={`chat-session-provider-${session.id}`}
                      >
                        <div className="w-12 h-12 rounded-full flex-shrink-0 relative">
                          <div className="w-full h-full rounded-full overflow-hidden">
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
                          {session.subjectProfileId && (() => {
                            const dotStyle = getDonorStatusStyle(session.profileStatus);
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
                            <span className="font-medium text-sm font-ui truncate">{session.title || session.matchmakerName || "Conversation"}</span>
                            {session.subjectProfileId && <DonorStatusPill status={session.profileStatus} />}
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    ) : null;

    const parentProviderJoined = !!selectedParentSession?.providerJoinedAt;
    // Treat a session as "provider-attached" only once the parent has actually
    // engaged the provider (booking placed, joined, or 3-way chat started).
    // A stale providerId left over from how the chat was opened (e.g. clicked
    // a sperm-bank donor) must NOT relabel the chat header as that provider's
    // when the parent is still in AI Concierge mode talking about a different
    // agency.
    const hasProvider = !!selectedParentSession?.providerId && (
      parentProviderJoined ||
      selectedParentSession?.status === "CONSULTATION_BOOKED" ||
      selectedParentSession?.status === "PROVIDER_CONNECTED"
    );
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
          {/* Provider session: stacked layout - donor (primary) + provider (subtitle).
              Only render this layout once the parent has ACTUALLY connected with the
              provider (booking placed, joined, or 3-way chat started). An AI Concierge
              session can carry a stale providerId from the marketplace context it was
              opened in (e.g. clicking a sperm-bank donor), but until the parent books
              a consultation the chat is still the parent's general AI concierge - not
              that provider's consultation channel - so "via Sperm Bank" misattributes
              it after the parent has moved on to a different agency in conversation. */}
          {selectedParentSession!.providerId && selectedParentSession!.title && (
            !!selectedParentSession!.providerJoinedAt ||
            selectedParentSession!.status === "CONSULTATION_BOOKED" ||
            selectedParentSession!.status === "PROVIDER_CONNECTED"
          ) ? (
            <button
              type="button"
              onClick={() => setParentHeaderPanelOpen(o => !o)}
              aria-expanded={parentHeaderPanelOpen}
              aria-controls="parent-header-context-panel"
              className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-[var(--radius)] -mx-1 px-1 py-1 lg:cursor-default active:bg-muted/40 lg:active:bg-transparent"
              data-testid="btn-parent-header-context"
            >
              <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden bg-muted relative">
                {selectedParentSession!.profilePhotoUrl ? (
                  <img src={getPhotoSrc(selectedParentSession!.profilePhotoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <User className="w-4 h-4 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm font-ui truncate" data-testid="parent-chat-subject-label">{selectedParentSession!.title}</span>
                  {selectedParentSession!.subjectProfileId && selectedParentSession!.profileStatus
                    ? <DonorStatusPill status={selectedParentSession!.profileStatus} />
                    : selectedParentSession!.providerId && onlineStatuses[selectedParentSession!.providerId] ? (
                      <span className="w-2 h-2 rounded-full bg-[hsl(var(--brand-success))] flex-shrink-0" aria-label="Provider online" />
                    ) : null}
                </div>
                <div className="flex items-center gap-1 mt-0.5 min-w-0">
                  <span className="text-[11px] text-muted-foreground flex-shrink-0">via</span>
                  {parentHeaderAvatar && (
                    <img src={parentHeaderAvatar} alt="" className="w-3.5 h-3.5 rounded-sm object-contain flex-shrink-0 bg-white border border-border/40" />
                  )}
                  <span className="text-[11px] text-muted-foreground truncate">{parentHeaderName}</span>
                </div>
              </div>
              <ChevronRight
                className="w-4 h-4 text-muted-foreground flex-shrink-0 lg:hidden"
                aria-hidden
              />
            </button>
          ) : (
            /* Concierge or no-subject: single line */
            <>
              <div className="w-10 h-10 rounded-full flex-shrink-0 relative">
                {parentHeaderAvatar ? (
                  <img src={parentHeaderAvatar} alt={parentHeaderName} className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold" style={{ backgroundColor: brandColor }}>
                    {parentHeaderName.charAt(0)}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-ui" style={{ fontWeight: 600 }}>{parentHeaderName}</h2>
                <p className="text-[11px] font-ui text-muted-foreground truncate">AI Concierge Chat</p>
              </div>
            </>
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
            {selectedParentSession!.status === "PROVIDER_CONNECTED" && (
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
              className="h-10 w-10 p-0 rounded-full"
              style={{ color: "white", backgroundColor: brandColor }}
              onClick={handleParentVideo}
              aria-label="Video call"
              data-testid="btn-parent-video"
            >
              <Video className="!w-5 !h-5" strokeWidth={2.25} />
            </Button>
          </div>
          )}
        </div>
        {selectedParentSession!.providerId && selectedParentSession!.title && (
          <ChatHeaderContextPanel
            open={parentHeaderPanelOpen}
            onClose={() => setParentHeaderPanelOpen(false)}
            role="parent"
            brandColor={brandColor}
            matchStatus={
              selectedParentSession!.status === "PROVIDER_CONNECTED"
                ? { label: "Connected", tone: "success" }
                : selectedParentSession!.status === "CONSULTATION_BOOKED"
                ? { label: "Call Booked", tone: "success" }
                : { label: "Q&A", tone: "neutral" }
            }
            subject={
              selectedParentSession!.subjectProfileId
                ? {
                    providerId: selectedParentSession!.providerId,
                    subjectProfileId: selectedParentSession!.subjectProfileId,
                    subjectType: selectedParentSession!.subjectType,
                    fallbackPhotoUrl: selectedParentSession!.profilePhotoUrl,
                    fallbackLabel: selectedParentSession!.title,
                    profileAvailable: selectedParentSession!.profileAvailable,
                    profileStatus: selectedParentSession!.profileStatus,
                  }
                : null
            }
            provider={{
              id: selectedParentSession!.providerId,
              name: parentSidePanelData?.providerName || parentHeaderName,
              logoUrl: parentSidePanelData?.subjectInfo?.providerLogo || selectedParentSession!.providerLogo,
              calendar: parentSidePanelData?.sessionCalendarSlug?.slug ? {
                slug: parentSidePanelData.sessionCalendarSlug.slug,
                memberName: parentSidePanelData.sessionCalendarSlug.memberName || parentSidePanelData.subjectInfo?.memberName,
                existingBooking:
                  parentSidePanelData.sessionBookings?.find((b: any) =>
                    b.providerUser?.provider?.id === parentSidePanelData.subjectInfo?.providerId ||
                    b.providerId === parentSidePanelData.subjectInfo?.providerId
                  ) ?? parentSidePanelData.sessionBookings?.[0] ?? undefined,
                consultationMeta: parentSidePanelData.subjectInfo ? {
                  providerId: parentSidePanelData.subjectInfo.providerId,
                  profileLabel: parentSidePanelData.subjectInfo.profileLabel,
                  profilePhotoUrl: parentSidePanelData.subjectInfo.profilePhotoUrl,
                  subjectProfileId: parentSidePanelData.subjectInfo.subjectProfileId,
                  subjectType: parentSidePanelData.subjectInfo.subjectType,
                } : undefined,
              } : null,
            }}
            testId="parent-header-context-panel"
          />
        )}
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
            onBookingConfirmed={handleBookingConfirmed}
          />
        </div>
        </div>{/* end centering wrapper */}
        {parentShowRightPanel && parentSidePanelData && (
          <ParentChatSidePanel
            subjectInfo={parentSidePanelData.subjectInfo}
            providerName={parentSidePanelData.providerName}
            sessionCalendarSlug={parentSidePanelData.sessionCalendarSlug}
            sessionBookings={parentSidePanelData.sessionBookings}
            brandColor={brandColor}
            sessionId={selectedParentSession?.id ?? null}
            profileAvailable={selectedParentSession?.profileAvailable ?? null}
            profileStatus={selectedParentSession?.profileStatus ?? null}
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
          sidebarAlwaysVisible={parentShowRightPanel}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
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
    const matchesProviderTab = (s: ProviderSession) => {
      if (activeFilter === "unread") return (s.unreadCount || 0) > 0;
      return true;
    };
    const filteredSessions = sessions.filter(s =>
      matchesProviderTab(s) && (
        !searchQuery ||
        (s.userName || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.userEmail || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.lastMessage || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.title || "").toLowerCase().includes(searchQuery.toLowerCase())
      )
    );

    // Group sessions by parent userId
    const parentGroups: Record<string, ProviderSession[]> = {};
    filteredSessions.forEach(s => {
      const key = s.userId;
      if (!parentGroups[key]) parentGroups[key] = [];
      parentGroups[key].push(s);
    });

    // Once a parent has a PROVIDER_CONNECTED session, hide the anonymous whisper session (no subjectProfileId)
    // so the provider only sees the actual donor/surrogate sessions in the folder
    for (const userId of Object.keys(parentGroups)) {
      const group = parentGroups[userId];
      const hasJoined = group.some(s => s.status === "PROVIDER_CONNECTED");
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

    const hasSessions = filteredSessions.length > 0;
    const sidebarContent = hasSessions ? (
      <>
        {sortedGroupEntries.map(([parentUserId, groupSessions]) => {
          const first = groupSessions[0];
          return (
            <div key={parentUserId} data-testid={`parent-group-${parentUserId}`}>
              {/* Section header - parent name (secondary-color pill, consistent with parent-side agency pills) */}
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
                <span className="text-[10px] text-muted-foreground">
                  {groupSessions.length} {groupSessions.length === 1 ? "match" : "matches"}
                </span>
              </div>
              {/* Donor/surrogate rows - flat, full-width chat rows */}
              {groupSessions.map(s => {
                const sUnread = s.unreadCount || 0;
                const photoSrc = getPhotoSrc(s.profilePhotoUrl);
                const pendingAgeMin = s.pendingQuestions > 0 ? (s.pendingMaxAgeMinutes || 0) : 0;
                const slaTone = pendingAgeMin >= 24 * 60
                  ? "bg-accent/20 text-accent-foreground border-accent/40"
                  : pendingAgeMin >= 2 * 60
                    ? "bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning))]/30"
                    : "bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success))]/30";
                const slaLabel = pendingAgeMin === 0
                  ? null
                  : pendingAgeMin < 60
                    ? `${pendingAgeMin}m`
                    : pendingAgeMin < 24 * 60
                      ? `${Math.floor(pendingAgeMin / 60)}h`
                      : `${Math.floor(pendingAgeMin / 1440)}d`;
                const isSelected = selectedSessionId === s.id;
                return (
                  <button
                    key={s.id}
                    className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left border-b border-border/10 relative ${isSelected ? "bg-secondary" : "hover:bg-muted/50"}`}
                    style={isSelected ? { borderLeft: `4px solid ${brandColor}`, paddingLeft: "calc(1rem - 4px)" } : undefined}
                    onClick={() => setSelectedSessionId(s.id, s)}
                    data-testid={`provider-session-${s.id}`}
                    aria-current={isSelected ? "page" : undefined}
                  >
                    <div className="w-12 h-12 rounded-full flex-shrink-0 relative">
                      <div className="w-full h-full rounded-full overflow-hidden">
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
                      {s.subjectProfileId && (() => {
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
                          <span className="font-medium text-sm font-ui truncate">{s.title || "Conversation"}</span>
                          {s.subjectProfileId && <DonorStatusPill status={s.profileStatus} />}
                          {slaLabel && (
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${slaTone} flex-shrink-0`}
                              title={`Oldest pending question: ${slaLabel} ago${s.pendingNudgeCount > 0 ? ` (nudged ${s.pendingNudgeCount}x)` : ""}`}
                              data-testid={`provider-session-sla-${s.id}`}
                            >
                              Q&A {slaLabel}
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
              })}
            </div>
          );
        })}
      </>
    ) : null;

    const providerDetailContent = (sessionDetailQuery.isLoading || sessionBookingsQuery.isLoading) ? (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    ) : detail ? (
      <div className="flex flex-1 min-h-0 overflow-hidden">
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
          <button
            type="button"
            onClick={() => setProviderHeaderPanelOpen(o => !o)}
            aria-expanded={providerHeaderPanelOpen}
            aria-controls="provider-header-context-panel"
            className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-[var(--radius)] -mx-1 px-1 py-1 lg:cursor-default active:bg-muted/40 lg:active:bg-transparent"
            data-testid="btn-provider-header-context"
          >
            {(detail.title || selectedSession?.profilePhotoUrl) ? (
              /* Stacked: parent (primary, who you're talking with) + donor (subtitle, what about) */
              <>
                <div className="w-10 h-10 rounded-full flex-shrink-0 overflow-hidden bg-muted">
                  {detail.user.photoUrl ? (
                    <img src={getPhotoSrc(detail.user.photoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <User className="w-4 h-4 text-muted-foreground" />
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
                  <div className="flex items-center gap-1 mt-0.5 min-w-0">
                    <span className="text-[11px] text-muted-foreground flex-shrink-0">re:</span>
                    {selectedSession?.profilePhotoUrl ? (
                      <img src={getPhotoSrc(selectedSession.profilePhotoUrl) || undefined} alt="" className="w-3.5 h-3.5 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-3.5 h-3.5 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                        <User className="w-2 h-2 text-muted-foreground" />
                      </div>
                    )}
                    <span className="text-[11px] text-muted-foreground truncate" data-testid="provider-subject-label">{detail.title || "Conversation"}</span>
                    {selectedSession?.subjectProfileId && <DonorStatusPill status={selectedSession.profileStatus} />}
                  </div>
                </div>
              </>
            ) : (
              /* Anonymous whisper phase: just the parent name + Q&A label */
              <>
                <div className="w-10 h-10 rounded-full flex-shrink-0 relative">
                  {detail.user.photoUrl ? (
                    <img src={getPhotoSrc(detail.user.photoUrl) || undefined} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <Sparkles className="w-4 h-4" style={{ color: brandColor }} />
                    </div>
                  )}
                  {onlineStatuses[detail.user.id] && <OnlineIndicator size="sm" />}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-sm font-ui truncate block">{detail.user.name || "Prospective Parent"}</span>
                  <p className="text-[11px] text-muted-foreground truncate">Anonymous Q&A via AI Concierge</p>
                </div>
              </>
            )}
            <ChevronRight
              className="w-4 h-4 text-muted-foreground flex-shrink-0 lg:hidden"
              aria-hidden
            />
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-10 p-0 rounded-full"
              style={{ color: "white", backgroundColor: brandColor }}
              onClick={handleProviderVideo}
              aria-label="Video call"
              data-testid="btn-provider-video"
            >
              <Video className="!w-5 !h-5" strokeWidth={2.25} />
            </Button>
          </div>
        </div>

        <ChatHeaderContextPanel
          open={providerHeaderPanelOpen}
          onClose={() => setProviderHeaderPanelOpen(false)}
          role="provider"
          brandColor={brandColor}
          user={detail.user}
          matchStatus={
            hasJoined
              ? { label: "Connected", tone: "success" }
              : isConsultationBooked
              ? { label: "Call Booked", tone: "success" }
              : (selectedSession?.pendingQuestions || 0) > 0
              ? { label: "Anonymous Q&A", tone: "neutral" }
              : null
          }
          subject={
            selectedSession?.subjectProfileId
              ? {
                  providerId: (user as any)?.providerId,
                  subjectProfileId: selectedSession.subjectProfileId,
                  subjectType: selectedSession.subjectType,
                  fallbackPhotoUrl: selectedSession.profilePhotoUrl,
                  fallbackLabel: selectedSession.title,
                  profileAvailable: selectedSession.profileAvailable,
                  profileStatus: selectedSession.profileStatus,
                }
              : null
          }
          testId="provider-header-context-panel"
        />

          <div className="flex-1 flex flex-col min-h-0">
            {(pendingWhispersQuery.data?.length || 0) > 0 && (
              <div
                className="border-b px-4 py-2.5 flex items-center gap-2 shrink-0 cursor-pointer lg:cursor-default select-none"
                style={{ backgroundColor: `hsl(var(--brand-warning) / 0.1)`, borderColor: `hsl(var(--brand-warning) / 0.3)` }}
                data-testid="pending-whispers-banner"
                role="button"
                tabIndex={0}
                aria-expanded={!whispersPanelCollapsedMobile}
                aria-controls="provider-whispers-inline-mobile"
                onClick={(e) => {
                  // Mobile-only: tapping the banner toggles the inline
                  // panel below. The desktop "Jump to panel" button has
                  // its own click handler and stops propagation, so it
                  // never accidentally triggers the toggle on lg+.
                  if ((e.target as HTMLElement).closest('[data-testid="btn-jump-to-whispers"]')) return;
                  setWhispersPanelCollapsedMobile(c => !c);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setWhispersPanelCollapsedMobile(c => !c);
                  }
                }}
              >
                <HelpCircle className="w-4 h-4 flex-shrink-0" style={{ color: `hsl(var(--brand-warning))` }} />
                <p className="text-xs flex-1" style={{ color: `hsl(var(--brand-warning))` }}>
                  <span className="font-semibold">{pendingWhispersQuery.data!.length} pending question{pendingWhispersQuery.data!.length > 1 ? "s" : ""}</span>
                  <span className="opacity-80"> from this parent</span>
                  <span className="opacity-80 hidden lg:inline"> - answer {pendingWhispersQuery.data!.length > 1 ? "them" : "it"} in the side panel</span>
                  <span className="opacity-80 lg:hidden"> - tap to {whispersPanelCollapsedMobile ? "expand" : "collapse"}</span>
                  <span className="opacity-80">.</span>
                </p>
                {/* Chevron indicator on mobile - reinforces that the banner
                    is the toggle for the inline panel. Hidden on lg+ where
                    the side panel is always visible and the toggle is a
                    no-op. */}
                <span
                  className="lg:hidden h-6 w-6 flex items-center justify-center flex-shrink-0"
                  style={{ color: `hsl(var(--brand-warning))` }}
                  aria-hidden
                >
                  {whispersPanelCollapsedMobile ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs hidden lg:inline-flex"
                  onClick={(e) => {
                    e.stopPropagation();
                    const panel = document.querySelector('[data-testid="whisper-questions-panel"]');
                    if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  data-testid="btn-jump-to-whispers"
                >
                  Jump to panel
                </Button>
              </div>
            )}
            {/* Mobile / tablet inline copy of the Q&A panel - the right-side
                sidebar that holds this panel on desktop is hidden at < lg, so
                without rendering it here the provider sees a banner pointing
                at a panel they can't reach. Capped at 55vh so the chat
                messages and composer below stay visible. Collapsible via the
                banner toggle so a provider who can't answer right now can
                still see the chat. */}
            {(pendingWhispersQuery.data?.length || 0) > 0 && !whispersPanelCollapsedMobile && (
              <div
                id="provider-whispers-inline-mobile"
                className="lg:hidden border-b bg-muted/30 px-4 py-3 max-h-[55vh] overflow-y-auto shrink-0"
                data-testid="provider-whispers-inline-mobile"
              >
                {whispersPanel}
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" data-testid="provider-chat-messages">
              <ChatMessageList
                ref={chatEndRef}
                messages={detail.messages}
                bookings={sessionBookingsQuery.data}
                brandColor={brandColor}
                chatPalette={chatPalette}
                borderRadius={brand?.borderRadius ?? 1}
                viewerRole="provider"
                sessionId={selectedSessionId}
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
                msgAvatarUrl={(msg) => {
                  if (msg.role === "assistant" || (msg.role !== "user" && msg.senderType !== "provider")) {
                    const mm = brand?.matchmakers?.find((m: any) => m.id === detail.matchmakerId);
                    if (mm?.avatarUrl) return getPhotoSrc(mm.avatarUrl) || mm.avatarUrl;
                  }
                  if (msg.role === "user") return getPhotoSrc((detail.user as any)?.photoUrl) || null;
                  return null;
                }}
                aiAvatarUrl={(() => {
                  const mm = brand?.matchmakers?.find((m: any) => m.id === detail.matchmakerId);
                  return mm?.avatarUrl ? getPhotoSrc(mm.avatarUrl) || mm.avatarUrl : null;
                })()}
                aiName={(() => {
                  const mm = brand?.matchmakers?.find((m: any) => m.id === detail.matchmakerId);
                  return mm?.name || "AI";
                })()}
                onOpenInlineVideo={setInlineVideoBookingId}
                onBookingUpdate={() => sessionBookingsQuery.refetch()}
                msgTestIdPrefix="provider-msg"
                onEditCostSheet={(hasJoined || isConsultationBooked)
                  ? () => {
                      if (selectedSessionId) generateCostSheetDraftsMutation.mutate(selectedSessionId);
                    }
                  : undefined}
                onEditInvoice={(hasJoined || isConsultationBooked) ? editInvoiceFromCard : undefined}
                onCancelInvoice={(hasJoined || isConsultationBooked) ? cancelInvoiceFromCard : undefined}
                invoiceActionPendingId={invoiceActionPendingId}
                onCancelCostSheet={(hasJoined || isConsultationBooked) ? cancelCostSheetFromCard : undefined}
                costSheetActionPendingId={costSheetActionPendingId}
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
                placeholder={(hasJoined || isConsultationBooked) ? "Type a message to the parent..." : "Type your answer..."}
                senderLabel={!hasJoined && !isConsultationBooked ? <WhisperDisclaimer /> : undefined}
                enableFileUpload
                testIdPrefix="provider"
                onMeetingClick={handleProviderMeeting}
                onCostSheetClick={(hasJoined || isConsultationBooked) ? () => {
                  if (selectedSessionId) generateCostSheetDraftsMutation.mutate(selectedSessionId);
                } : undefined}
                onInvoiceClick={(hasJoined || isConsultationBooked) ? () => { setInvoiceEditPrefill(null); setProviderInlinePanel("invoice"); } : undefined}
                onAgreementClick={(hasJoined || isConsultationBooked) ? () => setProviderInlinePanel("agreement") : undefined}
                inlinePanel={
                  providerInlinePanel === "costSheet" ? (
                    <CostSheetSidebarSection
                      key={`cs-embed-${selectedSessionId || "none"}-${costSheetEditPrefill ? costSheetEditPrefill.totalCostCents : "blank"}`}
                      sessionId={selectedSessionId}
                      brandColor={brandColor}
                      sessionQueryKey="/api/provider/concierge-sessions"
                      embedded
                      onClose={() => { setProviderInlinePanel(null); setCostSheetEditPrefill(null); }}
                      subjectType={selectedSession?.subjectType ?? null}
                      subjectProfileId={selectedSession?.subjectProfileId ?? null}
                      providerId={(user as any)?.providerId ?? null}
                      initialTotalCostCents={costSheetEditPrefill?.totalCostCents ?? null}
                      initialNotes={costSheetEditPrefill?.notes ?? null}
                    />
                  ) : providerInlinePanel === "invoice" ? (
                    <InvoiceSidebarSection
                      key={`inv-embed-${selectedSessionId || "none"}-${invoiceEditPrefill?.invoiceId || "blank"}`}
                      sessionId={selectedSessionId}
                      brandColor={brandColor}
                      sessionQueryKey="/api/provider/concierge-sessions"
                      embedded
                      onClose={() => { setProviderInlinePanel(null); setInvoiceEditPrefill(null); }}
                      initialLineItems={invoiceEditPrefill?.lineItems ?? null}
                      initialDescription={invoiceEditPrefill?.description ?? null}
                      cancelInvoiceIdOnSend={invoiceEditPrefill?.invoiceId ?? null}
                    />
                  ) : providerInlinePanel === "agreement" ? (
                    <AgreementSidebarSection
                      key={`agr-embed-${selectedSessionId || "none"}`}
                      agreement={detail?.agreements?.[0]}
                      brandColor={brandColor}
                      sessionId={selectedSessionId}
                      relationshipStatus={detail?.user?.relationshipStatus}
                      sessionQueryKey="/api/provider/concierge-sessions"
                      embedded
                      onClose={() => setProviderInlinePanel(null)}
                    />
                  ) : undefined
                }
              />
            ) : (
              <div className="border-t px-4 py-4 bg-muted/30 text-center shrink-0" data-testid="provider-waiting-prompt">
                <p className="text-sm text-muted-foreground">No pending questions. When the AI concierge receives questions from this parent, they'll appear here.</p>
              </div>
            )}
          </div>
        </div>{/* end header + messages column */}

          {(() => {
            // The whispersPanel JSX is hoisted to the component body so it
            // can also be rendered inline on mobile / tablet (where this
            // sidebar is hidden). We still use it here for desktop.
            if (!hasJoined && !isConsultationBooked) {
              return (
                <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden lg:block" data-testid="provider-sidebar">
                  {whispersPanel}
                </div>
              );
            }

            return (
            <ChatProfileSidebar
              user={detail.user}
              brandColor={brandColor}
              isOnline={!!onlineStatuses[detail.user.id]}
              testId="provider-sidebar"
              topSections={
                <>
                  {whispersPanel ? (
                    <div className="border-b pb-4 mb-4" data-testid="whisper-questions-section">
                      {whispersPanel}
                    </div>
                  ) : null}
                {(hasJoined || isConsultationBooked) ? (
                  <div className="border-b pb-4 mb-4" data-testid="consultation-status-section">
                    <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Match Status</h4>
                    <div className="space-y-2">
                      {hasJoined ? (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))] text-xs font-medium w-fit" data-testid="badge-provider-connected">
                          <CheckCircle2 className="w-3 h-3" />
                          Connected
                        </div>
                      ) : isConsultationBooked ? (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))] text-xs font-medium w-fit" data-testid="badge-call-booked">
                          <CheckCircle2 className="w-3 h-3" />
                          Call Booked
                        </div>
                      ) : null}
                      {hasJoined && (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                ) : null}
                </>
              }
              extraSections={
                <>
                  {(() => {
                    const bookings = sessionBookingsQuery.data || [];
                    // Only show bookings where this provider user is the host - never show admin/GoStork bookings
                    const activeBookings = bookings.filter((b: any) =>
                      b.providerUserId === user?.id && (
                        b.status === "PENDING" ||
                        (b.status === "CONFIRMED" && new Date() < new Date(new Date(b.scheduledAt).getTime() + (b.duration || 30) * 60 * 1000))
                      )
                    );
                    if (activeBookings.length === 0) return null;
                    return (
                      <div className="border-t pt-4 mt-4" data-testid="panel-consultation-call-section">
                        <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Consultation Call</h4>
                        <div className="space-y-2">
                          {activeBookings.map((b: any) => (
                            <ChatBookingCard
                              key={b.id}
                              booking={b}
                              onUpdate={() => queryClient.invalidateQueries({ queryKey: ["/api/chat-session/bookings", selectedSessionId] })}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  <SubjectProfileCard
                    providerId={(user as any)?.providerId}
                    subjectProfileId={selectedSession?.subjectProfileId}
                    subjectType={selectedSession?.subjectType}
                    fallbackPhotoUrl={selectedSession?.profilePhotoUrl}
                    fallbackLabel={selectedSession?.title}
                    profileAvailable={selectedSession?.profileAvailable}
                    profileStatus={selectedSession?.profileStatus}
                    brandColor={brandColor}
                    heading={
                      (selectedSession?.subjectType || "").toLowerCase() === "surrogate" ? "Interested Surrogate"
                        : (selectedSession?.subjectType || "").toLowerCase().includes("sperm") ? "Interested Sperm Donor"
                        : "Interested Egg Donor"
                    }
                    withSeparator
                    testId="provider-subject-profile-card"
                  />
                  {/* Cost Sheet / Invoice / Agreement sections moved into the + drawer above the composer */}
                </>
              }
            />
            );
          })()}
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
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
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
