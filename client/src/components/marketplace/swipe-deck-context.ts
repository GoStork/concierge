import { createContext, useContext } from "react";

/** Where a card is being rendered: the active (draggable, top) mobile card, the
 *  inert preview underneath it, or a static desktop grid cell. Lets the caller
 *  wire undo correctly (mobile back vs. per-card undo) the way each deck did. */
export type SwipeDeckCardMode = "active" | "preview" | "grid";

/**
 * The mode SwipeDeck rendered the current card in. SwipeDeckCard reads it so the
 * preview card underneath the active one can render the SAME action row - the
 * preview has swipe disabled (it is not draggable), but it must not drop the
 * Back button, or the parent sees 3 icons flip to 4 the instant the swipe lands
 * and the preview is promoted to active. Cards rendered outside a deck (chat,
 * whisper, standalone) get "grid" and keep the 3-button row.
 */
export const SwipeDeckCardModeContext = createContext<SwipeDeckCardMode>("grid");

export function useSwipeDeckCardMode(): SwipeDeckCardMode {
  return useContext(SwipeDeckCardModeContext);
}
