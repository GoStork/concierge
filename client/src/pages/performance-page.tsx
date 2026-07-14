import { useSearchParams } from "react-router-dom";
import { SponsorshipDashboard } from "@/components/sponsorship/sponsorship-dashboard";
import { JourneyFunnelDashboard } from "@/components/journey/journey-funnel";
import { ProviderReviewsPanel } from "@/components/reviews/reviews-ui";

/**
 * Provider-only top-level "Performance" tab, split into sub-tabs (tab
 * state lives in the URL so back-button returns to the exact view):
 *  - Profile Performance: the sponsorship/engagement analytics across all
 *    of the provider's marketplace profiles (SponsorshipDashboard).
 *  - Journey Funnel: how parents move through their journey with this
 *    provider, from first consultation to handoff (Phase 7C).
 *  - Reviews: verified-parent reviews of this org and its doctors, with
 *    public reply + flag-for-recheck actions (Phase 8).
 */
export default function PerformancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const tab = raw === "funnel" ? "funnel" : raw === "reviews" ? "reviews" : "profiles";
  const setTab = (t: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", t);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="max-w-[1400px] mx-auto w-full px-4 sm:px-6 py-6 space-y-6">
      <div className="inline-flex rounded-lg border border-border overflow-hidden" data-testid="performance-tabs">
        {([["profiles", "Profile Performance"], ["funnel", "Journey Funnel"], ["reviews", "Reviews"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            className={`px-4 py-2 text-sm font-ui transition-colors ${tab === v ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
            data-testid={`performance-tab-${v}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "profiles" ? (
        <SponsorshipDashboard mode="performance" />
      ) : tab === "funnel" ? (
        <div>
          <h2 className="text-xl font-heading mb-1">Journey Funnel</h2>
          <p className="text-sm text-muted-foreground mb-4">How parents move through their journey with you - from first consultation to handoff.</p>
          <JourneyFunnelDashboard scope="provider" />
        </div>
      ) : (
        <div>
          <h2 className="text-xl font-heading mb-1">Reviews</h2>
          <p className="text-sm text-muted-foreground mb-4">Verified reviews from intended parents. You can post one public response per review, or flag a review for GoStork to re-check.</p>
          <ProviderReviewsPanel brandColor="hsl(var(--primary))" />
        </div>
      )}
    </div>
  );
}
