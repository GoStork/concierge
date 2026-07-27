import { SwipeDeckCard } from "./swipe-deck-card";
import { useParentCostItems } from "@/lib/parent-programs";
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
  onMessage,
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
  // Opens an AI concierge chat about this doctor (the airplane button).
  onMessage?: () => void;
}) {
  const primaryClinicId = doctor.clinics?.[0]?.providerId || null;

  // Cost programs come from the doctor's primary clinic - batched for the whole
  // deck by ParentProgramsProvider (see lib/parent-programs).
  const costItems = useParentCostItems(primaryClinicId);

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
      onMessage={onMessage}
    />
  );
}
