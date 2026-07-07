import { forwardRef, type ReactNode, Fragment } from "react";
import { MessageStatus } from "@/components/ui/message-status";
import { chatDateLabel } from "./chat-utils";
import { WhisperProfileCard } from "./whisper-profile-card";
import { SpecialMessageCard } from "./special-message-card";
import { CostSheetDraftStack } from "./cost-sheet-draft-stack";
import { InlineBookingNotification } from "./inline-booking-notification";
import type { SessionMessage, ViewerRole } from "./chat-types";
import type { ChatPalette } from "@/lib/chat-palette";

interface ChatMessageListProps {
  messages: SessionMessage[];
  bookings?: any[];
  brandColor: string;
  chatPalette: ChatPalette;
  borderRadius?: number;
  viewerRole: ViewerRole;
  /** Return true if the message was sent by the current viewer */
  isOwnMessage: (msg: SessionMessage) => boolean;
  /** Return a display name label for the message sender, or null to hide */
  nameLabel: (msg: SessionMessage) => string | null;
  /** Return the avatar URL for a left-side message, or null for initials fallback */
  msgAvatarUrl?: (msg: SessionMessage) => string | null;
  /** Return the initials (1-2 chars) used in the avatar bubble when no photo is
   *  available. Lets callers provide initials independent of the visible name
   *  label - e.g. the admin monitor hides the parent name above the bubble
   *  (already shown in the right panel) but still wants "EA" in the avatar
   *  instead of a generic "?". When omitted, initials are derived from the
   *  name label, falling back to "?". */
  msgAvatarInitial?: (msg: SessionMessage) => string | null;
  /** Avatar URL for the AI/matchmaker, shown next to booking cards so they read as
   *  "the AI delivered this" - matches the parent /chat page layout. */
  aiAvatarUrl?: string | null;
  /** Display name for the AI/matchmaker - used for avatar initial fallback. */
  aiName?: string | null;
  onOpenInlineVideo?: (bookingId: string) => void;
  onBookingUpdate?: () => void;
  /** Test-ID prefix for message bubbles (default: "provider-msg") */
  msgTestIdPrefix?: string;
  /** Chat session id - threaded through to SpecialMessageCard for signed cost-sheet links. */
  sessionId?: string | null;
  /** Provider-only: open the send form pre-filled to revise and resend a sent cost sheet. */
  onEditCostSheet?: (initial: { totalCostCents: number; notes: string | null }) => void;
  /** Provider-only: open the invoice panel pre-filled with this invoice. Caller
   *  is expected to cancel the existing invoice and seed the form. */
  onEditInvoice?: (initial: { invoiceId: string }) => void;
  /** Phase 3: provider clicks Edit on an invoice draft card - open the invoice panel pre-filled. */
  onEditInvoiceDraft?: (initial: { lineItems: any[]; description: string | null }) => void;
  /** Provider-only: cancel a still-pending invoice. */
  onCancelInvoice?: (initial: { invoiceId: string }) => void;
  /** Disables the per-card invoice action buttons while a mutation runs. */
  invoiceActionPendingId?: string | null;
  /** Provider-only: cancel a still-active cost sheet. */
  onCancelCostSheet?: (initial: { quoteId: string }) => void;
  /** Disables the per-card cost-sheet action buttons while a mutation runs. */
  costSheetActionPendingId?: string | null;
}

/** Up to 2-letter initials from a name ("Eran Amir" -> "EA"). Returns null when
 *  no usable letters are present so callers can fall back further. */
function deriveInitials(name: string | null | undefined): string | null {
  if (!name) return null;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  const initials = (first + last).toUpperCase();
  return initials || null;
}

/** Renders a chat message with **bold** and line break support. */
function renderMessageContent(text: string): ReactNode {
  return text.split("\n").map((line, li) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <Fragment key={li}>
        {li > 0 && <br />}
        {parts.map((part, pi) =>
          part.startsWith("**") && part.endsWith("**")
            ? <strong key={pi}>{part.slice(2, -2)}</strong>
            : <Fragment key={pi}>{part}</Fragment>
        )}
      </Fragment>
    );
  });
}

/**
 * Shared chat message list component used by provider chat and admin concierge monitor.
 * Handles merging messages with booking cards chronologically,
 * date separator pills, sender avatar + name labels, message bubbles,
 * WhisperProfileCards, SpecialMessageCards, and read receipts.
 */
