import { JourneyFunnelDashboard } from "@/components/journey/journey-funnel";

/**
 * Phase 7C: GoStork admin journey analytics - the parent-journey funnel
 * aggregated across all providers, with per-provider drill-down. The
 * provider-facing variant of the same dashboard lives on their
 * Performance page (scope="provider").
 */
export default function AdminAnalyticsPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6 pb-24 md:pb-6">
      <div>
        <h1 className="text-2xl font-heading">Journey Analytics</h1>
        <p className="t-helper mt-1">How parents move through their journeys - conversion, stalls, and provider performance.</p>
      </div>
      <JourneyFunnelDashboard scope="admin" />
    </div>
  );
}
