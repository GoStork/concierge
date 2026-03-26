/**
 * Green dot overlay for avatars - indicates user is currently online.
 * Place inside a `relative` container (the avatar wrapper).
 * Sizes: "sm" for ~32px avatars, "md" for ~36-44px avatars, "lg" for larger.
 */
export function OnlineIndicator({
  size = "md",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  // sm=12px for ~32px avatars, md=14px for ~36-44px avatars, lg=16px for larger
  const dims = size === "sm" ? "w-3 h-3" : size === "lg" ? "w-4 h-4" : "w-3.5 h-3.5";

  return (
    <span
      className={`absolute -bottom-0.5 -right-0.5 ${dims} rounded-full bg-[hsl(var(--brand-success))] border-2 border-background ${className}`}
    />
  );
}
