import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useAppDispatch } from "@/store";
import { setMarketplaceTab } from "@/store/uiSlice";
import { EggDonorIcon, SpermIcon, SurrogateIcon, IvfClinicIcon, DoctorIcon } from "@/components/icons/marketplace-icons";

/**
 * Explore "explode" picker - a monday.com-style fan that blooms 5 provider cards
 * upward from a bottom-centered anchor (the Explore button in the mobile tab bar).
 * Selecting one switches the marketplace to that provider type and navigates there,
 * mirroring exactly what the old top-bar pills did (dispatch -> navigate).
 *
 * Mobile-only (the bottom tab bar it anchors to is `md:hidden`). The parent owns
 * the open/close state and fades the tab bar out while this is open.
 */

// --- Tunable feel (timing/spring/geometry are meant to be adjusted live) -------
// The picked card scales up and the others dim for a beat before everything
// collapses. Set to false to skip straight to collapse + navigate.
const SELECTION_EMPHASIS = true;
const EMPHASIS_MS = 300;

// A bottom-centered trigger can't scatter 360 without going off-screen, so the
// cards bloom across an upward arc (degrees), centered on straight-up.
const ARC_DEGREES = 150;
const RADIUS = 150;        // px from the anchor to each card's resting center
const CARD_LIFT = 72;      // px the whole fan sits above the anchor, clearing the X
const MAX_TILT = 14;       // deg of per-card rotation at the fan's edges
const SPRING = { type: "spring" as const, stiffness: 260, damping: 18 };

type Provider = {
  id: string;            // marketplaceTab id dispatched on select
  label: string;
  Icon: (props: { className?: string }) => JSX.Element;
};

// Left -> right across the fan. All 5 are first-class and symmetric (Doctors via
// Path B), each with a brand line icon.
const PROVIDERS: Provider[] = [
  { id: "egg-donors", label: "Eggs", Icon: EggDonorIcon },
  { id: "sperm-donors", label: "Sperm", Icon: SpermIcon },
  { id: "surrogates", label: "Surrogates", Icon: SurrogateIcon },
  { id: "ivf-clinics", label: "Clinics", Icon: IvfClinicIcon },
  { id: "doctors", label: "Doctors", Icon: DoctorIcon },
];

// Resting offset + tilt for card i. Index 0 sits on the left, last on the right.
function fanPosition(i: number, n: number) {
  const t = n === 1 ? 0.5 : i / (n - 1);              // 0..1 across the fan
  const angleDeg = 90 + ARC_DEGREES / 2 - t * ARC_DEGREES; // left=high deg, right=low
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: Math.cos(rad) * RADIUS,
    y: -(Math.sin(rad) * RADIUS) - CARD_LIFT,          // screen-up is negative
    rotate: (t - 0.5) * 2 * MAX_TILT,                  // -MAX_TILT (left) .. +MAX_TILT (right)
  };
}

export function ExploreProviderPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string | null>(null);

  const handleSelect = (id: string) => {
    if (picked) return;
    const go = () => {
      dispatch(setMarketplaceTab(id));
      navigate("/marketplace");
      onClose();
    };
    if (SELECTION_EMPHASIS) {
      setPicked(id);
      window.setTimeout(go, EMPHASIS_MS);
    } else {
      go();
    }
  };

  const close = () => {
    if (picked) return;
    onClose();
  };

  return (
    <AnimatePresence onExitComplete={() => setPicked(null)}>
      {open && (
        <motion.div className="fixed inset-0 z-[70] md:hidden" data-testid="explore-picker">
          {/* Dimmed tap-to-dismiss backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={close}
            data-testid="explore-backdrop"
          />

          {/* Bottom-centered anchor: cards translate out from here; X lives here too */}
          <div
            className="absolute left-1/2 -translate-x-1/2"
            style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 26px)" }}
          >
            {PROVIDERS.map((p, i) => {
              const pos = fanPosition(i, PROVIDERS.length);
              const isPicked = picked === p.id;
              const isDimmed = picked !== null && !isPicked;
              const { Icon } = p;
              return (
                <motion.button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelect(p.id)}
                  className="absolute bottom-0 left-1/2 flex flex-col items-center gap-1.5 focus:outline-none"
                  style={{ width: 76, marginLeft: -38 }}
                  initial={{ x: 0, y: 0, scale: 0.2, opacity: 0, rotate: 0 }}
                  animate={{
                    x: pos.x,
                    y: pos.y,
                    scale: isPicked ? 1.18 : isDimmed ? 0.92 : 1,
                    opacity: isDimmed ? 0.35 : 1,
                    rotate: pos.rotate,
                  }}
                  exit={{ x: 0, y: 0, scale: 0.2, opacity: 0, rotate: 0 }}
                  transition={{ ...SPRING, delay: picked ? 0 : i * 0.05 }}
                  data-testid={`explore-card-${p.id}`}
                >
                  <span className="w-16 h-16 rounded-2xl bg-card shadow-xl flex items-center justify-center">
                    <Icon className="w-7 h-7 text-primary" />
                  </span>
                  <span className="font-ui text-[11px] font-medium text-white drop-shadow">{p.label}</span>
                </motion.button>
              );
            })}

            {/* Close (X) pinned at the anchor */}
            <motion.button
              type="button"
              onClick={close}
              className="absolute bottom-0 left-1/2 w-14 h-14 rounded-full bg-card shadow-xl flex items-center justify-center focus:outline-none"
              style={{ marginLeft: -28 }}
              initial={{ scale: 0, rotate: -90, opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              exit={{ scale: 0, rotate: -90, opacity: 0 }}
              transition={SPRING}
              aria-label="Close"
              data-testid="explore-close"
            >
              <X className="w-6 h-6 text-foreground" strokeWidth={2.5} />
            </motion.button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
