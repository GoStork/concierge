interface BadgeProps {
  className?: string;
}

/**
 * Finished gradient provider badges (gradient-badge-06 set) - each is a complete
 * circular badge: per-type gradient background + white line glyph. Used on mobile
 * (the Explore explode picker). They are the full visual, so render them directly
 * (no extra tile/background wrapper). Size via className (e.g. "w-16 h-16").
 */

export function EggsBadge({ className }: BadgeProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Eggs" className={className}>
      <defs>
        <linearGradient id="g-eggs" x1="14" y1="6" x2="50" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e87396" />
          <stop offset="1" stopColor="#c24168" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#g-eggs)" />
      <g transform="translate(32 32) scale(1.4) translate(-12 -12)" fill="none" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.8 C 8.7 3.8 6.5 8.9 6.5 12.9 a5.5 5.5 0 0 0 11 0 C 17.5 8.9 15.3 3.8 12 3.8 Z" />
        <path d="M9.6 8.5 c -0.6 0.95 -1 2.05 -1.1 3.2" />
      </g>
    </svg>
  );
}

export function SpermBadge({ className }: BadgeProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Sperm" className={className}>
      <defs>
        <linearGradient id="g-sperm" x1="14" y1="6" x2="50" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#689ed7" />
          <stop offset="1" stopColor="#3571af" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#g-sperm)" />
      <g transform="translate(32 32) scale(1.4) translate(-12 -12)" fill="none" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="6" rx="2.45" ry="3.2" transform="rotate(12 12 6)" />
        <path d="M11.3 8.9 C 13.7 10.6 9.7 12.3 12 14 C 14.3 15.7 10.3 17.4 12 19.4" />
      </g>
    </svg>
  );
}

export function SurrogateBadge({ className }: BadgeProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Surrogates" className={className}>
      <defs>
        <linearGradient id="g-surrogate" x1="14" y1="6" x2="50" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8fba68" />
          <stop offset="1" stopColor="#5f8f35" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#g-surrogate)" />
      <g transform="translate(32 32) scale(1.4) translate(-12 -12)" fill="none" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="4" r="1.9" />
        <path d="M8.9 6.5 C 8.1 7.7 8.3 9.2 8.3 10.6 C 8.3 13.5 8.2 16.6 8.5 19.3 L 12.2 19.3 C 12.4 18.1 12.5 17.4 12.5 16.7 C 14.7 16.1 15.5 14.3 15.5 12.6 C 15.5 10.3 13.8 8.7 11.5 8.3 C 10.8 7.4 10 6.8 8.9 6.5 Z" />
        <circle cx="12.6" cy="12.9" r="1.45" />
      </g>
    </svg>
  );
}

export function ClinicsBadge({ className }: BadgeProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Clinics" className={className}>
      <defs>
        <linearGradient id="g-clinics" x1="14" y1="6" x2="50" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#48a097" />
          <stop offset="1" stopColor="#117269" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#g-clinics)" />
      <g transform="translate(32 32) scale(1.4) translate(-12 -12)" fill="none" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.8 19.6 V 11.3 H 9.3 V 8.3 H 14.7 V 11.3 H 19.2 V 19.6 Z" />
        <path d="M3.7 19.6 H 20.3" />
        <circle cx="12" cy="5.8" r="1.95" />
        <path d="M12 4.7 V 6.9 M 10.9 5.8 H 13.1" />
        <path d="M10.55 19.6 V 14.5 H 13.45 V 19.6" />
        <rect x="6.15" y="13" width="1.7" height="1.7" rx="0.3" />
        <rect x="16.15" y="13" width="1.7" height="1.7" rx="0.3" />
      </g>
    </svg>
  );
}

export function DoctorsBadge({ className }: BadgeProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Doctors" className={className}>
      <defs>
        <linearGradient id="g-doctors" x1="14" y1="6" x2="50" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9c93e4" />
          <stop offset="1" stopColor="#6e64bd" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#g-doctors)" />
      <g transform="translate(32 32) scale(1.4) translate(-12 -12)" fill="none" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="6.4" r="2.55" />
        <path d="M6.3 19.5 C 6.3 15.7 8.85 13.1 12 13.1 s 5.7 2.6 5.7 6.4" />
        <path d="M12 13.2 L 10.45 15.9 M 12 13.2 L 13.55 15.9" />
        <path d="M9.7 13.6 c -0.45 2.25 0.45 3.9 2.1 4.05" />
        <circle cx="13.5" cy="17.1" r="0.95" />
      </g>
    </svg>
  );
}
