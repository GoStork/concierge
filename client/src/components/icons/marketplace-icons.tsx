interface IconProps {
  className?: string;
}

export function EggDonorIcon({ className }: IconProps) {
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
      <path d="M12 2.5c-4 0-7.5 4.5-7.5 10S8 22 12 22s7.5-5 7.5-9.5S16 2.5 12 2.5Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function SurrogateIcon({ className }: IconProps) {
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
      <circle cx="13" cy="3.5" r="2" />
      <line x1="11" y1="5.5" x2="10" y2="16" />
      <path d="M13 5.5 C15 6.5,18 9,18 12 C18 15,15.5 17,13 17" />
      <line x1="10" y1="16" x2="9.5" y2="23" />
      <line x1="13" y1="17" x2="13.5" y2="23" />
      <path d="M11 10 C13 9.5,16 10.5,17 12" />
    </svg>
  );
}

export function IvfClinicIcon({ className }: IconProps) {
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
      <circle cx="12" cy="4" r="2.5" />
      <path d="M8 9.5h8a1 1 0 0 1 1 1V16a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4v-5.5a1 1 0 0 1 1-1Z" />
      <path d="M10 9.5v-1.5c0-.5.5-1 2-1s2 .5 2 1v1.5" />
      <circle cx="12" cy="14" r="1.5" />
      <line x1="12" y1="12.5" x2="12" y2="15.5" />
      <line x1="10.5" y1="14" x2="13.5" y2="14" />
      <line x1="9" y1="20" x2="8.5" y2="23" />
      <line x1="15" y1="20" x2="15.5" y2="23" />
    </svg>
  );
}

export function SpermIcon({ className }: IconProps) {
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
      <ellipse cx="14" cy="8.5" rx="6.5" ry="5" transform="rotate(-35 14 8.5)" />
      <line x1="9.8" y1="13.2" x2="8.4" y2="14.8" />
      <path d="M8.4 14.8 C7.2 16.2, 6.2 17.0, 5.0 18.0 C3.8 19.0, 2.8 19.4, 2.0 21.0" />
    </svg>
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
