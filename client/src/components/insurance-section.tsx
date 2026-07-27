import { ShieldCheck } from "lucide-react";

import { ProfileSection } from "@/components/ui/profile-section";
import { Badge } from "@/components/ui/badge";

/**
 * In-network insurance carriers.
 *
 * The data is clinic-level (Provider.acceptedInsurance, provider self-entry).
 * It renders on the clinic's own profile AND on a doctor's profile, where it is
 * unioned across that doctor's clinic affiliations - the same field either way,
 * so this is the single renderer for both.
 *
 * Renders nothing when the clinic hasn't entered any carriers, rather than an
 * empty card.
 */
export function InsuranceSection({
  insurance,
  title = "In-Network Insurances",
  note,
}: {
  insurance: string[] | null | undefined;
  title?: string;
  /** Optional line under the chips, e.g. attributing the list to a clinic. */
  note?: string;
}) {
  const carriers = (insurance || []).filter(Boolean);
  if (carriers.length === 0) return null;
  return (
    <ProfileSection title={title} data-testid="section-insurance">
      <div className="flex flex-wrap gap-2">
        {carriers.map((ins) => (
          <Badge key={ins} variant="secondary" className="gap-1">
            <ShieldCheck className="w-3 h-3 text-[hsl(var(--brand-success))]" /> {ins}
          </Badge>
        ))}
      </div>
      {note && <p className="t-helper mt-3">{note}</p>}
    </ProfileSection>
  );
}
