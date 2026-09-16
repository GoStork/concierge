/**
 * "Now let's meet your concierge" - the one screen between the finished
 * wizard and the persona picker.
 *
 * ONE implementation for both mounts: the wizard renders it in place right
 * after account creation (no route change, so the "creating your account"
 * state survives), and /onboarding/ai-intro renders it for deep links and
 * returning parents. The two used to be separate copies that had already
 * drifted (raw button vs shared Button, safe-area padding on one only) and
 * both clipped the Continue button on a 667px-tall phone because the fixed
 * container could not scroll.
 *
 * Card tints come from the platform-wide service hues (index.css --service-*),
 * the same identity the ServiceTag uses everywhere else. Never pink-for-eggs /
 * blue-for-sperm: that is gendered color coding and the brand forbids it.
 */
import { useEffect } from "react";
import { Stethoscope, Heart, Baby, FlaskConical, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPhotoSrc } from "@/lib/profile-utils";
import type { Matchmaker } from "@/hooks/use-brand-settings";

const SERVICE_CONFIG: Record<string, { icon: typeof Stethoscope; hue: string; label: string; imageKey: string; chatText: string; replyText: string }> = {
  "Fertility Clinic": { icon: Stethoscope, hue: "--service-ivf", label: "Top Clinics", imageKey: "onboardingClinicImageUrl", chatText: "I found a great match for you! A top-rated fertility clinic near you", replyText: "Tell me more about the clinic!" },
  "Egg Donor": { icon: FlaskConical, hue: "--service-egg-donation", label: "Egg Donors", imageKey: "onboardingEggDonorImageUrl", chatText: "I found an amazing egg donor that matches your preferences!", replyText: "She sounds great!" },
  "Surrogate": { icon: Baby, hue: "--service-surrogacy", label: "Surrogates", imageKey: "onboardingSurrogateImageUrl", chatText: "I found a wonderful surrogate who's a perfect fit for your journey!", replyText: "I'd love to learn more!" },
  "Sperm Donor": { icon: Heart, hue: "--service-sperm-donation", label: "Sperm Donors", imageKey: "onboardingSpermDonorImageUrl", chatText: "I found a great sperm donor that matches what you're looking for!", replyText: "He sounds like a great fit!" },
};

function ServiceCard({ service, imageUrl, style }: { service: string; imageUrl: string | null; style: React.CSSProperties }) {
  const config = SERVICE_CONFIG[service];
  if (!config) return null;
  const Icon = config.icon;
  const resolvedUrl = imageUrl ? (getPhotoSrc(imageUrl) || imageUrl) : null;
  return (
    <div
      className="absolute w-48 h-60 rounded-[var(--container-radius)] border border-border shadow-lg overflow-hidden"
      style={{ ...style, ...(resolvedUrl ? {} : { background: `linear-gradient(135deg, hsl(var(${config.hue}) / 0.18), hsl(var(${config.hue}) / 0.04))` }) }}
    >
      {resolvedUrl ? (
        <>
          <img src={resolvedUrl} alt={config.label} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent p-3">
            <span className="text-white text-sm font-semibold">{config.label}</span>
          </div>
        </>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3">
          <div className="w-16 h-16 rounded-full bg-card/80 flex items-center justify-center">
            <Icon className="w-8 h-8" style={{ color: `hsl(var(${config.hue}))` }} />
          </div>
          <span className="text-sm font-semibold text-foreground/80">{config.label}</span>
        </div>
      )}
    </div>
  );
}

