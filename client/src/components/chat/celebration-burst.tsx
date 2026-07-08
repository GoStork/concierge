import { useEffect } from "react";
import confetti from "canvas-confetti";

// iMessage-style full-screen confetti, fired when a celebration-flagged chat
// message (uiCardData.celebration) first renders - e.g. the "It's official,
// both sides said yes!" match announcement.
//
// Guards:
//  - fires at most once per message per browser tab (module Set + sessionStorage)
//  - only for reasonably fresh messages (48h) so revisiting an old chat
//    months later doesn't rain confetti

const firedThisTab = new Set<string>();
const FRESHNESS_MS = 48 * 60 * 60 * 1000;

export function CelebrationBurst({ messageId, createdAt }: { messageId: string; createdAt?: string | null }) {
  useEffect(() => {
    if (!messageId) return;
    if (createdAt && Date.now() - new Date(createdAt).getTime() > FRESHNESS_MS) return;
    const key = `celebrated-${messageId}`;
    if (firedThisTab.has(messageId)) return;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch { /* storage unavailable - fall back to the in-memory guard */ }
    firedThisTab.add(messageId);

    const base = { ticks: 220, gravity: 0.9, scalar: 1.1, zIndex: 9999, disableForReducedMotion: true };
    // Two side cannons, then a center burst - the iMessage feel.
    confetti({ ...base, particleCount: 80, spread: 65, angle: 60, origin: { x: 0.15, y: 0.75 } });
    confetti({ ...base, particleCount: 80, spread: 65, angle: 120, origin: { x: 0.85, y: 0.75 } });
    const t1 = setTimeout(() => {
      confetti({ ...base, particleCount: 140, spread: 110, angle: 90, origin: { x: 0.5, y: 0.6 }, startVelocity: 45 });
    }, 300);
    const t2 = setTimeout(() => {
      confetti({ ...base, particleCount: 60, spread: 80, angle: 90, origin: { x: 0.5, y: 0.7 }, scalar: 0.9 });
    }, 700);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [messageId, createdAt]);

  return null;
}
