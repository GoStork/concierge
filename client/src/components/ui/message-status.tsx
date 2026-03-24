/**
 * WhatsApp-style message delivery status indicator.
 * - Single check: sent
 * - Double check: delivered
 * - Double check (blue): read
 */
const READ_BLUE = "#53BDEB";

export function MessageStatus({
  deliveredAt,
  readAt,
  brandColor,
  className = "",
}: {
  deliveredAt?: string | null;
  readAt?: string | null;
  brandColor: string;
  className?: string;
}) {
  const isRead = !!readAt;
  const isDelivered = !!deliveredAt || isRead;

  if (isDelivered) {
    return (
      <svg
        viewBox="0 0 18 11"
        width="18"
        height="11"
        className={className}
        style={{ display: "inline-block", verticalAlign: "middle", ...(isRead ? { opacity: 1 } : {}) }}
      >
        <path
          d="M9.17 0.73 L2.63 7.26 L0.06 4.7 L-1.35 6.12 L2.63 10.1 L10.58 2.15 Z"
          fill={isRead ? READ_BLUE : "currentColor"}
        />
        <path
          d="M15.17 0.73 L8.63 7.26 L7.53 6.16 L6.12 7.57 L8.63 10.1 L16.58 2.15 Z"
          fill={isRead ? READ_BLUE : "currentColor"}
        />
      </svg>
    );
  }

  // Single checkmark (sent)
  return (
    <svg
      viewBox="0 0 12 11"
      width="12"
      height="11"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      <path
        d="M10.07 0.73 L3.53 7.26 L0.96 4.7 L-0.45 6.12 L3.53 10.1 L11.48 2.15 Z"
        fill="currentColor"
      />
    </svg>
  );
}
