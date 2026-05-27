import { useQuery } from "@tanstack/react-query";
import { mapDatabaseSurrogateToSwipeProfile } from "@/components/marketplace/swipe-mappers";
import { SubjectProfileBody } from "./subject-profile-body";

export interface SurrogateProfileCardProps {
  providerId: string | null | undefined;
  subjectProfileId: string | null | undefined;
  fallbackPhotoUrl?: string | null;
  fallbackLabel?: string | null;
  brandColor: string;
  testId?: string;
}

/**
 * Shows a surrogate profile (photo, label, View Full Profile, Overview,
 * Background & Education, Journey Costs, Medical, Agrees To).
 * Single source of truth.
 */
export function SurrogateProfileCard({
  providerId,
  subjectProfileId,
  fallbackPhotoUrl,
  fallbackLabel,
  brandColor,
  testId = "surrogate-profile-card",
}: SurrogateProfileCardProps) {
  const apiPath = providerId && subjectProfileId
    ? `/api/providers/${providerId}/surrogates/${subjectProfileId}`
    : null;

  const { data: profileData, isLoading } = useQuery<any>({
    queryKey: ["profile-card", "surrogate", providerId, subjectProfileId],
    queryFn: async () => {
      const res = await fetch(apiPath!, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!apiPath,
    staleTime: 300_000,
  });

  const swipeProfile = profileData ? mapDatabaseSurrogateToSwipeProfile(profileData) : null;

  return (
    <SubjectProfileBody
      providerId={providerId}
      subjectProfileId={subjectProfileId}
      subjectType="Surrogate"
      swipeProfile={swipeProfile}
      isLoading={isLoading}
      fallbackPhotoUrl={fallbackPhotoUrl}
      fallbackLabel={fallbackLabel}
      brandColor={brandColor}
      testId={testId}
    />
  );
}
