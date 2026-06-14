import type { ReactNode } from "react";

interface IconProps {
  className?: string;
}

// Provider line icons (unified-family set) - same glyph family as the gradient
// badges used on mobile, but stroke="currentColor" so they follow the desktop top
// nav's active/inactive color. No hardcoded color: they inherit from the parent.
function ProviderGlyph({ className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

export function EggDonorIcon({ className }: IconProps) {
  return (
    <ProviderGlyph className={className}>
      <path d="M12 3.8 C 8.7 3.8 6.5 8.9 6.5 12.9 a5.5 5.5 0 0 0 11 0 C 17.5 8.9 15.3 3.8 12 3.8 Z" />
      <path d="M9.6 8.5 c -0.6 0.95 -1 2.05 -1.1 3.2" />
    </ProviderGlyph>
  );
}

export function SurrogateIcon({ className }: IconProps) {
  return (
    <ProviderGlyph className={className}>
      <circle cx="10" cy="4" r="1.9" />
      <path d="M8.9 6.5 C 8.1 7.7 8.3 9.2 8.3 10.6 C 8.3 13.5 8.2 16.6 8.5 19.3 L 12.2 19.3 C 12.4 18.1 12.5 17.4 12.5 16.7 C 14.7 16.1 15.5 14.3 15.5 12.6 C 15.5 10.3 13.8 8.7 11.5 8.3 C 10.8 7.4 10 6.8 8.9 6.5 Z" />
      <circle cx="12.6" cy="12.9" r="1.45" />
    </ProviderGlyph>
  );
}

export function IvfClinicIcon({ className }: IconProps) {
  return (
    <ProviderGlyph className={className}>
      <path d="M4.8 19.6 V 11.3 H 9.3 V 8.3 H 14.7 V 11.3 H 19.2 V 19.6 Z" />
      <path d="M3.7 19.6 H 20.3" />
      <circle cx="12" cy="5.8" r="1.95" />
      <path d="M12 4.7 V 6.9 M 10.9 5.8 H 13.1" />
      <path d="M10.55 19.6 V 14.5 H 13.45 V 19.6" />
      <rect x="6.15" y="13" width="1.7" height="1.7" rx="0.3" />
      <rect x="16.15" y="13" width="1.7" height="1.7" rx="0.3" />
    </ProviderGlyph>
  );
}

export function SpermIcon({ className }: IconProps) {
  return (
    <ProviderGlyph className={className}>
      <ellipse cx="12" cy="6" rx="2.45" ry="3.2" transform="rotate(12 12 6)" />
      <path d="M11.3 8.9 C 13.7 10.6 9.7 12.3 12 14 C 14.3 15.7 10.3 17.4 12 19.4" />
    </ProviderGlyph>
  );
}

export function DoctorIcon({ className }: IconProps) {
  return (
    <ProviderGlyph className={className}>
      <circle cx="12" cy="6.4" r="2.55" />
      <path d="M6.3 19.5 C 6.3 15.7 8.85 13.1 12 13.1 s 5.7 2.6 5.7 6.4" />
      <path d="M12 13.2 L 10.45 15.9 M 12 13.2 L 13.55 15.9" />
      <path d="M9.7 13.6 c -0.45 2.25 0.45 3.9 2.1 4.05" />
      <circle cx="13.5" cy="17.1" r="0.95" />
    </ProviderGlyph>
  );
}

export function AgencyIcon({ className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="4" y="6" width="16" height="16" rx="2" />
      <path d="M9 2v4" />
      <path d="M15 2v4" />
      <path d="M8 10h3v3H8z" />
      <path d="M13 10h3v3h-3z" />
      <path d="M8 16h3v6H8z" />
      <path d="M13 16h3v6h-3z" />
    </svg>
  );
}
