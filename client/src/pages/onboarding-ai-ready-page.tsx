import { useNavigate, useSearchParams } from "react-router-dom";
import { useBrandSettings, Matchmaker } from "@/hooks/use-brand-settings";
import { useQuery } from "@tanstack/react-query";
import { getPhotoSrc } from "@/lib/profile-utils";
import { CalendarCheck, Clock, MessageSquare } from "lucide-react";

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
  const selected = matchmakers.find(m => m.id === matchmakerId) || matchmakers[0];

  const profileQuery = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
  });
  const services = profileQuery.data?.interestedServices || [];
  const primaryService = services[0] || "Fertility Clinic";
  const serviceLabel = SERVICE_LABELS[primaryService] || "fertility provider";

  const handleStart = () => {
    navigate(`/concierge?matchmaker=${matchmakerId || selected?.id || ""}`, { replace: true });
  };

  return (
    <div className="fixed inset-0 bg-background flex flex-col items-center justify-between py-12 px-6" data-testid="onboarding-ai-ready">
      <div className="max-w-md w-full flex flex-col items-center flex-1">
        {/* Selected avatar */}
        <div className="flex justify-center mb-4">
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
          className="text-3xl md:text-4xl font-bold leading-tight text-center mb-4"
          style={{ fontFamily: "var(--font-display)" }}
          data-testid="text-ai-ready-title"
        >
          {selected ? `${selected.name} is ready...` : "Your AI concierge is ready..."}
        </h1>

        <div className="text-foreground text-base leading-relaxed text-center space-y-1 mb-8">
          <p>On {brandName}, each match leads to a scheduled meeting.</p>
          <p>Your AI sets up the meetings directly.</p>
        </div>

        {/* Mock chat with booking confirmation */}
        <div className="relative mx-auto max-w-sm w-full">
          {/* AI message */}
          <div className="flex items-start gap-3 mb-3">
            {selected?.avatarUrl ? (
              <img
                src={getPhotoSrc(selected.avatarUrl) || undefined}
                alt=""
                className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: "hsl(var(--primary))" }}
              >
                <MessageSquare className="w-4 h-4 text-primary-foreground" />
              </div>
            )}
            <div className="bg-muted rounded-[var(--radius)] rounded-bl-none p-4 max-w-[300px]">
              <p className="text-sm text-foreground">
                Glad to connect you here! I have just booked a meeting with your {serviceLabel}, based on your availabilities.
              </p>

              {/* Booking confirmation card */}
              <div className="bg-background rounded-[var(--radius)] border border-border overflow-hidden mt-3">
                <div className="p-3 space-y-2">
                  <p className="font-semibold text-sm">Meeting Confirmed</p>
                  <div className="flex items-center gap-1.5 text-xs text-foreground">
                    <CalendarCheck className="w-3.5 h-3.5 text-primary" />
                    <span>Fri, Apr 4 - 10:00 AM</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="w-3.5 h-3.5" />
                    <span>30 min - Free consultation</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="w-full max-w-md mt-6">
        <button
          onClick={handleStart}
          data-testid="btn-ai-ready-start"
          className="w-full py-4 rounded-full text-lg font-semibold bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98] transition-all duration-200"
        >
          Let's go!
        </button>
      </div>
    </div>
  );
}
