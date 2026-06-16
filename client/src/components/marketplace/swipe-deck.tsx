import { useState, useEffect, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Handlers the deck hands to `renderCard` so the card's save/pass/undo buttons
 * are wired to the deck's history + advance bookkeeping. The caller's own
 * onSave/onPass/onUndo (Redux + server sync) run underneath these.
 */
export interface SwipeDeckCardApi {
  onSave: () => void;
  onPass: () => void;
  /** Mobile back: undo the last action and resurface that card. Undefined when
   *  there is nothing to undo. */
  onUndo?: () => void;
}

/** Where a card is being rendered: the active (draggable, top) mobile card, the
 *  inert preview underneath it, or a static desktop grid cell. Lets the caller
 *  wire undo correctly (mobile back vs. per-card undo) the way each deck did. */
export type SwipeDeckCardMode = "active" | "preview" | "grid";

export interface SwipeDeckProps<T> {
  /** Already filtered + sorted by the caller (favorites/skipped/ordering are
   *  type-specific and stay with the caller). The deck only owns index/history. */
  items: T[];
  getKey: (item: T) => string;
  /** Render one card for the given mode. The `api` wires the card's
   *  save/pass/undo buttons into the deck's history + advance bookkeeping. */
  renderCard: (item: T, mode: SwipeDeckCardMode, api: SwipeDeckCardApi) => ReactNode;
  /** Caller commits Redux + server sync. The deck adds history bookkeeping. */
  onSave: (key: string) => void;
  onPass: (key: string) => void;
  /** Undo a previously-acted card (caller reverses Redux + server sync). */
  onUndo: (key: string) => void;
  /** When any of these change, reset the deck to the top (e.g. tab/filter switch). */
  resetDeps?: ReadonlyArray<unknown>;
  /** Grayscale the stack/grid (skipped-only view). */
  dim?: boolean;
  emptyTitle: string;
  emptySubtitle?: string;
  seenAllTitle: string;
  seenAllSubtitle?: string;
  emptyTestId?: string;
  seenAllTestId?: string;
  restartTestId?: string;
  mobileDeckTestId?: string;
  /** Prefix for per-card container/next test ids, e.g. "card" -> card-container-X
   *  / card-next-X, "clinic-card" -> clinic-card-container-X. Preserves the
   *  per-type test ids the old decks used. */
  cardTestIdPrefix?: string;
  /** Desktop grid container classes (defaults to the standard 3-col grid). */
  gridClassName?: string;
  /** Optional per-item desktop grid wrapper (e.g. donors attach a
   *  scroll-past-view ref + fixed height). Receives the rendered card. */
  renderGridItem?: (item: T, card: ReactNode, key: string) => ReactNode;
  /** Default desktop grid item height wrapper when renderGridItem is omitted. */
  gridItemClassName?: string;
  /** Pagination preload: called on mobile when within `nearEndWithin` of the end. */
  onNearEnd?: () => void;
  nearEndWithin?: number;
  /** Fired when the mobile active card changes (and on mount). Lets callers
   *  record a view / preload images / paginate against the active index without
   *  owning the index. Memoize it to avoid redundant fires. */
  onActiveChange?: (item: T, index: number) => void;
  /** Rendered after the desktop grid items (e.g. an infinite-scroll sentinel). */
  gridFooter?: ReactNode;
}

const DEFAULT_GRID = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[1200px] mx-auto px-6";

/**
 * The single deck orchestrator for EVERY card type (donors, surrogates, sperm,
 * clinics, doctors, agencies). Mobile = a two-card swipe stack (active card on
 * top, next card pre-mounted static underneath); desktop = a static grid of the
 * same card with swipe disabled. Owns currentIndex + an undo history; all
 * type-specific data, ordering, Redux, and card content stay with the caller via
 * `items` + `renderCard`. Replaces the previously copy-pasted per-type decks.
 */
export function SwipeDeck<T>({
  items,
  getKey,
  renderCard,
  onSave,
  onPass,
  onUndo,
  resetDeps = [],
  dim = false,
  emptyTitle,
  emptySubtitle,
  seenAllTitle,
  seenAllSubtitle,
  emptyTestId,
  seenAllTestId,
  restartTestId,
  mobileDeckTestId,
  gridClassName,
  renderGridItem,
  gridItemClassName = "h-[600px]",
  onNearEnd,
  nearEndWithin = 10,
  cardTestIdPrefix = "card",
  onActiveChange,
  gridFooter,
}: SwipeDeckProps<T>) {
  const isMobile = useIsMobile();
  const [currentIndex, setCurrentIndex] = useState(0);
  // Stack of acted keys (most recent last) for the mobile back button, plus the
  // key to pin to the front of the deck after an undo so "back" shows that card.
  const [history, setHistory] = useState<string[]>([]);
  const [pinFrontId, setPinFrontId] = useState<string | null>(null);

  // After an undo, surface the restored card as the current one.
  const ordered = useMemo(() => {
    if (!pinFrontId) return items;
    const i = items.findIndex((it) => getKey(it) === pinFrontId);
    if (i <= 0) return items;
    const arr = [...items];
    const [item] = arr.splice(i, 1);
    arr.unshift(item);
    return arr;
  }, [items, pinFrontId, getKey]);

  useEffect(() => {
    setCurrentIndex(0);
    setHistory([]);
    setPinFrontId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps);

  // Notify when the mobile active card changes (record view / preload / paginate).
  useEffect(() => {
    if (!isMobile || !onActiveChange) return;
    const active = ordered[currentIndex];
    if (active) onActiveChange(active, currentIndex);
  }, [isMobile, currentIndex, ordered, onActiveChange]);

  // Saving/passing removes the card from `items` upstream (saved + passed are
  // hidden from Explore), which auto-advances - so we do NOT bump the index
  // (that would skip the previewed card). We only record it for the back button.
  const doSave = (key: string) => { onSave(key); setHistory((h) => [...h, key]); setPinFrontId(null); };
  const doPass = (key: string) => { onPass(key); setHistory((h) => [...h, key]); setPinFrontId(null); };
  const goBack = () => {
    const lastId = history[history.length - 1];
    if (!lastId) return;
    onUndo(lastId);
    setHistory((h) => h.slice(0, -1));
    setPinFrontId(lastId);
  };

  if (ordered.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground" data-testid={emptyTestId}>
        <p className="text-lg font-ui">{emptyTitle}</p>
        {emptySubtitle && <p className="text-sm">{emptySubtitle}</p>}
      </div>
    );
  }

  if (isMobile) {
    if (currentIndex >= ordered.length) {
      return (
        <div className="py-16 text-center text-muted-foreground" data-testid={seenAllTestId}>
          <p className="text-lg font-ui">{seenAllTitle}</p>
          {seenAllSubtitle && <p className="text-sm mt-2">{seenAllSubtitle}</p>}
          <Button variant="outline" className="mt-4" onClick={() => setCurrentIndex(0)} data-testid={restartTestId}>
            Start Over
          </Button>
        </div>
      );
    }

    if (onNearEnd && ordered.length - currentIndex <= nearEndWithin) onNearEnd();

    const current = ordered[currentIndex];
    const next = currentIndex + 1 < ordered.length ? ordered[currentIndex + 1] : null;
    const curKey = getKey(current);
    const nextKey = next ? getKey(next) : null;

    return (
      <div className="h-full" data-testid={mobileDeckTestId}>
        {/* No wrapper grayscale in the skipped view - the passed card dims
            itself (opacity, no grayscale) so its yellow restore control stays
            vivid instead of being desaturated into grey. */}
        <div className="relative h-full w-full">
          {next && nextKey && (
            <div key={`next-${nextKey}`} className="absolute inset-0 z-0" data-testid={`${cardTestIdPrefix}-next-${nextKey}`}>
              {renderCard(next, "preview", { onSave: () => {}, onPass: () => {} })}
            </div>
          )}
          <div key={`cur-${curKey}`} className="absolute inset-0 z-10" data-testid={`${cardTestIdPrefix}-container-${curKey}`}>
            {renderCard(current, "active", {
              onSave: () => doSave(curKey),
              onPass: () => doPass(curKey),
              onUndo: history.length > 0 ? goBack : undefined,
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={gridClassName || DEFAULT_GRID}>
      {ordered.map((item) => {
        const key = getKey(item);
        const card = renderCard(item, "grid", {
          onSave: () => doSave(key),
          onPass: () => doPass(key),
          // Desktop grid undo is per-card (the card knows if it's passed); the
          // caller wires it inside renderCard, so expose the same goBack-less api.
          onUndo: undefined,
        });
        if (renderGridItem) return <div key={key}>{renderGridItem(item, card, key)}</div>;
        return (
          <div key={key} className={gridItemClassName} data-testid={`${cardTestIdPrefix}-container-${key}`}>
            {card}
          </div>
        );
      })}
      {gridFooter}
    </div>
  );
}
