import { EggDonorProfileCard } from "./egg-donor-profile-card";
import { SpermDonorProfileCard } from "./sperm-donor-profile-card";
import { SurrogateProfileCard } from "./surrogate-profile-card";

export interface SubjectProfileCardProps {
  /** "Egg Donor" | "Sperm Donor" | "Surrogate" - matches Session.subjectType. */
  subjectType: string | null | undefined;
  providerId: string | null | undefined;
  subjectProfileId: string | null | undefined;
  fallbackPhotoUrl?: string | null;
  fallbackLabel?: string | null;
  profileAvailable?: boolean | null;
  profileStatus?: string | null;
  brandColor: string;
  /** Optional sidebar heading rendered above the card (e.g. "Interested Egg Donor"). */
  heading?: string;
  /** When true, the card is wrapped with a top border + margin (suitable for stacking after another sidebar section). */
  withSeparator?: boolean;
  testId?: string;
}

/**
 * Routes to the right per-type profile card based on subjectType. Use this
 * when the caller doesn't know the type at compile time (provider chat,
 * admin concierge monitor, parent chat side panel).
 *
 * Returns null if any required field is missing or the subjectType is unknown.
 */
export function SubjectProfileCard({
  subjectType,
  providerId,
  subjectProfileId,
  fallbackPhotoUrl,
  fallbackLabel,
  profileAvailable,
  profileStatus,
  brandColor,
  heading,
  withSeparator,
  testId,
}: SubjectProfileCardProps) {
  if (!subjectType || !providerId || !subjectProfileId) return null;

  const t = subjectType.toLowerCase();
  const inner = t === "surrogate" ? (
    <SurrogateProfileCard
      providerId={providerId}
      subjectProfileId={subjectProfileId}
      fallbackPhotoUrl={fallbackPhotoUrl}
      fallbackLabel={fallbackLabel}
      profileAvailable={profileAvailable}
      profileStatus={profileStatus}
      brandColor={brandColor}
      testId={testId}
    />
  ) : t.includes("sperm") ? (
    <SpermDonorProfileCard
      providerId={providerId}
      subjectProfileId={subjectProfileId}
      fallbackPhotoUrl={fallbackPhotoUrl}
      fallbackLabel={fallbackLabel}
      profileAvailable={profileAvailable}
      profileStatus={profileStatus}
      brandColor={brandColor}
      testId={testId}
    />
  ) : t.includes("donor") ? (
    <EggDonorProfileCard
      providerId={providerId}
      subjectProfileId={subjectProfileId}
      fallbackPhotoUrl={fallbackPhotoUrl}
      fallbackLabel={fallbackLabel}
      profileAvailable={profileAvailable}
      profileStatus={profileStatus}
      brandColor={brandColor}
      testId={testId}
    />
  ) : null;

  if (!inner) return null;

  if (!heading && !withSeparator) return inner;

  return (
    <div className={withSeparator ? "border-t pt-4 mt-4" : ""}>
      {heading && (
        <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>{heading}</h4>
      )}
      {inner}
    </div>
  );
}
