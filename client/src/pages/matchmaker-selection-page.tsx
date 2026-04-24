import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";
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

  // Cache resolved avatar URLs in sessionStorage so the chat header can display them
  // instantly on the next page before brand data loads
  useEffect(() => {
    if (!matchmakers.length) return;
    try {
      const cache = matchmakers.map(m => ({
        id: m.id,
        avatarUrl: m.avatarUrl ? (getPhotoSrc(m.avatarUrl) || m.avatarUrl) : null,
      }));
      sessionStorage.setItem("gostork_matchmakers_cache", JSON.stringify(cache));
    } catch {
      // sessionStorage unavailable
    }
  }, [matchmakers]);

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
        navigate(`/onboarding/ai-ready?matchmaker=${selectedId}`, { replace: true });
      }, 1500);
    }
  };

  if (transitioning && transitionMatchmaker) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50" data-testid="matchmaker-transition">
        <div className="animate-[scaleIn_0.6s_ease-out_forwards] flex flex-col items-center text-center px-8">
          <div className="w-24 h-24 rounded-full flex-shrink-0 relative mb-6">
            {transitionMatchmaker.avatarUrl && (
              <img
                src={getPhotoSrc(transitionMatchmaker.avatarUrl) || transitionMatchmaker.avatarUrl}
                alt={transitionMatchmaker.name}
                className="w-24 h-24 rounded-full object-cover border-4 absolute inset-0 z-10"
                style={{ borderColor: brand?.primaryColor || "#004D4D" }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            )}
            <div
              className="w-24 h-24 rounded-full flex items-center justify-center text-primary-foreground text-3xl font-bold"
              style={{ backgroundColor: brand?.primaryColor || "#004D4D" }}
            >
              {transitionMatchmaker.name.charAt(0)}
            </div>
          </div>
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
        <p className="text-foreground text-sm md:text-base max-w-xl mx-auto">
          Your dedicated concierge will help you navigate providers, compare costs, and organize your path to parenthood. Select the profile that best fits your preferred communication style.
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-4">
        {matchmakers.map((m) => {
          const isSelected = selectedId === m.id;
          return (
            <Card
              key={m.id}
              className={`relative cursor-pointer transition-all duration-200 p-5 space-y-3 hover:shadow-md w-full sm:w-[280px] ${
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
                  className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center text-primary-foreground text-xs"
                  style={{ backgroundColor: brand?.primaryColor || "#004D4D" }}
                  data-testid={`matchmaker-selected-badge-${m.id}`}
                >
                  ✓
                </div>
              )}
              <div className="flex flex-col items-center text-center gap-3">
                <div className="w-24 h-24 rounded-full flex-shrink-0 relative">
                  {m.avatarUrl && (
                    <img
                      src={getPhotoSrc(m.avatarUrl) || undefined}
                      alt={m.name}
                      className="w-24 h-24 rounded-full object-cover border-3 absolute inset-0 z-10"
                      style={{ borderColor: isSelected ? brand?.primaryColor : "transparent" }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div
                    className="w-24 h-24 rounded-full flex items-center justify-center text-primary-foreground text-2xl font-bold"
                    style={{ backgroundColor: brand?.primaryColor || "#004D4D" }}
                  >
                    {m.name.charAt(0)}
                  </div>
                </div>
                <div>
                  <h3
                    className="font-display font-semibold text-lg"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {m.name}
                  </h3>
                  <p className="text-xs text-primary font-medium">{m.title}</p>
                </div>
              </div>
              <p className="text-sm text-foreground leading-relaxed text-center">{m.description}</p>
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
