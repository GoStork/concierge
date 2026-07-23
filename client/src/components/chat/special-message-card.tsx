import { getPhotoSrc } from "@/lib/profile-utils";
import { isVideoInviteExpired } from "@/lib/booking-time";
import { AttachmentMessageCard } from "./attachment-message-card";
import { formatMoneyCents } from "@/lib/format-money";
import { CheckCircle2, FileText, Download, Video, CalendarDays, ExternalLink, UserCheck, Receipt, Paperclip, PenLine, Check, MessageSquare, Pencil, X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { SessionMessage } from "./chat-types";
import { CostSheetDraftApprovalCard } from "./cost-sheet-draft-approval-card";
import { InvoiceDraftApprovalCard } from "./invoice-draft-approval-card";
import { AgreementDraftApprovalCard } from "./agreement-draft-approval-card";
import { ProposedTimesCard } from "./proposed-times-card";
import { InvoiceCard } from "@/components/invoice-card";
import { ClearanceTrackerCard } from "@/components/clearance-tracker-card";
import { BankCheckoutCard } from "@/components/chat/bank-checkout-card";
import { PartnerInfoRequestCard } from "@/components/chat/partner-info-request-card";

// Egg-donor hold decision (provider-only card): the deposit is overdue and
// the donor has been sitting ON_HOLD - the provider chooses to keep holding
// her or start the release countdown (which warns the parent first).
function DonorHoldDecisionButtons({ messageId, data, brandColor }: {
  messageId: string;
  data: { donorLabel?: string | null; parentName?: string | null; resolvedAt?: string | null; resolvedAs?: string | null };
  brandColor: string;
}) {
  const [resolvedAs, setResolvedAs] = useState<string | null>(data.resolvedAt ? data.resolvedAs || "resolved" : null);
  const [pending, setPending] = useState(false);
  const donorLabel = data.donorLabel || "the donor";
  const decide = async (action: "release" | "keep") => {
    setPending(true);
    try {
      await apiRequest("POST", `/api/donor-hold/${messageId}/decision`, { action });
      setResolvedAs(action === "keep" ? "keep_holding" : "release_requested");
    } catch {
      // Leave buttons active so the provider can retry.
    } finally {
      setPending(false);
    }
  };
  if (resolvedAs) {
    const isKeep = resolvedAs === "keep_holding";
    const label =
      isKeep ? `Holding ${donorLabel} - I'll check back if still unpaid`
      : resolvedAs === "release_requested" ? `${data.parentName || "The parent"} notified - final payment window running`
      : resolvedAs === "paid" ? "Deposit paid - she's in a cycle"
      : "Hold released";
    return (
      <div className={`mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${isKeep || resolvedAs === "paid" ? "bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]" : "bg-muted text-muted-foreground"}`}>
        <Check className="w-3.5 h-3.5" />
        {label}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => decide("keep")}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: brandColor }}
        data-testid={`donor-hold-keep-${messageId}`}
      >
        <Check className="w-3.5 h-3.5" />
        Keep holding her
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => decide("release")}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-background border border-border text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
        data-testid={`donor-hold-release-${messageId}`}
      >
        <X className="w-3.5 h-3.5" />
        Ok, release her
      </button>
    </div>
  );
}

// Parent-side release countdown: pay soon (extends once) or release now.
// Providers/admins watching the same card see its status, not the buttons.
// Exported: the parent chat surface (ConciergeChatPage) has its own card
// renderer and mounts this directly.
export function DonorReleaseWarningButtons({ messageId, data, brandColor, viewerRole }: {
  messageId: string;
  data: { donorLabel?: string | null; releaseAt?: string | null; answered?: string | null; resolvedAt?: string | null; resolvedAs?: string | null };
  brandColor: string;
  viewerRole: string;
}) {
  const [state, setState] = useState<"open" | "extended" | "released" | "paid">(
    data.resolvedAt ? (data.resolvedAs === "paid" ? "paid" : "released") : data.answered === "pay_soon" ? "extended" : "open",
  );
  const [pending, setPending] = useState(false);
  const donorLabel = data.donorLabel || "the donor";
  const respond = async (action: "release" | "pay_soon") => {
    setPending(true);
    try {
      await apiRequest("POST", `/api/donor-release/${messageId}/respond`, { action });
      setState(action === "release" ? "released" : "extended");
      queryClient.invalidateQueries({ queryKey: ["/api/chat-session"] });
    } catch {
      // Leave buttons active so the parent can retry.
    } finally {
      setPending(false);
    }
  };
  if (state !== "open") {
    const label =
      state === "extended" ? "Hold extended - complete the deposit to make it official"
      : state === "paid" ? "Deposit paid - she's officially yours"
      : `${donorLabel} released`;
    const positive = state !== "released";
    return (
      <div className={`mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${positive ? "bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]" : "bg-muted text-muted-foreground"}`}>
        {positive ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
        {label}
      </div>
    );
  }
  if (viewerRole !== "parent") {
    return (
      <div className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]">
        Waiting on the parent - releases automatically if unpaid
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => respond("pay_soon")}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: brandColor }}
        data-testid={`donor-release-pay-soon-${messageId}`}
      >
        <Check className="w-3.5 h-3.5" />
        I will pay soon
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => respond("release")}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-background border border-border text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
        data-testid={`donor-release-now-${messageId}`}
      >
        <X className="w-3.5 h-3.5" />
        Ok, release her
      </button>
    </div>
  );
}

