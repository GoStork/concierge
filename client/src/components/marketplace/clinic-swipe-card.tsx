import { useState, useEffect, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatMoneyDollars } from "@/lib/format-money";
import { SwipeDeckCard } from "./swipe-deck-card";
import { getClinicTabs } from "./swipe-mappers";

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
}: {
  providerId: string;
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
}) {
  const [provider, setProvider] = useState<any>(null);
  const [costItems, setCostItems] = useState<{ label: string }[]>([]);
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/providers/${providerId}`, { credentials: "include" });
        if (res.ok && !cancelled) setProvider(await res.json());
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [providerId]);

  // Parent-matched published cost programs -> a single "Starting at $X" headline.
  useEffect(() => {
    if (!parentAccountId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/costs/provider/${providerId}/parent-programs?parentAccountId=${parentAccountId}`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        const programs: any[] = data?.programs || [];
        const totals = programs.map((p: any) => Number(p.minTotal)).filter((n: number) => Number.isFinite(n) && n > 0);
        const startingAt = totals.length ? Math.min(...totals) : null;
        if (cancelled) return;
        setCostItems(
          startingAt != null
            ? [
                { label: `Starting at ${formatMoneyDollars(startingAt)}` },
                ...(programs.length > 1 ? [{ label: `${programs.length} programs available` }] : []),
              ]
            : [],
        );
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [providerId, parentAccountId]);

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

  const ageLabel = cardAgeGroup === "under_35" ? "Under 35" : cardAgeGroup === "35_37" ? "35-37" : cardAgeGroup === "38_40" ? "38-40" : "Over 40";
  const contextLabel = cardEggSource === "donor" ? "Donor eggs" : ["Own eggs", ageLabel, cardIsNew ? "First-time IVF" : "Prior cycles"].join(" · ");

  const members: any[] = Array.isArray(provider.members) ? provider.members.filter((m: any) => m?.isPublicProfile !== false) : [];
  // Clinic cards stay on the clean cream cover background across ALL tabs - we do
  // NOT use doctor faces as tab backgrounds (those are dark/inconsistent and made
  // the inner tabs look nothing like the first tab). The doctors still appear by
  // name on the "Doctors at this clinic" tab.
  const clinicDoctors = members.filter((m: any) => m?.name).map((m: any) => ({ name: m.name }));
  const primaryLocation = provider.locations?.[0];
  const primaryLocationLabel = primaryLocation ? [primaryLocation.city, primaryLocation.state].filter(Boolean).join(", ") : null;

  const tabs = getClinicTabs({
    pct,
    natAvg,
    contextLabel,
    reasons,
    locations: provider.locations || [],
    doctors: clinicDoctors,
    costs: costItems,
    compact: isMobile,
  });
  const successBadge = isTop10 ? "Top 10%" : null;
  const logoSrc = getPhotoSrc(provider.logoUrl) || null;

  return (
    <SwipeDeckCard
      id={providerId}
      photos={doctorPhotos}
      photoLabels={photoLabels}
      title={provider.name}
      pinnedHeader={{ logoUrl: logoSrc, title: provider.name, location: primaryLocationLabel, badge: successBadge }}
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
    />
  );
}
