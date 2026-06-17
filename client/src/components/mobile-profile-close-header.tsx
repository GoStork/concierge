import { ArrowDown } from "lucide-react";

/**
 * Mobile-only green circular down-arrow that closes (navigates back from) a full
 * profile page, mirroring the egg-donor / surrogate detail close control. Render
 * it at the top-right of the profile header and hide the desktop "Back" text row
 * on mobile.
 */
export function MobileCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      className="shrink-0 w-10 h-10 rounded-full bg-[hsl(var(--brand-success))] hover:brightness-110 shadow-lg flex items-center justify-center transition-all"
      data-testid="button-mobile-back-down"
      aria-label="Close profile"
    >
      <ArrowDown className="w-5 h-5 text-white" strokeWidth={2.5} />
    </button>
  );
}
