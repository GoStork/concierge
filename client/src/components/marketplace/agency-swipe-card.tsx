import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { SwipeDeckCard } from "./swipe-deck-card";
import { getAgencyTabs } from "./swipe-mappers";

/**
 * Shared Surrogacy Agency card - the SINGLE agency SwipeDeckCard used by BOTH
 * the marketplace agencies deck AND the AI Concierge's agency match card, exactly
 * like ClinicSwipeCard is shared for clinics. Renders the cream cover (logo +
 * name + location) + agency tabs (Overview stats, Screening, Locations) built by
 * getAgencyTabs from the provider's SurrogacyAgencyProfile.
 *
 * Callers supply providerId (+ optional pre-fetched provider row) + the
 * swipe/action callbacks, so the card looks and behaves identically everywhere.
 */
export function AgencySwipeCard({
  providerId,
  provider: providerProp,
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
  // Pre-fetched provider row (marketplace deck). When omitted (AI chat card) the
  // card self-fetches by id - same dual-mode contract as ClinicSwipeCard.
  provider?: any;
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
  const [fetchedProvider, setFetchedProvider] = useState<any>(null);
  const provider = providerProp ?? fetchedProvider;

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

  if (!provider) {
    return (
      <div className="w-full h-full rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const sp = provider.surrogacyProfile || {};
  const primaryLocation = provider.locations?.[0];
  const primaryLocationLabel = primaryLocation ? [primaryLocation.city, primaryLocation.state].filter(Boolean).join(", ") : null;
  const logoSrc = getPhotoSrc(provider.logoUrl) || null;

  const tabs = getAgencyTabs({
    reasons,
    numberOfBabiesBorn: sp.numberOfBabiesBorn ?? null,
    timeToMatch: sp.timeToMatch ?? null,
    familiesPerCoordinator: sp.familiesPerCoordinator ?? null,
    screening: sp.screening || null,
    locations: provider.locations || [],
  });

  return (
    <SwipeDeckCard
      id={providerId}
      photos={[]}
      title={provider.name}
      pinnedHeader={{ logoUrl: logoSrc, title: provider.name, location: primaryLocationLabel, badge: null }}
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
