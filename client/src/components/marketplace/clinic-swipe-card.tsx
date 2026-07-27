import { useState, useEffect, useMemo } from "react";
import { deriveIvfParentContext, evaluateIvfRequirements, ivfRequirementsFromProvider } from "@shared/ivf-requirements";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { getPhotoSrc } from "@/lib/profile-utils";
import { parseInsuranceValue } from "@shared/insurance-data";
import { SwipeDeckCard } from "./swipe-deck-card";
import { getClinicTabs, buildClinicDoctorTab } from "./swipe-mappers";
import { useParentCostItems } from "@/lib/parent-programs";

/**
 * Shared clinic card - the SINGLE clinic SwipeDeckCard used by BOTH the AI
 * matcher (concierge-chat-page ClinicMatchCard) and the marketplace IVF Clinics
 * deck/grid. Self-fetches the provider (with members/doctors) + the parent's
 * matched cost programs, computes the success-rate bars for the given context,
 * and renders the cream cover + doctor-face tabs via getClinicTabs.
 *
 * Callers supply only the providerId + success-rate context + the swipe/action
 * callbacks, so the card looks and behaves identically everywhere.
 */
export function ClinicSwipeCard({
  providerId,
  provider: providerProp,
  eggSource,
  ageGroup,
  isNewPatient,
  reasons = [],
  disableSwipe = false,
  chatMode = false,
  isSaved = false,
  isPassed = false,
  onPass,
  onSave,
  onUndo,
  onViewProfile,
  onMessage,
}: {
  providerId: string;
  // Pre-fetched lean clinic row (from /api/providers/marketplace/clinics). When
  // supplied, the card renders from it with NO per-card /api/providers/:id fetch
  // (the marketplace deck). When omitted (AI chat card), it self-fetches by id.
  provider?: any;
  eggSource?: string;
  ageGroup?: string;
  isNewPatient?: boolean;
  // AI "why this clinic" reasons (matcher only); empty in the marketplace.
  reasons?: string[];
  disableSwipe?: boolean;
  chatMode?: boolean;
  isSaved?: boolean;
  isPassed?: boolean;
  onPass: () => void;
  onSave: () => void;
  onUndo?: () => void;
  onViewProfile: () => void;
  // Opens an AI concierge chat about this clinic (the airplane button). Omitted
  // in chatMode (the card is already inside a chat).
  onMessage?: () => void;
}) {
  const [fetchedProvider, setFetchedProvider] = useState<any>(null);
  const provider = providerProp ?? fetchedProvider;
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;

  // This parent's structured diagnoses (CDC labels) - shared react-query cache
  // (same key the marketplace already uses), so all clinic cards dedupe to one
  // fetch. Drives the personalized "Experience with your needs" tab.
  const { data: parentProfile } = useQuery<any>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const r = await fetch("/api/parent-profile", { credentials: "include" });
      return r.ok ? r.json() : null;
    },
    enabled: !!parentAccountId,
    staleTime: 60000,
  });
  const patientDiagnoses: string[] = useMemo(() => {
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

  useEffect(() => {
    if (providerProp) return; // marketplace supplies the row; skip the per-card fetch
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/providers/${providerId}`, { credentials: "include" });
        if (res.ok && !cancelled) setFetchedProvider(await res.json());
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [providerId, providerProp]);

  // Parent-matched cost programs -> one Costs row per program (name + total),
  // cheapest first. Batched for the whole deck by ParentProgramsProvider; see
  // lib/parent-programs for why this is no longer a per-card fetch.
  const costItems = useParentCostItems(providerId);

  // Phase 4: does this parent meet the clinic's matching requirements?
  // Same shared evaluator the AI search + booking check use. Providers and
  // admins browsing the marketplace get no badge (parentAccountId gate).
  // MUST stay above the !provider early return - in chatMode the provider
  // self-fetch resolves after the first render, and a hook that only appears
  // on later renders crashes React ("Rendered more hooks").
  const requirementsCheck = useMemo(() => {
    if (!parentAccountId || !provider) return null;
    const ctx = deriveIvfParentContext(user as any, parentProfile || null);
    return evaluateIvfRequirements(ivfRequirementsFromProvider(provider), ctx);
  }, [parentAccountId, provider, user, parentProfile]);

  if (!provider) {
    return (
      <div className="w-full h-full rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const cardEggSource = eggSource || "own_eggs";
  const cardAgeGroup = ageGroup || "under_35";
  const cardIsNew = isNewPatient !== undefined ? isNewPatient : true;
  const allRates = provider.ivfSuccessRates || [];

  // Same rate selection as the matcher / providers.controller.ts.
  let rates: any = null;
  if (cardEggSource === "donor") {
    rates = allRates.find((r: any) => r.profileType === "donor" && r.metricCode === "pct_transfers_live_births_donor");
  } else if (cardIsNew) {
    rates = allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === cardAgeGroup && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval")
      || allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === cardAgeGroup && r.metricCode === "pct_intended_retrievals_live_births");
  } else {
    rates = allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === cardAgeGroup && !r.isNewPatient && r.metricCode === "pct_intended_retrievals_live_births");
  }
  if (!rates) {
    rates = allRates.find((r: any) => r.profileType === "own_eggs" && r.ageGroup === "under_35" && r.isNewPatient === true && r.metricCode === "pct_new_patients_live_birth_after_1_retrieval") || null;
  }
  const pct = rates ? Math.round(Number(rates.successRate) * 100) : null;
  const natAvg = rates ? Math.round(Number(rates.nationalAverage) * 100) : null;
  const isTop10 = rates?.top10pct === true;
  // Matched-context volume: exact cycles (CDC denominator) + babies born for the
  // SAME journey (cycles x success rate, since the rate is live births / cycles).
  const matchedCycles = rates && Number(rates.cycleCount) > 0 ? Number(rates.cycleCount) : null;
  const matchedBabies = matchedCycles != null && rates ? Math.round(Number(rates.successRate) * matchedCycles) : null;

  const ageLabel = cardAgeGroup === "under_35" ? "Under 35" : cardAgeGroup === "35_37" ? "35-37" : cardAgeGroup === "38_40" ? "38-40" : "Over 40";
  const contextLabel = cardEggSource === "donor" ? "Donor eggs" : ["Own eggs", ageLabel, cardIsNew ? "First-time IVF" : "Prior cycles"].join(" · ");

  const members: any[] = Array.isArray(provider.members) ? provider.members.filter((m: any) => m?.isPublicProfile !== false) : [];

  // Clinic tabs (Overview / Matched / Costs / Practice / Experience) - all clinic
  // info, shown on cream (photoless) slides. The per-doctor tabs are appended
  // after, each carrying that doctor's face + their own Overview info.
  const clinicTabs = getClinicTabs({
    pct,
    natAvg,
    contextLabel,
    reasons,
    yearFounded: provider.yearFounded ?? null,
    about: provider.about ?? null,
    reviewCount: provider.reviewCount ?? null,
    avgOverallScore: provider.avgOverallScore ?? null,
    matchedCycles,
    matchedBabies,
    locations: provider.locations || [],
    costs: costItems,
    insurances: Array.from(new Set(
      (provider.acceptedInsurance || []).map((v: string) => parseInsuranceValue(v).carrier).filter(Boolean),
    )),
    matching: {
      twinsAllowed: provider.ivfTwinsAllowed ?? null,
      genderSelectionAllowed: provider.ivfGenderSelectionAllowed ?? null,
      transferFromOtherClinics: provider.ivfTransferFromOtherClinics ?? null,
      maxAgeIp1: provider.ivfMaxAgeIp1 ?? null,
      maxAgeIp2: provider.ivfMaxAgeIp2 ?? null,
      biologicalConnection: provider.ivfBiologicalConnection ?? null,
      acceptingPatients: Array.isArray(provider.ivfAcceptingPatients) ? provider.ivfAcceptingPatients : null,
      eggDonorType: provider.ivfEggDonorType ?? null,
    },
    // Surrogate Matching Requirements only matter to parents seeking surrogacy.
    showSurrogateMatching: parentProfile?.needsSurrogate === true
      || (Array.isArray(parentProfile?.interestedServices) && parentProfile.interestedServices.some((s: string) => /surrogat/i.test(s))),
    surrogateMatching: {
      minAge: provider.ivfSurrogateMinAge ?? null,
      maxAge: provider.ivfSurrogateMaxAge ?? null,
      minBmi: provider.ivfSurrogateMinBmi ?? null,
      maxBmi: provider.ivfSurrogateMaxBmi ?? null,
      minDeliveries: provider.ivfSurrogateMinDeliveries ?? null,
      maxDeliveries: provider.ivfSurrogateMaxDeliveries ?? null,
      maxCSections: provider.ivfSurrogateMaxCSections ?? null,
      maxMiscarriages: provider.ivfSurrogateMaxMiscarriages ?? null,
      maxAbortions: provider.ivfSurrogateMaxAbortions ?? null,
      maxYearsFromLastPregnancy: provider.ivfSurrogateMaxYearsFromLastPregnancy ?? null,
      monthsPostVaginal: provider.ivfSurrogateMonthsPostVaginal ?? null,
      covidVaccination: provider.ivfSurrogateCovidVaccination ?? false,
      gdDiet: provider.ivfSurrogateGdDiet ?? false,
      gdMedication: provider.ivfSurrogateGdMedication ?? false,
      highBloodPressure: provider.ivfSurrogateHighBloodPressure ?? false,
      preeclampsia: provider.ivfSurrogatePreeclampsia ?? false,
      placentaPrevia: provider.ivfSurrogatePlacentaPrevia ?? false,
      healthHistoryNotes: provider.ivfSurrogateMentalHealthHistory ?? null,
    },
    compact: isMobile,
    cdcServices: provider.cdcServices || null,
    cdcExperience: provider.cdcExperience || null,
    cdcCycleStats: provider.cdcCycleStats || null,
    patientDiagnoses,
  });

  // One tab per doctor WITH a photo: their face background + their own Overview
  // (About / Works at this clinic / Locations / Languages) - the exact first tab
  // the doctor's own card shows.
  const doctorTabs = members
    .filter((m: any) => !!getPhotoSrc(m?.highResPhotoUrl || m?.photoUrl) && m?.name)
    .slice(0, 10)
    .map((m: any) => buildClinicDoctorTab(
      { name: m.name, bio: m.bio, languagesSpoken: m.languagesSpoken },
      provider.name,
      provider.locations || [],
      getPhotoSrc(m.highResPhotoUrl || m.photoUrl) || null,
    ))
    .filter(Boolean) as any[];

  const tabs = [...clinicTabs, ...doctorTabs];
  const successBadge = isTop10 ? "Top 10%" : null;
  const logoSrc = getPhotoSrc(provider.logoUrl) || null;

  return (
    <SwipeDeckCard
      id={providerId}
      photos={[]}
      title={provider.name}
      pinnedHeader={{
        logoUrl: logoSrc,
        title: provider.name,
        location: null,
        badge: successBadge,
        warningBadge: requirementsCheck && !requirementsCheck.pass ? "May not meet requirements" : null,
        warningDetail: requirementsCheck && !requirementsCheck.pass ? `This clinic ${requirementsCheck.failed.join("; ")}.` : null,
      }}
      sponsored={!!(provider as any).sponsoredUntil && new Date((provider as any).sponsoredUntil).getTime() > Date.now()}
      firstSlidePlain
      tabs={tabs}
      disableSwipe={disableSwipe}
      chatMode={chatMode}
      isSaved={isSaved}
      isPassed={isPassed}
      onPass={onPass}
      onSave={onSave}
      onUndo={onUndo}
      onViewFullProfile={onViewProfile}
      onMessage={onMessage}
    />
  );
}
