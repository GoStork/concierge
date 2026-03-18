import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles, ArrowRight } from "lucide-react";

export default function MatchmakerSelectionPage() {
  const { data: brand, isLoading } = useBrandSettings();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transitionMatchmaker, setTransitionMatchmaker] = useState<Matchmaker | null>(null);
  const [checkedExisting, setCheckedExisting] = useState(false);

  const { data: existingSessions } = useQuery<any[]>({
    queryKey: ["/api/my/chat-sessions"],
    enabled: !!user,
  });

  const matchmakers: Matchmaker[] = (brand?.matchmakers || [])
    .filter(m => m.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  useEffect(() => {
    if (checkedExisting || !existingSessions || !matchmakers.length) return;
    setCheckedExisting(true);
    const sessionWithMatchmaker = existingSessions.find(s => s.matchmakerId);
    if (sessionWithMatchmaker) {
      navigate(`/concierge?matchmaker=${sessionWithMatchmaker.matchmakerId}`, { replace: true });
    }
  }, [existingSessions, matchmakers, checkedExisting, navigate]);

  const userName = (user as any)?.firstName || (user as any)?.name?.split(" ")[0] || "";

  const handleContinue = () => {
    if (!selectedId) return;
    const selected = matchmakers.find((m) => m.id === selectedId);
    if (selected) {
      setTransitionMatchmaker(selected);
      setTransitioning(true);
      setTimeout(() => {
        navigate(`/concierge?matchmaker=${selectedId}`);
      }, 1500);
    }
  };

  if (transitioning && transitionMatchmaker) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50" data-testid="matchmaker-transition">
        <div className="animate-[scaleIn_0.6s_ease-out_forwards] flex flex-col items-center text-center px-8">
          {transitionMatchmaker.avatarUrl ? (
            <img
              src={transitionMatchmaker.avatarUrl}
              alt={transitionMatchmaker.name}
              className="w-24 h-24 rounded-full object-cover border-4 mb-6"
              style={{ borderColor: brand?.primaryColor || "#004D4D" }}
            />
          ) : (
            <div
              className="w-24 h-24 rounded-full flex items-center justify-center text-white text-3xl font-bold mb-6"
              style={{ backgroundColor: brand?.primaryColor || "#004D4D" }}
            >
              {transitionMatchmaker.name.charAt(0)}
            </div>
          )}
          <h2
            className="text-2xl font-bold mb-2"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Connecting you with {transitionMatchmaker.name}...
          </h2>
          <p className="text-muted-foreground text-sm">{transitionMatchmaker.title}</p>
          <Loader2 className="w-6 h-6 animate-spin text-primary mt-6" />
        </div>
        <style>{`
          @keyframes scaleIn {
            from { opacity: 0; transform: scale(0.8); }
            to { opacity: 1; transform: scale(1); }
          }
        `}</style>
      </div>
    );
  }

  if (isLoading || (existingSessions && !checkedExisting)) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]" data-testid="matchmaker-loading">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (matchmakers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center" data-testid="matchmaker-empty">
        <Sparkles className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="font-display text-xl font-semibold mb-2">AI Concierges Coming Soon</h2>
        <p className="text-muted-foreground text-sm max-w-md">
          Our AI Concierges are currently being set up. Please check back shortly.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8" data-testid="matchmaker-selection-page">
      <div className="text-center space-y-3">
        <div className="flex items-center justify-center gap-2">
          <Sparkles className="w-6 h-6 text-primary" />
          <h1
            className="font-display text-2xl md:text-3xl font-bold"
            style={{ fontFamily: "var(--font-display)" }}
            data-testid="matchmaker-heading"
          >
            {userName ? `${userName}, choose your AI Concierge` : "Choose Your AI Concierge"}
          </h1>
        </div>
        <p className="text-muted-foreground text-sm md:text-base max-w-xl mx-auto">
          Your dedicated concierge will help you navigate providers, compare costs, and organize your path to parenthood. Select the profile that best fits your preferred communication style.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {matchmakers.map((m) => {
          const isSelected = selectedId === m.id;
          return (
            <Card
              key={m.id}
              className={`relative cursor-pointer transition-all duration-200 p-5 space-y-3 hover:shadow-md ${
                isSelected
                  ? "ring-2 ring-primary shadow-lg"
                  : "hover:ring-1 hover:ring-primary/30"
              }`}
              style={{ borderRadius: `var(--container-radius, 0.5rem)` }}
              onClick={() => setSelectedId(m.id)}
              data-testid={`matchmaker-option-${m.id}`}
            >
              {isSelected && (
                <div
                  className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center text-white text-xs"
                  style={{ backgroundColor: brand?.primaryColor || "#004D4D" }}
                  data-testid={`matchmaker-selected-badge-${m.id}`}
                >
                  ✓
                </div>
              )}
              <div className="flex items-center gap-3">
                {m.avatarUrl ? (
                  <img
                    src={m.avatarUrl}
                    alt={m.name}
                    className="w-14 h-14 rounded-full object-cover border-2"
                    style={{ borderColor: isSelected ? brand?.primaryColor : "transparent" }}
                  />
                ) : (
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-bold"
                    style={{ backgroundColor: brand?.primaryColor || "#004D4D" }}
                  >
                    {m.name.charAt(0)}
                  </div>
                )}
                <div>
                  <h3
                    className="font-display font-semibold text-base"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {m.name}
                  </h3>
                  <p className="text-xs text-muted-foreground">{m.title}</p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{m.description}</p>
            </Card>
          );
        })}
      </div>

      <div className="flex justify-center">
        <Button
          size="lg"
          disabled={!selectedId}
          onClick={handleContinue}
          className="px-8 gap-2"
          style={{ borderRadius: `var(--radius, 0.5rem)` }}
          data-testid="btn-continue-matchmaker"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
