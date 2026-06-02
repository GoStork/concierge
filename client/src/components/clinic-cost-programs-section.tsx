import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CostSheetProgramCard, ProgramCardData } from "@/components/cost-sheet-program-card";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DollarSign, Info, MessageCircle } from "lucide-react";

/**
 * Parent-facing cost-programs grid on the clinic profile page. Fetches the
 * subset of the clinic's APPROVED programs that match the current parent's
 * biology / journey state, then renders them as cards.
 *
 * Hidden entirely if no provider is given or the parent isn't logged in
 * with a parent account.
 */
export function ClinicCostProgramsSection({
  providerId,
  parentAccountId,
  hasIvfClinicService,
}: {
  providerId: string;
  parentAccountId: string | null | undefined;
  hasIvfClinicService: boolean;
}) {
  const navigate = useNavigate();
  const enabled = hasIvfClinicService && !!providerId && !!parentAccountId;

  const { data, isLoading } = useQuery<{
    programs: ProgramCardData[];
    matchingSubtypes: string[];
    isPartialProfile: boolean;
  }>({
    queryKey: ["/api/costs/provider", providerId, "parent-programs", parentAccountId],
    queryFn: async () => {
      const res = await fetch(
        `/api/costs/provider/${providerId}/parent-programs?parentAccountId=${parentAccountId}`,
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

  return (
    <section className="space-y-3" data-testid="clinic-cost-programs">
      <div className="flex items-center gap-2">
        <DollarSign className="w-5 h-5 text-primary" />
        <h2 className="font-heading text-xl text-foreground">Cost programs for your journey</h2>
      </div>

      {/* Profile incomplete -> block the grid entirely. Speculative matches
          aren't useful before the parent has told Eva the basics (embryos,
          egg source, carrier). Single CTA back to the concierge. */}
      {data?.isPartialProfile ? (
        <Card className="border-accent/40 bg-accent/5">
          <CardContent className="py-10 text-center space-y-3" data-testid="cost-programs-blocked-incomplete">
            <Info className="w-10 h-10 mx-auto text-accent" />
            <h3 className="font-heading text-lg text-foreground">Finish your profile to see cost programs</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              We need a few details from you - whether you already have embryos, your egg source, and who will carry the pregnancy - before we can show you the right cost programs for this clinic.
            </p>
            <Button
              size="sm"
              onClick={() => navigate(`/chat?providerId=${providerId}&intent=complete_profile`)}
              data-testid="btn-complete-profile"
            >
              <MessageCircle className="w-4 h-4 mr-1" /> Continue with Concierge
            </Button>
          </CardContent>
        </Card>
      ) : programs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <DollarSign className="w-10 h-10 mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              This provider doesn't have a published cost program that matches your situation yet.
              Ask our concierge to request a custom quote on your behalf.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/chat?providerId=${providerId}&intent=custom_quote`)}
              data-testid="btn-request-custom-quote"
            >
              <MessageCircle className="w-4 h-4 mr-1" /> Request a custom quote
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {programs.map((program, idx) => (
            <CostSheetProgramCard key={program.programId} program={program} index={idx} />
          ))}
        </div>
      )}
    </section>
  );
}
