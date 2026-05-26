import type { LucideIcon } from "lucide-react";

export interface ChatPlusAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  /**
   * Optional override for the icon color (any CSS color value, typically a
   * brand CSS variable like `hsl(var(--brand-success))`). When omitted the
   * drawer picks a sensible default based on the action id so each tile gets
   * a distinct, colorful icon (iMessage / WhatsApp style).
   */
  colorVar?: string;
}

interface ChatPlusDrawerProps {
  open: boolean;
  actions: ChatPlusAction[];
  brandColor: string;
}

/**
 * Map of action id -> CSS color expression (all referencing brand tokens
 * defined in `index.css`). Lets the drawer render each tile with a distinct
 * color while respecting the brand system. Anything not in the map falls
 * back to the page's brand color.
 */
const DEFAULT_COLORS: Record<string, string> = {
  photo: "hsl(var(--accent))",
  camera: "hsl(var(--destructive))",
  file: "hsl(var(--primary))",
  meeting: "var(--swipe-chat, hsl(var(--accent)))",
  costSheet: "hsl(var(--brand-success))",
  invoice: "hsl(var(--brand-warning))",
  agreement: "hsl(var(--foreground))",
};

/**
 * Inline-expandable + drawer rendered above the chat composer. Vertical
 * list of full-width rows (iMessage / WhatsApp style), each row showing a
 * filled colored circle icon on the left and a label on the right.
 *
 * Lives ABOVE the composer (not as a popup/modal) so it works identically
 * on desktop and mobile and respects the project's "no modals" guideline.
 */
export function ChatPlusDrawer({ open, actions, brandColor }: ChatPlusDrawerProps) {
  return (
    <div
      className="overflow-hidden transition-[max-height,opacity] duration-200 ease-out"
      style={{
        maxHeight: open ? 480 : 0,
        opacity: open ? 1 : 0,
      }}
      aria-hidden={!open}
      data-testid="chat-plus-drawer"
    >
      <div className="pb-2">
        <ul
          className="inline-block max-w-full rounded-2xl border bg-card shadow-md py-1.5"
          role="menu"
          style={{ minWidth: 220 }}
        >
          {actions.map((action) => {
            const Icon = action.icon;
            const color = action.colorVar || DEFAULT_COLORS[action.id] || brandColor;
            return (
              <li key={action.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  data-testid={action.testId || `plus-action-${action.id}`}
                  className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/60 active:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-ui rounded-lg"
                >
                  <span
                    className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white"
                    style={{ backgroundColor: color }}
                  >
                    <Icon className="w-[18px] h-[18px]" strokeWidth={2.25} />
                  </span>
                  <span className="text-[15px] font-medium text-foreground pr-3">
                    {action.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
