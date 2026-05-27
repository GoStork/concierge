import { useQuery } from "@tanstack/react-query";
import { mapDatabaseSpermDonorToSwipeProfile } from "@/components/marketplace/swipe-mappers";
import { SubjectProfileBody } from "./subject-profile-body";

export interface SpermDonorProfileCardProps {
  providerId: string | null | undefined;
  subjectProfileId: string | null | undefined;
  fallbackPhotoUrl?: string | null;
  fallbackLabel?: string | null;
  brandColor: string;
  testId?: string;
}

/**
 * Shows a sperm donor profile (photo, label, View Full Profile, Overview,
 * Physical Traits, Background & Education, Journey Costs vial pricing,
 * Personal Interests). Single source of truth.
 */
export function SpermDonorProfileCard({
  providerId,
  subjectProfileId,
  fallbackPhotoUrl,
  fallbackLabel,
  brandColor,
  testId = "sperm-donor-profile-card",
}: SpermDonorProfileCardProps) {
  const apiPath = providerId && subjectProfileId
    ? `/api/providers/${providerId}/sperm-donors/${subjectProfileId}`
    : null;

  const { data: profileData, isLoading } = useQuery<any>({
    queryKey: ["profile-card", "sperm-donor", providerId, subjectProfileId],
    queryFn: async () => {
      const res = await fetch(apiPath!, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!apiPath,
    staleTime: 300_000,
  });

  const swipeProfile = profileData ? mapDatabaseSpermDonorToSwipeProfile(profileData) : null;

  return (
    <SubjectProfileBody
      providerId={providerId}
      subjectProfileId={subjectProfileId}
      subjectType="Sperm Donor"
      swipeProfile={swipeProfile}
      isLoading={isLoading}
      fallbackPhotoUrl={fallbackPhotoUrl}
      fallbackLabel={fallbackLabel}
      brandColor={brandColor}
      testId={testId}
    />
  );
}