// Phase 4: provider-side match readiness buttons. The agency answers on the
// surrogate's behalf after a match call; "yes" plus the parent's yes fires
// the 24h deposit invoice, "no" releases the hold and Eva tells the parent.
export function ProviderReadinessButtons({
  sessionId,
  messageId,
  data,
  brandColor,
}: {
  sessionId: string;
  messageId: string;
  data: { answered?: "yes" | "no" | null; subjectLabel?: string | null; parentName?: string | null };
  brandColor: string;
}) {
  const [answered, setAnswered] = useState<"yes" | "no" | null>(data.answered ?? null);
  const [pending, setPending] = useState(false);
  const respond = async (answer: "yes" | "no") => {
    setPending(true);
    try {
      await apiRequest("POST", `/api/sessions/${sessionId}/provider-readiness/${messageId}/respond`, { answer });
      setAnswered(answer);
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
    } catch {
      // Leave buttons active so the provider can retry.
    } finally {
      setPending(false);
    }
  };
  if (answered === "yes") {
    return (
      <div className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[hsl(var(--brand-success))]/10 text-[hsl(var(--brand-success))]">
        <Check className="w-3.5 h-3.5" />
        Confirmed - {data.subjectLabel || "she"} is ready to move forward
      </div>
    );
  }
  if (answered === "no") {
    return (
      <div className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground">
        <X className="w-3.5 h-3.5" />
        Not moving forward - hold released
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => respond("yes")}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: brandColor }}
        data-testid={`provider-readiness-yes-${messageId}`}
      >
        <Check className="w-3.5 h-3.5" />
        Yes, she's ready
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => respond("no")}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-background border border-border text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
        data-testid={`provider-readiness-no-${messageId}`}
      >
        <X className="w-3.5 h-3.5" />
        Not moving forward
      </button>
    </div>
  );
}

