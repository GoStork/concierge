import { User, EyeOff, Eye, Pencil, Crown, Award, Trash2, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getPhotoSrc, getProfileTypeLabel, getProfileCardSummary, getProfileDetails } from "@/lib/profile-utils";
import type { ProfileType } from "@/lib/profile-utils";

interface AdminControls {
  onToggleVisibility: (profileId: string, hidden: boolean) => void;
  onTogglePremium: (profileId: string, premium: boolean) => void;
  onEdit?: (profileId: string) => void;
  onDelete?: (profileId: string) => void;
  isHidden: boolean;
  isPremium: boolean;
}

interface ProfileCardProps {
  profile: any;
  type: ProfileType;
  onNavigate?: () => void;
  variant: "marketplace" | "admin";
  showNewBadge?: boolean;
  adminControls?: AdminControls;
  matchReasons?: string[];
}

function NewBadge({ profileId }: { profileId: string }) {
  return (
    <div className="absolute -top-4 -right-4 flex flex-col items-center pointer-events-none z-20" style={{ width: 64, height: 80 }} data-testid={`badge-new-${profileId}`}>
      <div className="rounded-full bg-card flex items-center justify-center shadow-lg z-10" style={{ width: 48, height: 48, border: "1px solid hsl(var(--accent))" }}>
        <span className="font-heading tracking-wide" style={{ fontSize: 13, color: "hsl(var(--accent))" }}>NEW</span>
      </div>
      <svg width="56" height="32" viewBox="0 0 56 32" className="-mt-3 z-0">
        <defs>
          <radialGradient id={`bowL-${profileId}`} cx="0.35" cy="0.4" r="0.7">
            <stop offset="0%" stopColor="hsl(var(--brand-success) / 0.4)" />
            <stop offset="45%" stopColor="hsl(var(--brand-success) / 0.6)" />
            <stop offset="100%" stopColor="hsl(var(--brand-success) / 0.8)" />
          </radialGradient>
          <radialGradient id={`bowR-${profileId}`} cx="0.65" cy="0.4" r="0.7">
            <stop offset="0%" stopColor="hsl(var(--brand-success) / 0.4)" />
            <stop offset="45%" stopColor="hsl(var(--brand-success) / 0.6)" />
            <stop offset="100%" stopColor="hsl(var(--brand-success) / 0.8)" />
          </radialGradient>
          <radialGradient id={`bowK-${profileId}`} cx="0.5" cy="0.3" r="0.6">
            <stop offset="0%" stopColor="hsl(var(--brand-success) / 0.6)" />
            <stop offset="100%" stopColor="hsl(var(--brand-success))" />
          </radialGradient>
          <linearGradient id={`bowTail-${profileId}`} x1="0.5" y1="0" x2="0.5" y2="1">
            <stop offset="0%" stopColor="hsl(var(--brand-success) / 0.7)" />
            <stop offset="100%" stopColor="hsl(var(--brand-success))" />
          </linearGradient>
        </defs>
        <path d="M28 10 C24 4, 16 0, 7 3 C2 5, 0 9, 2 13 C4 17, 13 17, 20 14 C24 12, 27 10, 28 10Z" fill={`url(#bowL-${profileId})`} />
        <path d="M28 10 C32 4, 40 0, 49 3 C54 5, 56 9, 54 13 C52 17, 43 17, 36 14 C32 12, 29 10, 28 10Z" fill={`url(#bowR-${profileId})`} />
        <path d="M7 3 C10 7, 15 8, 20 7 C16 5, 11 3, 7 3Z" fill="hsl(var(--brand-success))" opacity="0.35" />
        <path d="M49 3 C46 7, 41 8, 36 7 C40 5, 45 3, 49 3Z" fill="hsl(var(--brand-success))" opacity="0.35" />
        <path d="M4 8 C8 6, 14 8, 18 11" stroke="hsl(var(--brand-success) / 0.3)" strokeWidth="1.2" fill="none" opacity="0.6" strokeLinecap="round" />
        <path d="M52 8 C48 6, 42 8, 38 11" stroke="hsl(var(--brand-success) / 0.3)" strokeWidth="1.2" fill="none" opacity="0.6" strokeLinecap="round" />
        <path d="M10 11 C14 14, 20 12, 22 13" stroke="hsl(var(--brand-success))" strokeWidth="0.7" fill="none" opacity="0.3" />
        <path d="M46 11 C42 14, 36 12, 34 13" stroke="hsl(var(--brand-success))" strokeWidth="0.7" fill="none" opacity="0.3" />
        <ellipse cx="28" cy="11" rx="5" ry="5" fill={`url(#bowK-${profileId})`} />
        <path d="M25 10 C26 8, 30 8, 31 10" stroke="hsl(var(--brand-success) / 0.3)" strokeWidth="0.8" fill="none" opacity="0.5" />
        <path d="M25 15 L28 31 L31 15 C29.5 17, 26.5 17, 25 15Z" fill={`url(#bowTail-${profileId})`} />
        <path d="M27 18 L28 31 L29 18" fill="hsl(var(--brand-success))" opacity="0.25" />
      </svg>
    </div>
  );
}

