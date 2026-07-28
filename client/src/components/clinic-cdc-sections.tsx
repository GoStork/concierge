import { ProfileSection } from "@/components/ui/profile-section";
import { Badge } from "@/components/ui/badge";
import { useParentProfile } from "@/hooks/use-parent-profile";
import {
  buildClinicExperience, buildClinicPracticeItems, buildParentMatchingItems, clinicServiceLabels,
} from "@/lib/clinic-cdc";

/**
 * The clinic facts a parent sees on the IVF clinic swipe card, rendered as full
 * profile sections: Services, "Experience with your needs", Parents Matching
 * Requirements, and "How they practice". The card and this page build from the
 * SAME helpers (lib/clinic-cdc), so a fact can never appear on one and not the
 * other - anything a parent swipes past is also here, in full, with no card cap.
 *
 * Each section renders nothing when the clinic has no data for it.
 */

export function ClinicServicesSection({ cdcServices }: { cdcServices: Record<string, boolean> | null | undefined }) {
  const labels = clinicServiceLabels(cdcServices);
  if (labels.length === 0) return null;
  return (
    <ProfileSection title="Services" data-testid="section-clinic-services">
      <div className="flex flex-wrap gap-2">
        {labels.map((label) => (
          <Badge
            key={label}
            variant="secondary"
            className="font-ui px-3 py-1"
            data-testid={`service-${label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {label}
          </Badge>
        ))}
      </div>
    </ProfileSection>
  );
}

export function ClinicExperienceSection({ cdcExperience }: { cdcExperience: Record<string, number> | null | undefined }) {
  // Personalized: the parent's own diagnoses lead the list in the primary color.
  const { diagnoses } = useParentProfile();
  // max: null - a profile page has room for every meaningful row (the card caps).
  const experience = buildClinicExperience(cdcExperience, diagnoses, { max: null });
  if (!experience) return null;
  return (
    <ProfileSection title={experience.title} contentClassName="p-6 space-y-4" data-testid="section-clinic-experience">
      <p className="t-helper font-ui">{experience.subtitle}</p>
      <div className="space-y-2">
        {experience.bars.map((bar) => (
          <div key={bar.label} className="flex items-center gap-3" data-testid={`experience-${bar.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <span className="t-helper w-44 shrink-0">{bar.label}</span>
            <div className="flex-1 h-5 bg-secondary/30 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(bar.value, 100)}%`,
                  backgroundColor: bar.isClinic ? "hsl(var(--primary))" : "hsl(var(--accent))",
                }}
              />
            </div>
            <span className={`w-12 text-right ${bar.isClinic ? "text-xs font-heading text-foreground" : "t-helper"}`}>{bar.value}%</span>
          </div>
        ))}
      </div>
    </ProfileSection>
  );
}

export function ClinicParentMatchingSection({ provider }: { provider: any }) {
  const items = buildParentMatchingItems({
    twinsAllowed: provider.ivfTwinsAllowed ?? null,
    genderSelectionAllowed: provider.ivfGenderSelectionAllowed ?? null,
    transferFromOtherClinics: provider.ivfTransferFromOtherClinics ?? null,
    maxAgeIp1: provider.ivfMaxAgeIp1 ?? null,
    maxAgeIp2: provider.ivfMaxAgeIp2 ?? null,
    biologicalConnection: provider.ivfBiologicalConnection ?? null,
    acceptingPatients: Array.isArray(provider.ivfAcceptingPatients) ? provider.ivfAcceptingPatients : null,
    eggDonorType: provider.ivfEggDonorType ?? null,
  });
  if (items.length === 0) return null;
  return (
    <ProfileSection title="Parents Matching Requirements" contentClassName="p-6 space-y-3" data-testid="section-parents-matching-requirements">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="flex items-start gap-2.5" data-testid={`matching-${item.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <Icon className="w-4 h-4 text-[hsl(var(--accent))] shrink-0 mt-0.5" />
            <span className="t-field-value">{item.label}</span>
          </div>
        );
      })}
    </ProfileSection>
  );
}

export function ClinicPracticeSection({ cdcCycleStats }: { cdcCycleStats: Record<string, number> | null | undefined }) {
  const items = buildClinicPracticeItems(cdcCycleStats);
  if (items.length === 0) return null;
  return (
    <ProfileSection title="How they practice" contentClassName="p-6 space-y-3" data-testid="section-how-they-practice">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.label} className="flex items-center gap-2.5" data-testid={`practice-${item.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <Icon className="w-4 h-4 text-[hsl(var(--accent))] shrink-0" />
            <span className="t-field-value">{item.label}</span>
            <span className="ml-auto pl-2 text-sm font-heading text-foreground tabular-nums shrink-0">{item.value}</span>
          </div>
        );
      })}
    </ProfileSection>
  );
}
