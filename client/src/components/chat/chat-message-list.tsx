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
 * date separator pills, sender name labels, message bubbles,
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

            {/* Sender name label */}
            {label && !own && (
              <div className="flex justify-start mb-0.5">
                <span className="text-[11px] font-medium text-muted-foreground" data-testid={`name-label-${msgTestIdPrefix}-${i}`}>
                  {label}
                </span>
              </div>
            )}

            {/* Whisper profile card */}
            {msg.uiCardData?.whisperMatchCard && (
              <WhisperProfileCard card={msg.uiCardData.whisperMatchCard} brandColor={brandColor} />
            )}

            {/* Message bubble + special card */}
            {(() => {
              // For attachment messages, strip auto-generated placeholder text so only the card shows
              const isAttachmentMsg = msg.uiCardType === "attachment";
              const displayContent = isAttachmentMsg
                ? (msg.content || "")
                    .replace(/\s*\[Attached file:[^\]]*\]/gi, "") // strip [Attached file: ...] suffix
                    .replace(/^(Shared a file:|I've shared a file with you:)[^\n]*/i, "") // strip placeholder lines
                    .trim()
                : msg.content;
              const showBubble = !isAttachmentMsg || displayContent.length > 0;
              return (
                <>
                  {showBubble && (
                  <div className={`flex ${own ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`relative max-w-[75%] overflow-hidden px-4 py-2.5 text-base leading-relaxed font-ui ${
                        own
                          ? "text-primary-foreground"
                          : "text-foreground"
                      }`}
                      style={{
                        borderRadius: resolvedRadius,
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
                      {msg.createdAt && (
                        <>
                          <span className={`inline-block ${own ? "w-[4.75rem]" : "w-[3.5rem]"}`} aria-hidden="true">&nbsp;</span>
                          <span
                            className="absolute bottom-1.5 right-3 whitespace-nowrap select-none flex items-center gap-0.5"
                            style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55 }}
                          >
                            {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                            {own && (
                              <MessageStatus deliveredAt={msg.deliveredAt} readAt={msg.readAt} brandColor={brandColor} className="ml-0.5" />
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  )}
                  {msg.uiCardType && (
                    <div className={`flex flex-col ${own ? "items-end" : "items-start"}`}>
                      <SpecialMessageCard
                        msg={msg}
                        brandColor={brandColor}
                        viewerRole={viewerRole}
                        onOpenInlineVideo={onOpenInlineVideo}
                      />
                      {!showBubble && msg.createdAt && (
                        <span className="flex items-center gap-0.5 mt-0.5 px-1" style={{ fontSize: "10px", lineHeight: "16px", opacity: 0.55 }}>
                          {new Date(msg.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                          {own && <MessageStatus deliveredAt={msg.deliveredAt} readAt={msg.readAt} brandColor={brandColor} className="ml-0.5" />}
                        </span>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        );
      })}
      <div ref={ref} />
    </>
  );
});