// Phase 2: small parent-side affordance for the cost-sheet card footer.
// Acknowledge persists ProviderQuote.parentAcknowledgedAt. "Have questions"
// pre-populates the chat input via the onPrefillInput callback. Both are
// soft signals - call proceeds either way.
export function CostSheetParentAck({
  sessionId,
  quoteId,
  brandColor,
  onPrefillInput,
}: {
  sessionId: string;
  quoteId: string;
  brandColor: string;
  onPrefillInput?: (text: string) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const ackMutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/sessions/${sessionId}/quotes/${quoteId}/acknowledge`, {}),
    onSuccess: () => {
      setAcknowledged(true);
      queryClient.invalidateQueries({ queryKey: ["/api/concierge"] });
    },
  });
  if (acknowledged) {
    return (
      <div className="border-t px-4 py-2 bg-[hsl(var(--brand-success))]/10 flex items-center gap-2 text-xs text-[hsl(var(--brand-success))]">
        <Check className="w-3.5 h-3.5" />
        Thanks - we let the provider know.
      </div>
    );
  }
  return (
    <div className="border-t px-4 py-2 bg-secondary/30 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => ackMutation.mutate()}
        disabled={ackMutation.isPending}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-background border hover:bg-muted/50 transition-colors disabled:opacity-50"
        style={{ borderColor: brandColor, color: brandColor }}
        data-testid={`cost-sheet-ack-${quoteId}`}
      >
        <Check className="w-3 h-3" />
        Acknowledge
      </button>
      {onPrefillInput && (
        <button
          type="button"
          onClick={() => onPrefillInput("I have a question about the cost sheet: ")}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-background border border-border hover:bg-muted/50 transition-colors text-foreground"
          data-testid={`cost-sheet-question-${quoteId}`}
        >
          <MessageSquare className="w-3 h-3" />
          I have questions
        </button>
      )}
    </div>
  );
}

interface SpecialMessageCardProps {
  msg: SessionMessage;
  brandColor: string;
  viewerRole?: "provider" | "parent" | "admin";
  onOpenInlineVideo?: (bookingId: string) => void;
  /** Chat session id - required for cost-sheet download links to mint a signed GCS URL. */
  sessionId?: string | null;
  /** Phase 2: when provider clicks Edit on a cost-sheet draft, open the sidebar form pre-filled. */
  onEditCostSheetDraft?: (initial: { lineItems: any[]; totalCostCents: number; notes: string | null }) => void;
  /** Phase 3: when provider clicks Edit on an invoice draft, open the invoice panel pre-filled. */
  onEditInvoiceDraft?: (initial: { lineItems: any[]; description: string | null }) => void;
  /** Provider-only: clicking "Edit & Resend" on a sent cost-sheet card opens the send form
   *  pre-filled with the prior quote. Posting supersedes the prior quote server-side. */
  onEditCostSheet?: (initial: { totalCostCents: number; notes: string | null }) => void;
  /** Phase 2: parent ack "Have questions" pre-fills the chat input. */
  onPrefillInput?: (text: string) => void;
  /** Provider-only: open the invoice panel pre-filled with this invoice's
   *  line items so the provider can revise and resend (server cancels the
   *  old invoice first). */
  onEditInvoice?: (initial: { invoiceId: string }) => void;
  /** Provider-only: cancel an AWAITING_PAYMENT invoice. */
  onCancelInvoice?: (initial: { invoiceId: string }) => void;
  /** Disables the provider's invoice action buttons while a mutation runs. */
  invoiceActionPendingId?: string | null;
  /** Provider-only: cancel an active cost sheet (supersedes without resending). */
  onCancelCostSheet?: (initial: { quoteId: string }) => void;
  /** Disables the cost-sheet action buttons while a mutation runs. */
  costSheetActionPendingId?: string | null;
}

export function SpecialMessageCard({ msg, brandColor, viewerRole, onOpenInlineVideo, sessionId, onEditCostSheetDraft, onEditInvoiceDraft, onEditCostSheet, onPrefillInput, onEditInvoice, onCancelInvoice, invoiceActionPendingId, onCancelCostSheet, costSheetActionPendingId }: SpecialMessageCardProps) {
  const data = msg.uiCardData as any;
  if (!data) return null;

  // Phase 2: provider-only auto-drafted cost sheet awaiting approval.
  if (msg.uiCardType === "cost_sheet_draft_approval" && sessionId) {
    return (
      <CostSheetDraftApprovalCard
        msg={{ id: msg.id, uiCardData: data }}
        sessionId={sessionId}
        onEdit={onEditCostSheetDraft}
      />
    );
  }

  // Phase 4: proposed time options - parents pick, providers watch status.
  if (msg.uiCardType === "proposed_times" && sessionId) {
    return (
      <ProposedTimesCard
        data={data}
        messageId={msg.id}
        sessionId={sessionId}
        brandColor={brandColor}
        canPick={false}
      />
    );
  }

  // Phase 4: provider answers the match readiness question (the question text
  // itself renders as the message bubble; this adds the answer buttons).
  if (msg.uiCardType === "provider_readiness_prompt" && sessionId && viewerRole !== "parent") {
    return (
      <ProviderReadinessButtons
        sessionId={sessionId}
        messageId={msg.id}
        data={data}
        brandColor={brandColor}
      />
    );
  }

  // Egg-donor hold: overdue deposit -> provider decides (hidden from parents).
  if (msg.uiCardType === "donor_hold_decision" && viewerRole !== "parent") {
    return <DonorHoldDecisionButtons messageId={msg.id} data={data} brandColor={brandColor} />;
  }

  // Egg-donor hold: release countdown - the parent answers, others watch.
  if (msg.uiCardType === "donor_release_warning") {
    return <DonorReleaseWarningButtons messageId={msg.id} data={data} brandColor={brandColor} viewerRole={viewerRole || "parent"} />;
  }

  // Phase 3: provider-only auto-drafted invoice awaiting approval.
  if (msg.uiCardType === "invoice_draft_approval" && sessionId) {
    return (
      <InvoiceDraftApprovalCard
        msg={{ id: msg.id, uiCardData: data }}
        sessionId={sessionId}
        onEdit={onEditInvoiceDraft}
      />
    );
  }

  // Phase 5: provider-only auto-drafted agreement awaiting approval.
  if (msg.uiCardType === "agreement_draft_approval" && sessionId) {
    return (
      <AgreementDraftApprovalCard
        msg={{ id: msg.id, uiCardData: data }}
        sessionId={sessionId}
      />
    );
  }

  if (msg.uiCardType === "attachment") {
    return <AttachmentMessageCard data={data} />;
  }

  // Phase 6: bank skip-to-checkout offer (parent-facing Buy button).
  if (msg.uiCardType === "bank_checkout") {
    return <BankCheckoutCard data={data} brandColor={brandColor} />;
  }

  // auto_send agreements: parent supplies partner signer details (or "just me").
  if (msg.uiCardType === "partner_info_request" && sessionId) {
    return <PartnerInfoRequestCard data={data} messageId={msg.id} sessionId={sessionId} brandColor={brandColor} viewerRole={viewerRole} />;
  }

  if (msg.uiCardType === "video_invite") {
    const isProviderViewer = viewerRole === "provider";
    const videoBookingId = data.bookingId;
    if (!videoBookingId || isVideoInviteExpired(msg.createdAt)) {
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

  if (msg.uiCardType === "signer_signed") {
    const signerName = data.signerName || "Signer";
    return (
      <div className="mt-1" data-testid="signer-signed-card">
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background"
          style={{ borderColor: brandColor }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <UserCheck className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{signerName} Signed</p>
            <p className="text-xs text-muted-foreground">Has signed the agreement</p>
          </div>
          <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: brandColor }} />
        </div>
      </div>
    );
  }

  // Intended Parent Form submitted - provider/admin card with download links
  // for both PDF variants. The parent reads the plain `content` text instead.
  if (msg.uiCardType === "ip_form_submitted" && viewerRole !== "parent") {
    const responseId: string | null = data.ipFormResponseId || null;
    const parentNames: string = data.parentNames || "The intended parents";
    const surrogateAvailable = !!data.surrogateAvailable;
    return (
      <div className="mt-1" data-testid="ip-form-submitted-card">
        <div className="rounded-[var(--radius)] border-2 bg-background overflow-hidden max-w-sm" style={{ borderColor: brandColor }}>
          <div className="p-1.5" style={{ backgroundColor: brandColor }}>
            <div className="flex items-center gap-2 px-3 py-1.5">
              <FileText className="w-4 h-4 text-primary-foreground" />
              <span className="text-primary-foreground text-xs font-semibold uppercase tracking-wider">Intended Parent Form Submitted</span>
            </div>
          </div>
          <div className="px-4 py-3 space-y-0.5">
            <p className="text-sm font-semibold">{parentNames}</p>
            <p className="text-xs text-muted-foreground">Completed and signed - ready to download.</p>
          </div>
          {responseId && (
            <div className="border-t px-4 py-3 space-y-2">
              <a href={`/api/provider/ip-forms/${responseId}/pdf?variant=full`} className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] border border-border bg-background hover:bg-muted transition-colors text-xs font-medium" data-testid="ip-form-card-download-full">
                <Download className="w-3.5 h-3.5 shrink-0" style={{ color: brandColor }} /> Download full PDF
              </a>
              {surrogateAvailable && (
                <a href={`/api/provider/ip-forms/${responseId}/pdf?variant=surrogate`} className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius)] border border-border bg-background hover:bg-muted transition-colors text-xs font-medium" data-testid="ip-form-card-download-surrogate">
                  <Download className="w-3.5 h-3.5 shrink-0" style={{ color: brandColor }} /> Surrogate version (safe to share)
                </a>
              )}
              <a href="/provider/parent-forms" className="flex items-center justify-between text-xs font-medium pt-0.5" style={{ color: brandColor }} data-testid="ip-form-card-open-page">
                <span>Open Parent Forms</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Sent-but-not-yet-signed agreement. Provider + admin renderer (parent
  // gets a richer interactive variant in concierge-chat-page). Click
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
          className="block rounded-[var(--radius)] border-2 bg-background overflow-hidden hover:bg-muted transition-colors"
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
    const agreementId = data.agreementId;
    return (
      <div className="mt-1" data-testid="agreement-signed-card">
        <a
          href={agreementId ? `/api/agreements/${agreementId}/download` : "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border-2 bg-background hover:bg-muted transition-colors"
          style={{ borderColor: brandColor }}
        >
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Agreement Fully Signed</p>
            <p className="text-xs text-muted-foreground">Click to download the signed PDF</p>
          </div>
          <Download className="w-4 h-4 text-muted-foreground shrink-0" />
        </a>
      </div>
    );
  }

  if (msg.uiCardType === "clearance_tracker") {
    return (
      <div className="mt-1" data-testid="clearance-tracker-card">
        <ClearanceTrackerCard data={data as any} isParent={viewerRole === "parent"} />
      </div>
    );
  }

  if (msg.uiCardType === "invoice") {
    const invoiceId: string | undefined = (data as any).invoiceId;
    const isProvider = viewerRole === "provider";
    return (
      <div className="mt-1" data-testid="invoice-card">
        <InvoiceCard
          data={data as any}
          isParent={viewerRole === "parent"}
          onEditResend={
            isProvider && invoiceId && onEditInvoice
              ? () => onEditInvoice({ invoiceId })
              : undefined
          }
          onCancel={
            isProvider && invoiceId && onCancelInvoice
              ? () => onCancelInvoice({ invoiceId })
              : undefined
          }
          actionPending={!!invoiceId && invoiceActionPendingId === invoiceId}
        />
      </div>
    );
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
    const csActionPending = !!quoteId && costSheetActionPendingId === quoteId;
    // Route through our authenticated download endpoint which mints a fresh
    // signed URL each click. The raw GCS URL returned by uploadBufferPublic
    // 403s when the bucket has uniform bucket-level access enabled.
    const downloadUrl = hasFile && sessionId && quoteId
      ? `/api/sessions/${sessionId}/cost-sheets/${quoteId}/file`
      : null;

    const borderColorWhenCancelled = "hsl(var(--muted-foreground) / 0.4)";
    return (
      <div className="mt-1" data-testid="cost-sheet-card">
        <div
          className={`rounded-[var(--radius)] border-2 bg-background overflow-hidden ${isCancelled ? "opacity-70" : ""}`}
          style={{ borderColor: isCancelled ? borderColorWhenCancelled : brandColor }}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0"
              style={{ backgroundColor: isCancelled ? borderColorWhenCancelled : brandColor }}
            >
              <Receipt className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-semibold ${isCancelled ? "line-through text-muted-foreground" : ""}`}>
                Cost Sheet from {providerName}
              </p>
              <p className="text-xs text-muted-foreground">
                {isCancelled
                  ? `Cancelled${cancelledAt ? ` - ${new Date(cancelledAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`
                  : `Total quoted cost${sentAt ? ` - ${new Date(sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p
                className={`text-lg font-bold ${isCancelled ? "line-through" : ""}`}
                style={{ color: isCancelled ? "hsl(var(--muted-foreground))" : brandColor }}
              >
                {totalFormatted}
              </p>
            </div>
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
                  <Paperclip className="w-3.5 h-3.5" />
                  {fileName || "Open cost sheet"}
                </a>
              )}
              {notes && <p className="text-xs text-muted-foreground italic whitespace-pre-line">{notes}</p>}
            </div>
          )}
          {/* Phase 2 ack footer: parent-only, only while not yet acknowledged
              and not cancelled - a cancelled cost sheet shouldn't invite the
              parent to acknowledge it. key={quoteId} guarantees a fresh
              CostSheetParentAck instance per quote so the local `acknowledged`
              flag never leaks across the superseded -> new quote transition. */}
          {viewerRole === "parent" && quoteId && sessionId && !data.parentAcknowledgedAt && !isCancelled && (
            <CostSheetParentAck
              key={quoteId}
              sessionId={sessionId}
              quoteId={quoteId}
              brandColor={brandColor}
              onPrefillInput={onPrefillInput}
            />
          )}
          {/* Provider-only: Edit & Resend opens the send form pre-filled with
              this quote (new quote supersedes this one). Cancel marks this
              quote as cancelled without replacing it. Both hide once the quote
              is already cancelled. */}
          {viewerRole === "provider" && !isCancelled && (onEditCostSheet || onCancelCostSheet) && (
            <div className="border-t px-4 py-2 bg-secondary/30 flex flex-wrap gap-2">
              {onEditCostSheet && (
                <button
                  type="button"
                  onClick={() => onEditCostSheet({ totalCostCents: totalCents, notes })}
                  disabled={csActionPending}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-background border hover:bg-muted/50 transition-colors disabled:opacity-50"
                  style={{ borderColor: brandColor, color: brandColor }}
                  data-testid={`cost-sheet-edit-${quoteId || msg.id}`}
                >
                  <Pencil className="w-3 h-3" />
                  Edit & Resend
                </button>
              )}
              {onCancelCostSheet && quoteId && (
                <button
                  type="button"
                  onClick={() => onCancelCostSheet({ quoteId })}
                  disabled={csActionPending}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-background border border-border hover:bg-muted/50 transition-colors text-foreground disabled:opacity-50"
                  data-testid={`cost-sheet-cancel-${quoteId}`}
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
