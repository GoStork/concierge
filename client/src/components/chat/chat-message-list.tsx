import { forwardRef, type ReactNode, Fragment } from "react";
import { MessageStatus } from "@/components/ui/message-status";
import { chatDateLabel } from "./chat-utils";
import { WhisperProfileCard } from "./whisper-profile-card";
import { SpecialMessageCard } from "./special-message-card";
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
  onOpenInlineVideo?: (bookingId: string) => void;
  onBookingUpdate?: () => void;
  /** Test-ID prefix for message bubbles (default: "provider-msg") */
  msgTestIdPrefix?: string;
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
    onOpenInlineVideo,
    onBookingUpdate,
    msgTestIdPrefix = "provider-msg",
  },
  ref,
) {
  // Merge messages with booking cards chronologically
  const allBookings = bookings || [];
  const hasActive = allBookings.some((b: any) => b.status === "PENDING" || b.status === "CONFIRMED");
  const visibleBookings = hasActive
    ? allBookings.filter((b: any) => b.status !== "CANCELLED" && b.status !== "DECLINED" && b.status !== "RESCHEDULED")
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

  const resolvedRadius = borderRadius !== undefined ? `${borderRadius}rem` : "var(--radius)";

  return (
    <>
      {merged.map((item, i) => {
        if (item.type === "booking") {
          return (
            <InlineBookingNotification
              key={`booking-${item.booking.id}`}
              booking={item.booking}
              brandColor={brandColor}
              onUpdate={() => onBookingUpdate?.()}
            />
          );
        }
        const msg = item.msg;
        const own = isOwnMessage(msg);
        const label = nameLabel(msg);
        const avatarUrl = !own && msgAvatarUrl ? msgAvatarUrl(msg) : null;
        const avatarInitial = !own ? (label?.charAt(0) || "?") : null;

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
                    <div className={`flex flex-col max-w-[75%] ${own ? "items-end" : "items-start"}`}>
                      <div
                        className={`overflow-hidden font-ui ${
                          own
                            ? "text-primary-foreground"
                            : "text-foreground"
                        }`}
                        style={{
                          borderRadius: resolvedRadius,
                          paddingLeft: "var(--chat-bubble-px, 16px)",
                          paddingRight: "var(--chat-bubble-px, 16px)",
                          paddingTop: "var(--chat-bubble-py, 11px)",
                          paddingBottom: "var(--chat-bubble-py, 11px)",
                          fontSize: "var(--chat-bubble-font-size, 15px)",
                          lineHeight: "var(--chat-bubble-line-height, 1.35)",
                          ...(own
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
