import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CostSheetProgramCard, ProgramCardData } from "@/components/cost-sheet-program-card";
import { CostProgramTailorForm } from "@/components/cost-program-tailor-form";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign, MessageCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Parent-facing cost-programs grid on the clinic profile page. Fetches the
 * subset of the clinic's APPROVED programs that match the current parent's
 * biology / journey state, then renders them as cards.
 *
 * When the matcher returns nothing (because the parent's profile is too
 * thin to filter against), the empty state renders an inline tailor form
 * instead of dead-ending the parent. They can answer a few quick-reply
 * questions to surface tailored programs, or tick "skip" to switch the
 * query into showAll mode and see every program this provider has.
 *
 * Hidden entirely if no provider is given or the parent isn't logged in
 * with a parent account.
 */
export function ClinicCostProgramsSection({
  providerId,
  parentAccountId,
  hasIvfClinicService,
  specificDonorId,
  specificDonorType,
}: {
  providerId: string;
  parentAccountId: string | null | undefined;
  hasIvfClinicService: boolean;
  // When set, the server overrides the program's generic compensation
  // range with this donor / surrogate's actual comp before totaling so
  // the card shows what THIS person would specifically cost the parent.
  // Used on individual surrogate / fresh egg donor profile pages.
  specificDonorId?: string;
  specificDonorType?: string;
}) {
  const navigate = useNavigate();
  const enabled = hasIvfClinicService && !!providerId && !!parentAccountId;

  // showAll flips the query into "ignore parentNeeds, list everything this
  // provider has published". Set by the tailor form's skip checkbox.
  // Session-scoped (resets when the parent navigates away) - we don't
  // persist the bypass because the parent might want filtered results on
  // the next visit once they've gone back and answered the questions.
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading } = useQuery<{
    programs: ProgramCardData[];
    matchingSubtypes: string[];
    isPartialProfile: boolean;
    // null = ask the parent; "tailored" / "show_all" = decision recorded,
    // never re-render the tailor form on any provider profile.
    costProgramsPreference: string | null;
  }>({
    queryKey: [
      "/api/costs/provider",
      providerId,
      "parent-programs",
      parentAccountId,
      specificDonorId ?? "none",
      specificDonorType ?? "none",
      showAll ? "all" : "filtered",
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ parentAccountId: parentAccountId as string });
      if (specificDonorId) params.set("specificDonorId", specificDonorId);
      if (specificDonorType) params.set("specificDonorType", specificDonorType);
      if (showAll) params.set("showAll", "true");
      const res = await fetch(
        `/api/costs/provider/${providerId}/parent-programs?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load cost programs");
      return res.json();
    },
    enabled,
  });

  if (!enabled) return null;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground text-sm">
          Loading cost programs...
        </CardContent>
      </Card>
    );
  }

  const programs = data?.programs ?? [];
  // We render the tailor form (instead of the generic empty state) when
  // the matcher returned nothing OR explicitly flagged the profile as
  // partial AND the parent hasn't already made a decision about it.
  // Once costProgramsPreference is set to "tailored" or "show_all" on
  // their IP profile, we trust that choice and never re-prompt - even
  // on a different provider where the matcher comes back empty.
  const hasDecided =
    data?.costProgramsPreference === "tailored" ||
    data?.costProgramsPreference === "show_all";
  const showTailorForm = !showAll && !hasDecided && (data?.isPartialProfile || programs.length === 0);

  return (
    <Card className="overflow-hidden border-[hsl(var(--brand-success))]/40" data-testid="clinic-cost-programs">
      <div className="px-6 pt-5">
        <h3 className="font-heading text-xl text-foreground flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-primary" />
          Costs
        </h3>
      </div>
      <div className="p-6 pt-4">
        {showTailorForm ? (
          <CostProgramTailorForm
            parentAccountId={parentAccountId as string}
            onSaved={() => { /* query invalidated by the form */ }}
            onSkip={() => setShowAll(true)}
          />
        ) : programs.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <DollarSign className="w-10 h-10 mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              This provider hasn't published a cost program yet. Ask our concierge to request a custom quote on your behalf.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/chat?providerId=${providerId}&intent=custom_quote`)}
              data-testid="btn-request-custom-quote"
            >
              <MessageCircle className="w-4 h-4 mr-1" /> Request a custom quote
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {programs.map((program, idx) => (
              <CostSheetProgramCard key={program.programId} program={program} index={idx} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
