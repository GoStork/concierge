import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { formatMoneyDollars } from "@/lib/format-money";
import { SwipeDeckCard } from "./swipe-deck-card";
import { buildDoctorCardProps, type DoctorCardData } from "./swipe-mappers";

/**
 * Shared doctor SwipeDeckCard wrapper. Builds the doctor card from the enriched
 * DoctorCardData (face hero + Overview/About/Credentials/Matched tabs) AND lazily
 * fetches the doctor's PRIMARY clinic's parent-matched cost programs so the card
 * shows a Costs tab (one row per program), exactly like the clinic/agency cards.
 * Used by both the marketplace Doctors deck and the AI matcher's doctor card so
 * they render identically.
 */
export function DoctorSwipeCard({
  doctor,
  contextLabel,
  compact = false,
  reasons,
  disableSwipe = false,
  chatMode = false,
  isSaved = false,
  isPassed = false,
  onPass,
  onSave,
  onUndo,
  onViewProfile,
}: {
  doctor: DoctorCardData;
  contextLabel?: string | null;
  compact?: boolean;
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
  const { user } = useAuth();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;
  const [costItems, setCostItems] = useState<{ label: string; country?: string | null; programName?: string; subLabel?: string | null; total?: string }[]>([]);
  const primaryClinicId = doctor.clinics?.[0]?.providerId || null;

  // Cost programs come from the doctor's primary clinic - same endpoint + shape
  // as the clinic card (parent-matched, one row per program).
  useEffect(() => {
    if (!parentAccountId || !primaryClinicId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/costs/provider/${primaryClinicId}/parent-programs?parentAccountId=${parentAccountId}`, { credentials: "include" });
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
            return { label: `${name}: ${cost}`, country: p.country || null, programName: name, subLabel: p.subTypeLabel || null, total: cost, _min: min };
          })
          .filter(Boolean) as { label: string; country: string | null; programName: string; subLabel: string | null; total: string; _min: number }[];
        items.sort((a, b) => a._min - b._min);
        if (cancelled) return;
        setCostItems(items.map(({ _min, ...rest }) => rest));
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [primaryClinicId, parentAccountId]);

  const { photos, photoLabels, logoSrc, successBadge, tabs, headerLocation, firstSlidePlain } =
    buildDoctorCardProps(doctor, { contextLabel, compact, reasons, costs: costItems });

  return (
    <SwipeDeckCard
      id={doctor.slug}
      photos={photos}
      photoLabels={photoLabels}
      title={doctor.name}
      pinnedHeader={{ logoUrl: logoSrc, title: doctor.name, location: headerLocation, badge: successBadge }}
      sponsored={!!(doctor as any).sponsoredUntil && new Date((doctor as any).sponsoredUntil).getTime() > Date.now()}
      monogramName={doctor.name}
      firstSlidePlain={firstSlidePlain}
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
