import { BRAND_PRIMARY_FALLBACK } from "@shared/brand-fallback";
import { greetingNameOf } from "@/lib/display-name";
import { useSyncExternalStore, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, Fragment } from "react";
import { ivfContextSearch } from "@/components/ivf-success-rates-section";
import { CostSheetSidebarSection } from "@/components/chat/cost-sheet-sidebar-section";
import { InvoiceHistorySidebarSection } from "@/components/chat/invoice-history-sidebar-section";
import { CostSheetParentAck } from "@/components/chat/special-message-card";
import { ChatPlusDrawer, type ChatPlusAction } from "@/components/chat/chat-plus-drawer";
import { ContactGuardNotice } from "@/components/chat/contact-guard-notice";
import { CONTACT_GUARD_CODE, contactGuardMessage, detectContactInfo } from "@shared/contact-guard";
import { InvoicePaymentPanel } from "@/components/chat/invoice-payment-panel";
import { InlineBookingNotification } from "@/components/chat/inline-booking-notification";
import { ComparisonCard } from "@/components/chat/comparison-card";
import { ChatInlineCards } from "@/components/chat/concierge-cards";
import { createPortal } from "react-dom";
import { BankCheckoutCard } from "@/components/chat/bank-checkout-card";
import { PartnerInfoRequestCard } from "@/components/chat/partner-info-request-card";
import { PartnerInviteCard } from "@/components/chat/partner-invite-card";
import { WhatIKnowStrip } from "@/components/chat/what-i-know-strip";
import { ChatThreadHeader } from "@/components/chat/chat-thread-header";
import { DonorReleaseWarningButtons } from "@/components/chat/special-message-card";
import { ReviewPromptCard } from "@/components/reviews/reviews-ui";
import { IpFormPromptCard } from "@/components/chat/ip-form-prompt-card";
import { useSearchParams, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { deriveChatPalette } from "@/lib/chat-palette";
import { getPhotoSrc } from "@/lib/profile-utils";
import { getProfileUrlSlug } from "@/components/chat/chat-utils";
import { isVideoInviteExpired } from "@/lib/booking-time";
import { StagedFileChip } from "@/components/chat/staged-file-chip";
import { AttachmentMessageCard } from "@/components/chat/attachment-message-card";
import { renderRichLine } from "@/lib/render-rich-text";
import { DonorStatusPill, getDonorStatusStyle } from "@/lib/donor-status";
import { useMarketplaceViewContext, recordProfileView, recordImpression } from "@/lib/profile-views";
import { formatMoneyCents, formatMoneyDollars } from "@/lib/format-money";
import { getCountryFlag } from "@/lib/country-flag";
import { formatLocationDisplay } from "@/lib/format-location";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { MessageStatus } from "@/components/ui/message-status";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SwipeDeckCard, type TabSection } from "@/components/marketplace/swipe-deck-card";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { ClinicSwipeCard } from "@/components/marketplace/clinic-swipe-card";
import { AgencySwipeCard } from "@/components/marketplace/agency-swipe-card";
import { LawGroupSwipeCard } from "@/components/marketplace/law-group-swipe-card";
import { JourneyTimelineCard } from "@/components/journey/journey-timeline-card";
import {
  mapDatabaseDonorToSwipeProfile,
  mapDatabaseSurrogateToSwipeProfile,
  mapDatabaseSpermDonorToSwipeProfile,
  getDonorTabs,
  getSurrogateTabs,
  getClinicTabs,
  buildDoctorCardProps,
  buildTitle,
  buildStatusLabel,
  getPhotoList,
  buildSidebarSections,
  type SidebarSection,
  type DoctorCardData,
} from "@/components/marketplace/swipe-mappers";
import { SubjectProfileCard, ProviderProfileCard } from "@/components/profile-cards";
import { Loader2, Send, ArrowUp, ArrowLeft, Sparkles, Headphones, FileText, Download, Heart, Brain, Stethoscope, MessageCircle, Shield, CalendarCheck, CalendarDays, X, ExternalLink, ChevronLeft, ChevronRight, Clock, Video, Globe, Check, Paperclip, UserPlus, Plus, Maximize, Minimize, PenLine, User, CheckCircle2, ThumbsUp, Image as ImageIcon, Camera, UploadCloud, AudioLines } from "lucide-react";
import { VoiceModePanel, VoiceStartHero } from "@/components/voice/VoiceModePanel";
import { useSharedVoiceSession } from "@/contexts/voice-session-context";
import { format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isBefore, isToday, isSameDay, isSameMonth, startOfDay } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import { parseApiError } from "@/lib/api-error";
import { ReadinessPromptCard } from "@/components/readiness-prompt-card";
import { ConsentAckCard, CONSENT_ACK_CARD_TYPES } from "@/components/chat/consent-ack-card";
import { CelebrationBurst } from "@/components/chat/celebration-burst";
import { useScrollToMessage, captureMessageTarget, hasPendingMessageTarget } from "@/hooks/use-scroll-to-message";
import { ProposedTimesCard } from "@/components/chat/proposed-times-card";
import { InvoiceCard } from "@/components/invoice-card";

import {
  AgreementSignCard,
  BookingOverlay,
  ChatMessage,
  ConsultationBookingCard,
  ConsultationCardData,
  DoctorCard,
  DoctorMatchCard,
  InlineBookingCalendar,
  MatchCard,
  MatchCardComponent,
  MeetingBookingCard,
  PrepDocCard,
  WORKING_CURATION_ID,
  chatDateLabel,
  isAffirmativeReply,
  persistChatFavorite,
} from "@/components/chat/concierge-cards";

function ConciergeInlineVideoOverlay({ bookingId, onClose }: { bookingId: string; onClose: () => void }) {
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

function ConciergeSpecialCard({ msg, brandColor, onOpenInlineVideo, sessionId, isAnswered, positiveChipStyle, declineChipStyle, onAnswer, onYesReady, onPayInvoiceInline, onPrefillCostSheetQuestion }: { msg: ChatMessage; brandColor: string; onOpenInlineVideo?: (bookingId: string) => void; sessionId?: string | null; isAnswered?: boolean; positiveChipStyle?: React.CSSProperties; declineChipStyle?: React.CSSProperties; onAnswer?: (text: string) => void; onYesReady?: (text: string) => void; onPayInvoiceInline?: (paymentToken: string) => void; onPrefillCostSheetQuestion?: (text: string) => void }) {
  const data = msg.uiCardData as any;
  if (!data) return null;

  if (msg.uiCardType === "attachment") {
    return <AttachmentMessageCard data={data} testId="concierge-attachment-card" />;
  }

  if (msg.uiCardType === "video_invite") {
    const videoBookingId = data.bookingId;
    if (!videoBookingId || isVideoInviteExpired(msg.createdAt)) {
      return (
        <div className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-muted/50 w-full text-left opacity-60" style={{ borderColor: brandColor }}>
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground/70 shrink-0" style={{ backgroundColor: brandColor }}>
            <Video className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="t-helper font-semibold">Video Call Ended</p>
            <p className="t-helper">This call session has expired</p>
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
      <button
        onClick={handleVideoClick}
        className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors cursor-pointer w-full text-left"
        style={{ borderColor: brandColor }}
        data-testid="concierge-video-invite"
      >
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
          <Video className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Join Video Call</p>
          <p className="t-helper">Click to join the video consultation</p>
        </div>
        <Video className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>
    );
  }

  if (msg.uiCardType === "calendar_share") {
    return (
      <a
        href={data.bookingUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
        style={{ borderColor: brandColor }}
        data-testid="concierge-calendar-share"
      >
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
          <CalendarDays className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Book a Meeting</p>
          <p className="t-helper">{data.memberName ? `Schedule with ${data.memberName}` : "Pick a time that works"}</p>
        </div>
        <ExternalLink className="w-4 h-4 text-muted-foreground shrink-0" />
      </a>
    );
  }

  if (msg.uiCardType === "agreement_signed") {
    return (
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
          <p className="t-helper">Tap to view and download the signed agreement</p>
        </div>
        <Download className="w-4 h-4 text-muted-foreground shrink-0" />
      </a>
    );
  }

  if (msg.uiCardType === "proposed_times") {
    return (
      <ProposedTimesCard
        data={data}
        messageId={msg.id || ""}
        sessionId={sessionId || ""}
        brandColor={brandColor}
        canPick={true}
      />
    );
  }

  if (msg.uiCardType === "readiness_prompt") {
    return (
      <ReadinessPromptCard
        data={data}
        messageId={msg.id || ""}
        sessionId={sessionId || ""}
        messageContent={msg.content || ""}
        isParent={true}
        isAnswered={isAnswered}
        brandColor={brandColor}
        positiveChipStyle={positiveChipStyle}
        declineChipStyle={declineChipStyle}
        onAnswer={onAnswer}
        onYesReady={onYesReady}
      />
    );
  }

  // Consultation focus lock + match-call consent gates. One component for all
  // three - they are the same interaction, driven by uiCardData.
  if (CONSENT_ACK_CARD_TYPES.includes(msg.uiCardType as any)) {
    return (
      <ConsentAckCard
        data={data}
        messageId={msg.id || ""}
        sessionId={sessionId || ""}
        viewerRole="parent"
        positiveChipStyle={positiveChipStyle}
      />
    );
  }

  if (msg.uiCardType === "invoice") {
    return (
      <InvoiceCard
        data={data}
        isParent={true}
        onPayInline={
          onPayInvoiceInline && data.paymentToken
            ? () => onPayInvoiceInline(data.paymentToken)
            : undefined
        }
      />
    );
  }

  if (msg.uiCardType === "bank_checkout") {
    return <BankCheckoutCard data={data} brandColor={brandColor} />;
  }

  // msg.id is optional (a message has none until it is persisted) and the card
  // posts to /partner-info/${messageId} - without an id that submit would go to
  // ".../partner-info/undefined" and fail with nothing shown to the parent. Gate
  // on it the same way sessionId is already gated.
  if (msg.uiCardType === "partner_info_request" && sessionId && msg.id) {
    return <PartnerInfoRequestCard data={data} messageId={msg.id} sessionId={String(sessionId)} brandColor={brandColor} />;
  }

  // Egg-donor hold release countdown - parent chooses pay-soon vs release.
  if (msg.uiCardType === "donor_release_warning") {
    return <DonorReleaseWarningButtons messageId={msg.id || ""} data={data} brandColor={brandColor} viewerRole="parent" />;
  }

  // Phase 8: Eva's review ask (parent-only - excluded from provider feeds server-side).
  if (msg.uiCardType === "review_prompt") {
    return <ReviewPromptCard messageId={msg.id || ""} data={data} />;
  }

  // Intended Parent Form nudge (parent-only - excluded from provider feeds server-side).
  if (msg.uiCardType === "ip_form_prompt") {
    return <IpFormPromptCard data={data} brandColor={brandColor} />;
  }

  if (msg.uiCardType === "cost_sheet") {
    const totalCents: number = data.totalCostCents ?? 0;
    const hasFile: boolean = !!data.costSheetFileUrl;
    const quoteId: string | null = data.quoteId || null;
    const fileName: string | null = data.costSheetFileName || null;
    const providerName: string = data.providerName || "Your provider";
    const notes: string | null = data.notes || null;
    const sentAt: string | null = data.sentAt || null;
    const cancelledAt: string | null = data.cancelledAt || null;
    const isCancelled = !!cancelledAt;
    const totalFormatted = formatMoneyCents(totalCents);
    const cancelledBorder = "hsl(var(--muted-foreground) / 0.4)";
    // Route through our authenticated download endpoint which mints a fresh
    // signed URL each click. The raw GCS URL returned by uploadBufferPublic
    // 403s when the bucket has uniform bucket-level access enabled.
    const downloadUrl = hasFile && sessionId && quoteId
      ? `/api/sessions/${sessionId}/cost-sheets/${quoteId}/file`
      : null;
    return (
      <div
        className={`rounded-[var(--radius)] border-2 bg-background overflow-hidden max-w-md ${isCancelled ? "opacity-70" : ""}`}
        style={{ borderColor: isCancelled ? cancelledBorder : brandColor }}
        data-testid="cost-sheet-card"
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: isCancelled ? cancelledBorder : brandColor }}>
            <FileText className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold ${isCancelled ? "line-through text-muted-foreground" : ""}`}>
              Cost Sheet from {providerName}
            </p>
            <p className="t-helper">
              {isCancelled
                ? `Cancelled${cancelledAt ? ` - ${new Date(cancelledAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`
                : `Total quoted cost${sentAt ? ` - ${new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`}
            </p>
          </div>
          <p
            className={`text-lg font-bold shrink-0 ${isCancelled ? "line-through" : ""}`}
            style={{ color: isCancelled ? "hsl(var(--muted-foreground))" : brandColor }}
          >
            {totalFormatted}
          </p>
        </div>
        {(downloadUrl || notes) && (
          <div className="border-t px-4 py-2.5 space-y-2 bg-muted/30">
            {downloadUrl && (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs hover:underline"
                style={{ color: brandColor }}
              >
                <Download className="w-3.5 h-3.5" />
                {fileName || "Open cost sheet"}
              </a>
            )}
            {notes && <p className="t-helper italic whitespace-pre-line">{notes}</p>}
          </div>
        )}
        {/* Parent-only ack footer. Shows Acknowledge + Have questions buttons
            so the cost sheet is interactive even when no PDF was attached. A
            cancelled cost sheet skips the ack so the parent isn't asked to
            confirm something the provider already retracted.
            key={quoteId} guarantees a fresh CostSheetParentAck instance per
            quote so the local `acknowledged` flag never leaks across the
            superseded -> new quote transition. */}
        {quoteId && sessionId && !data.parentAcknowledgedAt && !isCancelled && (
          <CostSheetParentAck
            key={quoteId}
            sessionId={sessionId}
            quoteId={quoteId}
            brandColor={brandColor}
            onPrefillInput={onPrefillCostSheetQuestion}
          />
        )}
      </div>
    );
  }

  return null;
}

export function ParentChatSidePanel({
  subjectInfo,
  providerName,
  providerLogo,
  sessionCalendarSlug,
  sessionBookings,
  brandColor,
  sessionId,
  profileAvailable,
  profileStatus,
  providerId = null,
}: {
  subjectInfo: ConsultationCardData | null;
  providerName: string | null;
  providerLogo?: string | null;
  sessionCalendarSlug: { slug: string | null; memberName: string | null } | null;
  sessionBookings: any[] | null;
  brandColor: string;
  sessionId: string | null;
  profileAvailable?: boolean | null;
  profileStatus?: string | null;
  /** Session's provider org - fallback for chats without a subject profile
   *  (legal firm chats) so the Journey section always renders. */
  providerId?: string | null;
}) {
  const statusStyle = getDonorStatusStyle(profileStatus);
  const existingBooking =
    sessionBookings?.find(
      (b: any) =>
        b.providerUser?.provider?.id === subjectInfo?.providerId ||
        b.providerId === subjectInfo?.providerId
    ) ??
    sessionBookings?.[0] ??
    null;

  // Post-booking the agency identity is REVEALED (the booking itself is the
  // consent moment) - but subjectInfo can still carry the PRE-booking masked
  // snapshot ("the Surrogate's Agency") from the old consultation card. Once
  // any booking exists on the session, prefer the session's real provider
  // name; with no booking yet the mask stands.
  const MASKED_AGENCY = /^the (surrogate|egg donor|sperm donor)'s agency$/i;
  const displayProviderName =
    subjectInfo?.providerName && MASKED_AGENCY.test(subjectInfo.providerName) && existingBooking && providerName
      ? providerName
      : (subjectInfo?.providerName || providerName);

  return (
    <div className="w-72 border-l overflow-y-auto bg-muted/30 hidden md:flex md:flex-col shrink-0">
      <div className="p-4 space-y-4">
        {/* Phase 7A: the parent's journey with THIS provider - same shared
            timeline the provider and admin sidebars show, self-scoped. */}
        {(subjectInfo?.providerId || providerId) && (
          <div className="border-b pb-4">
            <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Journey</h4>
            <JourneyTimelineCard providerId={subjectInfo?.providerId || providerId} sessionId={sessionId} testId="parent-chat-journey" />
          </div>
        )}
        {/* Compact photo + availability status - only when the full card below
            is NOT shown (no booking yet), so the name isn't duplicated. */}
        {subjectInfo && !existingBooking && (
          <div className="flex items-center gap-3">
            <div className="relative w-12 h-12 shrink-0">
              <div className="w-12 h-12 rounded-full overflow-hidden bg-muted">
                {subjectInfo.profilePhotoUrl ? (
                  <img src={getPhotoSrc(subjectInfo.profilePhotoUrl) || undefined} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-primary-foreground text-sm font-bold" style={{ backgroundColor: brandColor }}>
                    {(subjectInfo.profileLabel || subjectInfo.subjectType || "D").charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <span
                className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background ${
                  statusStyle
                    ? statusStyle.dotClassName
                    : profileAvailable === false ? "bg-muted-foreground/50" : "bg-[hsl(var(--brand-success))]"
                }`}
                title={statusStyle?.description || (profileAvailable === false ? "No longer available" : "Available")}
              />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium font-ui truncate">{subjectInfo.profileLabel || subjectInfo.subjectType}</p>
              {statusStyle ? (
                <p className={`text-[10px] font-medium ${profileStatus === "AVAILABLE" ? "text-[hsl(var(--brand-success))]" : profileStatus === "PENDING" ? "text-[hsl(var(--brand-warning))]" : "text-muted-foreground"}`}>
                  {statusStyle.label}
                </p>
              ) : profileAvailable === false ? (
                <p className="t-helper">No longer available</p>
              ) : (
                <p className="text-[10px] text-[hsl(var(--brand-success))] font-medium">Available</p>
              )}
            </div>
          </div>
        )}

        {/* Full profile card - only after a call has been scheduled. Status dot
            + label live inside the card header (SubjectProfileBody). */}
        {subjectInfo && existingBooking && (
          <SubjectProfileCard
            subjectType={subjectInfo.subjectType}
            providerId={subjectInfo.providerId}
            subjectProfileId={subjectInfo.subjectProfileId}
            fallbackPhotoUrl={subjectInfo.profilePhotoUrl}
            fallbackLabel={subjectInfo.profileLabel}
            profileAvailable={profileAvailable}
            profileStatus={profileStatus}
            brandColor={brandColor}
            testId="parent-subject-profile-card"
          />
        )}

        {/* Provider section (agency + coordinator + calendar) - only after a call has been scheduled */}
        {(displayProviderName || sessionCalendarSlug?.slug) && (existingBooking || sessionCalendarSlug?.slug) && (
          <div className={subjectInfo && existingBooking ? "border-t pt-3" : ""}>
            <ProviderProfileCard
              providerId={subjectInfo?.providerId || providerId}
              providerName={displayProviderName}
              providerLogo={subjectInfo?.providerLogo || providerLogo}
              brandColor={brandColor}
              calendar={sessionCalendarSlug?.slug ? {
                slug: sessionCalendarSlug.slug,
                memberName: sessionCalendarSlug.memberName || subjectInfo?.memberName,
                existingBooking: existingBooking || undefined,
                consultationMeta: subjectInfo ? {
                  providerId: subjectInfo.providerId,
                  profileLabel: subjectInfo.profileLabel,
                  profilePhotoUrl: subjectInfo.profilePhotoUrl,
                  subjectProfileId: subjectInfo.subjectProfileId,
                  subjectType: subjectInfo.subjectType,
                } : undefined,
              } : null}
              testId="parent-sidebar-provider-card"
            />
          </div>
        )}

        {/* Cost sheet history (renders nothing when empty, including its own divider) */}
        {sessionId && (
          <CostSheetSidebarSection
            sessionId={sessionId}
            brandColor={brandColor}
            readOnly={true}
          />
        )}

        {/* Payment history for this conversation (renders nothing when empty,
            including its own divider) */}
        {sessionId && (
          <InvoiceHistorySidebarSection sessionId={sessionId} brandColor={brandColor} />
        )}
      </div>
    </div>
  );
}

export interface ParentSidePanelData {
  providerInChat: boolean;
  subjectInfo: ConsultationCardData | null;
  providerName: string | null;
  sessionCalendarSlug: { slug: string | null; memberName: string | null } | null;
  sessionBookings: any[] | null;
}

interface ConciergeChatProps {
  inlineSessionId?: string;
  inlineMatchmakerId?: string;
  isInline?: boolean;
  externalBookingSlug?: { slug: string; memberName: string } | null;
  onCloseExternalBooking?: () => void;
  talkToTeamRef?: React.MutableRefObject<{ trigger: () => void; escalated: boolean } | null>;
  onSidePanelChange?: (data: ParentSidePanelData | null) => void;
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null }) => void;
  onHumanRequestCancelled?: () => void;
}

