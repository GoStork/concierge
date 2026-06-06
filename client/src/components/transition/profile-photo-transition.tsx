import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type Rect = { top: number; left: number; width: number; height: number; radius?: number };

type TransitionState = {
  src: string;
  fromRect: Rect;
  id: string;
};

type Ctx = {
  startTransition: (src: string, fromRect: Rect) => void;
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

const GROW_MS = 320;
const HOLD_MS = 280;

export function ProfilePhotoTransitionProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<TransitionState | null>(null);

  const startTransition = useCallback((src: string, fromRect: Rect) => {
    setActive({ src, fromRect, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
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
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[100] pointer-events-none"
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
                top: 0,
                left: 0,
                width: "100vw",
                height: "100vh",
                borderRadius: 0,
              }}
              transition={{ duration: GROW_MS / 1000, ease: [0.32, 0.72, 0.2, 1] }}
              className="fixed overflow-hidden bg-black"
              style={{ willChange: "top,left,width,height,border-radius" }}
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