export function AiIntroScreen({
  goals,
  concierge,
  brand,
  onContinue,
}: {
  goals: string[];
  /** The persona to preview, when one is already known; null shows a neutral mark. */
  concierge: Matchmaker | null;
  brand: any;
  onContinue: () => void;
}) {
  const brandName = brand?.companyName || "GoStork";
  const conciergeName = concierge?.name?.trim() || null;

  useEffect(() => {
    const prev = document.title;
    document.title = `Meet your concierge - ${brandName}`;
    return () => { document.title = prev; };
  }, [brandName]);

  const visibleServices = goals.filter((g) => SERVICE_CONFIG[g]).slice(0, 2);
  if (visibleServices.length === 0) visibleServices.push("Fertility Clinic", "Egg Donor");
  if (visibleServices.length === 1) {
    const fallback = Object.keys(SERVICE_CONFIG).find((k) => !visibleServices.includes(k));
    if (fallback) visibleServices.push(fallback);
  }
  const getImageUrl = (service: string): string | null => {
    const key = SERVICE_CONFIG[service]?.imageKey;
    if (!key || !brand) return null;
    return (brand as any)[key] || null;
  };

  return (
    // Scrollable on purpose: a fixed, non-scrolling container clipped the
    // Continue button on 667px-tall phones (measured: button bottom 682px).
    <div className="fixed inset-0 bg-background overflow-y-auto px-6" data-testid="onboarding-ai-intro">
      <div
        className="min-h-full max-w-md mx-auto flex flex-col items-center justify-between"
        style={{ paddingTop: "max(2rem, env(safe-area-inset-top, 0px))", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom, 0px))" }}
      >
        <div className="w-full flex flex-col items-center flex-1">
          <h1 className="text-3xl md:text-4xl font-bold leading-tight text-center mb-8 [@media(max-height:700px)]:mb-5" style={{ fontFamily: "var(--font-display)" }} data-testid="text-ai-intro-title">
            {conciergeName ? `Now let's meet ${conciergeName}` : "Now let's meet your AI concierge"}
          </h1>

          <div className="relative w-72 h-72 [@media(max-height:700px)]:h-64 mx-auto mb-6 [@media(max-height:700px)]:mb-3">
            <ServiceCard service={visibleServices[1]} imageUrl={getImageUrl(visibleServices[1])} style={{ left: "8px", top: "16px", transform: "rotate(-6deg)", zIndex: 1 }} />
            <ServiceCard service={visibleServices[0]} imageUrl={getImageUrl(visibleServices[0])} style={{ right: "8px", top: "0px", transform: "rotate(4deg)", zIndex: 2 }} />
            <div className="absolute bottom-0 left-0 right-0 z-10 flex items-end gap-2">
              {concierge?.avatarUrl ? (
                <img src={getPhotoSrc(concierge.avatarUrl) || undefined} alt={concierge.name} className="w-10 h-10 rounded-full object-cover border-2 border-background flex-shrink-0" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              ) : (
                <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center flex-shrink-0 border-2 border-background" aria-hidden="true">
                  {conciergeName ? (
                    <span className="text-primary-foreground text-sm font-bold">{conciergeName.charAt(0).toUpperCase()}</span>
                  ) : (
                    <Sparkles className="w-5 h-5 text-primary-foreground" />
                  )}
                </div>
              )}
              <div className="bg-muted rounded-[var(--radius)] rounded-bl-none px-4 py-3 shadow-sm max-w-[220px]">
                <p className="text-sm text-foreground">{SERVICE_CONFIG[visibleServices[0]]?.chatText || "I found a great match for you!"}</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end w-full max-w-xs mb-8">
            <div className="bg-primary text-primary-foreground rounded-[var(--radius)] rounded-br-none px-4 py-2.5">
              <p className="text-sm">{SERVICE_CONFIG[visibleServices[0]]?.replyText || "Tell me more!"}</p>
            </div>
          </div>

          <p className="t-helper text-center leading-relaxed max-w-sm mx-auto">
            {conciergeName ?? "Your concierge"} can answer most questions right away. When something needs a person, the {brandName} team steps in.
          </p>
        </div>

        <div className="w-full mt-6">
          <Button size="lg" onClick={onContinue} data-testid="btn-ai-intro-continue" className="w-full h-auto py-4 text-lg rounded-full">
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
