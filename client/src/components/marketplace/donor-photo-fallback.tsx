import { User } from "lucide-react";

/**
 * Branded "anonymous" avatar shown when a donor/surrogate has no usable photo
 * (the source profile is anonymous, or a stored photo URL 404s). Mirrors the
 * silhouette placeholder source sites use, but rendered from the GoStork brand
 * palette so a photo-less card reads as intentional - never a broken image.
 *
 * Fills its parent (w-full/h-full), so it works as both a swipe-card hero and a
 * detail-page hero. All colors come from brand CSS variables.
 */
export function DonorPhotoFallback({
  className = "",
  testId = "donor-photo-fallback",
}: {
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={`w-full h-full flex items-center justify-center bg-gradient-to-br from-[hsl(var(--secondary))] via-[hsl(var(--secondary))] to-[hsl(var(--muted))] ${className}`}
      data-testid={testId}
    >
      <User
        className="text-[hsl(var(--primary)/0.30)]"
        style={{ width: "42%", height: "42%" }}
        strokeWidth={1.25}
        aria-hidden
      />
    </div>
  );
}