export default function ConciergeChatPage({ inlineSessionId, inlineMatchmakerId, isInline, externalBookingSlug, onCloseExternalBooking, talkToTeamRef, onSidePanelChange, onBookingConfirmed, onHumanRequestCancelled }: ConciergeChatProps = {}) {
  // Deep-link (?msg=) capture MUST run before the ?session= URL locking
  // below rewrites the address bar and drops the query string.
  captureMessageTarget();
  const [searchParams] = useSearchParams();
  const matchmakerId = isInline ? (inlineMatchmakerId || null) : searchParams.get("matchmaker");
  const existingSessionId = isInline ? (inlineSessionId || null) : searchParams.get("session");
  // isEmbedded = fully embedded in an iframe (embedded=1 param); isInline = rendered inside ConversationsShell
  const isEmbedded = searchParams.get("embedded") === "1";
  const donorIdParam = searchParams.get("donorId");
  const donorTypeParam = searchParams.get("donorType");
  const donorProviderIdParam = searchParams.get("providerId");
  const donorPhotoParam = searchParams.get("photoUrl");
  const navigate = useNavigate();
  const routerLocation = useLocation();
  // Doctors open via the airplane carry their full card object in nav state, so
  // the optimistic greeting can render the doctor card (doctorCards path) before
  // the server resolves it for persistence.
  const doctorCardParam = (routerLocation.state as any)?.doctorCard || null;

  const { user } = useAuth();
  const { data: brand } = useBrandSettings();
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Deep-link support: ?msg=<id> / ?msg=quote:<quoteId> scrolls to the card
  useScrollToMessage(messages.length);
  const [input, setInput] = useState("");
  /** Contact-guard copy, set client-side before sending or from the server's 422. */
  const [contactNotice, setContactNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [multiSelectChoices, setMultiSelectChoices] = useState<Set<string>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(existingSessionId);
  // Live voice conversation mode (full-height inline takeover of the chat column)
  const [voiceMode, setVoiceMode] = useState(false);
  // Voice-first landing for a brand-new session: Eva speaks the greeting when tapped
  const [voiceHeroGreeting, setVoiceHeroGreeting] = useState<string | null>(null);
  const voiceSession = useSharedVoiceSession();
  const [showCuration, setShowCuration] = useState(false);
  const showCurationRef = useRef(false);
  const [pendingCurationMessage, setPendingCurationMessage] = useState<ChatMessage | null>(null);
  const curationAwaitingRef = useRef(false);
  // What the parent ACTUALLY typed/tapped to confirm the curation ("Yes",
  // "go ahead", ...). The turn we send the model is the literal "ready"
  // control signal, but that is not what she said - so the bubble we persist
  // has to be her words, not ours.
  const curationConfirmTextRef = useRef<string | null>(null);
  const [humanEscalated, setHumanEscalated] = useState(false);
  const [humanInChat, setHumanInChat] = useState(false);
  const [humanAgentPhotoUrl, setHumanAgentPhotoUrl] = useState<string | null>(null);
  const [bookingCard, setBookingCard] = useState<ConsultationCardData | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [greetingSet, setGreetingSet] = useState(false);
  const [providerInChat, setProviderInChat] = useState(false);
  const [providerChatName, setProviderChatName] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  // Session-level subject info returned directly from the API (used when no consultation card is in messages)
  const [sessionSubjectInfo, setSessionSubjectInfo] = useState<{ subjectProfileId: string; subjectType: string; profilePhotoUrl?: string | null; providerLogo?: string | null; providerId?: string } | null>(null);
  // Provider logo for provider-direct sessions (no donor/surrogate subject), where sessionSubjectInfo stays null
  const [sessionProviderLogo, setSessionProviderLogo] = useState<string | null>(null);
  // Provider org of this session - available even for chats without a
  // subject profile (e.g. legal firm chats), so the Journey sidebar can
  // always scope to the right provider.
  const [sessionProviderId, setSessionProviderId] = useState<string | null>(null);
  const [conciergeBookingSlug, setConciergeBookingSlug] = useState<{ slug: string; memberName: string } | null>(null);
  const parentFileInputRef = useRef<HTMLInputElement>(null);
  const parentPhotoInputRef = useRef<HTMLInputElement>(null);
  const parentCameraInputRef = useRef<HTMLInputElement>(null);
  const [parentUploading, setParentUploading] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<File[]>([]);
  const [parentPlusOpen, setParentPlusOpen] = useState(false);
  // Drag-and-drop file attach onto the whole chat column. dragDepthRef counts
  // enter/leave across nested children so the overlay doesn't flicker when the
  // cursor moves over message bubbles.
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragDepthRef = useRef(0);
  // Embedded Stripe payment panel - opened when the parent clicks "Pay Now
  // Securely" on an invoice card. Holds the paymentToken of the invoice
  // being paid; null = panel closed.
  const [inlinePaymentToken, setInlinePaymentToken] = useState<string | null>(null);
  // Ref so uploadAndSendFiles can access the current matchmaker ID without TDZ issues
  const effectiveMatchmakerIdRef = useRef<string | null>(null);

  // Typing animation refs
  const typingRawRef = useRef("");       // total raw chars received from stream
  const typingDisplayedRef = useRef(0); // how many raw chars have been revealed
  const typingStreamingIdRef = useRef<string | null>(null);
  const typingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingOnDoneRef = useRef<(() => void) | null>(null);
  // Early quick-reply detection: populated as soon as the complete [[QUICK_REPLY:...]] tag
  // appears in the stream buffer so buttons can show the moment the question text is done
  const earlyQuickReplyRef = useRef<{ tagPos: number; options: string[]; multiSelect: boolean } | null>(null);

  const { data: sessionBookings } = useQuery<any[]>({
    queryKey: ["/api/chat-session", sessionId, "bookings"],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${sessionId}/bookings`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!sessionId,
    refetchInterval: 10000,
  });

  const { data: sessionCalendarSlug } = useQuery<{ slug: string | null; memberName: string | null }>({
    queryKey: ["/api/chat-session", sessionId, "provider-calendar-slug"],
    queryFn: async () => {
      const res = await fetch(`/api/chat-session/${sessionId}/provider-calendar-slug`, { credentials: "include" });
      if (!res.ok) return { slug: null, memberName: null };
      return res.json();
    },
    enabled: !!sessionId,
    staleTime: 60000,
  });

  const myDisplayName = useMemo(() => {
    const u = user as any;
    if (!u?.name) return "";
    const parts = u.name.trim().split(/\s+/);
    return parts.length >= 2
      ? `${parts[0]} ${parts[parts.length - 1][0]}.`
      : parts[0] || "";
  }, [user]);
  const handleViewProfile = useCallback((card: MatchCard) => {
    if (!card.ownerProviderId) return;
    const slug = getProfileUrlSlug(card.type);
    const profileUrl = `/${slug}/${card.ownerProviderId}/${card.providerId}`;
    navigate(profileUrl, {
      state: {
        fromChat: true,
        matchReasons: card.reasons || [],
        chatPath: window.location.pathname + window.location.search,
      },
    });
  }, [navigate]);

  const handleConciergeMeeting = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/chat-session/${sessionId}/provider-calendar-slug`, { credentials: "include" });
      const data = await res.json();
      if (data.slug) {
        setConciergeBookingSlug({ slug: data.slug, memberName: data.memberName || "Provider" });
        setTimeout(() => {
          const container = messagesEndRef.current?.closest('[data-testid="concierge-messages"]');
          if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        }, 100);
      } else {
        alert("Online scheduling isn't set up for this chat yet - send a message and we'll arrange a time.");
      }
    } catch {
      alert("Failed to load calendar. Please try again.");
    }
  }, [sessionId]);

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

  const handleParentFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Snapshot to array BEFORE clearing value - Safari/Chrome invalidate FileList on value reset
    const fileArray = Array.from(files);
    e.target.value = "";
    setStagedFiles(prev => [...prev, ...fileArray]);
  }, []);

  const removeStagedFile = useCallback((index: number) => {
    setStagedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Only react to actual file drags (ignore dragging text, links, or cards
  // around inside the chat).
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types || []).includes("Files");

  const handleChatDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFile(true);
  }, []);

  const handleChatDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleChatDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDraggingFile(false);
    }
  }, []);

  const handleChatDrop = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    if (parentUploading) return;
    const dropped = Array.from(e.dataTransfer.files || []);
    if (dropped.length === 0) return;
    // Stage them in the same tray the "+" button feeds; the existing send flow
    // uploads via /api/chat-upload, which validates type/size server-side.
    setStagedFiles(prev => [...prev, ...dropped]);
  }, [parentUploading]);

  const uploadAndSendFiles = useCallback(async (filesToUpload: File[], messageText: string) => {
    if (filesToUpload.length === 0) return;
    setStagedFiles([]);
    setParentUploading(true);
    setSending(true);
    sendingRef.current = true;

    const now = new Date().toISOString();
    const tempId = `temp-${Date.now()}`;

    try {
      // Step 1: Upload all files
      const uploadedFiles: Array<{ originalName: string; url: string; mimeType: string; size: number }> = [];
      for (const file of filesToUpload) {
        const formData = new FormData();
        formData.append("file", file);
        const uploadRes = await fetch("/api/chat-upload", { method: "POST", credentials: "include", body: formData });
        if (!uploadRes.ok) {
          const errData = await uploadRes.json().catch(() => ({}));
          throw new Error(errData.message || `Upload failed (${uploadRes.status})`);
        }
        uploadedFiles.push(await uploadRes.json());
      }

      const firstFile = uploadedFiles[0];
      const extraFiles = uploadedFiles.slice(1);
      const fileNames = uploadedFiles.map(f => f.originalName).join(", ");
      const displayText = messageText.trim() || `Shared a file: ${firstFile.originalName}`;
      const aiText = messageText.trim()
        ? `${messageText.trim()} [Attached file: ${fileNames}]`
        : `I've shared a file with you: ${fileNames}. Please acknowledge it.`;

      // Step 2: Show optimistic message with file card immediately
      setMessages(prev => [...prev, {
        role: "user" as const,
        content: displayText,
        createdAt: now,
        id: tempId,
        uiCardType: "attachment" as const,
        uiCardData: firstFile,
      }]);

      // Step 3: Call AI with attachmentData - it saves ONE unified user message (text + attachment)
      const aiRes = await fetch("/api/ai-concierge/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        credentials: "include",
        body: JSON.stringify({
          message: aiText,
          sessionId,
          matchmakerId: effectiveMatchmakerIdRef.current,
          attachmentData: firstFile,
        }),
      });

      if (!aiRes.ok) {
        setMessages(prev => prev.filter(m => m.id !== tempId));
        const errData = await aiRes.json().catch(() => ({}));
        throw new Error(errData.error || `AI request failed (${aiRes.status})`);
      }

      // Parse SSE stream for file upload response
      const streamingUploadId = `streaming-upload-${Date.now()}`;
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, id: streamingUploadId } : m));

      let aiData: any = null;
      const aiReader = aiRes.body?.getReader();
      const aiDecoder = new TextDecoder();
      let aiBuf = "";
      if (aiReader) {
        setMessages(prev => [...prev, { role: "assistant" as const, content: "", id: `${streamingUploadId}-ai`, createdAt: new Date().toISOString() }]);
        while (true) {
          const { done, value } = await aiReader.read();
          if (done) break;
          aiBuf += aiDecoder.decode(value, { stream: true });
          const aiLines = aiBuf.split("\n");
          aiBuf = aiLines.pop() ?? "";
          for (const ln of aiLines) {
            if (!ln.startsWith("data: ")) continue;
            let ev: any;
            try { ev = JSON.parse(ln.slice(6).trim()); } catch { continue; }
            if (ev.type === "token") {
              const delta = ev.delta || "";
              if (delta) {
                if (!typingStreamingIdRef.current) startTypingAnimation(`${streamingUploadId}-ai`);
                typingRawRef.current += delta;
              }
            } else if (ev.type === "reset") {
              // Interceptor replaced the streamed draft - clear the buffer/bubble
              typingRawRef.current = "";
              typingDisplayedRef.current = 0;
              earlyQuickReplyRef.current = null;
              setMessages(prev => prev.map(m => m.id === `${streamingUploadId}-ai` ? { ...m, content: "", quickReplies: undefined, multiSelect: undefined } : m));
            } else if (ev.type === "done") {
              aiData = ev;
            }
          }
        }
      }

      // Step 4: Update session ID if new session was created
      if (aiData?.sessionId && aiData.sessionId !== sessionId) {
        setSessionId(aiData.sessionId);
        queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
      }

      // Remove optimistic upload message - real user message was saved by AI endpoint
      setMessages(prev => prev.filter(m => m.id !== streamingUploadId));

      // Finalize AI response bubble - defer until typing animation drains
      if (aiData?.message?.content) {
        const aiMsgId = aiData.message.id;
        // Register the message ID immediately so the polling loop doesn't add a duplicate
        // while the typing animation is still running (which defers finalizeUploadBubble)
        if (aiMsgId) {
          knownMessageIds.current.add(aiMsgId);
          markSessionRead(aiData.sessionId || sessionId);
        }
        const finalizeUploadBubble = () => {
          setMessages(prev => prev.map(m => {
            if (m.id !== `${streamingUploadId}-ai`) return m;
            if (aiMsgId && prev.some(x => x.id === aiMsgId && x.id !== m.id)) return null as any;
            return {
              ...m,
              content: aiData.message.content,
              createdAt: aiData.message.createdAt || now,
              id: aiMsgId,
              quickReplies: aiData.quickReplies,
              matchCards: aiData.matchCards,
              doctorCards: aiData.doctorCards,
              comparisonCards: aiData.comparisonCards ?? aiData.message?.uiCardData?.comparisonCards,
              meetingCards: aiData.meetingCards ?? aiData.message?.uiCardData?.meetingCards,
              senderType: aiData.message.senderType,
              senderName: aiData.message.senderName,
            };
          }).filter(Boolean));
        };
        if (typingIntervalRef.current) {
          typingOnDoneRef.current = finalizeUploadBubble;
        } else {
          finalizeUploadBubble();
        }
      }

      // Save additional files as separate attachment messages (fire-and-forget)
      const resolvedSessionId = aiData.sessionId || sessionId;
      if (resolvedSessionId && extraFiles.length > 0) {
        for (const extraFile of extraFiles) {
          fetch(`/api/chat-session/${resolvedSessionId}/message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              content: `Shared a file: ${extraFile.originalName}`,
              uiCardType: "attachment",
              uiCardData: extraFile,
            }),
          }).catch(() => {});
        }
      }
    } catch (e: any) {
      setMessages(prev => prev.filter(m => m.id !== tempId));
      alert(e.message || "Failed to upload file. Please try again.");
    } finally {
      setParentUploading(false);
      setSending(false);
      sendingRef.current = false;
    }
  }, [sessionId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const reconnectPendingRef = useRef(false); // true when connection dropped mid-request
  const sessionIdRef = useRef<string | null>(null); // stable ref for use in event listeners
  const lastSentRef = useRef<{ text: string; time: number } | null>(null);
  const pendingClientMsgIdRef = useRef<string | null>(null); // idempotency key for retry dedup
  const lastQrClickRef = useRef<number>(0); // timestamp of last QR button click
  const lastPollTimeRef = useRef<string | null>(null);
  const memberWelcomeAskedRef = useRef(false);
  const knownMessageIds = useRef<Set<string>>(new Set());
  const statusPollCounter = useRef(0);

  // Send a read receipt for a session the user is actively viewing and
  // optimistically clear its unreadCount so the sidebar + top-nav Chats badge
  // update instantly instead of waiting for the next sessions-list poll.
  // Must be called from EVERY path that appends an incoming message while the
  // chat is open - loader, poller, AND the send-response paths (send-response
  // messages never pass through the poller, so skipping them leaves the fresh
  // AI reply counted as unread even though it is on screen).
  const markSessionRead = (sid: string | null | undefined) => {
    if (!sid) return;
    queryClient.setQueryData<any[]>(["/api/my/chat-sessions"], (old) =>
      old?.map((s) => (s.id === sid ? { ...s, unreadCount: 0 } : s))
    );
    fetch(`/api/chat-sessions/${sid}/read`, { method: "POST", credentials: "include" })
      .then(() => queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] }))
      .catch(() => {});
  };

  const matchmakers: Matchmaker[] = brand?.matchmakers || [];
  const [resolvedMatchmakerId, setResolvedMatchmakerId] = useState<string | null>(null);
  const [resolvedMatchmakerName, setResolvedMatchmakerName] = useState<string | null>(null);
  const effectiveMatchmakerId = matchmakerId || resolvedMatchmakerId
    || (donorIdParam && matchmakers.find(m => m.isActive)?.id) || null;
  effectiveMatchmakerIdRef.current = effectiveMatchmakerId;
  const selectedMatchmaker = matchmakers.find((m) => m.id === effectiveMatchmakerId);
  const aiName = selectedMatchmaker?.name || resolvedMatchmakerName || null;

  // Browser tab / recent-tabs title: the conversation partner, then the brand.
  useEffect(() => {
    const who = providerInChat && providerChatName ? providerChatName : (aiName || "Chat");
    const prev = document.title;
    document.title = `${who} - ${brand?.companyName || "GoStork"}`;
    return () => { document.title = prev; };
  }, [aiName, providerInChat, providerChatName, brand?.companyName]);

  // Keep the composer focused: on landing (desktop only - a phone would pop
  // the keyboard over the first message) and again after each reply lands.
  const prevSendingRef = useRef(false);
  useEffect(() => {
    // Desktop only: on a phone this would raise the keyboard over the
    // quick-reply chips that answer most scripted questions.
    if (prevSendingRef.current && !sending && window.innerWidth >= 768) {
      requestAnimationFrame(() => chatInputRef.current?.focus());
    }
    prevSendingRef.current = sending;
  }, [sending]);
  useEffect(() => {
    if (!sessionLoaded || window.innerWidth < 768) return;
    const t = setTimeout(() => { if (document.activeElement === document.body) chatInputRef.current?.focus(); }, 400);
    return () => clearTimeout(t);
  }, [sessionLoaded]);

  // Keep sessionIdRef in sync so the online/offline handlers always see the current session
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Online/offline detection - mirrors Claude Code behavior:
  // when connection is lost mid-request, keep the loading indicator and refetch on reconnect
  useEffect(() => {
    const handleOnline = async () => {
      setIsOnline(true);
      if (reconnectPendingRef.current) {
        reconnectPendingRef.current = false;
        const sid = sessionIdRef.current;
        if (sid) {
          await loadMessagesForSession(sid);
        }
        setSending(false);
        sendingRef.current = false;
      }
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync resolvedMatchmakerName from brand settings when effectiveMatchmakerId resolves
  useEffect(() => {
    if (!effectiveMatchmakerId || resolvedMatchmakerName) return;
    const mm = matchmakers.find((m) => m.id === effectiveMatchmakerId);
    if (mm) setResolvedMatchmakerName(mm.name);
  }, [effectiveMatchmakerId, matchmakers]);

  // Lock in the avatar URL once resolved — never revert to null on re-renders.
  // useRef holds the last known good value so useMemo can return it synchronously
  // even during re-renders where selectedMatchmaker is briefly undefined.
  const _lockedAvatarUrl = useRef<string | null>(null);
  const resolvedAvatarUrl = useMemo(() => {
    let url: string | null = null;
    if (selectedMatchmaker?.avatarUrl) {
      url = getPhotoSrc(selectedMatchmaker.avatarUrl) || selectedMatchmaker.avatarUrl;
    } else if (effectiveMatchmakerId) {
      try {
        const raw = localStorage.getItem("gostork_brand_settings");
        if (raw) {
          const cached = JSON.parse(raw);
          const mm = (cached?.matchmakers || []).find((m: any) => m.id === effectiveMatchmakerId);
          if (mm?.avatarUrl) url = getPhotoSrc(mm.avatarUrl) || mm.avatarUrl;
        }
      } catch {}
    }
    if (url) _lockedAvatarUrl.current = url;
    return _lockedAvatarUrl.current;
  }, [selectedMatchmaker?.avatarUrl, effectiveMatchmakerId]);

  // The voice session lives at app level (VoiceSessionProvider) so navigating
  // away never kills a call - GlobalVoicePip floats over other pages instead.
  // Report whether the full panel is on screen, keep the PiP's display meta
  // current, and re-open the panel when the parent returns mid-call.
  useEffect(() => {
    voiceSession.setPanelActive(voiceMode);
    if (voiceMode) {
      voiceSession.setMeta({
        personaName: aiName,
        avatarUrl: resolvedAvatarUrl,
        returnTo: window.location.pathname + window.location.search,
      });
    }
    return () => voiceSession.setPanelActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode, aiName, resolvedAvatarUrl]);
  useEffect(() => {
    if (["connecting", "listening", "thinking", "speaking"].includes(voiceSession.state)) {
      setVoiceMode(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const brandColor = brand?.primaryColor || BRAND_PRIMARY_FALLBACK;

  // Voice mode: gated by the admin Voice settings toggle; Eva sessions only
  // (never a provider/human chat). The mic button opens the inline takeover.
  const voiceModeAvailable = !!(brand as any)?.voiceModeEnabled && !providerInChat;
  // Ref mirror for effects whose closures predate the async brand load.
  const voiceModeAvailableRef = useRef(false);
  voiceModeAvailableRef.current = voiceModeAvailable;
  const openVoiceMode = () => {
    setVoiceMode(true);
    // Runs inside the click gesture: AudioContext resume + mic permission.
    void voiceSession.start({
      sessionId,
      matchmakerId: effectiveMatchmakerId || null,
    });
  };
  const closeVoiceMode = useCallback(() => {
    voiceSession.stop();
    setVoiceMode(false);
    // The transcript was persisted server-side by the /chat pipeline - reload
    // so the written record appears in the thread.
    if (sessionId) void loadMessagesForSession(sessionId);
    queryClient.invalidateQueries({ queryKey: ["concierge-sessions"] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, voiceSession.stop]);
  // Server-initiated end (silence timeout, session cap): close the panel.
  // voice_not_configured stays OPEN in error state - the parent should see
  // why voice stopped instead of the panel silently vanishing.
  useEffect(() => {
    if (
      voiceMode &&
      voiceSession.state === "ended" &&
      voiceSession.endReason &&
      voiceSession.endReason !== "user_ended" &&
      voiceSession.endReason !== "voice_not_configured"
    ) {
      closeVoiceMode();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceSession.state, voiceSession.endReason, voiceMode]);

  const chatPalette = useMemo(() => deriveChatPalette(brandColor), [brandColor]);
  const qrStyle = brand?.quickReplyColorStyle ?? "primary";
  const qrColor = qrStyle === "accent" ? (brand?.accentColor ?? "#0DA4EA")
    : qrStyle === "secondary" ? (brand?.secondaryColor ?? "#F0FAF5")
    : brandColor;
  const qrIsOutline = qrStyle === "outline";
  const qrIsSecondary = qrStyle === "secondary";

  const decStyle = brand?.quickReplyDeclineStyle ?? "secondary";
  const decColor = decStyle === "accent" ? (brand?.accentColor ?? "#0DA4EA")
    : decStyle === "secondary" ? (brand?.secondaryColor ?? "#F0FAF5")
    : decStyle === "primary" ? brandColor
    : brandColor;
  const decIsOutline = decStyle === "outline";
  const decIsSecondary = decStyle === "secondary";

  const multiStyle = brand?.quickReplyMultiStyle ?? "outline";
  const multiColor = multiStyle === "accent" ? (brand?.accentColor ?? "#0DA4EA")
    : multiStyle === "secondary" ? (brand?.secondaryColor ?? "#F0FAF5")
    : brandColor;
  const multiIsOutline = multiStyle === "outline";
  const multiIsSecondary = multiStyle === "secondary";

  const qrShowBorder = brand?.quickReplyShowBorder ?? true;

  // Chip styles computed at component level - reused by quick reply chips AND ReadinessPromptCard
  const chipPositiveStyle: React.CSSProperties = qrIsOutline
    ? { backgroundColor: "transparent", color: qrColor, border: `1px solid ${qrColor}` }
    : qrIsSecondary
    ? { backgroundColor: qrColor, color: "hsl(var(--foreground))", border: qrShowBorder ? `1px solid ${brandColor}50` : "none" }
    : { backgroundColor: qrColor, color: "#ffffff", border: "none" };
  const chipDeclineStyle: React.CSSProperties = decIsOutline
    ? { backgroundColor: "transparent", color: decColor, border: `1px solid ${decColor}` }
    : decIsSecondary
    ? { backgroundColor: decColor, color: "hsl(var(--foreground))", border: qrShowBorder ? `1px solid ${brandColor}50` : "none" }
    : { backgroundColor: decColor, color: "#ffffff", border: "none" };

  const loadMessagesForSession = async (sid: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/ai-concierge/session/${sid}/messages`, { credentials: "include" });
      if (!res.ok) return false;
      const data = await res.json();
      const msgs = Array.isArray(data) ? data : (data.messages || []);
      setSessionTitle(data.sessionTitle || null);
      if (data.providerName) setProviderChatName(data.providerName);
      if (data.providerJoined) setProviderInChat(true);
      if (data.matchmakerId) setResolvedMatchmakerId(data.matchmakerId);
      if (data.matchmakerName) setResolvedMatchmakerName(data.matchmakerName);
      // Sync human escalation state: active only when humanRequested=true AND not yet concluded
      if (typeof data.humanRequested === "boolean") {
        setHumanEscalated(data.humanRequested && !data.humanConcludedAt);
        setHumanInChat(!!data.humanJoinedAt && !data.humanConcludedAt);
      }
      if (data.humanAgentPhotoUrl) setHumanAgentPhotoUrl(data.humanAgentPhotoUrl);
      if (data.providerLogo) setSessionProviderLogo(data.providerLogo);
      if (data.sessionProviderId) setSessionProviderId(data.sessionProviderId);
      if (data.subjectProfileId && data.subjectType) {
        setSessionSubjectInfo({
          subjectProfileId: data.subjectProfileId,
          subjectType: data.subjectType,
          profilePhotoUrl: data.profilePhotoUrl || null,
          providerLogo: data.providerLogo || null,
          providerId: data.sessionProviderId || undefined,
        });
      }
      if (msgs.length > 0) {
        const parsed: ChatMessage[] = msgs.map((m: any, idx: number) => {
          const extras = m.uiCardData || {};
          return {
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            senderType: m.senderType,
            senderName: m.senderName,
            matchCards: extras.matchCards,
            doctorCards: extras.doctorCards,
            comparisonCards: extras.comparisonCards,
            meetingCards: extras.meetingCards,
            prepDoc: extras.prepDoc,
            partnerInvite: extras.partnerInvite,
            whisper: extras.whisper,
            memberWelcome: extras.memberWelcome,
            consultationCard: extras.consultationCard,
            agreementCard: extras.agreementCard,
            // Restore quick replies for the last message so buttons reappear on navigation
            quickReplies: idx === msgs.length - 1 ? extras.quickReplies : undefined,
            uiCardType: m.uiCardType,
            uiCardData: m.uiCardData,
            deliveredAt: m.deliveredAt,
            readAt: m.readAt,
            createdAt: m.createdAt,
          };
        });
        setMessages(parsed);
        setGreetingSet(true);
        lastPollTimeRef.current = msgs[msgs.length - 1].createdAt;
        msgs.forEach((m: any) => { if (m.id) knownMessageIds.current.add(m.id); });
        if (msgs.some((m: any) => m.senderType === "provider")) setProviderInChat(true);
        markSessionRead(existingSessionId);
        // An invited member's first open: ask the concierge to greet THEM once
        // (server posts a deterministic welcome keyed by user id).
        const me: any = user;
        const isMemberSeat = !!me?.parentAccountRole && me.parentAccountRole !== "INTENDED_PARENT_1";
        if (isMemberSeat && !parsed.some((m) => m.memberWelcome?.userId === me.id) && !memberWelcomeAskedRef.current) {
          memberWelcomeAskedRef.current = true;
          fetch("/api/ai-concierge/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
            credentials: "include",
            body: JSON.stringify({ message: "member_first_open", sessionId: existingSessionId, matchmakerId: effectiveMatchmakerIdRef.current, isSystemTrigger: true }),
          }).then(async (r) => {
            if (!r.ok) return;
            const text = await r.text();
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const ev = JSON.parse(line.slice(6));
                if (ev.type === "done" && ev.message?.id && ev.message.content) {
                  knownMessageIds.current.add(ev.message.id);
                  setMessages((prev) => prev.some((m) => m.id === ev.message.id) ? prev : [...prev, {
                    role: "assistant" as const, id: ev.message.id, content: ev.message.content, senderType: ev.message.senderType, senderName: ev.message.senderName,
                    createdAt: ev.message.createdAt || new Date().toISOString(), memberWelcome: ev.memberWelcome,
                  }]);
                }
              } catch { /* ignore */ }
            }
          }).catch(() => {});
        }
      }
    } catch { return false; }
    return true;
  };

  useEffect(() => {
    if (sessionLoaded) return;

    if (existingSessionId) {
      (async () => {
        const found = await loadMessagesForSession(existingSessionId);
        if (!found) {
          // Session no longer exists (e.g. after "Delete All Chats") - clear the stale URL
          // param so existingSessionId becomes null and the greeting effect can fire.
          setSessionId(null);
          navigate(window.location.pathname, { replace: true });
        }
        setSessionLoaded(true);
      })();
      return;
    }

    (async () => {
      try {
        const sessRes = await fetch("/api/ai-concierge/my-session", { credentials: "include" });
        if (sessRes.ok) {
          const data = await sessRes.json();
          if (data.session) {
            setSessionId(data.session.id);
            if (matchmakerId && data.session.matchmakerId !== matchmakerId) {
              fetch("/api/my/chat-session/matchmaker", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ matchmakerId }),
              });
              setResolvedMatchmakerId(matchmakerId);
            } else if (data.session.matchmakerId) {
              setResolvedMatchmakerId(data.session.matchmakerId);
            }
            if (!donorIdParam && data.messages?.length > 0) {
              const msgs = data.messages;
              setSessionTitle(data.session.title || null);
              if (data.session.providerName) setProviderChatName(data.session.providerName);
              const parsed: ChatMessage[] = msgs.map((m: any, idx: number) => {
                const extras = m.uiCardData || {};
                return {
                  id: m.id,
                  role: m.role as "user" | "assistant",
                  content: m.content,
                  senderType: m.senderType,
                  senderName: m.senderName,
                  matchCards: extras.matchCards,
                  doctorCards: extras.doctorCards,
                  comparisonCards: extras.comparisonCards,
                  meetingCards: extras.meetingCards,
                  prepDoc: extras.prepDoc,
                  partnerInvite: extras.partnerInvite,
            whisper: extras.whisper,
            memberWelcome: extras.memberWelcome,
                  consultationCard: extras.consultationCard,
                  quickReplies: idx === msgs.length - 1 ? extras.quickReplies : undefined,
                  uiCardType: m.uiCardType,
                  uiCardData: m.uiCardData,
                  deliveredAt: m.deliveredAt,
                  readAt: m.readAt,
                  createdAt: m.createdAt,
                };
              });
              setMessages(parsed);
              setGreetingSet(true);
              lastPollTimeRef.current = msgs[msgs.length - 1].createdAt;
              msgs.forEach((m: any) => { if (m.id) knownMessageIds.current.add(m.id); });
              if (msgs.find((m: any) => m.senderType === "provider")) setProviderInChat(true);
            }
          }
        }
      } catch {}
      setSessionLoaded(true);
    })();
  }, [existingSessionId, matchmakerId, donorIdParam, sessionLoaded]);

  // Persist the resolved session ID into the URL so page refresh reloads the same session.
  // This runs in a separate effect that only fires after sessionLoaded=true, so the
  // session-loading effect above will bail immediately (sessionLoaded guard) on the
  // re-render caused by navigate, preventing double-loads or duplicate greetings.
  useEffect(() => {
    if (isInline || !sessionId || !sessionLoaded) return;
    if (searchParams.get("session") === sessionId) return;
    navigate(`?session=${sessionId}`, { replace: true });
  }, [sessionId, sessionLoaded, isInline]);

  // Initial scroll - use container scroll, not window scroll
  useEffect(() => {
    if (hasPendingMessageTarget()) return; // ?msg= deep link owns the scroll
    const container = document.querySelector('[data-testid="concierge-messages"]');
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  const parentProfileQuery = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!user,
    staleTime: 0,           // always treat cached data as stale
    refetchOnMount: true,   // always refetch on component mount
  });

  // Subject profile info for the right panel: prefer consultation card from messages, fall back to session-level data
  const subjectInfo = useMemo<ConsultationCardData | null>(() => {
    for (const msg of [...messages].reverse()) {
      if (msg.consultationCard?.subjectProfileId) return msg.consultationCard;
    }
    // Fall back to session-level subject data returned by the API
    if (sessionSubjectInfo?.subjectProfileId && sessionSubjectInfo?.providerId) {
      return {
        providerId: sessionSubjectInfo.providerId,
        providerName: providerChatName || "",
        providerLogo: sessionSubjectInfo.providerLogo || undefined,
        subjectProfileId: sessionSubjectInfo.subjectProfileId,
        subjectType: sessionSubjectInfo.subjectType,
        profilePhotoUrl: sessionSubjectInfo.profilePhotoUrl || undefined,
        profileLabel: sessionTitle?.split(" x ")?.[0]?.trim() || undefined,
      } as ConsultationCardData;
    }
    return null;
  }, [messages, sessionSubjectInfo, providerChatName, sessionTitle]);

  const initialScrollDone = useRef(false);
  // When true, the initial batch was a new session - scroll to top so greeting is visible first.
  const newSessionInitRef = useRef(false);
  // Track whether the user is near the bottom (within 120px). Only auto-scroll when they are.
  const userNearBottom = useRef(true);
  // Force-scroll during phase0 animation regardless of userNearBottom (phase0 starts at top so
  // the scroll event handler immediately sets userNearBottom=false before the first tick fires).
  const forceScrollRef = useRef(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const scrollToBottom = useRef((behavior?: "smooth") => {
    if (hasPendingMessageTarget()) return; // ?msg= deep link owns the scroll
    if (messagesEndRef.current) {
      const container = messagesEndRef.current.closest('[data-testid="concierge-messages"]') as HTMLElement | null;
      if (container) {
        if (behavior === "smooth") {
          container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
        } else {
          container.scrollTop = container.scrollHeight;
        }
      }
    }
  });
  const scrollToBottomIfNear = useRef((behavior?: "smooth") => {
    if (!userNearBottom.current) return;
    scrollToBottom.current(behavior);
  });

  // When inline, notify parent about side panel data so it can render the panel at the correct DOM level
  useEffect(() => {
    if (!isInline || !onSidePanelChange) return;
    onSidePanelChange({
      providerInChat,
      subjectInfo,
      providerName: providerChatName,
      sessionCalendarSlug: sessionCalendarSlug ?? null,
      sessionBookings: sessionBookings ?? null,
    });
  }, [isInline, providerInChat, subjectInfo, providerChatName, sessionCalendarSlug, sessionBookings]);

  // Cleanup side panel when unmounting
  useEffect(() => {
    if (!isInline || !onSidePanelChange) return;
    return () => { onSidePanelChange(null); };
  }, [isInline]);

  // When on the standalone /concierge route and no onBookingConfirmed callback is provided,
  // navigate to the full provider chat view when the booking is confirmed.
  // For the inline (ConversationsPage) case this is handled via the onBookingConfirmed prop.
  // We use the callback from InlineBookingCalendar's onSuccess for reliability (no polling).
  // This effect is kept as a fallback for sessions already in progress when the page loads.
  useEffect(() => {
    if (isInline || onBookingConfirmed) return;
    if (!sessionBookings?.length) return;

    // Bookings are ordered by createdAt desc - first is newest
    const newest = sessionBookings[0];
    if (!newest?.createdAt) return;
    const ageMs = Date.now() - new Date(newest.createdAt).getTime();
    if (ageMs > 15000) return; // only act on very recently created bookings (< 15s)

    const providerId = subjectInfo?.providerId;
    const subjectProfileId = subjectInfo?.subjectProfileId;
    if (providerId && subjectProfileId) {
      navigate(`/chat/${providerId}/${subjectProfileId}`, { replace: true });
    } else if (providerId) {
      navigate(`/chat`, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionBookings?.length, isInline]);

  // Track whether user is near the bottom so we know if auto-scroll should fire.
  // A user scrolling UP during the typing animation must also cancel forceScrollRef,
  // otherwise the 18ms typing tick keeps yanking them back to the bottom.
  useEffect(() => {
    const container = document.querySelector('[data-testid="concierge-messages"]') as HTMLElement | null;
    if (!container) return;
    let lastScrollTop = container.scrollTop;
    let touchActive = false;
    const cancelAutoFollow = () => {
      forceScrollRef.current = false;
      userNearBottom.current = false;
    };
    const onScroll = () => {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const scrolledUp = container.scrollTop < lastScrollTop - 1;
      lastScrollTop = container.scrollTop;
      // Every programmatic scroll here goes down, so an upward move is the user - except
      // when scrollHeight shrinks and the browser clamps scrollTop (distFromBottom stays ~0),
      // hence the distance threshold. An active touch drag is always the user.
      if (scrolledUp && (touchActive || distFromBottom > 30)) {
        cancelAutoFollow();
        return;
      }
      userNearBottom.current = distFromBottom < 120;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) cancelAutoFollow();
    };
    const onTouchStart = () => { touchActive = true; };
    const onTouchEnd = () => { touchActive = false; };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  // Synchronously scroll to bottom before the first paint to prevent the booking card
  // (or any early message) from flashing visible while the async useEffect fires.
  useLayoutEffect(() => {
    if (newSessionInitRef.current || initialScrollDone.current) return;
    if (!messages.length) return;
    scrollToBottom.current();
  }, [messages.length, sessionBookings?.length]);

  // Scroll to bottom on messages change
  useEffect(() => {
    if (!messages.length) return;
    // Skip scroll-on-tick during typing animation - the interval fires setMessages
    // every 18ms and stacking smooth scrolls causes overshoot when quick replies appear.
    // The animation's applyFinalMsg triggers one clean scroll when it's done.
    if (typingIntervalRef.current) return;
    if (!initialScrollDone.current) {
      if (newSessionInitRef.current) {
        // New session: scroll to TOP so the greeting (first message) is visible.
        // The parent reads top-down - they should not be thrown past it to message 2.
        const container = messagesEndRef.current?.closest('[data-testid="concierge-messages"]') as HTMLElement | null;
        if (container) container.scrollTop = 0;
        initialScrollDone.current = true;
        userNearBottom.current = false;
      } else {
        // Existing session: scroll to bottom to show the latest messages
        scrollToBottom.current();
        const t1 = setTimeout(() => scrollToBottom.current(), 150);
        const t2 = setTimeout(() => scrollToBottom.current(), 400);
        const t3 = setTimeout(() => scrollToBottom.current(), 800);
        const t4 = setTimeout(() => {
          scrollToBottom.current();
          initialScrollDone.current = true;
          userNearBottom.current = true;
        }, 1500);
        return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
      }
    } else {
      // New message arrived - only scroll if user is already near the bottom
      scrollToBottomIfNear.current("smooth");
      const t1 = setTimeout(() => scrollToBottomIfNear.current("smooth"), 150);
      const t2 = setTimeout(() => scrollToBottomIfNear.current("smooth"), 400);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [messages, sessionBookings?.length]);

  // When a NEW reply carries a match card, the card (not the end of the
  // blurb) is what the parent should see: measured before this, the card sat
  // 255px above the fold on desktop and fully off screen on a phone, so the
  // parent met an essay and two buttons before a face.
  const lastCardMsgKeyRef = useRef<string | null>(null);
  // The loop lives in a ref, not in the effect's cleanup: this effect re-runs
  // on every streamed token, and a cleanup-owned interval died after the
  // first one (measured: the card landed a third visible, never repositioned).
  const cardLandingIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (cardLandingIvRef.current) clearInterval(cardLandingIvRef.current); }, []);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    // A new card, or a long reply-chip question (the ten pass reasons): both
    // land with their top at the top of the log, so the question is read
    // before the choices and the face before the prose.
    const chipCount = (last.quickReplies?.length || (last as any).uiCardData?.quickReplies?.length || 0);
    if (!last.matchCards?.length && chipCount < 6) return;
    const key = last.id || last.createdAt || String(messages.length);
    if (lastCardMsgKeyRef.current === key) return;
    lastCardMsgKeyRef.current = key;
    // Reopening an existing thread keeps the usual "latest message" landing;
    // this positioning is for the moment a NEW card arrives in a live session.
    if (!initialScrollDone.current) return;
    // The card mounts a loading placeholder first and the real card when the
    // profile arrives; position on whatever is there now and again as it
    // grows, for a few seconds, so the face ends up in view.
    // The reply's character drain can run for 20s+ after the card mounts and
    // ends with its own scroll-to-bottom; keep positioning until 1.5s after
    // the drain has stopped (hard cap 45s).
    let attempts = 0;
    let quietTicks = 0;
    const position = () => {
      const container = document.querySelector('[data-testid="concierge-messages"]') as HTMLElement | null;
      if (!container) return;
      // Anchor on the LAST message: its card if it has one, else its chip
      // row. Anchoring on the last card in the whole thread positioned an
      // older card when the new message was a chip question.
      const wraps = container.querySelectorAll('[id^="msg-"]');
      const lastWrap = wraps.length ? (wraps[wraps.length - 1] as HTMLElement) : null;
      const anchor = (lastWrap?.querySelector('[data-testid^="match-card-"]') || lastWrap?.querySelector('[data-testid="quick-replies"]')) as HTMLElement | null;
      if (!lastWrap || !anchor) return;
      // The message wrapper, not the card itself: the sender label sits
      // above the card and was clipped under the sticky strip.
      const target = lastWrap;
      const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
      if (Math.abs(delta) > 2) container.scrollTop += delta;
      // The parent is reading the card; do not yank them back down while
      // images load or the blurb drains (the drain's 18ms tick scrolls to the
      // bottom while forceScrollRef is set). Scrolling near the bottom
      // re-arms auto-follow as usual.
      userNearBottom.current = false;
      forceScrollRef.current = false;
    };
    if (cardLandingIvRef.current) clearInterval(cardLandingIvRef.current);
    const iv = setInterval(() => {
      attempts += 1;
      position();
      if (!typingIntervalRef.current) quietTicks += 1; else quietTicks = 0;
      if (quietTicks >= 5 || attempts >= 150) {
        clearInterval(iv);
        if (cardLandingIvRef.current === iv) cardLandingIvRef.current = null;
      }
    }, 300);
    cardLandingIvRef.current = iv;
  }, [messages]);

  // Watch for layout shifts (image loads, card renders) and keep scrolled to bottom
  useEffect(() => {
    const container = document.querySelector('[data-testid="concierge-messages"]');
    if (!container || !messages.length) return;

    // Only scroll on DOM mutations if user is near the bottom
    const scrollDown = () => {
      if (userNearBottom.current) container.scrollTop = (container as HTMLElement).scrollHeight;
    };

    // MutationObserver catches DOM changes (new elements, attribute changes from image loads)
    const mutObs = new MutationObserver(scrollDown);
    mutObs.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style", "class"] });

    // Capture image load events bubbling up
    container.addEventListener("load", scrollDown, true);

    // Stop observing after 3 seconds to avoid interfering with user scroll
    const stopTimer = setTimeout(() => {
      mutObs.disconnect();
      container.removeEventListener("load", scrollDown, true);
    }, 3000);

    return () => {
      mutObs.disconnect();
      container.removeEventListener("load", scrollDown, true);
      clearTimeout(stopTimer);
    };
  }, [messages.length, sessionBookings?.length]);

  useEffect(() => {
    if (externalBookingSlug) {
      setTimeout(() => {
        const container = messagesEndRef.current?.closest('[data-testid="concierge-messages"]');
        if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      }, 100);
    }
  }, [externalBookingSlug]);

  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(async () => {
      if (sendingRef.current) return;
      try {
        const afterParam = lastPollTimeRef.current ? `?after=${encodeURIComponent(lastPollTimeRef.current)}` : "";
        const res = await fetch(`/api/ai-concierge/session/${sessionId}/messages${afterParam}`, { credentials: "include" });
        if (!res.ok) return;
        const rawData = await res.json();
        const newMsgs = Array.isArray(rawData) ? rawData : (rawData.messages || []);
        if (rawData.sessionTitle !== undefined) setSessionTitle(rawData.sessionTitle);
        if (rawData.providerName) setProviderChatName(rawData.providerName);
        if (rawData.matchmakerId) setResolvedMatchmakerId(rawData.matchmakerId);
        if (rawData.matchmakerName) setResolvedMatchmakerName(rawData.matchmakerName);
        const unseenMsgs = newMsgs.filter((m: any) => m.id && !knownMessageIds.current.has(m.id));
        if (unseenMsgs.length > 0) {
          unseenMsgs.forEach((m: any) => knownMessageIds.current.add(m.id));
          // A fetched USER message supersedes its optimistic (id-less) bubble -
          // without this, a send that got persisted server-side but errored
          // mid-stream (silent retry / reconnect) renders the same user
          // message twice: once optimistic, once from the poll.
          const incomingUserTexts = new Set(
            unseenMsgs.filter((m: any) => m.role === "user").map((m: any) => (m.content || "").trim()),
          );
          setMessages((prev) => [
            ...prev.filter((m) => !(m.role === "user" && !m.id && incomingUserTexts.has((m.content || "").trim()))),
            ...unseenMsgs.map((m: any) => {
              const extras = m.uiCardData || {};
              return {
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
                senderType: m.senderType as string | undefined,
                senderName: m.senderName || (m.senderType === "human" ? "GoStork Expert" : m.senderType === "provider" ? m.senderName : undefined),
                matchCards: extras.matchCards,
                doctorCards: extras.doctorCards,
                comparisonCards: extras.comparisonCards,
                meetingCards: extras.meetingCards,
                prepDoc: extras.prepDoc,
                partnerInvite: extras.partnerInvite,
            whisper: extras.whisper,
            memberWelcome: extras.memberWelcome,
                consultationCard: extras.consultationCard,
                agreementCard: extras.agreementCard,
                quickReplies: extras.quickReplies,
                multiSelect: extras.multiSelect,
                uiCardType: m.uiCardType,
                uiCardData: m.uiCardData,
                deliveredAt: m.deliveredAt,
                readAt: m.readAt,
                createdAt: m.createdAt,
              };
            }),
          ]);
          lastPollTimeRef.current = unseenMsgs[unseenMsgs.length - 1].createdAt;
          if (unseenMsgs.some((m: any) => m.senderType === "provider")) {
            setProviderInChat(true);
          }
          // Mark newly polled messages as read since user is actively viewing this chat.
          markSessionRead(sessionId);
        }

        // Periodically refresh delivery status AND uiCardData on existing
        // messages (every 3rd poll). The uiCardData refresh is what makes
        // cancel-and-ack flow on existing cost-sheet cards (or any uiCard
        // mutated server-side) without forcing the parent to hard refresh.
        statusPollCounter.current = (statusPollCounter.current || 0) + 1;
        if (statusPollCounter.current >= 3) {
          statusPollCounter.current = 0;
          const statusRes = await fetch(`/api/ai-concierge/session/${sessionId}/messages`, { credentials: "include" });
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.providerJoined && !providerInChat) {
              if (statusData.providerName) setProviderChatName(statusData.providerName);
              setProviderInChat(true);
            }
            // Sync human escalation state from server on every status poll
            if (typeof statusData.humanRequested === "boolean") {
              setHumanEscalated(statusData.humanRequested && !statusData.humanConcludedAt);
              setHumanInChat(!!statusData.humanJoinedAt && !statusData.humanConcludedAt);
            }
            if (statusData.humanAgentPhotoUrl) setHumanAgentPhotoUrl(statusData.humanAgentPhotoUrl);
            const allMsgs: any[] = Array.isArray(statusData) ? statusData : (statusData.messages || []);
            const serverByIdMap = new Map(allMsgs.map((m: any) => [m.id, m]));
            setMessages(prev => {
              let changed = false;
              const updated = prev.map(m => {
                if (!m.id) return m;
                const server: any = serverByIdMap.get(m.id);
                if (!server) return m;
                const next: any = m;
                const statusChanged =
                  server.deliveredAt !== m.deliveredAt || server.readAt !== m.readAt;
                // Detect uiCardData mutation by JSON-comparing - the
                // server side flips fields like cancelledAt /
                // parentAcknowledgedAt on the same message, and the
                // chat needs those changes to flow through to the card.
                const cardChanged = JSON.stringify(server.uiCardData || null) !== JSON.stringify(m.uiCardData || null);
                if (statusChanged || cardChanged) {
                  changed = true;
                  return {
                    ...next,
                    deliveredAt: server.deliveredAt,
                    readAt: server.readAt,
                    ...(cardChanged ? { uiCardData: server.uiCardData, uiCardType: server.uiCardType } : {}),
                  };
                }
                return m;
              });
              return changed ? updated : prev;
            });
          }
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [sessionId]);

  useEffect(() => {
    if (greetingSet || !selectedMatchmaker || !user) return;
    if (!donorIdParam && !sessionLoaded) return;
    if (!donorIdParam && (sessionId || existingSessionId)) return;
    setGreetingSet(true);

    // For donor deep-links: build greeting client-side immediately (no profile needed)
    if (donorIdParam) {
      const u = user as any;
      const firstName = greetingNameOf(u);
      const donorLabel = donorTypeParam === "surrogate" ? "Surrogate" : donorTypeParam === "sperm-donor" ? "Sperm Donor" : donorTypeParam === "clinic" ? "Clinic" : donorTypeParam === "agency" ? "Surrogacy Agency" : donorTypeParam === "doctor" ? "Doctor" : "Egg Donor";
      const greeting = `Hi ${firstName}! I see you're interested in learning more about a ${donorLabel} profile. I'd love to help you with any questions you have. Do you have a specific question about this ${donorLabel.toLowerCase()}?`;
      // Doctors render through the doctorCards path (keyed by slug); everything
      // else uses matchCards. For doctors we render the card carried in nav state.
      if (donorTypeParam === "doctor") {
        const greetingDoctorCards: DoctorCard[] = [doctorCardParam && doctorCardParam.slug ? doctorCardParam : ({ slug: donorIdParam, name: "Doctor" } as any)];
        setMessages([{ role: "assistant", content: greeting, createdAt: new Date().toISOString(), doctorCards: greetingDoctorCards }]);
      } else {
        const greetingMatchCards: MatchCard[] = [{
          name: donorLabel, type: donorLabel, providerId: donorIdParam,
          ownerProviderId: donorProviderIdParam || undefined,
          photo: donorPhotoParam || undefined, reasons: [],
        }];
        setMessages([{ role: "assistant", content: greeting, createdAt: new Date().toISOString(), matchCards: greetingMatchCards }]);
      }
      (async () => {
        try {
          const res = await fetch("/api/ai-concierge/init-session", {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
            body: JSON.stringify({ matchmakerId: effectiveMatchmakerId, greeting, donorId: donorIdParam, donorType: donorTypeParam, ownerProviderId: donorProviderIdParam || undefined }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.sessionId) setSessionId(data.sessionId);
            if (data.greetingMessageId) knownMessageIds.current.add(data.greetingMessageId);
          }
        } catch {}
      })();
      return;
    }

    // For normal chat: call init-session and let server build greeting + phase0 with correct services
    // Show a minimal placeholder while waiting so UI feels instant
    (async () => {
      try {
        const res = await fetch("/api/ai-concierge/init-session", {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
          body: JSON.stringify({ matchmakerId: effectiveMatchmakerId }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.sessionId) setSessionId(data.sessionId);
        if (data.greetingMessageId) knownMessageIds.current.add(data.greetingMessageId);
        if (data.phase0MessageId) knownMessageIds.current.add(data.phase0MessageId);

        // Voice-first default: on a brand-new session with voice mode enabled
        // (and no prior opt-out), offer the tap-to-start hero so Eva SPEAKS
        // the greeting. The greeting still types into the chat below either way.
        if (
          data.greeting &&
          voiceModeAvailableRef.current &&
          !localStorage.getItem("eva-voice-opt-out")
        ) {
          setVoiceHeroGreeting(data.greeting);
        }

        // Display server-built greeting and phase0 with typing animation
        if (data.greeting) {
          const greetingId = `greeting-${Date.now()}`;
          newSessionInitRef.current = true;
          setMessages([{ role: "assistant", content: "", id: greetingId, createdAt: new Date().toISOString() }]);

          typingRawRef.current = data.greeting; typingDisplayedRef.current = 0;
          typingOnDoneRef.current = () => {
            // Attach quick replies after greeting finishes typing
            if (data.greetingQuickReplies?.length) {
              setMessages(prev => prev.map(m => m.id === greetingId ? { ...m, quickReplies: data.greetingQuickReplies } : m));
            }
            // Animate phase0 message after greeting completes
            if (data.phase0Content) {
              const phase0Id = `phase0-${Date.now()}`;
              setMessages(prev => [...prev, { role: "assistant", content: "", id: phase0Id, createdAt: new Date().toISOString() }]);
              typingRawRef.current = data.phase0Content; typingDisplayedRef.current = 0;
              typingOnDoneRef.current = () => {};
              const p0ms = data.phase0Content.match(/\[\[MULTI_SELECT:(.*?)\]\]/);
              const p0qr = data.phase0Content.match(/\[\[QUICK_REPLY:(.*?)\]\]/);
              const p0tag = p0ms || p0qr;
              if (p0tag && p0tag.index !== undefined) {
                earlyQuickReplyRef.current = { tagPos: p0tag.index, options: p0tag[1].split("|").map((s: string) => s.trim()), multiSelect: !!p0ms };
              }
              // Greeting is done - re-enable auto-scroll so phase0 follows the text as it types
              userNearBottom.current = true;
              forceScrollRef.current = true;
              typingOnDoneRef.current = () => { forceScrollRef.current = false; };
              startTypingAnimation(phase0Id);
            }
          };
          startTypingAnimation(greetingId);
        } else if (data.phase0Content) {
          const phase0Id = `phase0-${Date.now()}`;
          newSessionInitRef.current = true;
          setMessages([{ role: "assistant", content: "", id: phase0Id, createdAt: new Date().toISOString() }]);
          typingRawRef.current = data.phase0Content; typingDisplayedRef.current = 0;
          typingOnDoneRef.current = () => { forceScrollRef.current = false; };
          const p0ms = data.phase0Content.match(/\[\[MULTI_SELECT:(.*?)\]\]/);
          const p0qr = data.phase0Content.match(/\[\[QUICK_REPLY:(.*?)\]\]/);
          const p0tag = p0ms || p0qr;
          if (p0tag && p0tag.index !== undefined) {
            earlyQuickReplyRef.current = { tagPos: p0tag.index, options: p0tag[1].split("|").map((s: string) => s.trim()), multiSelect: !!p0ms };
          }
          userNearBottom.current = true;
          forceScrollRef.current = true;
          startTypingAnimation(phase0Id);
        }
        // Phase 0 ends with an engagement question - wait for the parent to respond.
        // The AI will naturally deliver the vetting paragraph + Phase 1 question after their reply.
        if (data.sessionId) setSessionId(data.sessionId);
      } catch {}
    })();
  }, [selectedMatchmaker, user, greetingSet, sessionLoaded, sessionId, existingSessionId, donorIdParam, donorTypeParam]);

  const noMatchmakerYet = !effectiveMatchmakerId && !existingSessionId && !sessionId && sessionLoaded;

  // Retries are exhausted. Before telling a parent "something went wrong",
  // check whether anything actually did: the reply is usually already saved -
  // the stream broke on a phone's network, not the server - and printing a
  // dead-end error next to a reply that exists is its own bug. Refetch the
  // thread; only surface the error if the reply genuinely is not there.

  // Pulled out of the consultation card's JSX when the cards moved to the
  // shared renderer. Behaviour is unchanged - same matching rules, same
  // callback - it just has a name now and can be handed to the component.
  const existingBookingForMessage = (msg: any) => {
    const card = msg?.consultationCard ?? msg?.uiCardData?.consultationCard;
    if (!card) return undefined;
    if (!sessionBookings) return undefined;
    // Use ?? null to normalise both undefined and null to null before comparing,
    // because Prisma returns null for missing relations while JS optional chaining
    // returns undefined - strict === would make them unequal.
    const cardProviderId = card?.providerId ?? null;
    // Also match by providerUserId for admin calendar cards (no providerId).
    const cardProviderUserId = card?.providerUserId ?? null;
    // A fresh calendar card is asking the parent to book a NEW meeting -
    // don't shadow it with a past/completed meeting from the same provider
    // (e.g. an earlier Sperm Bank consult when the parent is now booking
    // with the egg donor's agency). Only attach future, non-cancelled bookings.
    const cardCreatedAt = msg.createdAt ? new Date(msg.createdAt).getTime() : 0;
    const nowMs = Date.now();
    // Same call type only: a Match Call booking must never
    // shadow the Consultation card (and vice versa) - they are
    // two separate meetings for the same provider.
    const cardSubtype = (card as any)?.meetingSubtype ?? null;
    const providerBookings = sessionBookings.filter(
      (b: any) => {
        const bookingProviderId = (b.providerUser?.provider?.id ?? null);
        const bookingProviderUserId = (b.providerUser?.id ?? b.providerUserId ?? null);
        const idMatch = bookingProviderId === cardProviderId;
        const userIdMatch = cardProviderUserId && bookingProviderUserId === cardProviderUserId;
        if (!(idMatch || userIdMatch)) return false;
        if ((b.meetingSubtype ?? null) !== cardSubtype) return false;
        if (b.status === "CANCELLED") return false;
        const scheduledMs = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
        const createdMs = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        // Future meeting OR a meeting created at/after this calendar card was shown.
        return scheduledMs > nowMs || createdMs >= cardCreatedAt;
      }
    );
    return providerBookings.sort((a: any, b: any) =>
      new Date(b.scheduledAt).getTime() - new Date(a.scheduledAt).getTime()
    )[0];
  };

  const handleConsultationCallbackSubmitted = () => {
    setTimeout(async () => {
      if (sessionId) {
        await loadMessagesForSession(sessionId);
        fetch("/api/ai-concierge/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
          credentials: "include",
          body: JSON.stringify({
            message: "consultation_callback_submitted",
            sessionId,
            matchmakerId: effectiveMatchmakerIdRef.current,
            isSystemTrigger: true,
          }),
        }).then(async (r) => {
          if (!r.ok || !r.body) return;
          const rd = r.body.getReader();
          const dc = new TextDecoder();
          let b = "";
          while (true) {
            const { done, value } = await rd.read();
            if (done) break;
            b += dc.decode(value, { stream: true });
            const ls = b.split("\n");
            b = ls.pop() ?? "";
            for (const l of ls) {
              if (!l.startsWith("data: ")) continue;
              let ev: any;
              try { ev = JSON.parse(l.slice(6).trim()); } catch { continue; }
              if (ev.type === "done" && sessionId) loadMessagesForSession(sessionId);
            }
          }
        }).catch(() => {});
      }
    }, 800);
  };

  const recoverOrShowSendError = async (sentAt: string) => {
    const sid = sessionIdRef.current || sessionId;
    let recovered = false;
    if (sid) {
      // Ask the server directly whether a reply landed after the turn we sent,
      // rather than trusting "the refetch did not throw" - that would swallow
      // the error even when the reply really is missing.
      try {
        const res = await fetch(`/api/ai-concierge/session/${sid}/messages`, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          const msgs = Array.isArray(data) ? data : (data.messages || []);
          recovered = msgs.some(
            (m: any) => m?.role === "assistant" && new Date(m?.createdAt || 0).getTime() >= new Date(sentAt).getTime(),
          );
        }
      } catch { recovered = false; }
      if (recovered) await loadMessagesForSession(sid).catch(() => false);
    }
    if (recovered) return;
    setMessages((prev) => [...prev, {
      role: "assistant" as const,
      content: "Something went wrong. Please try again.",
      createdAt: new Date().toISOString(),
    }]);
  };

  const sendMessage = async (text: string, retryCount = 0, clientMsgId?: string, fixedReply?: string) => {
    const hasFiles = stagedFiles.length > 0;
    if (!text.trim() && !hasFiles) return;
    // On auto-retry (retryCount > 0), bypass the sending guard - we're continuing an in-flight request
    if (retryCount === 0 && (sending || sendingRef.current || showCurationRef.current)) return;
    // "ready" must never appear as a visible user message - it's always sent silently by
    // the curation animation. If it arrives here through any path, redirect to silent send.
    if (/^ready$/i.test(text.trim())) {
      if (!sessionId) return;
      fetch("/api/ai-concierge/chat", {
        method: "POST", headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        credentials: "include",
        body: JSON.stringify({ message: "ready", sessionId, matchmakerId: effectiveMatchmakerId, isSystemTrigger: true }),
      }).catch(() => {});
      return;
    }
    // Contact guard. Runs before ANY of the state clearing below, so a blocked
    // message stays in the box for the parent to edit.
    //
    // Gated on providerInChat, matching the server's isSharedWithProvider: in
    // the parent's private thread Eva legitimately asks for their email and
    // phone during intake, and blocking that would break onboarding outright.
    // Retries skip it - the first pass already cleared the text.
    if (retryCount === 0 && providerInChat) {
      const scan = detectContactInfo(text.trim());
      if (scan.blocked) {
        setContactNotice(contactGuardMessage(scan.kinds));
        return;
      }
      setContactNotice(null);
    }
    // Deduplicate: block the same message if sent within 3 seconds (double-tap / fast-click protection)
    const sendNow = Date.now();
    if (retryCount === 0 && lastSentRef.current && lastSentRef.current.text === text.trim() && sendNow - lastSentRef.current.time < 3000) return;
    if (retryCount === 0) lastSentRef.current = { text: text.trim(), time: sendNow };
    // Generate an idempotency key on the first send; reuse it on retries so the server
    // can deduplicate and not create a second DB record if the stream failed mid-response.
    const msgId = retryCount === 0 ? crypto.randomUUID() : (clientMsgId || crypto.randomUUID());
    if (retryCount === 0) pendingClientMsgIdRef.current = msgId;
    // Stamped before the request so the recovery check below can ask "did a
    // reply land after this turn?" rather than guessing.
    const sentAtIso = new Date().toISOString();

    // User just sent a message - they want to follow the AI response.
    // forceScrollRef bypasses userNearBottom (which smooth-scroll intermediate events can reset).
    userNearBottom.current = true;
    forceScrollRef.current = true;

    // If curation is awaiting parent confirmation, show their message and start animation
    if (curationAwaitingRef.current) {
      const now = new Date().toISOString();
      setMessages((prev) => {
        const updated = prev.map((m, i) =>
          i === prev.length - 1 && m.quickReplies ? { ...m, quickReplies: undefined } : m
        );
        return [...updated, { role: "user" as const, content: text.trim(), createdAt: now }];
      });
      setInput("");
      curationAwaitingRef.current = false;
      curationConfirmTextRef.current = text.trim();
      // No takeover. The search happens in the thread: one working line in
      // the persona's voice, the typing row, then the real match card. The
      // old CurationOverlay was a fixed, blurred, six-second portal with
      // stock "Analyzing your goals..." copy - a modal at the climax.
      setMessages((prev) => [...prev, {
        role: "assistant" as const,
        id: WORKING_CURATION_ID,
        content: `${aiName || "Your concierge"} is going through the network now with everything you just shared.`,
        createdAt: new Date().toISOString(),
      }]);
      setTimeout(() => { void handleCurationComplete(); }, 300);
      return;
    }

    // Upload staged files + call AI (handles both file-only and file+text cases)
    if (hasFiles) {
      const filesToUpload = [...stagedFiles]; // capture before state clears
      setInput("");
      uploadAndSendFiles(filesToUpload, text); // fire-and-forget; manages its own state
      return;
    }

    if (!text.trim()) return;
    // On retry, sendingRef is already true (we kept it set to hold the loading indicator)
    if (retryCount === 0 && sendingRef.current) return; // block double-sends (e.g. double-tap on QR button)
    sendingRef.current = true;
    const userMessage = text.trim();
    const now = new Date().toISOString();

    // Only add the user message to state and update sidebar on the initial send.
    // On retry the message is already in state from the first attempt.
    if (retryCount === 0) {
      setInput("");
      setMessages((prev) => {
        const updated = prev.map((m, i) =>
          i === prev.length - 1 && m.quickReplies ? { ...m, quickReplies: undefined } : m
        );
        return [...updated, { role: "user" as const, content: userMessage, createdAt: now }];
      });
      if (sessionId) {
        queryClient.setQueryData<any[]>(["/api/my/chat-sessions"], (old) =>
          old?.map(s => s.id === sessionId ? { ...s, lastMessage: userMessage, lastMessageAt: now, lastMessageRole: "user", lastMessageSenderType: "parent", lastMessageDeliveredAt: null, lastMessageReadAt: null } : s)
        );
      }
      setSending(true);
    }

    // Unique key to track the streaming placeholder message
    const streamingId = `streaming-${Date.now()}`;
    let skipFinallyReset = false;

    try {
      const res = await fetch("/api/ai-concierge/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        credentials: "include",
        body: JSON.stringify({
          message: userMessage,
          sessionId,
          matchmakerId: effectiveMatchmakerId,
          clientMsgId: msgId,
          ...(fixedReply ? { fixedReply } : {}),
        }),
      });

      if (!res.ok) {
        // The contact guard's 422 is a decision, not a transient failure: it
        // must skip the retry ladder below (which would fire two more blocked
        // requests) and put the parent's text back so they can edit it.
        if (res.status === 422) {
          const body = await res.json().catch(() => ({} as any));
          if (body?.code === CONTACT_GUARD_CODE) {
            stopTypingAnimation(false);
            setMessages((prev) => prev.filter((m) => m.id !== streamingId && m.content !== userMessage));
            setContactNotice(body.message || contactGuardMessage(body.kinds || []));
            setInput(userMessage);
            setSending(false);
            sendingRef.current = false;
            return;
          }
        }
        throw new Error("Chat request failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (!reader) throw new Error("No response body");

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          let event: any;
          try { event = JSON.parse(jsonStr); } catch { continue; }

          if (event.type === "token") {
            const delta = event.delta || "";
            if (delta) {
              if (!typingStreamingIdRef.current) {
                setMessages(prev => {
                  if (prev.some(m => m.id === streamingId)) return prev;
                  return [...prev, { role: "assistant" as const, content: "", id: streamingId, createdAt: new Date().toISOString() }];
                });
                startTypingAnimation(streamingId);
              }
              typingRawRef.current += delta;
              // Detect [[QUICK_REPLY:...]] or [[MULTI_SELECT:...]] as soon as the complete tag
              // lands in the buffer - record position so the animation can show buttons immediately
              if (!earlyQuickReplyRef.current) {
                const msTagMatch = typingRawRef.current.match(/\[\[MULTI_SELECT:(.*?)\]\]/);
                const qrTagMatch = typingRawRef.current.match(/\[\[QUICK_REPLY:(.*?)\]\]/);
                const tagMatch = msTagMatch || qrTagMatch;
                if (tagMatch && tagMatch.index !== undefined) {
                  earlyQuickReplyRef.current = {
                    tagPos: tagMatch.index,
                    options: tagMatch[1].split("|").map(s => s.trim()),
                    multiSelect: !!msTagMatch,
                  };
                }
              }
            }
          } else if (event.type === "reset") {
            // Server discarded the streamed draft (an interceptor replaced the
            // content) - clear the streaming bubble immediately so the rejected
            // draft doesn't linger on screen until the final "done" replace.
            typingRawRef.current = "";
            typingDisplayedRef.current = 0;
            earlyQuickReplyRef.current = null;
            setMessages(prev => prev.map(m => m.id === streamingId ? { ...m, content: "", quickReplies: undefined, multiSelect: undefined } : m));
          } else if (event.type === "done") {
            const data = event;

            if (data.sessionId && data.sessionId !== sessionId) {
              setSessionId(data.sessionId);
              queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
            }
            // Eva opened a thread for a profile at an agency the family is
            // already connected to (no second consultation needed). It is a
            // DIFFERENT session, so the check above never fires for it - and
            // her reply has just told the parent the thread exists.
            if (data.openedSubjectSessionId) {
              queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
            }

            if (data.userMessageId) {
              knownMessageIds.current.add(data.userMessageId);
              setMessages((prev) =>
                prev.map((m) =>
                  m.role === "user" && m.content === userMessage && !m.id
                    ? { ...m, id: data.userMessageId, deliveredAt: data.userMessageDeliveredAt || null, readAt: data.userMessageReadAt || null }
                    : m
                )
              );
              if (data.userMessageDeliveredAt && sessionId) {
                queryClient.setQueryData<any[]>(["/api/my/chat-sessions"], (old) =>
                  old?.map((s) => s.id === sessionId ? { ...s, lastMessageDeliveredAt: data.userMessageDeliveredAt } : s)
                );
              }
            }

            if (data.humanNeeded) setHumanEscalated(true);
            if (data.humanRequestCancelled) handleHumanRequestCancelled();

            // The preliminary-ack card posted server-side DURING this turn
            // (holding the consultation calendar). It's a separate DB message
            // the poller won't fetch, so append it here. Built BEFORE the
            // skipAiResponse early-return: on a calendar hold the Eva bubble
            // is suppressed entirely and the card IS the whole response.
            const gateCardMsg: ChatMessage | null = data.gateCardMessage?.id
              ? {
                  role: "assistant",
                  content: data.gateCardMessage.content ?? "",
                  id: data.gateCardMessage.id,
                  senderType: data.gateCardMessage.senderType,
                  senderName: data.gateCardMessage.senderName,
                  uiCardType: data.gateCardMessage.uiCardType,
                  uiCardData: data.gateCardMessage.uiCardData,
                  createdAt: data.gateCardMessage.createdAt || new Date().toISOString(),
                }
              : null;
            if (gateCardMsg?.id) knownMessageIds.current.add(gateCardMsg.id);
            // A re-ask deletes the old open card server-side and creates a
            // fresh one at the bottom - drop any stale unacknowledged copy.
            const appendGateCard = (list: ChatMessage[]): ChatMessage[] => {
              if (!gateCardMsg) return list;
              const pruned = list.filter(
                (m) =>
                  m.id === gateCardMsg.id ||
                  m.uiCardType !== "consult_preliminary_ack" ||
                  !!m.uiCardData?.acknowledgedAt,
              );
              return pruned.some((m) => m.id === gateCardMsg.id) ? pruned : [...pruned, gateCardMsg];
            };

            if (data.skipAiResponse) {
              // Remove the streaming placeholder - and still land the ack
              // card when this turn's reply was suppressed in its favor.
              setMessages((prev) => appendGateCard(prev.filter((m) => m.id !== streamingId)));
              setSending(false);
              sendingRef.current = false;
              return;
            }

            // NOTE: Do NOT flip providerInChat / providerChatName here just because the AI
            // streamed a consultationCard. A consultationCard means "AI is OFFERING a calendar
            // to the parent" - not "the parent has booked / a provider has joined". Flipping
            // providerInChat here would (1) relabel the chat header from "AI Concierge" to
            // "via <provider>" (often the wrong agency, since one session can discuss many),
            // (2) reveal the right-side donor profile panel, and (3) switch the page from the
            // centered single-column AI layout to the 3-column provider-consultation layout.
            // All three are reserved for AFTER an actual booking - the polling/loader paths
            // (data.providerJoined, status === CONSULTATION_BOOKED|PROVIDER_CONNECTED, or a
            // real senderType==="provider" message) handle that transition correctly.

            const finalMsg: ChatMessage = {
              role: "assistant",
              content: data.message?.content ?? "",
              id: data.message?.id,
              quickReplies: data.quickReplies,
              multiSelect: data.multiSelect,
              matchCards: data.matchCards,
              doctorCards: data.doctorCards,
              comparisonCards: data.comparisonCards,
              meetingCards: data.meetingCards,
              prepDoc: data.prepDoc,
              partnerInvite: data.partnerInvite,
                whisper: data.whisper,
              consultationCard: data.consultationCard,
              agreementCard: data.agreementCard,
              senderType: data.message?.senderType,
              senderName: data.message?.senderName,
              deliveredAt: data.message?.deliveredAt,
              readAt: data.message?.readAt,
              createdAt: data.message?.createdAt || new Date().toISOString(),
            };

            // Apply the final message (with metadata like quickReplies, matchCards, etc.)
            // after the typing animation finishes draining - or immediately if no animation ran.
            //
            // Register the id BEFORE the animation defers applyFinalMsg, so
            // the 3s poller never appends a second copy of a reply whose
            // placeholder is still typing (registered late, the poller's full
            // copy rendered NEXT TO the half-typed bubble - observed live).
            // The lost-animation-callback race that late registration was
            // covering is handled by the timeout fallback at the call site
            // below instead: applyFinalMsg is guaranteed to run either way.
            if (data.message?.id) {
              knownMessageIds.current.add(data.message.id);
              // The reply arrives via this response, not the poller, so send
              // the read receipt here - the user is looking at it right now.
              markSessionRead(data.sessionId || sessionId);
            }
            const applyFinalMsg = () => {
              if (data.showCuration) {
                setMessages((prev) => {
                  // Clear quick reply buttons from ALL previous messages when curation fires.
                  // Stale Phase 0 buttons (e.g. "Yes, I'm looking into surrogacy") on earlier
                  // messages must be disabled so the parent can only confirm via the curation UI.
                  const cleared = prev
                    .filter((m) => !(finalMsg.id && m.id === finalMsg.id))
                    .map((m) =>
                      m.quickReplies || m.multiSelect ? { ...m, quickReplies: undefined, multiSelect: undefined } : m
                    );
                  const hasPlaceholder = cleared.some((m) => m.id === streamingId);
                  const next = hasPlaceholder
                    ? cleared.map((m) => m.id === streamingId ? finalMsg : m)
                    : [...cleared.filter((m) => m.id !== streamingId), finalMsg];
                  return appendGateCard(next);
                });
                setPendingCurationMessage(finalMsg);
                curationAwaitingRef.current = true;
              } else {
                setMessages((prev) => {
                  const deduped = prev.filter((m) => !(finalMsg.id && m.id === finalMsg.id));
                  const hasPlaceholder = deduped.some((m) => m.id === streamingId);
                  const next = hasPlaceholder
                    ? deduped.map((m) => m.id === streamingId ? finalMsg : m)
                    : [...deduped.filter((m) => m.id !== streamingId), finalMsg];
                  return appendGateCard(next);
                });
              }
            };
            if (typingIntervalRef.current) {
              // Animation still running - defer finalMsg until the queue
              // drains. The completion callback can be LOST (another path
              // overwrites the shared typingOnDoneRef slot), which used to
              // leave the half-typed bubble on screen with no quickReplies
              // forever - so a timeout fallback guarantees the apply runs.
              // Run-once guard: whichever fires second is a no-op.
              let applied = false;
              const applyOnce = () => {
                if (applied) return;
                applied = true;
                forceScrollRef.current = false;
                applyFinalMsg();
              };
              typingOnDoneRef.current = applyOnce;
              window.setTimeout(applyOnce, 6000);
            } else {
              forceScrollRef.current = false;
              applyFinalMsg();
            }
          } else if (event.type === "retry_needed" || event.type === "error") {
            // Server hit a transient error - silently retry rather than showing an error message
            stopTypingAnimation(false);
            setMessages((prev) => prev.filter((m) => m.id !== streamingId));
            if (retryCount < 2) {
              skipFinallyReset = true;
              const delay = 800 + retryCount * 600;
              setTimeout(() => {
                sendingRef.current = false;
                sendMessage(userMessage, retryCount + 1, msgId);
              }, delay);
            } else {
              void recoverOrShowSendError(sentAtIso);
            }
          }
        }
      }
    } catch {
      stopTypingAnimation(false);
      setMessages((prev) => prev.filter((m) => m.id !== streamingId));
      if (!navigator.onLine) {
        // Connection dropped - keep loading state, refetch messages when back online
        reconnectPendingRef.current = true;
        skipFinallyReset = true;
      } else if (retryCount < 2) {
        // Online but transient error - silently retry
        skipFinallyReset = true;
        const delay = 800 + retryCount * 600;
        setTimeout(() => {
          sendingRef.current = false;
          sendMessage(userMessage, retryCount + 1, msgId);
        }, delay);
      } else {
        void recoverOrShowSendError(sentAtIso);
      }
    } finally {
      if (!skipFinallyReset) {
        setSending(false);
        sendingRef.current = false;
      }
    }
  };

  // Strip [[TAG:...]] structured tags from display content during animation.
  // Complete tags are removed entirely; trailing incomplete tags are hidden until closed.
  const stripStreamingTags = (raw: string) =>
    raw.replace(/\[\[[\s\S]*?\]\]/g, "").replace(/\[\[[\s\S]*$/, "");

  const startTypingAnimation = (streamingId: string) => {
    typingStreamingIdRef.current = streamingId;
    if (typingIntervalRef.current) return;
    typingIntervalRef.current = setInterval(() => {
      const rawLen = typingRawRef.current.length;
      const displayed = typingDisplayedRef.current;
      if (displayed >= rawLen) {
        if (typingOnDoneRef.current) {
          const cb = typingOnDoneRef.current;
          typingOnDoneRef.current = null;
          earlyQuickReplyRef.current = null;
          clearInterval(typingIntervalRef.current!);
          typingIntervalRef.current = null;
          typingStreamingIdRef.current = null;
          // Reset buffers so next message starts clean
          typingRawRef.current = "";
          typingDisplayedRef.current = 0;
          cb();
        }
        return;
      }
      const remaining = rawLen - displayed;
      const drain = (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
        ? remaining // reduced motion: land the whole reply at once
        : Math.max(1, Math.ceil(remaining / 111));
      const newDisplayed = Math.min(displayed + drain, rawLen);
      typingDisplayedRef.current = newDisplayed;
      const displayContent = stripStreamingTags(typingRawRef.current.slice(0, newDisplayed));
      const sid = typingStreamingIdRef.current;
      if (sid) {
        // Apply early quick replies the moment the cursor passes the tag position
        const eqr = earlyQuickReplyRef.current;
        if (eqr && newDisplayed >= eqr.tagPos) {
          earlyQuickReplyRef.current = null;
          // Normalize sense-check options early (before server normalization arrives) so
          // verbose AI-generated labels like "Yes, I'm looking into surrogacy" on a
          // "Does that make sense so far?" message are collapsed to the correct buttons.
          const fullRawLc = typingRawRef.current.toLowerCase();
          const isSenseCheck = /does that make sense|make sense so far/.test(fullRawLc);
          const normalizedOptions = isSenseCheck
            ? eqr.options.map((opt: string) => {
                const o = opt.toLowerCase().trim();
                if (/^yes[,! ]|^yeah\b|^sure\b|^correct\b|^exactly\b|^that'?s right/i.test(o) || (/^yes,\s+/i.test(o) && opt.length > 15)) return "Yes, makes sense!";
                if (/^no[,! ]|^nope\b|^i have a question|^i have questions|^not quite|^not really/i.test(o)) return "I have a question";
                return opt;
              })
            : eqr.options;
          setMessages(prev => prev.map(m => m.id === sid ? { ...m, content: displayContent, quickReplies: normalizedOptions, multiSelect: eqr.multiSelect } : m));
        } else {
          setMessages(prev => prev.map(m => m.id === sid ? { ...m, content: displayContent } : m));
        }
      }
      // Scroll to keep up with new text appearing, but only instant (no smooth)
      // to avoid the stacked-smooth-scroll overshoot problem
      if (userNearBottom.current || forceScrollRef.current) {
        const container = messagesEndRef.current?.closest('[data-testid="concierge-messages"]') as HTMLElement | null;
        if (container) container.scrollTop = container.scrollHeight;
      }
    }, 18);
  };

  const stopTypingAnimation = (flush: boolean) => {
    typingOnDoneRef.current = null;
    earlyQuickReplyRef.current = null;
    forceScrollRef.current = false;
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }
    if (flush) {
      const sid = typingStreamingIdRef.current;
      if (sid && typingRawRef.current) {
        const displayContent = stripStreamingTags(typingRawRef.current);
        setMessages(prev => prev.map(m => m.id === sid ? { ...m, content: displayContent } : m));
      }
    }
    typingRawRef.current = "";
    typingDisplayedRef.current = 0;
    typingStreamingIdRef.current = null;
  };

  const handleSend = () => sendMessage(input.trim() || input);

  // Expands a short quick-reply option into a self-contained sentence so the
  // AI chat history always has meaningful context instead of bare "Yes"/"No".
  const expandQuickReply = (option: string, aiMessage: string): string => {
    const q = aiMessage.toLowerCase();
    const o = option.toLowerCase().trim();

    // Curation confirmation buttons - never expand, always send exactly as shown.
    // These confirm the parent is ready to see matches; they must not be rewritten
    // as service mentions ("Yes, I'm looking into surrogacy") just because the
    // curation summary happens to mention surrogacy/clinic/etc.
    if (/^(yes,? find my matches?!?|yes,? let'?s go!?|ready to see|show me matches?|find my matches?|yes, find|i'm ready to see)/i.test(option.trim())) {
      return option;
    }

    // Sense-check question (Phase 0 "Does that make sense so far?"): collapse verbose
    // AI-generated options to simple confirmations so the wrong intent is never sent.
    if (/does that make sense|make sense so far/i.test(q)) {
      if (/^(yes|yeah|sure|correct|exactly|that'?s right)\b/i.test(o) || (/^yes,\s+/i.test(o) && option.length > 15)) return "Yes, makes sense!";
      if (/^(no\b|nope\b|i have a question|i have questions|not quite|not really)/i.test(o)) return "I have a question";
    }

    // Solo or partner identity question
    if (/solo.*partner|partner.*solo|journey solo|on your own.*with a partner/i.test(q)) {
      if (/^solo$/i.test(o)) return "I'm going on this journey solo";
      if (/^with a partner$/i.test(o)) return "I'm going on this journey with a partner";
    }
    // Gender question
    if (/are you a woman or a man|woman or.*man|man or.*woman/i.test(q)) {
      if (/^a woman$/i.test(o) || o === "i'm the woman") return "I am a woman";
      if (/^a man$/i.test(o) || o === "i'm the man") return "I am a man";
    }
    // Service type selection
    if (/what are you looking for|help with today/i.test(q)) {
      if (/^surrogacy$/i.test(o)) return "I'm looking for surrogacy help";
      if (/^egg donation$/i.test(o)) return "I'm looking for egg donation help";
      if (/^sperm donation$/i.test(o)) return "I'm looking for sperm donation help";
      if (/^ivf clinics?$/i.test(o)) return "I'm looking for an IVF clinic";
    }

    // Embryo count (number cards)
    if (/how many embryos/i.test(q)) {
      if (o === "1") return "I have 1 frozen embryo";
      if (/^\d+$/.test(o)) return `I have ${o} frozen embryos`;
      if (o === "6-10") return "I have between 6 and 10 frozen embryos";
      if (/above 10/i.test(o)) return "I have more than 10 frozen embryos";
    }
    // PGT-A tested
    if (/pgt-?a/i.test(q)) {
      if (o === "yes") return "Yes, my embryos have been PGT-A tested";
      if (o === "no") return "No, my embryos haven't been PGT-A tested";
      if (/not sure/i.test(o)) return "I'm not sure if my embryos have been PGT-A tested";
    }
    // Frozen embryos (Step 1) - only when directly asking about embryos, not when
    // "frozen embryos" appears in a curation summary that mentions them in passing.
    if (/do you (?:already )?have (?:any )?frozen embryos|frozen embryos\?$/i.test(q)) {
      if (/^yes/i.test(o)) return "Yes, I already have frozen embryos";
      if (/^no/i.test(o)) return "No, I don't have frozen embryos yet";
      if (/working/i.test(o)) return "I'm working on creating embryos";
    }
    // LGBTQ
    if (/lgbtq/i.test(q)) {
      if (o === "yes") return "Yes, I am LGBTQ+";
      if (o === "no") return "No, I'm not LGBTQ+";
    }
    // Sperm source options
    if (/sperm/i.test(q)) {
      const past = /did you use|used/i.test(q);
      if (/^my own$/i.test(o)) return past ? "I used my own sperm" : "I'll be using my own sperm";
      if (/^my partner'?s$/i.test(o)) return past ? "We used my partner's sperm" : "We'll be using my partner's sperm";
      if (/^donor sperm$/i.test(o)) return past ? "I used donor sperm" : "I'll be using donor sperm";
    }
    // Egg source options
    if (/egg/i.test(q) && !/egg donor/i.test(q)) {
      const past = /were the eggs|did you use/i.test(q);
      if (/^my own eggs$/i.test(o)) return past ? "The eggs were my own" : "I'll be using my own eggs";
      if (/^my partner'?s eggs$/i.test(o)) return past ? "We used my partner's eggs" : "We'll be using my partner's eggs";
      if (/^donor eggs$/i.test(o)) return past ? "We used donor eggs" : "We'll be using donor eggs";
    }
    // Carrier options
    if (/carr(y|ying|ier)|pregnancy/i.test(q)) {
      if (/^me$/i.test(o)) return "I will carry the pregnancy myself";
      if (/^my partner'?s?$/i.test(o)) return "My partner will carry the pregnancy";
      if (/surrogate/i.test(o)) return "A gestational surrogate will carry the pregnancy";
    }
    // "I need help finding one" / "I already have one" - add subject from question
    if (/egg donor/i.test(q)) {
      if (/need help/i.test(o)) return "I need help finding an egg donor";
      if (/already have/i.test(o)) return "I already have an egg donor";
    }
    if (/sperm donor/i.test(q)) {
      if (/need help/i.test(o)) return "I need help finding a sperm donor";
      if (/already have/i.test(o)) return "I already have a sperm donor";
    }
    if (/surrogate/i.test(q)) {
      if (/need help/i.test(o)) return "I need help finding a surrogate";
      if (/already have/i.test(o)) return "I already have a surrogate";
    }
    if (/clinic/i.test(q)) {
      if (/need help/i.test(o)) return "I need help finding a fertility clinic";
      if (/already have/i.test(o)) return "I already have a fertility clinic";
    }

    // General affirmative/negative to a service-confirmation question
    // e.g. AI: "I see you're looking into surrogacy - is that correct?" → "Yes, that's right"
    const isAffirmative = /^(yes|yeah|yep|that'?s right|correct|exactly|right|sure)\b/i.test(o);
    const isNegative = /^(no|nope|not exactly|not quite|not really)\b/i.test(o);
    // Only rewrite GENERIC confirmations ("Yes, that's right", "Not exactly").
    // A button that already carries its own meaning ("Yes, connect me with a
    // lawyer") must be sent verbatim - matching service words in the AI's
    // question would turn a lawyer acceptance into "Yes, I'm looking into
    // surrogacy" and derail the flow.
    const genericWord = /^(yes|yeah|yep|no|nope|not|sure|ok|okay|correct|exactly|right|really|quite|absolutely|definitely|that'?s|it'?s|i'?m|i|we|do|does|don'?t|did|is|it|am|are|yet|now|please|thanks|thank|you)$/i;
    const isGenericConfirmation = o.split(/[^a-z']+/i).filter(Boolean).every(w => genericWord.test(w));
    if ((isAffirmative || isNegative) && isGenericConfirmation) {
      // A decline must never put a STRONGER claim in the parent's mouth. The
      // old expansion "No, I'm not specifically looking for a clinic" contained
      // the word "clinic", which the server's service-mention scan then read as
      // wanting one (observed live: two dads routed into the clinic cycle). A
      // decline now carries no service word at all and simply opens the
      // correction path.
      if (isNegative) return "Not exactly - let me tell you what I'm looking for";
      if (/surrogacy|surrogate/i.test(q)) return "Yes, I'm looking into surrogacy";
      if (/egg donation|egg donor/i.test(q)) return "Yes, I'm looking into egg donation";
      if (/sperm donation|sperm donor/i.test(q)) return "Yes, I'm looking into sperm donation";
      if (/ivf clinic|fertility clinic/i.test(q)) return "Yes, I'm looking for a fertility clinic";
    }

    // Already descriptive (e.g. "My own eggs", "Donor sperm", "A gestational surrogate")
    return option;
  };

  const handleReadinessYes = (text: string) => {
    const now = Date.now();
    if (now - lastQrClickRef.current < 1500) return;
    lastQrClickRef.current = now;
    sendMessage(text, 0, undefined, "Ready to move forward - invoice coming shortly.");
  };

  const handleQuickReply = (text: string, aiMessage = "") => {
    // Debounce: block any QR click within 1.5 seconds of the previous one.
    // expandQuickReply can return different text for the same option if the message
    // animation is still running (partial vs full aiMessage), so we can't rely on
    // string dedup alone - we need to block at the click level.
    const now = Date.now();
    if (now - lastQrClickRef.current < 1500) return;
    lastQrClickRef.current = now;
    sendMessage(expandQuickReply(text, aiMessage));
  };

  // The server cancelled a pending human request this turn - put the header
  // button back to "available" here and in the conversations list.
  const handleHumanRequestCancelled = () => {
    setHumanEscalated(false);
    queryClient.setQueryData<any[]>(["/api/my/chat-sessions"], (old) =>
      old?.map((s) => s.id === sessionId ? { ...s, humanRequested: false } : s)
    );
    onHumanRequestCancelled?.();
  };

  const handleTalkToTeam = () => {
    sendMessage("I'd like to talk to a real person on the GoStork team");
  };

  useEffect(() => {
    if (talkToTeamRef) {
      talkToTeamRef.current = { trigger: handleTalkToTeam, escalated: humanEscalated };
      // Clear on unmount so a stale trigger can never send into a session
      // that is no longer displayed (the next mount re-sets it).
      return () => { talkToTeamRef.current = null; };
    }
  }, [talkToTeamRef, humanEscalated]);

  // Immediately re-enable button when GoStork human exits
  useEffect(() => {
    const handler = () => { setHumanEscalated(false); setHumanInChat(false); };
    window.addEventListener("human-concluded", handler);
    return () => window.removeEventListener("human-concluded", handler);
  }, []);

  useEffect(() => {
    return () => { if (typingIntervalRef.current) clearInterval(typingIntervalRef.current); };
  }, []);

  const handleCurationComplete = useCallback(async () => {
    showCurationRef.current = false;
    setShowCuration(false);
    if (!pendingCurationMessage) return;
    setPendingCurationMessage(null);

    // Send "ready" silently (not visible in chat) to trigger match search
    setSending(true);
    sendingRef.current = true;
    const curationStreamId = `streaming-curation-${Date.now()}`;
    try {
      const res = await fetch("/api/ai-concierge/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        credentials: "include",
        body: JSON.stringify({
          message: "ready",
          sessionId,
          matchmakerId: effectiveMatchmakerId,
          // "ready" is a control signal, not something the parent said - the
          // server must not save it as her chat bubble. It saves what she
          // actually said instead, so the transcript stays truthful and her
          // confirmation survives a reload.
          isSystemTrigger: true,
          curationConfirmText: curationConfirmTextRef.current || undefined,
        }),
      });
      if (!res.ok) throw new Error("Chat request failed");

      // Add streaming placeholder (and retire the working line)
      setMessages((prev) => [...prev.filter((m) => m.id !== WORKING_CURATION_ID), { role: "assistant" as const, content: "", id: curationStreamId, createdAt: new Date().toISOString() }]);

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let ev: any;
            try { ev = JSON.parse(line.slice(6).trim()); } catch { continue; }
            if (ev.type === "token") {
              setMessages((prev) => prev.map((m) => m.id === curationStreamId ? { ...m, content: m.content + ev.delta } : m));
            } else if (ev.type === "done") {
              const data = ev;
              if (data.sessionId && data.sessionId !== sessionId) {
                setSessionId(data.sessionId);
                queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
              }
              // See the note in the other done handler: a subject thread opened
              // by the already-connected shortcut is a different session id.
              if (data.openedSubjectSessionId) {
                queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
              }
              if (data.skipAiResponse) {
                setMessages((prev) => prev.filter((m) => m.id !== curationStreamId));
                return;
              }
              if (data.humanNeeded) setHumanEscalated(true);
              if (data.humanRequestCancelled) handleHumanRequestCancelled();
              if (data.message?.id) {
                knownMessageIds.current.add(data.message.id);
                markSessionRead(data.sessionId || sessionId);
              }
              const newMessage: ChatMessage = {
                role: "assistant",
                content: data.message?.content ?? "",
                id: data.message?.id,
                quickReplies: data.quickReplies,
                multiSelect: data.multiSelect,
                matchCards: data.matchCards,
                doctorCards: data.doctorCards,
                comparisonCards: data.comparisonCards,
                meetingCards: data.meetingCards,
                prepDoc: data.prepDoc,
                partnerInvite: data.partnerInvite,
                whisper: data.whisper,
                consultationCard: data.consultationCard,
                agreementCard: data.agreementCard,
                senderType: data.message?.senderType,
                senderName: data.message?.senderName,
                deliveredAt: data.message?.deliveredAt,
                readAt: data.message?.readAt,
                createdAt: data.message?.createdAt || new Date().toISOString(),
              };
              setMessages((prev) => prev.map((m) => m.id === curationStreamId ? newMessage : m));
            }
          }
        }
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== curationStreamId && m.id !== WORKING_CURATION_ID));
      setMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: "I'm sorry, I'm having trouble connecting right now. Please try again.", createdAt: new Date().toISOString() },
      ]);
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }, [pendingCurationMessage, sessionId, effectiveMatchmakerId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Paste-to-attach: pasting a screenshot/image (Cmd+V) stages it like a drop.
  // Plain text paste falls through to the textarea's default behavior.
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter(it => it.kind === "file")
      .map(it => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    if (parentUploading) return;
    setStagedFiles(prev => [...prev, ...files]);
  }, [parentUploading]);

  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  // Prefill the chat composer with a seed string and focus it. Used by the
  // cost-sheet card's "I have questions" button so the parent can edit/extend
  // the seed before sending. We do NOT auto-send - the parent chooses when.
  const handlePrefillCostSheetQuestion = (text: string) => {
    setInput(text);
    requestAnimationFrame(() => {
      const el = chatInputRef.current;
      if (!el) return;
      el.focus();
      // Place caret at the end so the parent can keep typing.
      const len = el.value.length;
      try { el.setSelectionRange(len, len); } catch { /* ignore */ }
    });
  };

  if (noMatchmakerYet) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center" data-testid="concierge-no-matchmaker">
        <Sparkles className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="font-display text-xl font-semibold mb-2">No Matchmaker Selected</h2>
        <p className="t-helper mb-4">
          Please choose an AI guide to start your concierge experience.
        </p>
        <Button onClick={() => navigate("/matchmaker-selection")} data-testid="btn-go-select-matchmaker">
          Choose a Concierge
        </Button>
      </div>
    );
  }

  return (
    <>

      <div
        className={`flex ${isInline ? "flex-1 min-h-0 min-w-0" : "h-dvh"} overflow-hidden${!isEmbedded && !isInline && !(providerInChat && (sessionBookings?.length ?? 0) > 0) ? " max-w-3xl mx-auto" : ""}`}
        data-testid="concierge-chat-page"
      >
        <div
          className="flex flex-col flex-1 min-w-0 overflow-hidden relative"
          onDragEnter={handleChatDragEnter}
          onDragOver={handleChatDragOver}
          onDragLeave={handleChatDragLeave}
          onDrop={handleChatDrop}
        >
        {voiceHeroGreeting && !voiceMode && (
          <VoiceStartHero
            avatarUrl={resolvedAvatarUrl}
            personaName={aiName}
            brandColor={brandColor}
            onStart={() => {
              const greeting = voiceHeroGreeting;
              setVoiceHeroGreeting(null);
              setVoiceMode(true);
              void voiceSession.start({
                sessionId,
                matchmakerId: effectiveMatchmakerId || null,
                greetingText: greeting,
              });
            }}
            onContinueInText={() => {
              localStorage.setItem("eva-voice-opt-out", "1");
              setVoiceHeroGreeting(null);
            }}
          />
        )}
        {voiceMode && (
          <VoiceModePanel
            state={voiceSession.state}
            avatarUrl={resolvedAvatarUrl}
            personaName={aiName}
            brandColor={brandColor}
            avatar={voiceSession.avatar}
            partialTranscript={voiceSession.partialTranscript}
            caption={voiceSession.caption}
            cards={voiceSession.cards}
            cardsPreview={voiceSession.cardsPreview}
            chipsReady={voiceSession.chipsReady}
            micMuted={voiceSession.micMuted}
            error={voiceSession.error}
            onToggleMute={() => voiceSession.setMicMuted(!voiceSession.micMuted)}
            onQuickReply={(text) => voiceSession.sendText(text, true)}
            onClose={closeVoiceMode}
            renderCards={(c, opts) => (
              <>
                {(c.matchCards || []).map((card: any, ci: number) => (
                  <MatchCardComponent
                    key={`vm-${ci}`}
                    card={card}
                    brandColor={brandColor}
                    fill={opts?.fill}
                    onAction={(text) => voiceSession.sendText(text)}
                    onViewProfile={handleViewProfile}
                  />
                ))}
                {(c.doctorCards || []).map((card: any, ci: number) => (
                  <DoctorMatchCard
                    key={`vd-${ci}`}
                    card={card}
                    brandColor={brandColor}
                    onAction={(text) => voiceSession.sendText(text)}
                  />
                ))}
                {/* The booking calendar Eva "pulls up" mid-call - without this
                    the takeover opened as a blank screen for consultation
                    cards. Booking persists server-side; the transcript reloads
                    when the call ends. */}
                {c.consultationCard && (
                  <div className="w-full">
                    <ConsultationBookingCard
                      card={c.consultationCard}
                      brandColor={brandColor}
                      userEmail={(user as any)?.email || ""}
                      userName={(user as any)?.name || ""}
                      onSchedule={() => {}}
                      onBookingConfirmed={() => {
                        if (sessionId) void loadMessagesForSession(sessionId);
                      }}
                    />
                  </div>
                )}
                {/* Comparison tables Eva presents mid-call - the takeover
                    trigger list included comparisonCards but nothing rendered
                    them, so "compare the last two donors" opened a BLANK
                    takeover (same drift as the consultationCard bug above).
                    ComparisonCard is w-full with its own horizontal scroll,
                    so it fills whatever width the takeover grants. */}
                {(c.comparisonCards || []).map((card: any, ci: number) => (
                  <div key={`vc-${ci}`} className="w-full">
                    <ComparisonCard card={card} brandColor={brandColor} />
                  </div>
                ))}
                {/* Meeting/booking cards ("when is my call?") - meetingCards
                    was in the takeover trigger list but nothing rendered it,
                    so asking about an existing meeting opened a BLANK screen.
                    Same shared card as the chat transcript. */}
                {(c.meetingCards || []).map((booking: any) => (
                  <MeetingBookingCard key={`vmb-${booking.id}`} booking={booking} brandColor={brandColor} />
                ))}
                {/* Match-call prep guide - rendered in chat, dropped in voice. */}
                {c.prepDoc && (
                  <div className="w-full">
                    <PrepDocCard brandColor={brandColor} />
                  </div>
                )}
              </>
            )}
          />
        )}
        {isDraggingFile && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
            style={{ backgroundColor: `${brandColor}14`, backdropFilter: "blur(2px)" }}
            data-testid="concierge-drop-overlay"
          >
            <div
              className="flex flex-col items-center gap-3 rounded-[var(--radius)] border-2 border-dashed bg-background/90 px-10 py-8 shadow-lg"
              style={{ borderColor: brandColor }}
            >
              <UploadCloud className="w-9 h-9" style={{ color: brandColor }} />
              <div className="text-sm font-medium font-ui" style={{ color: brandColor }}>
                Drop files to attach
              </div>
            </div>
          </div>
        )}
        {!isEmbedded && !isInline && (
          <ChatThreadHeader
            brandColor={brandColor}
            testId="concierge-chat-header"
            onBack={() => navigate("/chat")}
            identity={{
              name: providerInChat && providerChatName ? providerChatName : (aiName || "AI Concierge"),
              subtitle: providerInChat && sessionTitle ? sessionTitle : (selectedMatchmaker?.title || "AI Concierge"),
              avatarUrl: !providerInChat ? resolvedAvatarUrl : null,
              avatarFit: "cover",
            }}
            subject={
              providerInChat && (sessionBookings?.length ?? 0) > 0 && subjectInfo
                ? {
                    title: subjectInfo.profileLabel || providerChatName || "",
                    photoUrl: subjectInfo.profilePhotoUrl || null,
                    viaName: providerChatName || "",
                    viaLogo: subjectInfo.providerLogo || null,
                  }
                : null
            }
            team={
              !providerInChat && sessionLoaded
                ? (humanInChat
                    ? { state: "talking" }
                    : { state: humanEscalated ? "notified" : "available", onClick: handleTalkToTeam, disabled: sending })
                : null
            }
          />
        )}

        {/* "So far": what Eva has saved about the family, folded to one line.
            Eva's own session only - provider threads never show it. */}
        {!providerInChat && sessionLoaded && !inlinePaymentToken && (
          <WhatIKnowStrip
            conciergeName={selectedMatchmaker?.name || aiName || null}
            lastExchange={(() => {
              // The strip shows a fact the moment Eva hears it (pending) until
              // the profile poll confirms the save, so the parent sees listening
              // happen instead of finding out when the question comes back.
              const lastUser = [...messages].reverse().find((m) => m.role === "user");
              const lastAiBefore = lastUser
                ? [...messages].reverse().find((m) => m.role === "assistant" && m.createdAt && lastUser.createdAt && new Date(m.createdAt) < new Date(lastUser.createdAt))
                : null;
              return lastUser && lastAiBefore ? { question: lastAiBefore.content || "", answer: lastUser.content || "" } : null;
            })()}
          />
        )}

        {/* Hide the messages list entirely while the payment panel is
            open. The parent doesn't need to see chat history mid-
            payment, and reclaiming this full pane lets the panel take
            every pixel between the chat header and the bottom of the
            viewport - so even the fully-expanded Link form + Card form
            + Pay button fit on screen without scroll. */}
        <div
          className={`flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 ${inlinePaymentToken ? "hidden" : ""}`}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Conversation"
          data-testid="concierge-messages"
        >
          {(() => {
            const shouldInlineBooking = !externalBookingSlug && !conciergeBookingSlug && sessionBookings && sessionBookings.length > 0;
            // Skip standalone booking cards only when a ConsultationBookingCard
            // already shows the SAME provider + SAME call type inline - a
            // Consultation and a Match Call are separate meetings and each
            // needs its own widget.
            const consultationCardKeys = new Set(
              messages
                .filter(m => m.consultationCard?.providerId || m.consultationCard?.providerUserId)
                .map(m => `${m.consultationCard!.providerId || m.consultationCard!.providerUserId}:${(m.consultationCard as any)?.meetingSubtype ?? ""}`)
            );
            const activeBookings: any[] = shouldInlineBooking
              ? sessionBookings!.filter((b: any) => {
                  const pid = b.providerUser?.provider?.id;
                  const puid = b.providerUserId ?? b.providerUser?.id;
                  const subtype = b.meetingSubtype ?? "";
                  if (consultationCardKeys.has(`${pid}:${subtype}`) || consultationCardKeys.has(`${puid}:${subtype}`)) return false;
                  if (b.status === "CANCELLED") return false;
                  // Confirmed bookings already have a dedicated provider session with the full
                  // booking UI. Only show the card in the AI concierge timeline while PENDING
                  // so the parent can track a booking awaiting confirmation. In provider-specific
                  // sessions (providerInChat set) always show regardless of status.
                  return b.status === "PENDING" || !!providerInChat;
                })
              : [];
            type TimelineItem = { type: "message"; msg: ChatMessage; ts: string } | { type: "booking"; booking: any; ts: string };
            // Filter out empty assistant streaming placeholders that haven't received tokens yet
            const msgItems: TimelineItem[] = messages
              .filter((m) => !(m.role === "assistant" && !m.content && !m.uiCardData && !m.uiCardType && !m.consultationCard))
              .map((m) => ({ type: "message" as const, msg: m, ts: m.createdAt || "" }));
            const bookingItems: TimelineItem[] = activeBookings.map((b: any) => ({
              type: "booking" as const,
              booking: b,
              ts: b.createdAt || b.scheduledAt || "",
            }));
            const timeline = [...msgItems, ...bookingItems].sort(
              (a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime()
            );
            return timeline.map((item, idx) => {
              if (item.type === "booking") {
                return (
                  <div key={`booking-${item.booking.id}`} className="flex items-start gap-2 px-1 pb-2" data-testid="parent-standalone-booking-card">
                    <div className="w-8 h-8 rounded-full shrink-0 overflow-hidden mt-0.5">
                      {resolvedAvatarUrl ? (
                        <img src={resolvedAvatarUrl} alt={aiName || "AI"} className="w-full h-full object-cover" />
                      ) : (
                        <div
                          className="w-full h-full flex items-center justify-center text-primary-foreground text-xs font-semibold"
                          style={{ backgroundColor: brandColor }}
                        >
                          {aiName?.charAt(0) || "A"}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        className="w-full overflow-hidden border border-border bg-card"
                        style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 420px)" }}
                      >
                        <div className="p-1.5" style={{ backgroundColor: brandColor }}>
                          <div className="flex items-center gap-2 px-3 py-1.5">
                            <CalendarCheck className="w-4 h-4 text-primary-foreground" />
                            <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
                              {`${item.booking.meetingSubtype === "MATCH_CALL" ? "Match Call" : item.booking.meetingSubtype === "DOCTOR_CONSULTATION" ? "Doctor Call" : "Consultation Call"} with ${item.booking.providerUser?.provider?.name || item.booking.providerUser?.name || "Provider"}`}
                            </span>
                          </div>
                        </div>
                        <div className="px-4 pb-4">
                          <InlineBookingCalendar
                            slug={sessionCalendarSlug?.slug || "__none__"}
                            memberName={sessionCalendarSlug?.memberName || item.booking.providerUser?.name || "Provider"}
                            brandColor={brandColor}
                            existingBooking={item.booking}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              const msg = item.msg;
              const i = messages.indexOf(msg);
              // Compute identity/alignment here so every child element shares the same avatar row.
              const isOwnMessage = msg.role === "user" && (!msg.senderName || msg.senderName === myDisplayName);
              const isOtherParent = msg.role === "user" && msg.senderName && msg.senderName !== myDisplayName;
              const msgNameLabel = isOwnMessage
                ? (myDisplayName || "You")
                : isOtherParent
                ? (msg.senderName || "Partner")
                : msg.role === "user"
                ? (msg.senderName || myDisplayName || "You")
                : msg.senderType === "human"
                ? (msg.senderName || "GoStork Expert")
                : msg.senderType === "provider"
                ? (msg.senderName || "Agency Expert")
                : msg.senderType === "system"
                ? (msg.senderName === "GoStork" ? "GoStork" : aiName || "AI")
                : (aiName || "AI");
              const alignRight = isOwnMessage || (!isOtherParent && msg.role === "user");
              // Consecutive turns from the same left-side sender within five
              // minutes share one avatar and name label; twelve identical
              // "Adam" headers in one screen cost ~40px each on a phone.
              const prevForGroup = i > 0 ? messages[i - 1] : null;
              const continuesGroup = !alignRight && !!prevForGroup
                && prevForGroup.role === msg.role
                && (prevForGroup.senderType || null) === (msg.senderType || null)
                && (prevForGroup.senderName || null) === (msg.senderName || null)
                && !!prevForGroup.createdAt && !!msg.createdAt
                && new Date(prevForGroup.createdAt).toDateString() === new Date(msg.createdAt).toDateString()
                && Math.abs(new Date(msg.createdAt).getTime() - new Date(prevForGroup.createdAt).getTime()) < 5 * 60 * 1000;
              const cardReplacesbubble = ["readiness_prompt", "invoice"].includes(msg.uiCardType ?? "");
              // For attachment messages, strip auto-generated placeholder text so only the file card shows
              const isAttachmentMsg = msg.uiCardType === "attachment";
              const rawDisplay = isAttachmentMsg
                ? (msg.content || "")
                    .replace(/\s*\[Attached file:[^\]]*\]/gi, "")
                    .replace(/^(Shared a file:|I've shared a file with you:)[^\n]*/i, "")
                    .trim()
                : (msg.content || "");
              // The card renders ABOVE the bubble, so a caption line that points
              // down at where the tag used to be ("Here is her profile:") and the
              // blank lines the stripped tag left behind read as a hole. Measured
              // live: three empty lines inside a 1187px bubble.
              const displayContent = (msg.matchCards?.length || msg.doctorCards?.length)
                ? rawDisplay
                    .split("\n")
                    .filter((l) => !/^\s*here (?:is|are) (?:her|his|their|the|a)? ?(?:full )?profiles?\s*[:.!]?\s*$/i.test(l))
                    .join("\n")
                    .replace(/\n{3,}/g, "\n\n")
                    .trim()
                : rawDisplay;
              const hasQuickReplies = !!(msg.quickReplies?.length || (msg as any).uiCardData?.quickReplies?.length);
              const showBubble = !isAttachmentMsg || displayContent.length > 0 || hasQuickReplies;
              // A person card's turn: the reply chips render right under the
              // card, before the prose, and the prose bubble may run as wide
              // as the card. Measured before: a 258px bubble of 21px type put
              // the four chips 123-279px below a phone's fold.
              const hasPersonCardMsg = !alignRight && !!(msg.matchCards || []).some((c: any) => /(surrogate|egg donor|sperm donor|donor)/i.test(String(c?.type || "")) && !/agency|program|bank|clinic/i.test(String(c?.type || "")));
              // The other parent's words must never sit under the concierge's
              // face: a monogram from their name, on the secondary tint.
              const msgAvatarUrl = !alignRight
                ? (isOtherParent
                    ? null
                    : msg.senderType === "provider"
                    ? (getPhotoSrc(sessionSubjectInfo?.providerLogo || sessionProviderLogo) || null)
                    : msg.senderType === "human"
                    ? (getPhotoSrc(humanAgentPhotoUrl) || null)
                    : resolvedAvatarUrl)
                : null;
              const msgAvatarInitial = !alignRight
                ? (isOtherParent
                    ? (msg.senderName?.trim().charAt(0).toUpperCase() || "P")
                    : msg.senderType === "provider"
                    ? "P"
                    : msg.senderType === "human"
                    ? (msg.senderName?.charAt(0) || "G")
                    : (aiName?.charAt(0) || "A"))
                : null;
              const msgAvatarIsPerson = !alignRight && isOtherParent;
              // Key by stable message id (NOT index) so React mounts new
              // messages cleanly. With index keys, polling-appended messages
              // can inherit the React state of a sibling at the same index -
              // most visibly the cost-sheet card's Acknowledge / I have
              // questions buttons could appear stuck or inert until a hard
              // refresh. Index is only the fallback for unsaved local stubs.
              // Reply chips: inside the bubble normally; on a person-card turn,
              // directly under the card (see hasPersonCardMsg).
              const renderQuickReplies = () => {
                if (i !== messages.length - 1) return null;
                        // msg.quickReplies is a transient copy set by the SSE done
                        // handler - a typing-animation race can drop it. The persisted
                        // uiCardData.quickReplies (refreshed by the 3s poll) is the
                        // durable source of truth, so fall back to it.
                        const qrOptions: string[] = (msg.quickReplies && msg.quickReplies.length > 0)
                          ? msg.quickReplies
                          : (((msg as any).uiCardData?.quickReplies as string[] | undefined) || []);
                        // A person card's two card actions live here now, as
                        // replies, next to "I have questions" and "Schedule":
                        // the red X and green heart were marketplace verbs on
                        // a card the concierge had just recommended.
                        const isPersonCard = (c: any) => /(surrogate|egg donor|sperm donor|donor)/i.test(String(c?.type || "")) && !/agency|program|bank|clinic/i.test(String(c?.type || ""));
                        const latestPersonCard = [...messages].reverse().flatMap((m) => m.matchCards || []).find(isPersonCard) || null;
                        // The card's own turn, or a follow-up turn whose chips are about it.
                        const cardForChips = (msg.matchCards || []).find(isPersonCard)
                          || (latestPersonCard && qrOptions.some((q) => /save as favorite|not the right fit|schedule a free consultation|questions about (her|him)/i.test(q)) ? latestPersonCard : null);
                        // No "Save as favorite" right after the parent saved.
                        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
                        const justSaved = !!lastUserMsg && /as a favorite|save as favorite/i.test(String(lastUserMsg.content || ""));
                        const saveChip = cardForChips && !justSaved ? "Save as favorite" : null;
                        const allOptions = saveChip && !qrOptions.some((q) => /save as favorite/i.test(q)) ? [...qrOptions, saveChip] : qrOptions;
                        if (allOptions.length === 0) return null;
                        const isMulti = msg.multiSelect ?? !!(msg as any).uiCardData?.multiSelect;
                        const isBinary = qrOptions.length === 2 && !isMulti;
                        // Filled-vs-muted only means something for a real yes/no
                        // pair. "First time" vs "I've done IVF before" was drawn
                        // as a right answer and a wrong one purely by position.
                        const isYesNo = isBinary && isAffirmativeReply(qrOptions[0]) && /^(no\b|not\b|never\b|skip\b|later\b|maybe later|i(?:'| a)m not|don'?t|do not|no,)/i.test(qrOptions[1].trim());
                        return (
                          <div className="flex flex-wrap gap-2 mt-3" data-testid="quick-replies">
                            {allOptions.map((qr, qi) => {
                              const isSelected = isMulti && multiSelectChoices.has(qr);
                              const multiUnselectedStyle: React.CSSProperties = multiIsOutline
                                ? { backgroundColor: "transparent", color: multiColor, border: `1px solid ${multiColor}` }
                                : multiIsSecondary
                                ? { backgroundColor: multiColor, color: "hsl(var(--foreground))", border: qrShowBorder ? `1px solid ${brandColor}50` : "none" }
                                : { backgroundColor: multiColor, color: "#ffffff", border: "none" };
                              const multiSelectedStyle: React.CSSProperties = {
                                backgroundColor: qrColor,
                                color: qrIsSecondary ? "hsl(var(--foreground))" : "#ffffff",
                                border: "none",
                              };
                              // The one chip that moves the family forward is
                              // the only filled one in a post-card row.
                              const isScheduleChip = !!cardForChips && !isMulti && /schedule/i.test(qr);
                              const chipStyle = isYesNo
                                ? qi === 0
                                  ? chipPositiveStyle
                                  : chipDeclineStyle
                                : isScheduleChip
                                ? chipPositiveStyle
                                : isSelected
                                ? multiSelectedStyle
                                : multiUnselectedStyle;
                              return (
                                <Button
                                  key={qi}
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  // 44px touch target on phones (the chips are the
                                  // primary intake control); desktop keeps the
                                  // brand's compact height.
                                  className="transition-all hover-elevate font-medium min-h-11 md:min-h-8 qr-chip"
                                  style={{
                                    borderRadius: "var(--quick-reply-radius, 999px)",
                                    paddingLeft: "var(--quick-reply-px, 14px)",
                                    paddingRight: "var(--quick-reply-px, 14px)",
                                    paddingTop: "var(--quick-reply-py, 6px)",
                                    paddingBottom: "var(--quick-reply-py, 6px)",
                                    touchAction: "manipulation",
                                    height: "auto",
                                    ...chipStyle,
                                  }}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (isMulti) {
                                      setMultiSelectChoices((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(qr)) next.delete(qr); else next.add(qr);
                                        return next;
                                      });
                                    } else if (cardForChips && /save as favorite/i.test(qr)) {
                                      // The parent's bubble reads what they tapped; the
                                      // server resolves the person from the latest card.
                                      persistChatFavorite("donor", cardForChips.providerId);
                                      handleQuickReply("Save as favorite", msg.content ?? "");
                                    } else {
                                      handleQuickReply(qr, msg.content ?? "");
                                    }
                                  }}
                                  disabled={sending}
                                  data-testid={`quick-reply-${qi}`}

                                >
                                  {isYesNo && qi === 0 && <ThumbsUp className="shrink-0" style={{ width: "13px", height: "13px", marginRight: "5px" }} />}
                                  {isSelected && <Check className="shrink-0" style={{ width: "11px", height: "11px", marginRight: "4px" }} />}
                                  {qr}
                                </Button>
                              );
                            })}
                            {isMulti && multiSelectChoices.size > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="font-semibold hover:opacity-90"
                                style={{ borderRadius: "var(--quick-reply-radius, 999px)", backgroundColor: brandColor, color: "white", border: "none", height: "auto", paddingLeft: "var(--quick-reply-px, 14px)", paddingRight: "var(--quick-reply-px, 14px)", paddingTop: "var(--quick-reply-py, 6px)", paddingBottom: "var(--quick-reply-py, 6px)", fontSize: "var(--quick-reply-font-size, 13px)" }}
                                onClick={() => { const selected = Array.from(multiSelectChoices).join(", "); setMultiSelectChoices(new Set()); handleQuickReply(selected); }}
                                disabled={sending}
                                data-testid="multi-select-done"
                              >
                                Done ({multiSelectChoices.size})
                              </Button>
                            )}
                          </div>
                        );
              };
              return (
            <div key={msg.id || `local-${i}`} id={msg.id ? `msg-${msg.id}` : undefined} data-quote-id={(msg as any).uiCardData?.quoteId || undefined}>
              {/* Date separator - full width, outside the avatar row */}
              {msg.createdAt && (() => {
                const msgDate = new Date(msg.createdAt).toDateString();
                const prevMsgItem = timeline.slice(0, idx).reverse().find((x) => x.type === "message");
                const prevDate = prevMsgItem ? new Date(prevMsgItem.ts).toDateString() : null;
                if (!prevDate || msgDate !== prevDate) {
                  return (
                    <div className="flex items-center justify-center my-3">
                      <span className="t-helper px-3 py-1 font-medium bg-muted/60 rounded-full shadow-sm">
                        {chatDateLabel(msg.createdAt)}
                      </span>
                    </div>
                  );
                }
                return null;
              })()}

              {/* Avatar row - wraps every element of this message */}
              <div className={alignRight ? "flex justify-end" : "flex items-start gap-2"}>
                {/* Avatar - left-aligned messages only */}
                {!alignRight && continuesGroup && <div className="w-8 shrink-0" aria-hidden="true" />}
                {!alignRight && !continuesGroup && (
                  <div className="w-8 h-8 rounded-full shrink-0 overflow-hidden mt-0.5">
                    {msgAvatarUrl ? (
                      <img src={msgAvatarUrl} alt={msgNameLabel} className="w-full h-full object-cover" />
                    ) : (
                      <div
                        className={`w-full h-full flex items-center justify-center text-xs font-semibold ${msgAvatarIsPerson ? "bg-secondary text-foreground border border-border" : "text-primary-foreground"}`}
                        style={msgAvatarIsPerson ? undefined : { backgroundColor: brandColor }}
                        aria-hidden="true"
                      >
                        {msgAvatarInitial}
                      </div>
                    )}
                  </div>
                )}

                {/* Content column: name, match cards, bubble, all special cards, quick replies */}
                <div className={`flex flex-col min-w-0 flex-1 ${alignRight ? "items-end" : "items-start"}`}>
                  {/* Name label */}
                  {!alignRight && !continuesGroup && (
                    <span className="t-helper font-medium mb-0.5" data-testid={`name-label-${i}`}>
                      {msgNameLabel}
                    </span>
                  )}

                  {/* Match / doctor / comparison cards - the SAME shared renderer
                      the admin monitor and the provider view use, so a card type
                      added there shows up on every surface. The chips slot keeps
                      the parent's layout: the decision sits with the face. */}
                  {!alignRight && (
                    <ChatInlineCards
                      msg={msg}
                      allMessages={messages}
                      brandColor={brandColor}
                      placement="above"
                      onAction={handleQuickReply}
                      onViewProfile={handleViewProfile}
                      afterMatchCards={hasPersonCardMsg ? (
                        <div className="mb-1.5 w-full max-w-[340px] sm:max-w-[380px] -mt-2" data-testid="card-chips">
                          {renderQuickReplies()}
                        </div>
                      ) : undefined}
                    />
                  )}

                  {/* Text bubble */}
                  {!cardReplacesbubble && showBubble && (
                    <div
                      className="overflow-hidden"
                      style={{
                        fontSize: "var(--chat-bubble-font-size, 21px)",
                        lineHeight: "var(--chat-bubble-line-height, 1.35)",
                        borderRadius: "var(--chat-bubble-radius, 20px)",
                        paddingLeft: "var(--chat-bubble-px, 16px)",
                        paddingRight: "var(--chat-bubble-px, 16px)",
                        paddingTop: "var(--chat-bubble-py, 11px)",
                        paddingBottom: "var(--chat-bubble-py, 11px)",
                        maxWidth: hasPersonCardMsg ? "min(100%, 380px)" : "var(--chat-bubble-max-width, 85%)",
                        ...(isOwnMessage
                          ? {
                              backgroundColor: "var(--chat-bubble-own-bg)",
                              color: "var(--chat-bubble-own-fg)",
                              border: "1px solid var(--chat-bubble-own-border)",
                            }
                          : isOtherParent
                          ? {
                              backgroundColor: "var(--chat-bubble-parent-bg)",
                              color: "var(--chat-bubble-parent-fg)",
                              border: "1px solid var(--chat-bubble-parent-border)",
                            }
                          : msg.role === "user"
                          ? {
                              backgroundColor: "var(--chat-bubble-own-bg)",
                              color: "var(--chat-bubble-own-fg)",
                              border: "1px solid var(--chat-bubble-own-border)",
                            }
                          : msg.senderType === "human"
                          ? {
                              backgroundColor: `${brandColor}14`,
                              color: "hsl(var(--foreground))",
                              border: `1px solid ${brandColor}33`,
                            }
                          : msg.senderType === "provider"
                          ? {
                              backgroundColor: "var(--chat-bubble-provider-bg)",
                              color: "var(--chat-bubble-provider-fg)",
                              border: "1px solid var(--chat-bubble-provider-border)",
                            }
                          : {
                              backgroundColor: "var(--chat-bubble-ai-bg)",
                              color: "var(--chat-bubble-ai-fg)",
                              border: "1px solid var(--chat-bubble-ai-border)",
                            }),
                      }}
                      data-testid={`chat-message-${msg.role}-${i}`}
                    >
                      <span style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>
                        {displayContent.split("\n").map((line, li) => (
                          <Fragment key={li}>
                            {li > 0 && <br />}
                            {renderRichLine(line)}
                          </Fragment>
                        ))}
                      </span>
                      {!hasPersonCardMsg && renderQuickReplies()}
                    </div>
                  )}

                  {/* Timestamp for regular bubble - suppressed on attachment
                      messages so the single timestamp renders under the image
                      instead of between the text and the image */}
                  {!cardReplacesbubble && showBubble && !isAttachmentMsg && msg.createdAt && (
                    <span
                      className="whitespace-nowrap select-none flex items-center gap-0.5 mt-0.5 px-1"
                      style={{ fontSize: "var(--chat-timestamp-font-size, 11px)", lineHeight: "16px", opacity: "var(--chat-timestamp-opacity, 0.45)" as unknown as number }}
                    >
                      {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                      {alignRight && (
                        <MessageStatus deliveredAt={msg.deliveredAt} readAt={msg.readAt} brandColor={brandColor} className="ml-0.5" />
                      )}
                    </span>
                  )}

                  {/* Meeting cards - existing bookings the parent asked about.
                      Rendered AFTER the text bubble so the AI's answer comes first,
                      then the card. Reuses InlineBookingCalendar (same component as
                      the standalone session booking) so join/reschedule/cancel work
                      identically. slug comes from each booking's OWN provider so the
                      reschedule picker hits the right calendar. */}
                  {/* Meeting, prep-doc, agreement and consultation cards - the
                      same shared renderer the admin monitor and provider view
                      use. (The whisper status line and the partner-invite form
                      below are parent-only answer surfaces, not cards, so they
                      stay here; a message never carries both.) */}
                  <ChatInlineCards
                    msg={msg}
                    allMessages={messages}
                    brandColor={brandColor}
                    placement="below"
                    userEmail={(user as any)?.email || ""}
                    userName={(user as any)?.name || ""}
                    onSchedule={(c) => setBookingCard(c)}
                    onBookingConfirmed={onBookingConfirmed}
                    onCallbackSubmitted={handleConsultationCallbackSubmitted}
                    existingBookingFor={existingBookingForMessage}
                  />


                  {/* In-chat partner invite form: Eva asked "add your partner?"
                      as its own turn, the parent said yes, this is the answer
                      surface. Submitting sends the invitation and posts the
                      parent's "Invitation sent" message so the intake resumes. */}
                  {msg.whisper?.queryId && !alignRight && (
                    <p className="mt-1.5 flex items-center gap-2 t-helper" data-testid={`whisper-status-${msg.whisper.status}`}>
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: msg.whisper.status === "answered" ? "hsl(var(--brand-success))" : "hsl(var(--brand-warning))" }}
                        aria-hidden="true"
                      />
                      {msg.whisper.status === "answered"
                        ? `${msg.whisper.providerLabel || "The agency"} answered. Their reply is below.`
                        : `Question sent to ${msg.whisper.providerLabel || "the agency"}. Waiting for their reply.`}
                    </p>
                  )}
                  {msg.partnerInvite?.form && (
                    <div className="mt-3">
                      <PartnerInviteCard brandColor={brandColor} onDone={(text) => sendMessage(text)} />
                    </div>
                  )}

                  {/* Full-screen confetti for celebration-flagged messages
                      (e.g. "both sides said yes" match announcement) */}
                  {(msg.uiCardData as any)?.celebration && (
                    <CelebrationBurst messageId={msg.id || ""} createdAt={msg.createdAt} kind={(msg.uiCardData as any).celebration} />
                  )}

                  {/* Special cards: readiness_prompt, invoice, calendar_share, video_invite, etc. */}
                  {msg.uiCardType && msg.uiCardData && (
                    <div className={`mt-2 flex flex-col ${alignRight ? "items-end" : "items-start"}`}>
                      {(() => {
                        const isAnswered = msg.uiCardType === "readiness_prompt"
                          ? !!(msg.uiCardData as any)?.answered ||
                            messages.slice(i + 1).some(m =>
                              m.senderName === "GoStork" &&
                              (m.content || "").includes("Thank you for letting us know")
                            )
                          : undefined;
                        return <ConciergeSpecialCard msg={msg} brandColor={brandColor} onOpenInlineVideo={setInlineVideoBookingId} sessionId={sessionId} isAnswered={isAnswered} positiveChipStyle={chipPositiveStyle} declineChipStyle={chipDeclineStyle} onAnswer={handleQuickReply} onYesReady={handleReadinessYes} onPayInvoiceInline={setInlinePaymentToken} onPrefillCostSheetQuestion={handlePrefillCostSheetQuestion} />;
                      })()}
                      {(cardReplacesbubble || !showBubble || isAttachmentMsg) && msg.createdAt && (
                        <span
                          className="whitespace-nowrap select-none flex items-center gap-0.5 mt-0.5 px-1"
                          style={{ fontSize: "var(--chat-timestamp-font-size, 11px)", lineHeight: "16px", opacity: "var(--chat-timestamp-opacity, 0.45)" as unknown as number }}
                        >
                          {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                          {alignRight && (
                            <MessageStatus deliveredAt={msg.deliveredAt} readAt={msg.readAt} brandColor={brandColor} className="ml-0.5" />
                          )}
                        </span>
                      )}
                    </div>
                  )}

                </div>
              </div>
            </div>
              );
            })
          })()}
          {sending && (
            <div className="flex items-center gap-2 justify-start py-1" data-testid="chat-typing-indicator">
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-pulse" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-pulse" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 bg-muted-foreground/50 rounded-full animate-pulse" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="t-helper">{aiName || "AI Concierge"} is typing</span>
            </div>
          )}
          {(externalBookingSlug || conciergeBookingSlug) && (() => {
            const bk = externalBookingSlug || conciergeBookingSlug!;
            const onClose = externalBookingSlug ? onCloseExternalBooking : () => setConciergeBookingSlug(null);
            return (
              <div className="px-1 pb-2">
                <div
                  className="w-full overflow-hidden border border-border bg-card"
                  style={{ borderRadius: "var(--container-radius, 0.5rem)", maxWidth: "min(100%, 420px)" }}
                  data-testid="parent-meeting-booking-card"
                >
                  <div className="p-1.5" style={{ backgroundColor: brandColor }}>
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <CalendarCheck className="w-4 h-4 text-primary-foreground" />
                      <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">
                        {`Schedule a Meeting${bk.memberName ? ` with ${bk.memberName}` : ""}`}
                      </span>
                    </div>
                  </div>
                  <div className="px-4 pb-4">
                    <InlineBookingCalendar
                      slug={bk.slug}
                      memberName={bk.memberName}
                      brandColor={brandColor}
                    />
                  </div>
                </div>
              </div>
            );
          })()}
          <div ref={messagesEndRef} />
        </div>

        {!isOnline && (
          <div className="t-helper flex items-center justify-center gap-2 px-3 py-2 border-t bg-muted/40">
            <div className="flex gap-0.5">
              <div className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: "0ms" }} />
              <div className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: "150ms" }} />
              <div className="w-1 h-1 rounded-full bg-muted-foreground/60 animate-pulse" style={{ animationDelay: "300ms" }} />
            </div>
            <span>Connection lost - waiting to reconnect</span>
          </div>
        )}
        {/* Embedded Stripe payment panel - mounted between messages and the
            composer when the parent clicks "Pay Now Securely" on an invoice
            card. Closes itself on success and triggers a chat refetch so the
            invoice card flips to PAID + the confirmation message appears. */}
        {inlinePaymentToken && (
          // The panel grows to its natural height, no inner scroll. The
          // messages container above us has `flex-1 min-h-0 overflow-y-
          // auto`, so it yields height to make room: as the panel grows,
          // the chat history's visible window shrinks (older messages
          // scroll off the top), but every pixel of the panel - card
          // fields, Link form, Pay button - stays visible. The composer
          // stays anchored at the bottom. shrink-0 on this wrapper
          // guarantees flex won't squeeze the panel mid-form-expand.
          <div className="border-t px-3 py-3 bg-muted/30 flex-1 min-h-0 overflow-y-auto" data-testid="payment-panel-slot">
            <InvoicePaymentPanel
              paymentToken={inlinePaymentToken}
              brandColor={brandColor}
              onClose={() => setInlinePaymentToken(null)}
              onSuccess={() => {
                setInlinePaymentToken(null);
                if (sessionId) {
                  // Webhook updates the invoice + posts confirmation message.
                  // Refetch a couple times in case the webhook is mid-flight.
                  loadMessagesForSession(sessionId).catch(() => {});
                  setTimeout(() => sessionId && loadMessagesForSession(sessionId).catch(() => {}), 1500);
                }
              }}
            />
          </div>
        )}
        {/* Hide the composer while the payment panel is open. The panel
            already has an X to close itself, and hiding the composer
            frees ~60px of vertical space - critical for fitting the
            expanded Link "Save my info" form on smaller screens
            without forcing internal scroll. */}
        <div className={`border-t px-3 py-2 relative ${inlinePaymentToken ? "hidden" : ""}`} data-testid="concierge-input-area">
          {(() => {
            const closeAfter = (fn: () => void) => () => {
              setParentPlusOpen(false);
              fn();
            };
            // Camera tile only works on devices that honor <input capture>
            // (mobile). On desktop the attribute is ignored and falls back to
            // a file picker - matches iMessage/WhatsApp which hide Camera on
            // desktop.
            const isTouchDevice =
              typeof window !== "undefined" &&
              window.matchMedia?.("(pointer: coarse)").matches;
            const tiles: ChatPlusAction[] = [
              {
                id: "photo",
                label: "Photo",
                icon: ImageIcon,
                onClick: closeAfter(() => parentPhotoInputRef.current?.click()),
                disabled: parentUploading,
                testId: "btn-attach-photo",
              },
              ...(isTouchDevice
                ? [{
                    id: "camera",
                    label: "Camera",
                    icon: Camera,
                    onClick: closeAfter(() => parentCameraInputRef.current?.click()),
                    disabled: parentUploading,
                    testId: "btn-attach-camera",
                  } as ChatPlusAction]
                : []),
              {
                id: "file",
                label: "File",
                icon: Paperclip,
                onClick: closeAfter(() => parentFileInputRef.current?.click()),
                disabled: parentUploading,
                testId: "btn-attach-file",
              },
            ];
            if (providerInChat) {
              tiles.push({
                id: "meeting",
                label: "Meeting",
                icon: CalendarDays,
                onClick: closeAfter(() => handleConciergeMeeting()),
                disabled: parentUploading || sending,
                testId: "btn-meeting",
              });
            }
            return (
              <div className="absolute left-2 bottom-full mb-2 z-40 pointer-events-none">
                <div className={parentPlusOpen ? "pointer-events-auto" : ""}>
                  <ChatPlusDrawer open={parentPlusOpen} actions={tiles} brandColor={brandColor} onDismiss={() => setParentPlusOpen(false)} />
                </div>
              </div>
            );
          })()}
          {stagedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {stagedFiles.map((file, i) => (
                <StagedFileChip
                  key={i}
                  file={file}
                  onRemove={() => removeStagedFile(i)}
                />
              ))}
            </div>
          )}
          <input
            ref={parentFileInputRef}
            type="file"
            className="hidden"
            accept="application/pdf,.doc,.docx,.txt,.csv,.xlsx"
            multiple
            onChange={handleParentFileSelect}
            data-testid="input-parent-file"
          />
          <input
            ref={parentPhotoInputRef}
            type="file"
            className="hidden"
            accept="image/*"
            multiple
            onChange={handleParentFileSelect}
            data-testid="input-parent-photo"
          />
          <input
            ref={parentCameraInputRef}
            type="file"
            className="hidden"
            accept="image/*"
            capture="environment"
            onChange={handleParentFileSelect}
            data-testid="input-parent-camera"
          />
          {contactNotice && <ContactGuardNotice message={contactNotice} className="mb-2" />}
          <div className="flex items-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-10 p-0 shrink-0 rounded-full border"
              style={{
                color: parentPlusOpen ? "white" : brandColor,
                backgroundColor: parentPlusOpen ? brandColor : `${brandColor}14`,
                borderColor: parentPlusOpen ? brandColor : `${brandColor}40`,
              }}
              onMouseEnter={(e) => {
                if (!parentPlusOpen) e.currentTarget.style.backgroundColor = `${brandColor}26`;
              }}
              onMouseLeave={(e) => {
                if (!parentPlusOpen) e.currentTarget.style.backgroundColor = `${brandColor}14`;
              }}
              onClick={() => setParentPlusOpen(v => !v)}
              disabled={parentUploading}
              aria-label={parentPlusOpen ? "Close actions" : "More actions"}
              data-plus-toggle="true"
              data-testid="btn-attach"
            >
              {parentUploading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Plus
                  className="w-[22px] h-[22px] transition-transform duration-200"
                  strokeWidth={2.5}
                  style={{ transform: parentPlusOpen ? "rotate(45deg)" : "rotate(0deg)" }}
                />
              )}
            </Button>
            <textarea
              ref={chatInputRef}
              rows={1}
              placeholder={`Message ${providerInChat && providerChatName ? providerChatName : (aiName || "AI Concierge")}...`}
              value={input}
              onChange={(e) => { setInput(e.target.value); if (contactNotice) setContactNotice(null); }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              aria-label={`Message ${providerInChat && providerChatName ? providerChatName : (aiName || "your concierge")}`}
              // Stay enabled while a reply is in flight: a disabled textarea
              // drops keyboard focus to the page body after every send
              // (observed: eleven re-clicks in eleven turns). sendMessage's
              // own in-flight guard already blocks a double submit.
              disabled={!isOnline}
              className="flex-1 border border-input bg-background text-foreground placeholder:text-muted-foreground rounded-full shadow-sm resize-none overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:opacity-50"
              style={{
                fontSize: "var(--chat-input-font-size, 17px)",
                minHeight: "var(--chat-input-height, 36px)",
                lineHeight: "1.35",
                paddingTop: "9px",
                paddingBottom: "9px",
                paddingLeft: "14px",
                paddingRight: "14px",
              }}
              data-testid="input-concierge-message"
            />
            {voiceModeAvailable && (
              // ChatGPT-style voice-mode button: filled circle + waveform, NOT
              // a microphone (that reads as dictation, this starts a live
              // voice conversation).
              <Button
                variant="ghost"
                size="sm"
                className="h-10 w-10 p-0 shrink-0 rounded-full text-primary-foreground hover:opacity-90"
                style={{ backgroundColor: brandColor }}
                onClick={openVoiceMode}
                disabled={sending || parentUploading || !isOnline}
                aria-label={`Start a voice conversation with ${aiName || "your AI Concierge"}`}
                data-testid="btn-voice-mode"
              >
                <AudioLines className="w-5 h-5" strokeWidth={2.25} />
              </Button>
            )}
            <Button
              size="sm"
              onClick={handleSend}
              disabled={(!input.trim() && stagedFiles.length === 0) || sending || parentUploading || !isOnline}
              className="h-10 w-10 p-0 rounded-full text-primary-foreground shrink-0"
              style={{ backgroundColor: brandColor }}
              aria-label="Send message"
              data-testid="btn-send-message"
            >
              {(sending || parentUploading) ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
              )}
            </Button>
          </div>
        </div>

        </div>
        {providerInChat && !isEmbedded && !isInline && (sessionBookings?.length ?? 0) > 0 && (
          <ParentChatSidePanel
            subjectInfo={subjectInfo}
            providerName={providerChatName}
            providerLogo={sessionProviderLogo}
            sessionCalendarSlug={sessionCalendarSlug ?? null}
            sessionBookings={sessionBookings ?? null}
            brandColor={brandColor}
            sessionId={sessionId}
            providerId={sessionProviderId}
          />
        )}
      </div>
      {bookingCard && (
        <BookingOverlay
          card={bookingCard}
          brandColor={brandColor}
          userEmail={(user as any)?.email || ""}
          userName={(user as any)?.name || ""}
          onClose={() => setBookingCard(null)}
          onCallbackSubmitted={() => {
            // Reload messages to show confirmation, then trigger AI to continue with next cycle
            setTimeout(async () => {
              if (sessionId) {
                await loadMessagesForSession(sessionId);
                // Send a hidden trigger so the AI continues with the next pending match cycle
                fetch("/api/ai-concierge/chat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
                  credentials: "include",
                  body: JSON.stringify({
                    message: "consultation_callback_submitted",
                    sessionId,
                    matchmakerId: effectiveMatchmakerIdRef.current,
                    isSystemTrigger: true,
                  }),
                }).then(async (r) => {
                  if (!r.ok || !r.body) return;
                  const rd = r.body.getReader();
                  const dc = new TextDecoder();
                  let b = "";
                  while (true) {
                    const { done, value } = await rd.read();
                    if (done) break;
                    b += dc.decode(value, { stream: true });
                    const ls = b.split("\n");
                    b = ls.pop() ?? "";
                    for (const l of ls) {
                      if (!l.startsWith("data: ")) continue;
                      let ev: any;
                      try { ev = JSON.parse(l.slice(6).trim()); } catch { continue; }
                      if (ev.type === "done" && sessionId) loadMessagesForSession(sessionId);
                    }
                  }
                }).catch(() => {});
              }
            }, 800);
          }}
        />
      )}
      {inlineVideoBookingId && (
        <ConciergeInlineVideoOverlay
          bookingId={inlineVideoBookingId}
          onClose={() => setInlineVideoBookingId(null)}
        />
      )}
    </>
  );
}
