import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type Rect = { top: number; left: number; width: number; height: number; radius?: number };

type TransitionState = {
  src: string;
  fromRect: Rect;
  toRect: Rect;
  id: string;
};

type Ctx = {
  startTransition: (src: string, fromRect: Rect, toRect: Rect) => void;
  endTransition: () => void;
  active: TransitionState | null;
};

const ProfilePhotoTransitionContext = createContext<Ctx | null>(null);

export function useProfilePhotoTransition() {
  const ctx = useContext(ProfilePhotoTransitionContext);
  if (!ctx) {
    return { startTransition: () => {}, endTransition: () => {}, active: null } as Ctx;
  }
  return ctx;
}

const GROW_MS = 350;
const HOLD_MS = 400;
const FADE_MS = 140;
const EASE_OUT: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];

export function ProfilePhotoTransitionProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<TransitionState | null>(null);

  const startTransition = useCallback((src: string, fromRect: Rect, toRect: Rect) => {
    setActive({ src, fromRect, toRect, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  }, []);

  const endTransition = useCallback(() => {
    setActive(null);
  }, []);

  useEffect(() => {
    if (!active) return;
    const total = GROW_MS + HOLD_MS;
    const t = window.setTimeout(() => setActive(null), total);
    return () => window.clearTimeout(t);
  }, [active]);

  return (
    <ProfilePhotoTransitionContext.Provider value={{ startTransition, endTransition, active }}>
      {children}
      <AnimatePresence>
        {active && (
          <motion.div
            key={active.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: FADE_MS / 1000, ease: EASE_OUT }}
            className="fixed inset-0 z-[100] pointer-events-none"
            style={{ backgroundColor: "hsl(var(--deck-bg))" }}
            data-testid="profile-photo-transition"
          >
            <motion.div
              initial={{
                top: active.fromRect.top,
                left: active.fromRect.left,
                width: active.fromRect.width,
                height: active.fromRect.height,
                borderRadius: active.fromRect.radius ?? 24,
              }}
              animate={{
                top: active.toRect.top,
                left: active.toRect.left,
                width: active.toRect.width,
                height: active.toRect.height,
                borderRadius: active.toRect.radius ?? 0,
              }}
              transition={{ duration: GROW_MS / 1000, ease: EASE_OUT }}
              className="fixed overflow-hidden"
              style={{ willChange: "top,left,width,height,border-radius", backgroundColor: "hsl(var(--deck-bg))" }}
            >
              <img
                src={active.src}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ProfilePhotoTransitionContext.Provider>
  );
}
