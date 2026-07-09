import { useEffect } from "react";

/**
 * Deep-link into a chat at a specific message: `?msg=<messageId>` or
 * `?msg=quote:<quoteId>` (cost-sheet cards carry uiCardData.quoteId, not a
 * message id the caller knows). Used by the Home dashboards' Review/Open
 * buttons so the user lands ON the task, not just in the conversation.
 *
 * Design notes - two things fight a naive implementation:
 *   1. Both chat pages rewrite the URL shortly after mount (buildChatUrl /
 *      ?session= locking), dropping the query string before the message list
 *      even renders. So the target is CAPTURED module-side on first render
 *      (captureMessageTarget) and survives the rewrite.
 *   2. Both chats aggressively auto-scroll to the bottom for up to ~3s
 *      (staged timeouts + a MutationObserver). Their scroll code now yields
 *      while a deep-link target is pending (hasPendingMessageTarget), and we
 *      still re-assert the target position with staged attempts as a belt.
 *
 * Both chat renderers stamp each message wrapper with id="msg-<id>" and
 * data-quote-id="<quoteId>".
 */

let pending: { target: string; ts: number } | null = null;

const PENDING_TTL_MS = 20_000;

/** Grab ?msg= from the CURRENT URL before any rewriting. Safe to call on
 *  every render - only overwrites when the param is actually present. */
export function captureMessageTarget() {
  try {
    const m = new URLSearchParams(window.location.search).get("msg");
    if (m) pending = { target: m, ts: Date.now() };
  } catch { /* SSR/no-window safety */ }
}

/** Chat auto-scroll-to-bottom code checks this and yields while true. */
export function hasPendingMessageTarget(): boolean {
  if (!pending) return false;
  if (Date.now() - pending.ts > PENDING_TTL_MS) {
    pending = null;
    return false;
  }
  return true;
}

function findTarget(target: string): HTMLElement | null {
  return target.startsWith("quote:")
    ? document.querySelector<HTMLElement>(`[data-quote-id="${CSS.escape(target.slice(6))}"]`)
    : document.getElementById(`msg-${target}`);
}

export function useScrollToMessage(messageCount: number) {
  // Capture as early as this renderer gets to run, in case the page-level
  // capture didn't happen (e.g. a future chat surface).
  useEffect(() => { captureMessageTarget(); }, []);

  useEffect(() => {
    if (messageCount === 0 || !hasPendingMessageTarget()) return;
    const target = pending!.target;
    let highlighted = false;

    const attempt = (final: boolean) => () => {
      if (!pending || pending.target !== target) return;
      const el = findTarget(target);
      if (!el) {
        if (final) pending = null; // card not in this conversation - give up
        return;
      }
      el.scrollIntoView({ behavior: final ? "smooth" : "auto", block: "center" });
      if (!highlighted) {
        highlighted = true;
        el.style.transition = "background-color 0.4s ease";
        el.style.backgroundColor = "hsl(var(--brand-warning) / 0.18)";
        el.style.borderRadius = "var(--radius)";
        setTimeout(() => { el.style.backgroundColor = ""; }, 3200);
      }
      if (final) pending = null;
    };

    // Staged attempts: early ones position instantly while cards/images are
    // still rendering; the last one (after the chats' own scroll windows end)
    // settles the final position and releases the yield flag.
    const timers = [
      setTimeout(attempt(false), 350),
      setTimeout(attempt(false), 1100),
      setTimeout(attempt(false), 2200),
      setTimeout(attempt(true), 3600),
    ];
    return () => timers.forEach(clearTimeout);
    // Re-arm as messages stream in - pending guard prevents double-handling.
  }, [messageCount]);
}
