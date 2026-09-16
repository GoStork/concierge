import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { useQuery } from "@tanstack/react-query";
import { getPhotoSrc } from "@/lib/profile-utils";

const SERVICE_LABELS: Record<string, string> = {
  "Fertility Clinic": "fertility clinic",
  "Egg Donor": "egg donor agency",
  "Surrogate": "surrogacy agency",
  "Sperm Donor": "sperm bank",
};

export default function OnboardingAiReadyPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const matchmakerId = searchParams.get("matchmaker");
  const { data: brand } = useBrandSettings();
  const brandName = brand?.companyName || "GoStork";

  const matchmakers: Matchmaker[] = (brand?.matchmakers || []).filter(m => m.isActive);
  const selected = matchmakers.find(m => m.id === matchmakerId) || null;

  // This screen announces the persona the parent just chose. Without a valid
  // ?matchmaker= it used to fall back to the first persona and say "Ariel is
  // ready" to someone who picked Adam; send them back to choose instead.
  useEffect(() => {
    if (brand && matchmakers.length > 0 && !selected) navigate("/matchmaker-selection", { replace: true });
  }, [brand, matchmakers.length, selected, navigate]);

  useEffect(() => {
    const prev = document.title;
    document.title = `${selected ? `${selected.name} is ready` : "Your concierge is ready"} - ${brandName}`;
    return () => { document.title = prev; };
  }, [selected, brandName]);

  const profileQuery = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
  });
  const services = profileQuery.data?.interestedServices || [];
  const primaryService = services[0] || "Fertility Clinic";
  const serviceLabel = SERVICE_LABELS[primaryService] || "fertility provider";
  const firstName = selected?.name?.split(" ")[0] || "your concierge";

  const handleStart = () => {
    // Same as the picker's shortcut: /chat sits behind the chat in history so
    // Back goes to the conversations list, never out of the app.
    navigate("/chat", { replace: true });
    navigate(`/concierge?matchmaker=${matchmakerId || selected?.id || ""}`);
  };

  return (
    <div className="fixed inset-0 bg-background overflow-y-auto px-6" data-testid="onboarding-ai-ready">
      <div
        className="min-h-full max-w-md mx-auto flex flex-col items-center justify-between"
        style={{ paddingTop: "max(2rem, env(safe-area-inset-top, 0px))", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom, 0px))" }}
      >
      <div className="w-full flex flex-col items-center flex-1">
        {/* Selected avatar */}
        <div className="flex justify-center mb-4 [@media(max-height:700px)]:mb-2">
          {selected?.avatarUrl ? (
            <img
              src={getPhotoSrc(selected.avatarUrl) || undefined}
              alt={selected.name}
              className="w-20 h-20 rounded-full object-cover border-2"
              style={{ borderColor: brand?.primaryColor || "hsl(var(--primary))" }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center text-primary-foreground text-2xl font-bold"
              style={{ backgroundColor: brand?.primaryColor || "hsl(var(--primary))" }}
            >
              {selected?.name?.charAt(0) || "AI"}
            </div>
          )}
        </div>

        <h1
          className="text-3xl md:text-4xl font-bold leading-tight text-center mb-4 [@media(max-height:700px)]:mb-2"
          style={{ fontFamily: "var(--font-display)" }}
          data-testid="text-ai-ready-title"
        >
          {selected ? `${selected.name} is ready` : "Your AI concierge is ready"}
        </h1>

        <p className="t-field-prose text-center max-w-sm mx-auto mb-6 [@media(max-height:700px)]:mb-3" data-testid="text-ai-ready-intro">
          Here is how the next few minutes go.
        </p>

        {/* What happens next - true steps, no mock booking. The previous mock
            "Meeting Confirmed" card told a nervous first-timer that calls get
            booked without them; the product promise is the opposite. */}
        <ol className="mx-auto max-w-sm w-full space-y-3 [@media(max-height:700px)]:space-y-2" data-testid="ai-ready-steps">
          {[
            { n: 1, title: `Tell ${firstName} about your journey`, body: "A few short questions, one at a time. Answer in your own words or tap a reply." },
            { n: 2, title: `${firstName} brings you hand-picked matches`, body: "One at a time, from our vetted network, with real costs shown up front." },
            { n: 3, title: "You decide when to book a Match Call", body: "Nothing is booked, and no provider sees your name, until you say so." },
          ].map((step) => (
            <li key={step.n} className="flex items-start gap-3 rounded-[var(--container-radius)] border border-border bg-card px-4 py-3">
              <span
                className="mt-0.5 w-7 h-7 rounded-full flex items-center justify-center text-primary-foreground shrink-0 font-ui"
                style={{ backgroundColor: "hsl(var(--primary))", fontSize: "var(--micro-value-size)" }}
                aria-hidden="true"
              >
                {step.n}
              </span>
              <div className="min-w-0">
                <p className="t-field-value font-medium">{step.title}</p>
                <p className="t-helper mt-0.5">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* CTA */}
      <div className="w-full mt-6">
        <Button size="lg" onClick={handleStart} data-testid="btn-ai-ready-start" className="w-full h-auto py-4 text-lg rounded-full">
          Let's go!
        </Button>
      </div>
      </div>
    </div>
  );
}
