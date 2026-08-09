import { JourneyFunnelDashboard } from "@/components/journey/journey-funnel";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Phase 7C: GoStork admin journey analytics - the parent-journey funnel
 * aggregated across all providers, with per-provider drill-down. The
 * provider-facing variant of the same dashboard lives on their
 * Performance page (scope="provider").
 */
export default function AdminAnalyticsPage() {
  return (
    <div className="space-y-8 pb-24 md:pb-6">
      <PageHeader
        title="Journey Analytics"
        subtitle="How parents move through their journeys - conversion, stalls, and provider performance."
      />
      <JourneyFunnelDashboard scope="admin" />
    </div>
  );
}
