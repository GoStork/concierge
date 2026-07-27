import { useEffect, useState } from "react";

/**
 * The value, but settled - it only updates once `delay` ms have passed without
 * a change.
 *
 * Used to split a search box into two speeds: the live value narrows what is
 * already on screen instantly, while the debounced value is what goes into a
 * server query key, so typing "24067" is one request instead of five.
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return settled;
}
