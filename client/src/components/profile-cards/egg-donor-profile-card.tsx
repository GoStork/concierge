import { useQuery } from "@tanstack/react-query";
import { mapDatabaseDonorToSwipeProfile } from "@/components/marketplace/swipe-mappers";
import { SubjectProfileBody } from "./subject-profile-body";

export interface EggDonorProfileCardProps {
  providerId: string | null | undefined;
  subjectProfileId: string | null | undefined;
  fallbackPhotoUrl?: string | null;
  fallbackLabel?: string | null;
  brandColor: string;
  testId?: string;
}

/**
 * Shows an egg donor profile (photo, label, View Full Profile, Overview,
 * Physical Traits, Background & Education, Journey Costs, Personal Interests).
 * Single source of truth - same fields rendered the same way wherever it's used.
 */
export function EggDonorProfileCard({
  providerId,
  subjectProfileId,
  fallbackPhotoUrl,
  fallbackLabel,
  brandColor,
  testId = "egg-donor-profile-card",
}: EggDonorProfileCardProps) {
  const apiPath = providerId && subjectProfileId
    ? `/api/providers/${providerId}/egg-donors/${subjectProfileId}`
    : null;

  const { data: profileData, isLoading } = useQuery<any>({
    queryKey: ["profile-card", "egg-donor", providerId, subjectProfileId],
    queryFn: async () => {
      const res = await fetch(apiPath!, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!apiPath,
    staleTime: 300_000,
  });

  const swipeProfile = profileData ? mapDatabaseDonorToSwipeProfile(profileData) : null;

  return (
    <SubjectProfileBody
      providerId={providerId}
      subjectProfileId={subjectProfileId}
      subjectType="Egg Donor"
      swipeProfile={swipeProfile}
      isLoading={isLoading}
      fallbackPhotoUrl={fallbackPhotoUrl}
      fallbackLabel={fallbackLabel}
      brandColor={brandColor}
      testId={testId}
    />
  );
}