export function ProfileCard({ profile, type, onNavigate, variant, showNewBadge, adminControls, matchReasons }: ProfileCardProps) {
  let photoUrl = getPhotoSrc(profile.photoUrl);
  if (!photoUrl && Array.isArray(profile.photos)) {
    for (const p of profile.photos) {
      const src = getPhotoSrc(p);
      if (src) { photoUrl = src; break; }
    }
  }
  const rawId = profile.externalId || profile.id.slice(0, 8);
  const displayId = rawId.startsWith("pdf-") ? rawId.replace(/^pdf-/, "") : rawId;
  const typeLabel = getProfileTypeLabel(type);
  const isHidden = adminControls?.isHidden ?? false;
  const isMarketplace = variant === "marketplace";

  return (
    <Card
      data-testid={isMarketplace ? `card-profile-${profile.id}` : `card-${type}-${profile.id}`}
      className="group relative cursor-pointer hover:shadow-lg hover:border-primary/30 transition-all duration-200 flex flex-col"
      onClick={onNavigate}
    >
      {showNewBadge && <NewBadge profileId={profile.id} />}

      <div className="relative aspect-[3/4] bg-muted overflow-hidden" style={{ borderTopLeftRadius: 'var(--container-radius)', borderTopRightRadius: 'var(--container-radius)' }}>
        {photoUrl ? (
          <img
            src={photoUrl}
            alt={`${typeLabel} #${displayId}`}
            className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ${isHidden ? "opacity-50 grayscale" : ""}`}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <User className="w-12 h-12 text-muted-foreground/60" />
          </div>
        )}
        {isHidden && (
          <div className="absolute top-2 left-2 z-10" data-testid={`badge-hidden-${profile.id}`}>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-heading bg-[hsl(var(--brand-warning))] text-white shadow">
              <EyeOff className="w-3 h-3" />
              HIDDEN
            </span>
          </div>
        )}
        {(profile.isPremium || adminControls?.isPremium) && (
          <div className={`absolute ${isHidden ? "top-9" : "top-2"} left-2 z-10`} data-testid={`badge-premium-${profile.id}`}>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-heading bg-[hsl(var(--brand-warning))] text-white shadow">
              <Crown className="w-3 h-3" />
              PREMIUM
            </span>
          </div>
        )}
        {profile.isExperienced && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3 pt-8 flex items-end justify-end">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-heading bg-[hsl(var(--brand-warning))] text-white shadow">
              <Award className="w-3 h-3" />
              Experienced
            </span>
          </div>
        )}
      </div>

      {isMarketplace ? (
        <div className="p-3 flex-1 space-y-1.5">
          <h4 className="font-heading text-sm text-primary truncate" data-testid={`text-profile-name-${profile.id}`}>
            {typeLabel} #{displayId}
          </h4>
          {profile.provider?.name && (
            <p className="text-[11px] text-muted-foreground truncate">{profile.provider.name}</p>
          )}
          <div className="flex flex-wrap gap-1 pt-0.5">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{typeLabel}</Badge>
            {profile.donorType && profile.donorType !== type && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">{profile.donorType}</Badge>
            )}
          </div>
          <div className="space-y-1 pt-1">
            {getProfileCardSummary(profile, type).map(({ label, value }) => (
              <p key={label} className="text-xs leading-snug truncate">
                <span className="text-[10px] text-muted-foreground">{label}</span>{" "}
                <span className="font-ui text-foreground">{value}</span>
              </p>
            ))}
          </div>
          {matchReasons && matchReasons.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border/50 space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Why This Match</p>
              {matchReasons.map((reason, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs">
                  <Check className="w-3 h-3 text-primary flex-shrink-0 mt-0.5" />
                  <span className="text-foreground leading-snug">{reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="p-3 space-y-1 flex-1">
          <h4 className="font-heading text-sm text-foreground mb-1.5">{typeLabel} #{displayId}</h4>
          {getProfileDetails(profile, type).map(({ label, value }) => (
            <p key={label} className="text-xs leading-snug truncate">
              <span className="font-heading text-foreground">{label}:</span>{" "}
              <span className="text-muted-foreground">{value}</span>
            </p>
          ))}
        </div>
      )}

      <div className="p-3 pt-0 flex gap-2">
        <button
          className="flex-1 py-2 rounded-lg text-xs font-ui text-primary-foreground bg-primary hover:bg-primary/90 transition-colors"
          onClick={(e) => { e.stopPropagation(); onNavigate?.(); }}
          data-testid={isMarketplace ? `button-view-profile-${profile.id}` : `btn-view-${type}-${profile.id}`}
        >
          {isMarketplace ? "View Profile" : "VIEW"}
        </button>
        {adminControls && (
          <>
            {adminControls.onEdit && (
              <button
                className="py-2 px-3 rounded-lg text-xs font-ui border border-primary/30 text-primary hover:bg-primary/10 transition-colors"
                onClick={(e) => { e.stopPropagation(); adminControls.onEdit!(profile.id); }}
                data-testid={`btn-edit-${type}-${profile.id}`}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              className={`py-2 px-3 rounded-lg text-xs font-ui border transition-colors ${
                adminControls.isPremium
                  ? "border-[hsl(var(--brand-warning))]/50 text-[hsl(var(--brand-warning))] bg-[hsl(var(--brand-warning))]/10 hover:bg-[hsl(var(--brand-warning))]/15"
                  : "border-primary/30 text-primary hover:bg-primary/10"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                adminControls.onTogglePremium(profile.id, !adminControls.isPremium);
              }}
              title={adminControls.isPremium ? "Premium — click to remove" : "Not premium — click to mark as Premium"}
              data-testid={`btn-toggle-premium-${type}-${profile.id}`}
            >
              <Crown className="w-3.5 h-3.5" />
            </button>
            <button
              className={`py-2 px-3 rounded-lg text-xs font-ui border transition-colors ${
                isHidden
                  ? "border-[hsl(var(--brand-warning)/0.3)] text-[hsl(var(--brand-warning))] bg-[hsl(var(--brand-warning)/0.08)] hover:bg-[hsl(var(--brand-warning)/0.12)]"
                  : "border-primary/30 text-primary hover:bg-primary/10"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                adminControls.onToggleVisibility(profile.id, !isHidden);
              }}
              title={isHidden ? "Hidden from parent search — click to make visible" : "Visible to parents — click to hide from search"}
              data-testid={`btn-toggle-visibility-${type}-${profile.id}`}
            >
              {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
            {adminControls.onDelete && (
              <button
                className="py-2 px-3 rounded-lg text-xs font-ui border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  adminControls.onDelete!(profile.id);
                }}
                title="Delete this profile"
                data-testid={`btn-delete-${type}-${profile.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
