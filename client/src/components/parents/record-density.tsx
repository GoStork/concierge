/**
 * "Am I inside a narrow column?" - answered by the column, read by everything
 * in it.
 *
 * The record page is three columns on desktop: a ~320px contact rail, a wide
 * activity middle, and a ~340px related-objects rail. The components in those
 * rails were all written for a full-width page and lean on `sm:` / `md:`
 * breakpoints to decide when to go side-by-side.
 *
 * Those breakpoints key off the VIEWPORT, not the container. At 1512px every
 * `sm:` and `md:` rule is active, so a row inside a 340px rail happily lays
 * itself out as if it had 700px and overflows. This has already bitten this
 * page once (the vanishing "Profile" title), so the fix is an explicit signal
 * rather than another breakpoint guess.
 *
 * Wrap a narrow column in <DenseColumn>; anything inside can ask useDense().
 */
import { createContext, useContext, type ReactNode } from "react";

const DenseContext = createContext(false);

export function DenseColumn({ children }: { children: ReactNode }) {
  return <DenseContext.Provider value={true}>{children}</DenseContext.Provider>;
}

/** True when rendered inside a narrow record column. */
export function useDense(): boolean {
  return useContext(DenseContext);
}
