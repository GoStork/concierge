/**
 * Picking who to compare.
 *
 * This replaced a permanent bar of name pills sitting above the Saved grid. It
 * was redundant - the profiles were already on screen as cards, so the bar asked
 * a parent to find each one a second time, by ID, in a row that on a phone
 * scrolled sideways and hid its own Compare button off the right edge.
 *
 * So the cards themselves are the control. Compare is one always-visible button;
 * pressing it turns the page into a selection page, and choices collect in a
 * tray at the bottom that only exists once something is in it. Nothing is on
 * screen before it has a job.
 */

import { Check, X, Columns3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import type { SavedCardVisual } from "@/lib/saved-card-visual";

export type CompareCard = SavedCardVisual & { id: string };

/** Dark on the mobile deck, light on the desktop page. */
type Theme = "light" | "dark";

/** The entry point: always visible on Saved, so comparing is never hidden behind a scroll. */
export function CompareLaunchButton({
  onClick,
  theme = "light",
  className,
}: {
  onClick: () => void;
  theme?: Theme;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 transition-colors",
        theme === "dark"
          ? "border-white/25 text-white hover:bg-white/10"
          : "border-primary/30 text-primary hover:bg-secondary",
        className,
      )}
      data-testid="compare-start"
    >
      <Columns3 className="w-4 h-4" aria-hidden />
      <span className="t-micro-value">Compare</span>
    </button>
  );
}

/** The photo tile, shared by the selection grid so selection is shown on the thing being selected. */
function SelectCard({
  card,
  selected,
  disabled,
  onToggle,
}: {
  card: CompareCard;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "relative w-full text-left rounded-[var(--radius)] overflow-hidden bg-[hsl(var(--deck-bg-elevated))] shadow-md transition-all",
        // The ring is the whole card, not a tick in a corner: at two columns on a
        // phone the corner alone was easy to miss while scanning faces.
        selected ? "ring-2 ring-primary ring-offset-2 ring-offset-transparent" : "hover:opacity-95",
        disabled && "opacity-40 cursor-not-allowed",
      )}
      style={{ paddingBottom: "133.333%" }}
      data-testid={`compare-pick-${card.id}`}
    >
      {card.photo ? (
        <img src={card.photo} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" decoding="async" />
      ) : card.logo ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 bg-white">
          <img src={card.logo} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
        </div>
      ) : card.monogramName ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <DoctorMonogram name={card.monogramName} size={72} />
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-white/60 text-xs font-ui">No Photo</div>
      )}

      <div className="absolute inset-x-0 bottom-0 pt-12 pb-2 px-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent">
        <div className="font-ui text-sm font-medium text-white truncate">{card.title}</div>
        {card.subtitle && <div className="font-ui text-xs text-white/80 truncate">{card.subtitle}</div>}
      </div>

      <span
        className={cn(
          "absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-colors",
          selected ? "bg-primary text-primary-foreground" : "bg-black/40 border-2 border-white/70",
        )}
        aria-hidden
      >
        {selected && <Check className="w-4 h-4" strokeWidth={3} />}
      </span>
    </button>
  );
}

/**
 * The selection page. Same cards as Saved, same order - only the tap changes,
 * from "open her" to "add her".
 */
export function CompareSelectGrid({
  cards,
  selectedIds,
  onToggle,
  max,
  theme = "light",
  className,
}: {
  cards: CompareCard[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  max: number;
  theme?: Theme;
  /** The mobile deck scrolls inside a fixed container; the desktop page scrolls itself. */
  className?: string;
}) {
  const atMax = selectedIds.length >= max;
  return (
    <div className={className} data-testid="compare-select-grid">
      <p
        className={cn(
          "px-3 pt-1 pb-2 t-helper",
          theme === "dark" ? "text-white/70" : "text-muted-foreground",
        )}
      >
        {atMax
          ? `That's the maximum of ${max}. Remove one to swap another in.`
          : `Tap up to ${max} to compare them side by side.`}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 px-2 pb-40 content-start">
        {cards.map((card) => {
          const selected = selectedIds.includes(card.id);
          return (
            <SelectCard
              key={card.id}
              card={card}
              selected={selected}
              disabled={!selected && atMax}
              onToggle={() => onToggle(card.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The tray. It appears with the first pick and leaves with the last, so the page
 * never carries an empty container - and it holds the same faces the parent just
 * tapped, at thumbnail size, because a name alone does not confirm you picked
 * the person you meant.
 */
export function CompareTray({
  cards,
  selectedIds,
  onRemove,
  onCompare,
  onCancel,
  className,
}: {
  cards: CompareCard[];
  selectedIds: string[];
  onRemove: (id: string) => void;
  onCompare: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const picked = selectedIds
    .map((id) => cards.find((c) => c.id === id))
    .filter(Boolean) as CompareCard[];
  if (picked.length === 0) return null;

  const ready = picked.length >= 2;

  return (
    <div
      className={cn(
        "z-50 border-t border-border bg-card px-3 py-2.5 shadow-[0_-6px_24px_-12px_rgba(0,0,0,0.35)]",
        className,
      )}
      style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom, 0px))" }}
      data-testid="compare-tray"
    >
      <div className="mx-auto max-w-5xl flex items-center gap-3">
        <div className="flex items-center gap-2 overflow-x-auto flex-1 min-w-0" style={{ scrollbarWidth: "none" }}>
          {picked.map((card) => (
            <div key={card.id} className="relative shrink-0" data-testid={`compare-tray-item-${card.id}`}>
              <div className="w-12 h-12 rounded-full overflow-hidden bg-secondary flex items-center justify-center">
                {card.photo ? (
                  <img src={card.photo} alt="" className="w-full h-full object-cover" />
                ) : card.logo ? (
                  <img src={card.logo} alt="" className="max-w-full max-h-full object-contain p-1 bg-white" />
                ) : card.monogramName ? (
                  <DoctorMonogram name={card.monogramName} size={48} />
                ) : (
                  <span className="t-micro-value text-muted-foreground">?</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(card.id)}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-foreground text-background flex items-center justify-center shadow"
                aria-label={`Remove ${card.title} from the comparison`}
                data-testid={`compare-tray-remove-${card.id}`}
              >
                <X className="w-3 h-3" strokeWidth={3} />
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="t-micro-value text-muted-foreground hover:text-foreground px-1"
            data-testid="compare-cancel"
          >
            Cancel
          </button>
          <Button size="sm" disabled={!ready} onClick={onCompare} data-testid="compare-open">
            {/* One profile cannot be compared with anything, and saying so beats a
                dead button with no explanation. */}
            {ready ? `Compare ${picked.length}` : "Pick 1 more"}
          </Button>
        </div>
      </div>
    </div>
  );
}
