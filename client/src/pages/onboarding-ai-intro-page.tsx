import { useNavigate, useSearchParams } from "react-router-dom";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { AiIntroScreen } from "@/components/onboarding/ai-intro-screen";

/**
 * Deep-link / return mount of the meet-your-concierge screen. The wizard
 * renders the same AiIntroScreen in place after account creation.
 */
export default function OnboardingAiIntroPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: brand } = useBrandSettings();

  const goalsParam = searchParams.get("goals") || "";
  const goals = goalsParam ? decodeURIComponent(goalsParam).split(",") : [];

  const matchmakers: Matchmaker[] = (brand?.matchmakers || [])
    .filter((m) => m.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const requestedId = searchParams.get("matchmaker");
  const concierge = requestedId
    ? matchmakers.find((m) => m.id === requestedId) || null
    : matchmakers.length === 1 ? matchmakers[0] : null;

  return (
    <AiIntroScreen
      goals={goals}
      concierge={concierge}
      brand={brand}
      onContinue={() => navigate("/matchmaker-selection", { replace: true })}
    />
  );
}
