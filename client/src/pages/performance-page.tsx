import { SponsorshipDashboard } from "@/components/sponsorship/sponsorship-dashboard";

/**
 * Provider-only top-level "Performance" tab: the same analytics surface as the
 * sponsorship dashboard, but across ALL of the provider's marketplace profiles
 * (with an All-profiles / Sponsored-only scope toggle). Reuses the dashboard in
 * "performance" mode - no duplicated analytics logic.
 */
export default function PerformancePage() {
  return (
    <div className="max-w-[1400px] mx-auto w-full px-4 sm:px-6 py-6">
      <SponsorshipDashboard mode="performance" />
    </div>
  );
}
