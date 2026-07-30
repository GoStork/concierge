import type React from "react";

/**
 * Shared geometry for in-chat action chips (quick replies, card buttons).
 *
 * Every value reads a brand CSS variable so the whole chat restyles from the
 * Brand Settings page. The fallbacks match the quick-reply defaults, so a card
 * button and a quick-reply chip are visually the same control.
 */
export const chipBase: React.CSSProperties = {
  borderRadius: "var(--quick-reply-radius, 999px)",
  fontSize: "var(--quick-reply-font-size, 13px)",
  paddingLeft: "var(--quick-reply-px, 14px)",
  paddingRight: "var(--quick-reply-px, 14px)",
  paddingTop: "var(--quick-reply-py, 6px)",
  paddingBottom: "var(--quick-reply-py, 6px)",
  height: "auto",
};

/** The AI bubble a card sits inside. */
export const chatBubbleStyle: React.CSSProperties = {
  fontSize: "var(--chat-bubble-font-size, 14px)",
  lineHeight: "var(--chat-bubble-line-height, 1.35)",
  borderRadius: "var(--chat-bubble-radius, 20px)",
  paddingLeft: "var(--chat-bubble-px, 16px)",
  paddingRight: "var(--chat-bubble-px, 16px)",
  paddingTop: "var(--chat-bubble-py, 11px)",
  paddingBottom: "var(--chat-bubble-py, 11px)",
  maxWidth: "var(--chat-bubble-max-width, 85%)",
  backgroundColor: "var(--chat-bubble-ai-bg)",
  color: "var(--chat-bubble-ai-fg)",
  border: "1px solid var(--chat-bubble-ai-border)",
};
