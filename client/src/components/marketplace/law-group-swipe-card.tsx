import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { SwipeDeckCard } from "./swipe-deck-card";
import { getAgencyTabs, buildClinicDoctorTab } from "./swipe-mappers";

// The card shows ONLY the attorneys a parent would actually retain - no
// paralegals, assistants, case managers, or executives. A member counts as a
// lawyer when their title says so (Attorney / Partner / Counsel) or their
// name carries the Esq. suffix; support-role keywords veto first so titles
// like "Executive Assistant to <partner>" never slip through.
function isLawyer(m: { name?: string | null; title?: string | null }): boolean {
  const t = (m.title || "").toLowerCase();
  if (/paralegal|assistant|case manager|coordinator|consultant|intake|officer|marketing|finance|billing/.test(t)) return false;
  if (/\b(attorney|lawyer|counsel|partner)\b/.test(t)) return true;
  return /\besq\b/i.test((m.name || "").replace(/[.,]/g, " "));
}

// Founding/managing partners first, then partners, then attorneys.
function lawyerRank(m: { title?: string | null }): number {
  const t = (m.title || "").toLowerCase();
  if (/\b(founder|founding|managing|principal|senior)\b/.test(t)) return 0;
  if (/\bpartner\b/.test(t)) return 1;
  return 2;
}

/**
 * Shared Law Group card - the legal-services SwipeDeckCard used by the AI
 * Concierge's law-firm match card (and any future marketplace Legal deck),
 * exactly like ClinicSwipeCard / AgencySwipeCard are shared for their types.
 * Composition mirrors the clinic card: firm tabs (Overview / Services +
 * Locations via getAgencyTabs) on the cream cover, then one face tab per
 * lawyer WITH a photo (their own overview, built by buildClinicDoctorTab -
 * the same mapper the clinic card uses for its doctor-face tabs).
 */
export function LawGroupSwipeCard({
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
  // Pre-fetched provider row (deck usage). When omitted (AI chat card) the
  // card self-fetches by id - same dual-mode contract as the other cards.
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
  onMessage?: () => void;
}) {
  const [fetchedProvider, setFetchedProvider] = useState<any>(null);
  const provider = providerProp ?? fetchedProvider;
  const isMobile = useIsMobile();

  useEffect(() => {
    if (providerProp) return;
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

  const logoSrc = getPhotoSrc(provider.logoUrl) || null;

  const serviceNames: string[] = Array.from(new Set(
    (provider.services || [])
      .filter((s: any) => s?.status === "APPROVED")
      .map((s: any) => s?.providerType?.name)
      .filter(Boolean),
  ));

  const members: any[] = Array.isArray(provider.members)
    ? provider.members
        .filter((m: any) => m?.isPublicProfile !== false && isLawyer(m))
        .sort((a: any, b: any) => {
          const ra = lawyerRank(a);
          const rb = lawyerRank(b);
          if (ra !== rb) return ra - rb;
          return (a?.sortOrder ?? 0) - (b?.sortOrder ?? 0);
        })
    : [];

  // Firm-level tabs on the cream cover: Matched-to-you reasons (when the AI
  // supplied them), Overview (founded + about), Services + Locations.
  const firmTabs = getAgencyTabs({
    reasons,
    about: provider.about ?? null,
    services: serviceNames.length > 0 ? serviceNames : ["Legal Services"],
    yearFounded: provider.yearFounded ?? null,
    locations: provider.locations || [],
    team: members.filter((m: any) => m?.name).map((m: any) => ({ name: m.name, title: m.title ?? null })),
    compact: isMobile,
  });

  // One face tab per lawyer WITH a photo - their photo as the slide
  // background + their own overview, exactly like the clinic doctor tabs.
  const lawyerTabs = members
    .filter((m: any) => !!getPhotoSrc(m?.highResPhotoUrl || m?.photoUrl) && m?.name)
    .slice(0, 10)
    .map((m: any) => buildClinicDoctorTab(
      { name: m.name, bio: m.bio, languagesSpoken: m.languagesSpoken },
      provider.name,
      provider.locations || [],
      getPhotoSrc(m.highResPhotoUrl || m.photoUrl) || null,
    ))
    .filter(Boolean) as any[];

  return (
    <SwipeDeckCard
      id={providerId}
      photos={[]}
      title={provider.name}
      pinnedHeader={{ logoUrl: logoSrc, title: provider.name, location: null, badge: null }}
      firstSlidePlain
      tabs={[...firmTabs, ...lawyerTabs]}
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
