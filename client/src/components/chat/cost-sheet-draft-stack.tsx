import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Layers } from "lucide-react";
import type { SessionMessage } from "./chat-types";
import { CostSheetDraftApprovalCard } from "./cost-sheet-draft-approval-card";

// iMessage-style stacked deck for multiple auto-drafted cost sheet cards.
// When several programs match one booking, the cards pile up with offsets
// instead of stretching the chat vertically. Interactions:
//   - click anywhere on the front card body (not its buttons) -> next card
//   - swipe the front card horizontally (touch or mouse drag) -> next card
//   - click a peeking back card or the count chip -> next card
//   - approving/rejecting the front card auto-promotes the next pending one
// Every card must stay at least partially visible at all times, regardless
// of card heights - back cards peek out above and to the right of the front
// card by a generous fixed offset.

export function CostSheetDraftStack({
  msgs,
  sessionId,
}: {
  msgs: SessionMessage[];
  sessionId: string;
}) {
  const n = msgs.length;
  const isResolved = (m: SessionMessage) => !!(m.uiCardData as any)?.resolvedAt;
  const firstPending = () => {
    const idx = msgs.findIndex(m => !isResolved(m));
    return idx === -1 ? 0 : idx;
  };
  // Start on the first actionable (pending) card, not necessarily msgs[0].
  const [active, setActive] = useState(firstPending);
  const advance = () => setActive(a => (a + 1) % n);

  // When the front card gets resolved (approved/rejected), auto-flip to the
  // next still-pending card so the provider can send them all one by one.
  const resolvedSig = msgs.map(m => (isResolved(m) ? "1" : "0")).join("");
  const prevSigRef = useRef(resolvedSig);
  useEffect(() => {
    if (prevSigRef.current === resolvedSig) return;
    prevSigRef.current = resolvedSig;
    setActive(a => {
      if (msgs[a] && isResolved(msgs[a])) {
        const next = msgs.findIndex(m => !isResolved(m));
        if (next !== -1) return next;
      }
      return a;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedSig]);

  // Suppress the click-to-flip when the click was actually the end of a drag.
  const wasDraggedRef = useRef(false);

  // Peek offsets. Big enough that the card behind always shows its full
  // title bar above the front card, whatever the height difference. Tighter
  // as the stack grows, like iMessage.
  const gapY = n <= 2 ? 44 : n <= 4 ? 32 : 22;
  const gapX = n <= 2 ? 12 : n <= 4 ? 8 : 6;
  const visibleDepth = Math.min(n - 1, 3);

  const pendingCount = msgs.filter(m => !isResolved(m)).length;

  // Fade the bottom of each peeking strip so a visible gap separates it from
  // the card in front - otherwise the two card tops read as a double title.
  const peekMask = `linear-gradient(to bottom, black ${gapY - 14}px, transparent ${gapY - 2}px)`;

  return (
    <div className="w-full max-w-2xl mt-1">
      {/* Count chip - mirrors iMessage's "6 Photos" label. Click flips. */}
      <div className="flex items-center mb-2.5 px-1">
        <button
          type="button"
          onClick={advance}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground bg-secondary rounded-full px-2.5 py-1 hover:bg-secondary/70 transition-colors"
          data-testid="cost-sheet-stack-chip"
        >
          <Layers className="w-3 h-3" />
          {n} cost sheets
          <span className="text-muted-foreground">
            {active + 1}/{n}{pendingCount > 0 ? ` - ${pendingCount} awaiting approval` : ""} - tap card to flip
          </span>
        </button>
      </div>

      {/* paddingTop reserves room for the peeking back cards; paddingRight
          for their right-edge peek. */}
      <div className="relative" style={{ paddingTop: visibleDepth * gapY, paddingRight: visibleDepth * gapX }}>
        <div className="relative">
          {msgs.map((m, i) => {
            // Slot 0 = front. Higher slots peek out behind, up-and-right.
            const slot = (i - active + n) % n;
            const isFront = slot === 0;
            return (
              <motion.div
                key={m.id}
                // Back cards are clipped to the front card's box (inset-0 +
                // overflow-hidden) so a taller back card can never poke out
                // BELOW the front card into the rest of the chat. Their
                // visible parts are the top strip + right edge peeks created
                // by the translate. transformOrigin top-right keeps the
                // right-edge peek visible despite the scale-down.
                className={isFront ? "relative" : "absolute inset-0 overflow-hidden rounded-xl"}
                style={{
                  zIndex: n - slot,
                  transformOrigin: "top right",
                  ...(isFront
                    ? {}
                    : { WebkitMaskImage: peekMask, maskImage: peekMask }),
                }}
                animate={{
                  y: -slot * gapY,
                  x: slot * gapX,
                  scale: 1 - slot * 0.015,
                  opacity: slot > 3 ? 0 : 1,
                }}
                transition={{ type: "spring", stiffness: 300, damping: 28 }}
                drag={isFront && n > 1 ? "x" : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.7}
                whileDrag={{ rotate: -2, scale: 1.01 }}
                onDragStart={isFront ? () => { wasDraggedRef.current = true; } : undefined}
                onDragEnd={
                  isFront
                    ? (_, info) => {
                        if (Math.abs(info.offset.x) > 90 || Math.abs(info.velocity.x) > 600) advance();
                        // Let the click event that follows mouseup pass, then re-arm.
                        setTimeout(() => { wasDraggedRef.current = false; }, 50);
                      }
                    : undefined
                }
                onClick={
                  isFront && n > 1
                    ? (e) => {
                        if (wasDraggedRef.current) return;
                        // Clicking the card body flips; buttons/inputs still work.
                        const el = e.target as HTMLElement;
                        if (el.closest("button, a, input, textarea, select, label, [role=button]")) return;
                        advance();
                      }
                    : undefined
                }
                onClickCapture={
                  !isFront
                    ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        advance();
                      }
                    : undefined
                }
              >
                {/* Back cards are display-only until promoted - their inner
                    buttons must not steal the flip click. */}
                <div className={isFront && n > 1 ? "cursor-pointer" : isFront ? undefined : "pointer-events-none select-none"}>
                  <CostSheetDraftApprovalCard
                    msg={{ id: m.id, uiCardData: m.uiCardData as any }}
                    sessionId={sessionId}
                  />
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
