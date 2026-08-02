import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// Drag-to-corner behavior for the FaceTime PiP frames. Listeners go on
// window from pointerdown onward - element-level pointermove + capture was
// unreliable on iOS Safari (drags simply didn't track). The element needs
// touch-action: none so Safari doesn't steal the gesture for scrolling.
//
// A release without meaningful movement counts as a TAP (onTap), so the same
// surface can be both draggable and tappable.

export type PipCorner = "tl" | "tr" | "bl" | "br";

export function useCornerDrag(initial: PipCorner, onTap?: () => void) {
  const [corner, setCorner] = useState<PipCorner>(initial);
  const ref = useRef<HTMLDivElement | null>(null);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      el.style.transform = "";
      if (moved) {
        const left = ev.clientX < window.innerWidth / 2;
        const top = ev.clientY < window.innerHeight / 2;
        setCorner(top ? (left ? "tl" : "tr") : left ? "bl" : "br");
      } else {
        onTapRef.current?.();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  return { ref, corner, onPointerDown };
}