export const ChatMessageList = forwardRef<HTMLDivElement, ChatMessageListProps>(function ChatMessageList(
  {
    messages,
    bookings,
    brandColor,
    chatPalette,
    borderRadius,
    viewerRole,
    isOwnMessage,
    nameLabel,
    msgAvatarUrl,
    aiAvatarUrl,
    aiName,
    msgAvatarInitial,
    onOpenInlineVideo,
    onBookingUpdate,
    msgTestIdPrefix = "provider-msg",
    sessionId,
    onEditCostSheet,
    onEditInvoice,
    onEditInvoiceDraft,
    onCancelInvoice,
    invoiceActionPendingId,
    onCancelCostSheet,
    costSheetActionPendingId,
  },
  ref,
) {
  // Merge messages with booking cards chronologically
  const allBookings = bookings || [];
  const hasActive = allBookings.some((b: any) => b.status === "PENDING" || b.status === "CONFIRMED");
  const visibleBookings = hasActive
    ? allBookings.filter((b: any) => b.status !== "CANCELLED" && b.status !== "DECLINED" && b.status !== "RESCHEDULED" && b.status !== "EXPIRED")
    : allBookings.slice(0, 1);
  const bookingItems: Array<{ type: "booking"; booking: any; createdAt: string }> = visibleBookings.map((b: any) => ({
    type: "booking" as const,
    booking: b,
    createdAt: b.createdAt || b.scheduledAt,
  }));
  const msgItems: Array<{ type: "message"; msg: SessionMessage; createdAt: string }> = messages.map((m) => ({
    type: "message" as const,
    msg: m,
    createdAt: m.createdAt,
  }));
  const merged = [...msgItems, ...bookingItems].sort(
    (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
  );

  // Bubble shape now driven by the chat-specific CSS variable so provider/admin
  // match the parent's /chat page exactly. The `borderRadius` prop is kept as a
  // last-resort fallback for callers that still pass it.
  const resolvedRadius = `var(--chat-bubble-radius, ${borderRadius !== undefined ? `${borderRadius}rem` : "20px"})`;

  return (
    <>
      {merged.map((item, i) => {
        if (item.type === "booking") {
          // Match the parent /chat layout exactly: avatar + flex-1 wrapper.
          // The maxWidth is applied on the card border div inside InlineBookingNotification.
          return (
            <div key={`booking-${item.booking.id}`} className="flex items-start gap-2 px-1 pb-2">
              <div className="w-8 h-8 rounded-full shrink-0 overflow-hidden mt-0.5">
                {aiAvatarUrl ? (
                  <img src={aiAvatarUrl} alt={aiName || "AI"} className="w-full h-full object-cover" />
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
                <InlineBookingNotification
                  booking={item.booking}
                  brandColor={brandColor}
                  viewerRole={viewerRole === "admin" ? "admin" : "provider"}
                  onUpdate={() => onBookingUpdate?.()}
                />
              </div>
            </div>
          );
        }
        const msg = item.msg;
        const own = isOwnMessage(msg);
        const label = nameLabel(msg);
        const avatarUrl = !own && msgAvatarUrl ? msgAvatarUrl(msg) : null;
        const avatarInitial = !own
          ? (msgAvatarInitial?.(msg) || deriveInitials(label) || "?")
          : null;

        // ---- iMessage-style stack for adjacent cost-sheet draft cards ----
        // A manual regenerate / multi-program match creates several draft
        // cards back-to-back. Instead of stretching the chat with N tall
        // cards, collapse the run into one stacked deck (swipe / click to
        // flip). Single cards fall through to the normal renderer.
        const isDraftItem = (it: typeof merged[number] | undefined): boolean =>
          !!it && it.type === "message" && (it as any).msg.uiCardType === "cost_sheet_draft_approval";
        if (isDraftItem(item)) {
          if (isDraftItem(merged[i - 1])) return null; // rendered by the run head
          const run: SessionMessage[] = [msg];
          for (let j = i + 1; isDraftItem(merged[j]); j++) run.push((merged[j] as any).msg);
          if (run.length >= 2 && sessionId) {
            return (
              <div key={msg.id}>
                {/* Date separator pill (same logic as the standard path) */}
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
                <div className="flex items-start gap-2">
                  <div className="w-8 h-8 rounded-full shrink-0 overflow-hidden mt-0.5">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt={label ?? ""} className="w-full h-full object-cover" />
                    ) : (
                      <div
                        className="w-full h-full flex items-center justify-center text-primary-foreground text-xs font-semibold"
                        style={{ backgroundColor: brandColor }}
                      >
                        {avatarInitial}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col flex-1 min-w-0 items-start">
                    {label && (
                      <span className="text-[11px] font-medium text-muted-foreground mb-0.5">{label}</span>
                    )}
                    <CostSheetDraftStack msgs={run} sessionId={sessionId} />
                    {msg.createdAt && (
                      <span className="flex items-center gap-0.5 mt-0.5 px-1" style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55 }}>
                        {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          }
        }

        // For attachment messages, strip auto-generated placeholder text so only the card shows
        const isAttachmentMsg = msg.uiCardType === "attachment";
        const displayContent = isAttachmentMsg
          ? (msg.content || "")
              .replace(/\s*\[Attached file:[^\]]*\]/gi, "")
              .replace(/^(Shared a file:|I've shared a file with you:)[^\n]*/i, "")
              .trim()
          : msg.content;
        const showBubble = !isAttachmentMsg || displayContent.length > 0;

        return (
          <div key={msg.id}>
            {/* Date separator pill */}
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

            {/* Avatar row - wraps all message content */}
            <div className={own ? "flex justify-end" : "flex items-start gap-2"}>
              {/* Avatar - left-aligned messages only */}
              {!own && (
                <div className="w-8 h-8 rounded-full shrink-0 overflow-hidden mt-0.5">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt={label ?? ""} className="w-full h-full object-cover" />
                  ) : (
                    <div
                      className="w-full h-full flex items-center justify-center text-primary-foreground text-xs font-semibold"
                      style={{ backgroundColor: brandColor }}
                    >
                      {avatarInitial}
                    </div>
                  )}
                </div>
              )}

              {/* Content column: name, whisper card, bubble, special card */}
              <div className={`flex flex-col flex-1 min-w-0 ${own ? "items-end" : "items-start"}`}>
                {/* Sender name label */}
                {label && !own && (
                  <span className="text-[11px] font-medium text-muted-foreground mb-0.5" data-testid={`name-label-${msgTestIdPrefix}-${i}`}>
                    {label}
                  </span>
                )}

                {/* Whisper profile card */}
                {msg.uiCardData?.whisperMatchCard && (
                  <WhisperProfileCard card={msg.uiCardData.whisperMatchCard} brandColor={brandColor} />
                )}

                {/* Message bubble + timestamp below */}
                {showBubble && (
                  <div className={`flex w-full ${own ? "justify-end" : "justify-start"}`}>
                    <div className={`flex flex-col ${own ? "items-end" : "items-start"}`} style={{ maxWidth: "var(--chat-bubble-max-width, 85%)" }}>
                      <div
                        className="overflow-hidden font-ui"
                        style={{
                          borderRadius: resolvedRadius,
                          paddingLeft: "var(--chat-bubble-px, 16px)",
                          paddingRight: "var(--chat-bubble-px, 16px)",
                          paddingTop: "var(--chat-bubble-py, 11px)",
                          paddingBottom: "var(--chat-bubble-py, 11px)",
                          fontSize: "var(--chat-bubble-font-size, 21px)",
                          lineHeight: "var(--chat-bubble-line-height, 1.35)",
                          ...(own
                            ? { backgroundColor: "var(--chat-bubble-own-bg)", color: "var(--chat-bubble-own-fg)", border: "1px solid var(--chat-bubble-own-border)" }
                            : msg.role === "user"
                            ? { backgroundColor: "var(--chat-bubble-parent-bg)", color: "var(--chat-bubble-parent-fg)", border: "1px solid var(--chat-bubble-parent-border)" }
                            : msg.senderType === "provider"
                            ? { backgroundColor: "var(--chat-bubble-provider-bg)", color: "var(--chat-bubble-provider-fg)", border: "1px solid var(--chat-bubble-provider-border)" }
                            : msg.senderType === "human"
                            ? { backgroundColor: `${brandColor}14`, color: "hsl(var(--foreground))", border: `1px solid ${brandColor}33` }
                            : msg.senderType === "system"
                            ? { backgroundColor: "var(--chat-bubble-ai-bg)", color: "var(--chat-bubble-ai-fg)", border: "1px solid var(--chat-bubble-ai-border)" }
                            : { backgroundColor: "var(--chat-bubble-ai-bg)", color: "var(--chat-bubble-ai-fg)", border: "1px solid var(--chat-bubble-ai-border)" }),
                        }}
                        data-testid={`${msgTestIdPrefix}-${i}`}
                      >
                        <span style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>{renderMessageContent(displayContent)}</span>
                      </div>
                      {/* Suppress bubble timestamp on attachment messages so the
                          single timestamp renders below the image instead of
                          between the text and the image */}
                      {msg.createdAt && !isAttachmentMsg && (
                        <span
                          className="whitespace-nowrap select-none flex items-center gap-0.5 mt-0.5 px-1"
                          style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55 }}
                        >
                          {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                          {own && (
                            <MessageStatus deliveredAt={msg.deliveredAt} readAt={msg.readAt} brandColor={brandColor} className="ml-0.5" />
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Special card (attachment, video, calendar, etc.) */}
                {msg.uiCardType && (
                  <div className={`flex flex-col ${own ? "items-end" : "items-start"}`}>
                    <SpecialMessageCard
                      msg={msg}
                      brandColor={brandColor}
                      viewerRole={viewerRole}
                      onOpenInlineVideo={onOpenInlineVideo}
                      sessionId={sessionId}
                      onEditCostSheet={onEditCostSheet}
                      onEditInvoice={onEditInvoice}
                      onEditInvoiceDraft={onEditInvoiceDraft}
                      onCancelInvoice={onCancelInvoice}
                      invoiceActionPendingId={invoiceActionPendingId}
                      onCancelCostSheet={onCancelCostSheet}
                      costSheetActionPendingId={costSheetActionPendingId}
                    />
                    {(!showBubble || isAttachmentMsg) && msg.createdAt && (
                      <span className="flex items-center gap-0.5 mt-0.5 px-1" style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55 }}>
                        {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                        {own && <MessageStatus deliveredAt={msg.deliveredAt} readAt={msg.readAt} brandColor={brandColor} className="ml-0.5" />}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={ref} />
    </>
  );
});
