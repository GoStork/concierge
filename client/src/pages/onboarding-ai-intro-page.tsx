import { useNavigate, useSearchParams } from "react-router-dom";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { getPhotoSrc } from "@/lib/profile-utils";
import { Stethoscope, Heart, Baby, FlaskConical } from "lucide-react";

// Service-to-visual config
const SERVICE_CONFIG: Record<string, { icon: typeof Stethoscope; gradient: string; label: string; imageKey: string; chatText: string; replyText: string }> = {
  "Fertility Clinic": { icon: Stethoscope, gradient: "from-primary/20 to-primary/5", label: "Top Clinics", imageKey: "onboardingClinicImageUrl", chatText: "I found a great match for you! A top-rated fertility clinic near you", replyText: "Tell me more about the clinic!" },
  "Egg Donor": { icon: FlaskConical, gradient: "from-pink-100 to-rose-50", label: "Egg Donors", imageKey: "onboardingEggDonorImageUrl", chatText: "I found an amazing egg donor that matches your preferences!", replyText: "She sounds great!" },
  "Surrogate": { icon: Baby, gradient: "from-amber-100 to-orange-50", label: "Surrogates", imageKey: "onboardingSurrogateImageUrl", chatText: "I found a wonderful surrogate who's a perfect fit for your journey!", replyText: "Tell me more about her!" },
  "Sperm Donor": { icon: Heart, gradient: "from-blue-100 to-sky-50", label: "Sperm Donors", imageKey: "onboardingSpermDonorImageUrl", chatText: "I found a great sperm donor that matches what you're looking for!", replyText: "Tell me more!" },
};

function ServiceCard({
  service,
  imageUrl,
  style,
}: {
  service: string;
  imageUrl: string | null;
  style: React.CSSProperties;
}) {
  const config = SERVICE_CONFIG[service];
  if (!config) return null;
  const Icon = config.icon;
  const resolvedUrl = imageUrl ? (getPhotoSrc(imageUrl) || imageUrl) : null;

  return (
    <div
      className={`absolute w-48 h-60 rounded-2xl border border-border shadow-lg overflow-hidden ${!resolvedUrl ? `bg-gradient-to-br ${config.gradient}` : ""}`}
      style={style}
    >
      {resolvedUrl ? (
        <>
          <img
            src={resolvedUrl}
            alt={config.label}
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-3">
            <span className="text-white text-sm font-semibold">{config.label}</span>
          </div>
        </>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3">
          <div className="w-16 h-16 rounded-full bg-background/80 flex items-center justify-center">
            <Icon className="w-8 h-8 text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground/80">{config.label}</span>
        </div>
      )}
    </div>
  );
}

export default function OnboardingAiIntroPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: brand } = useBrandSettings();

  const goalsParam = searchParams.get("goals") || "";
  const goals = goalsParam ? decodeURIComponent(goalsParam).split(",") : [];

  // Get the first active matchmaker for the avatar
  const matchmakers: Matchmaker[] = (brand?.matchmakers || [])
    .filter(m => m.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const concierge = matchmakers[0];

  // Pick up to 2 services to show as cards
  const visibleServices = goals
    .filter(g => SERVICE_CONFIG[g])
    .slice(0, 2);

  if (visibleServices.length === 0) {
    visibleServices.push("Fertility Clinic", "Egg Donor");
  }
  if (visibleServices.length === 1) {
    const fallback = Object.keys(SERVICE_CONFIG).find(k => !visibleServices.includes(k));
    if (fallback) visibleServices.push(fallback);
  }

  // Get image URLs from brand settings
  const getImageUrl = (service: string): string | null => {
    const key = SERVICE_CONFIG[service]?.imageKey;
    if (!key || !brand) return null;
    return (brand as any)[key] || null;
  };

  return (
    <div className="fixed inset-0 bg-background flex flex-col items-center justify-between py-12 px-6" data-testid="onboarding-ai-intro">
      <div className="max-w-md w-full flex flex-col items-center flex-1">
        {/* Title */}
        <h1
          className="text-3xl md:text-4xl font-bold leading-tight text-center mb-8"
          style={{ fontFamily: "var(--font-display)" }}
          data-testid="text-ai-intro-title"
        >
          Now let's meet your AI concierge
        </h1>

        {/* Photo cards - front card (service[0]) on top, matches chat text */}
        <div className="relative w-72 h-72 mx-auto mb-6">
          {/* Back card - secondary service, behind */}
          <ServiceCard
            service={visibleServices[1]}
            imageUrl={getImageUrl(visibleServices[1])}
            style={{ left: "8px", top: "16px", transform: "rotate(-6deg)", zIndex: 1 }}
          />
          {/* Front card - primary service, on top, matches chat bubble */}
          <ServiceCard
            service={visibleServices[0]}
            imageUrl={getImageUrl(visibleServices[0])}
            style={{ right: "8px", top: "0px", transform: "rotate(4deg)", zIndex: 2 }}
          />

          {/* Chat bubble overlay - text matches front card service */}
          <div className="absolute bottom-0 left-0 right-0 z-10 flex items-end gap-2">
            {concierge?.avatarUrl ? (
              <img
                src={getPhotoSrc(concierge.avatarUrl) || undefined}
                alt={concierge.name}
                className="w-10 h-10 rounded-full object-cover border-2 border-background flex-shrink-0"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center flex-shrink-0 border-2 border-background">
                <span className="text-primary-foreground text-sm font-bold">AI</span>
              </div>
            )}
            <div className="bg-muted rounded-[var(--radius)] rounded-bl-none px-4 py-3 shadow-sm max-w-[220px]">
              <p className="text-sm text-foreground">
                {SERVICE_CONFIG[visibleServices[0]]?.chatText || "I found a great match for you!"}
              </p>
            </div>
          </div>
        </div>

        {/* User reply bubble - matches front card service */}
        <div className="flex justify-end w-full max-w-xs mb-8">
          <div className="bg-primary text-primary-foreground rounded-[var(--radius)] rounded-br-none px-4 py-2.5">
            <p className="text-sm">{SERVICE_CONFIG[visibleServices[0]]?.replyText || "Tell me more!"}</p>
          </div>
        </div>

        {/* Disclaimer */}
        <p className="text-center text-muted-foreground text-xs leading-relaxed max-w-sm mx-auto">
          Our AI is not perfect yet. It can have some glitches.
        </p>
      </div>

      {/* CTA */}
      <div className="w-full max-w-md mt-6">
        <button
          onClick={() => navigate("/matchmaker-selection", { replace: true })}
          data-testid="btn-ai-intro-continue"
          className="w-full py-4 rounded-full text-lg font-semibold bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] transition-all duration-200"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
