import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatMoneyDollars } from "@/lib/format-money";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { SwipeDeckCard } from "./swipe-deck-card";
import { getAgencyTabs } from "./swipe-mappers";

// Leadership-first ordering for the rotating team faces: the CEO/Owner/Founder
// is shown first on tab 2, mirroring how the clinic card surfaces its lead
// doctor. Lower rank = earlier. Falls back to the member's sortOrder.
function leadershipRank(title?: string | null): number {
  const t = (title || "").toLowerCase();
  if (/\b(ceo|chief executive|founder|owner|co-founder|cofounder)\b/.test(t)) return 0;
  if (/\b(president|managing director|executive director)\b/.test(t)) return 1;
  if (/\b(director|partner|principal|vp|vice president)\b/.test(t)) return 2;
  if (/\b(manager|coordinator|lead)\b/.test(t)) return 3;
  return 4;
}

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
  onMessage,
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
  // Opens an AI concierge chat about this agency (the airplane button).
  onMessage?: () => void;
}) {
  const [fetchedProvider, setFetchedProvider] = useState<any>(null);
  const provider = providerProp ?? fetchedProvider;
  const [costItems, setCostItems] = useState<{ label: string; value?: string; country?: string | null; programName?: string; subLabel?: string | null; total?: string }[]>([]);
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;

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

  // Parent-matched surrogacy programs -> one Costs row per program (name +
  // total), cheapest first. Same endpoint as the clinic card (type-agnostic
  // by providerId).
  useEffect(() => {
    if (!parentAccountId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/costs/provider/${providerId}/parent-programs?parentAccountId=${parentAccountId}`, { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        const programs: any[] = data?.programs || [];
        const items = programs
          .map((p: any) => {
            const min = Number(p.minTotal);
            const max = Number(p.maxTotal);
            if (!Number.isFinite(min) || min <= 0) return null;
            const cost = Number.isFinite(max) && max > min
              ? `${formatMoneyDollars(min)} - ${formatMoneyDollars(max)}`
              : formatMoneyDollars(min);
            const name = p.programName || p.country || "Program";
            // Structured fields drive the cost_cards layout; label is the fallback.
            return { label: `${name}: ${cost}`, country: p.country || null, programName: name, subLabel: p.subTypeLabel || null, total: cost, _min: min };
          })
          .filter(Boolean) as { label: string; country: string | null; programName: string; subLabel: string | null; total: string; _min: number }[];
        items.sort((a, b) => a._min - b._min);
        if (cancelled) return;
        setCostItems(items.map(({ _min, ...rest }) => rest));
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

  const sp = provider.surrogacyProfile || {};
  const logoSrc = getPhotoSrc(provider.logoUrl) || null;

  const serviceNames: string[] = Array.from(new Set(
    (provider.services || [])
      .filter((s: any) => s?.status === "APPROVED")
      .map((s: any) => s?.providerType?.name)
      .filter(Boolean),
  ));

  // Team faces become the tab backgrounds (one face per tab from tab 2 on),
  // CEO/Owner/Founder first - identical to the clinic card's doctor-face tabs.
  const members: any[] = Array.isArray(provider.members)
    ? provider.members
        .filter((m: any) => m?.isPublicProfile !== false)
        .slice()
        .sort((a: any, b: any) => {
          const ra = leadershipRank(a?.title);
          const rb = leadershipRank(b?.title);
          if (ra !== rb) return ra - rb;
          return (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0);
        })
    : [];
  const photoMembers = members.filter((m: any) => !!getPhotoSrc(m?.highResPhotoUrl || m?.photoUrl)).slice(0, 10);
  const teamPhotos: string[] = photoMembers.map((m: any) => getPhotoSrc(m.highResPhotoUrl || m.photoUrl) as string);
  const photoLabels: Record<string, string> = {};
  photoMembers.forEach((m: any) => {
    const src = getPhotoSrc(m.highResPhotoUrl || m.photoUrl);
    if (src && m.name) photoLabels[src] = m.name;
  });
  const teamMembers = members.filter((m: any) => m?.name).map((m: any) => ({ name: m.name, title: m.title ?? null }));

  const tabs = getAgencyTabs({
    reasons,
    about: provider.about ?? null,
    services: serviceNames,
    yearFounded: provider.yearFounded ?? null,
    numberOfBabiesBorn: sp.numberOfBabiesBorn ?? null,
    timeToMatch: sp.timeToMatch ?? null,
    familiesPerCoordinator: sp.familiesPerCoordinator ?? null,
    screening: sp.screening || null,
    costs: costItems,
    matching: {
      twinsAllowed: provider.surrogacyTwinsAllowed ?? null,
      citizensNotAllowed: Array.isArray(provider.surrogacyCitizensNotAllowed) ? provider.surrogacyCitizensNotAllowed : null,
      stayAfterBirthMonths: provider.surrogacyStayAfterBirthMonths ?? null,
      surrogateRemovableFromCert: provider.surrogacySurrogateRemovableFromCert ?? null,
    },
    team: teamMembers,
    locations: provider.locations || [],
    compact: isMobile,
    reviewCount: provider.reviewCount ?? null,
    avgOverallScore: provider.avgOverallScore ?? null,
  });

  return (
    <SwipeDeckCard
      id={providerId}
      photos={teamPhotos}
      photoLabels={photoLabels}
      title={provider.name}
      pinnedHeader={{ logoUrl: logoSrc, title: provider.name, location: null, badge: null }}
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
