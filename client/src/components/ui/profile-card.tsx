import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ProfileCardProps {
  imageUrl: string;
  title: string;
  subtitle: string;
  actionNode?: ReactNode;
  className?: string;
}

export function ProfileCard({
  imageUrl,
  title,
  subtitle,
  actionNode,
  className,
}: ProfileCardProps) {
  return (
    <div
      data-testid="profile-card"
      className={cn(
        "relative w-full overflow-hidden rounded-2xl aspect-[3/4] group",
        className
      )}
    >
      <img
        src={imageUrl}
        alt={title}
        data-testid="profile-card-image"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
      <div className="absolute bottom-0 left-0 w-full p-5 flex items-end justify-between">
        <div className="flex flex-col">
          <h3
            data-testid="profile-card-title"
            className="text-2xl font-heading text-white leading-tight"
          >
            {title}
          </h3>
          <p
            data-testid="profile-card-subtitle"
            className="text-base font-body text-white/80"
          >
            {subtitle}
          </p>
        </div>
        {actionNode && (
          <div data-testid="profile-card-action">{actionNode}</div>
        )}
      </div>
    </div>
  );
}
