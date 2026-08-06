import * as React from "react"

const MOBILE_BREAKPOINT = 768

/**
 * Subscribe to a CSS media query from JS.
 *
 * For LAYOUT you should almost always use a Tailwind breakpoint instead - CSS
 * needs no hydration and cannot flash. This is for the cases where the two
 * sizes render genuinely different STRUCTURE (a vertical ladder vs a
 * horizontal one), which no amount of CSS can turn one into the other.
 *
 * Seeded synchronously rather than in an effect: this is a client-only SPA, so
 * the first paint can already be correct instead of rendering the small layout
 * and snapping.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}

export function useIsMobile() {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
}
