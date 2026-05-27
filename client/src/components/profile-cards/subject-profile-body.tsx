import { useNavigate } from "react-router-dom";
import { ExternalLink, Loader2 } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { getProfileUrlSlug } from "@/components/chat/chat-utils";
import {
  buildSidebarSections,
  buildTitle,
  pickFirstValidPhoto,
  isExpiredPresignedAwsUrl,
  type SwipeDeckProfile,
} from "@/components/marketplace/swipe-mappers";

export interface SubjectProfileBodyProps {
  /** Provider that owns the profile (used to build the View Full Profile URL and as a render gate). */
  providerId: string | null | undefined;
  /** The donor/surrogate profile ID. */
  subjectProfileId: string | null | undefined;
  /** "Egg Donor" | "Sperm Donor" | "Surrogate" - drives URL slug + section rendering. */
  subjectType: string;
  /** SwipeDeckProfile produced by mapDatabase*ToSwipeProfile, or null while loading. */
  swipeProfile: SwipeDeckProfile | null;
  /** True only when the fetch is in flight AND we have no data to render yet. */
  isLoading: boolean;
  /** Photo URL to show before the swipeProfile arrives (e.g. session thumbnail). */
  fallbackPhotoUrl?: string | null;
  /** Label to show before the swipeProfile arrives (e.g. session title). */
  fallbackLabel?: string | null;
  brandColor: string;
  testId?: string;
}

/**
 * Shared rendering for an egg donor / sperm donor / surrogate profile card.
 *
 * Layout: avatar + label + "View Full Profile" link + the canonical sidebar
 * sections from buildSidebarSections (Overview, Physical Traits, Background &
 * Education, Journey Costs, Medical, Agrees To, Personal Interests).
 *
 * This is an internal building block - call sites should use one of the
 * type-specific cards (EggDonorProfileCard, SpermDonorProfileCard,
 * SurrogateProfileCard) or the SubjectProfileCard switcher.
 */
export function SubjectProfileBody({
  providerId,
  subjectProfileId,
  subjectType,
  swipeProfile,
  isLoading,
  fallbackPhotoUrl,
  fallbackLabel,
  brandColor,
  testId,
}: SubjectProfileBodyProps) {
  const navigate = useNavigate();

  if (!providerId || !subjectProfileId) return null;

  const isSpermDonor = subjectType.toLowerCase().includes("sperm");
  const validFallback = fallbackPhotoUrl && !isExpiredPresignedAwsUrl(fallbackPhotoUrl) ? fallbackPhotoUrl : null;
  const photo = pickFirstValidPhoto(swipeProfile?.photos, swipeProfile?.photoUrl) || validFallback;
  const label = swipeProfile ? buildTitle(swipeProfile) : (fallbackLabel || null);
  const sections = swipeProfile ? buildSidebarSections(swipeProfile, isSpermDonor) : [];

  const slug = getProfileUrlSlug(subjectType);
  const fullProfileUrl = `/${slug}/${providerId}/${subjectProfileId}`;

  return (
    <div data-testid={testId}>
      <div className="flex items-center gap-2.5 mb-2">
        {photo ? (
          <div className="w-10 h-10 rounded-full overflow-hidden bg-muted shrink-0">
            <img
              src={getPhotoSrc(photo) || undefined}
              alt={label || "Profile"}
              className="w-full h-full object-cover object-top"
            />
          </div>
        ) : (
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0"
            style={{ backgroundColor: brandColor }}
          >
            {(label || "?").charAt(0)}
          </div>
        )}
        <p className="text-sm font-semibold leading-tight">{label || "-"}</p>
      </div>
      <button
        type="button"
        className="text-xs flex items-center gap-1 mb-3"
        style={{ color: brandColor }}
        onClick={() => navigate(fullProfileUrl)}
        data-testid={testId ? `${testId}-view-full` : undefined}
      >
        <ExternalLink className="w-3 h-3" />
        View Full Profile
      </button>
      {isLoading && !swipeProfile ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading profile...
        </div>
      ) : (
        sections.map((section, i) => (
          <div key={i} className={i > 0 ? "border-t pt-2 mt-2" : "mt-1"}>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              {section.title}
            </p>
            <div className="space-y-1">
              {section.rows.map((row, j) => (
                <div key={j} className="flex items-center gap-1.5 text-xs">
                  {row.icon && <row.icon className="w-3 h-3 text-muted-foreground shrink-0" />}
                  <span className="text-muted-foreground shrink-0">{row.label}:</span>
                  <span className="text-foreground">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
