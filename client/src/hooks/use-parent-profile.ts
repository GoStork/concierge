import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";

/**
 * The signed-in parent's profile plus the CDC diagnosis labels derived from it.
 *
 * Shared by the clinic swipe card and the clinic profile page so the
 * personalized "Experience with your needs" section is computed once, the same
 * way, everywhere. Uses the marketplace's existing "/api/parent-profile" query
 * key, so every caller on a page dedupes to a single request.
 *
 * Providers and admins have no parentAccountId - the query stays disabled and
 * both values come back empty, which is what un-personalizes the section.
 */
export function useParentProfile(): { parentProfile: any | null; diagnoses: string[] } {
  const { user } = useAuth();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;

  const { data: parentProfile } = useQuery<any>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const r = await fetch("/api/parent-profile", { credentials: "include" });
      return r.ok ? r.json() : null;
    },
    enabled: !!parentAccountId,
    staleTime: 60000,
  });

  const diagnoses: string[] = useMemo(() => {
    const dx: string[] = Array.isArray(parentProfile?.diagnoses) ? [...parentProfile.diagnoses] : [];
    // Map existing needs/carrier signals to CDC experience labels so a parent who
    // hasn't stated a diagnosis but needs a surrogate / donor still gets a match.
    if (parentProfile?.needsSurrogate === true || /surrogate/i.test(parentProfile?.carrier || "")) {
      if (!dx.includes("Gestational carrier")) dx.push("Gestational carrier");
    }
    if (parentProfile?.needsEggDonor === true || /donor/i.test(parentProfile?.eggSource || "")) {
      if (!dx.includes("Egg or embryo banking")) dx.push("Egg or embryo banking");
    }
    return dx;
  }, [parentProfile]);

  return { parentProfile: parentProfile ?? null, diagnoses };
}
