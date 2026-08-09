import { useMemo, useState } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { apiRequest } from "@/lib/queryClient";
import { formatMoneyCents } from "@/lib/format-money";
import { getPhotoSrc } from "@/lib/profile-utils";
import { SponsorshipCheckoutOverlay } from "./sponsorship-checkout";
import { BoostProfilesCard } from "./sponsorship-wizard";
import {
  Sparkles, Eye, Heart, MessageCircle, Flame, TrendingUp, Loader2, MousePointerClick,
  Plus, X, ChevronDown, ChevronUp, Gift, CreditCard, User, CalendarCheck, DollarSign, Download, Search,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";

const TYPE_LABELS: Record<string, string> = {
  EGG_DONOR: "Egg donors", SURROGATE: "Surrogates", SPERM_DONOR: "Sperm donors", DOCTOR: "Doctors", PROFILE: "Whole profile",
};

type BillingMode = "AUTO_RENEW" | "ONE_TIME";
type EntityType = "EGG_DONOR" | "SURROGATE" | "SPERM_DONOR" | "DOCTOR";

const SLOT_ENTITY_TYPES: { type: EntityType; label: string }[] = [
  { type: "EGG_DONOR", label: "Egg donors" },
  { type: "SURROGATE", label: "Surrogates" },
  { type: "SPERM_DONOR", label: "Sperm donors" },
  { type: "DOCTOR", label: "Doctors" },
];

const SLOT_TYPE_HEADERS: Record<string, string> = {
  EGG_DONOR: "Egg donor slots",
  SPERM_DONOR: "Sperm donor slots",
  SURROGATE: "Surrogate slots",
  DOCTOR: "Doctor slots",
};

/**
 * Shared sponsorship dashboard + management surface. Mounted standalone in two
 * places: the admin provider-edit "Sponsorship" tab (pass providerId + isAdmin)
 * and the provider self-serve /account/sponsorship page (no providerId).
 */
export function SponsorshipDashboard({ providerId, isAdmin = false, mode = "sponsorship" }: { providerId?: string; isAdmin?: boolean; mode?: "sponsorship" | "performance" | "manage" }) {
  const qc = useQueryClient();
  // Three surfaces, one component:
  //  - "performance": the all-profiles analytics tab (scope toggle, no management).
  //  - "manage": the provider self-serve Sponsorship tab - management only (Boost
  //    bar + Your Sponsorships) plus the lift hero as an ROI teaser; the full
  //    analytics live in the Performance tab.
  //  - "sponsorship" (default): the admin provider-edit view - full analytics.
  const isPerformance = mode === "performance";
  const isManage = mode === "manage";
  const showFullAnalytics = !isManage; // manage hides the detailed analytics
  // The Performance tab honors ?scope=sponsored (the lift-hero "See full
  // analytics" link deep-links to the sponsored view).
  const [searchParams] = useSearchParams();
  const [scope, setScope] = useState<"all" | "sponsored">(
    isPerformance ? (searchParams.get("scope") === "sponsored" ? "sponsored" : "all") : "sponsored",
  );

  // URL builders: admin routes carry ?providerId; provider self-serve is implicit.
  const base = isAdmin ? "/api/admin/sponsorship" : "/api/sponsorship";
  const withProvider = (qs = "") => (isAdmin ? `?providerId=${providerId}${qs ? `&${qs}` : ""}` : (qs ? `?${qs}` : ""));

  const plansQ = useQuery<any[]>({ queryKey: ["/api/sponsorship/plans"] });
  const listKey = isAdmin ? [`${base}`, providerId] : ["/api/sponsorship/mine"];
  // The global query client uses staleTime: Infinity, so without this a remount
  // (navigating back from the profile picker after adding slots) would serve a
  // stale cache and only update on a full page refresh. Always refetch on mount.
  const listQ = useQuery<any[]>({
    queryKey: listKey,
    queryFn: async () => (await apiRequest("GET", isAdmin ? `${base}${withProvider()}` : "/api/sponsorship/mine")).json(),
    enabled: !isAdmin || !!providerId,
    refetchOnMount: "always",
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const [range, setRange] = useState<"all" | "30" | "7" | "custom">("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const qsParts: string[] = [];
  if (range === "custom") { if (customFrom) qsParts.push(`from=${customFrom}`); if (customTo) qsParts.push(`to=${customTo}`); }
  else if (range !== "all") qsParts.push(`range=${range}`);
  if (typeFilter !== "all") qsParts.push(`type=${typeFilter}`);
  if (scope === "all") qsParts.push("scope=all");
  const analyticsQs = qsParts.join("&");
  const analyticsQ = useQuery<any>({
    queryKey: [`${base}/analytics`, providerId, range, customFrom, customTo, typeFilter, scope],
    queryFn: async () => (await apiRequest("GET", `${base}/analytics${withProvider(analyticsQs)}`)).json(),
    enabled: !isAdmin || !!providerId,
    refetchOnMount: "always",
    // Live updates: poll every 15s and refetch when the provider tabs back in,
    // so impressions/clicks/saves/inquiries climb without a manual refresh.
    // React Query pauses the interval while the tab is hidden (no background
    // refetch), so this adds no load when nobody's watching.
    refetchInterval: 10000,
    // Keep polling even when the dashboard sits in a background/unfocused tab,
    // so numbers stay live while the provider tests saves/inquiries in another
    // window. One provider's 10s analytics poll is negligible load.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: listKey });
    qc.invalidateQueries({ queryKey: [`${base}/analytics`, providerId] });
  };

  const a = analyticsQ.data;
  const kpis = a?.kpis;
  const saveRate = kpis?.totalImpressions ? `${Math.round((kpis.saves / kpis.totalImpressions) * 100)}% save rate` : undefined;

  return (
    <div className="space-y-6" data-testid="sponsorship-dashboard">
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-accent" />
        <h2 className="text-xl font-heading text-foreground">{isPerformance ? "Performance" : "Profile Sponsorship"}</h2>
      </div>
      <p className="t-helper -mt-4">
        {isPerformance
          ? "Engagement and conversions across all your marketplace profiles - impressions, clicks, saves, inquiries and consultations."
          : 'Boost your profiles to the top of the marketplace with a "Sponsored" badge and priority in the AI concierge.'}
      </p>

      {/* Start a sponsorship - pinned at the top for providers (admins use the
          per-plan Charge / Complimentary grid lower down). Hidden in the
          performance (all-profiles) view, which is analytics-only. */}
      {!isAdmin && !isPerformance && <BoostProfilesCard onChanged={refetchAll} />}

      {/* ONE filter bar (user decision, 7C polish): scope, date range, and
          profile type sit together instead of three stacked rows. The same
          segmented controls, shared state - just one line. */}
      {(isPerformance || showFullAnalytics) && (
        <div className="flex items-center gap-2.5 flex-wrap" data-testid="performance-filter-bar">
          {isPerformance && (
            <div className="inline-flex rounded-lg border border-border overflow-hidden">
              {([["all", "All profiles"], ["sponsored", "Sponsored only"]] as const).map(([v, label]) => (
                <button key={v} onClick={() => setScope(v)}
                  className={`px-3 py-1.5 text-sm transition-colors ${scope === v ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
                  data-testid={`scope-${v}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {showFullAnalytics && (
            <div className="inline-flex rounded-lg border border-border overflow-hidden">
              {([["all", "All time"], ["30", "Last 30 days"], ["7", "Last 7 days"], ["custom", "Custom"]] as const).map(([v, label]) => (
                <button key={v} onClick={() => setRange(v)}
                  className={`px-3 py-1.5 text-sm transition-colors ${range === v ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
                  data-testid={`range-${v}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {showFullAnalytics && range === "custom" && (
            <div className="flex items-center gap-1.5 text-sm">
              <input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm" data-testid="range-from" />
              <span className="text-muted-foreground">to</span>
              <input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm" data-testid="range-to" />
            </div>
          )}
          {showFullAnalytics && (a?.availableTypes?.length ?? 0) > 1 && (
            <div className="inline-flex rounded-lg border border-border overflow-hidden flex-wrap" data-testid="page-type-filter">
              {(["all", ...a.availableTypes] as string[]).map((t) => (
                <button key={t} onClick={() => setTypeFilter(t)}
                  className={`px-3 py-1.5 text-sm transition-colors ${typeFilter === t ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
                  data-testid={`page-type-${t}`}>
                  {t === "all" ? "All types" : TYPE_LABELS[t] || t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Lift hero - the ROI proof: sponsored vs the provider's non-sponsored profiles. */}
      {a?.lift?.multiple != null && (
        <Card className="border-accent/40 bg-accent/5">
          <CardContent className="p-5 flex items-center gap-4 flex-wrap" data-testid="lift-hero">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><TrendingUp className="w-6 h-6" /></div>
            <div className="min-w-0">
              <div className="text-2xl font-heading text-foreground">
                {a.lift.multiple.toFixed(1)}× more impressions <span className="t-helper font-body">than your non-sponsored profiles</span>
              </div>
              <p className="t-helper">
                Your sponsored profiles average <strong className="text-foreground">{a.lift.sponsoredAvg.toFixed(1)}</strong> views each vs <strong className="text-foreground">{a.lift.baselineAvg.toFixed(1)}</strong> for your {a.lift.baselineCount} non-sponsored profiles, this period.
              </p>
            </div>
            {isManage && (
              <Link to="/performance?scope=sponsored" className="ml-auto shrink-0 text-sm font-ui text-primary hover:underline whitespace-nowrap" data-testid="see-full-analytics">
                See full analytics →
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {/* Detailed analytics block - hidden in the management view (manage), where
          it's replaced by the Performance tab + the lift-hero teaser above. */}
      {showFullAnalytics && (<>
      {/* Search visibility - boosted vs organic deck position (the non-circular
          proof: sponsorship is a paid placement, this shows how far up it moves you). */}
      {a?.ranking && (
        <Card className="border-accent/40 bg-accent/5">
          <CardContent className="p-5" data-testid="ranking-card">
            <div className="flex items-center gap-2 mb-3">
              <Search className="w-4 h-4 text-accent" />
              <span className="font-heading text-foreground">Search visibility</span>
            </div>
            <div className="flex items-center gap-x-8 gap-y-3 flex-wrap">
              <div>
                <div className="text-2xl font-heading text-foreground">#{a.ranking.avgPosition}</div>
                <div className="t-helper">avg position (boosted)</div>
              </div>
              <span className="t-helper">vs</span>
              <div>
                <div className="text-2xl font-heading text-muted-foreground">#{a.ranking.avgOrganicPosition}</div>
                <div className="t-helper">organic (without boost)</div>
              </div>
              <div className="h-8 w-px bg-border hidden sm:block" />
              <div>
                <div className="text-2xl font-heading text-[hsl(var(--brand-success))]">▲ {a.ranking.lift}</div>
                <div className="t-helper">spots higher</div>
              </div>
              <div>
                <div className="text-2xl font-heading text-foreground">{a.ranking.topFiveRate}%</div>
                <div className="t-helper">in the top 5</div>
              </div>
            </div>
            <p className="t-helper mt-3">
              Sponsorship moves your {rankingNouns(a.ranking.types)} profiles about <strong className="text-foreground">{a.ranking.lift} spots</strong> up the marketplace deck (from ~#{a.ranking.avgOrganicPosition} organically to ~#{a.ranking.avgPosition}), across {a.ranking.samples} periodic ranking checks this period.
            </p>
          </CardContent>
        </Card>
      )}

      {/* KPIs - all in one row on desktop. The all-profiles view drops the two
          sponsorship-only tiles (Active sponsorships, Slots used). */}
      <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${scope === "all" ? "lg:grid-cols-6" : "lg:grid-cols-8"}`}>
        {scope !== "all" && <KpiCard icon={<Sparkles className="w-4 h-4" />} label="Active sponsorships" value={kpis?.activeSponsorships ?? 0} />}
        <KpiCard icon={<Eye className="w-4 h-4" />} label="Impressions" value={kpis?.totalImpressions ?? 0} hint={`${kpis?.uniqueReach ?? 0} parents reached`} delta={a?.deltas?.impressions} />
        <KpiCard icon={<MousePointerClick className="w-4 h-4" />} label="Clicks" value={kpis?.profileViews ?? 0} hint="opened full profile" delta={a?.deltas?.profileViews} />
        <KpiCard icon={<Heart className="w-4 h-4" />} label="Saves" value={kpis?.saves ?? 0} hint={saveRate} delta={a?.deltas?.saves} />
        <KpiCard icon={<MessageCircle className="w-4 h-4" />} label="Inquiries" value={kpis?.inquiries ?? 0} hint={scope === "all" ? "about your profiles" : "about sponsored profiles"} delta={a?.deltas?.inquiries} />
        <KpiCard icon={<CalendarCheck className="w-4 h-4" />} label="Consultations" value={kpis?.consultations ?? 0} hint={scope === "all" ? "booked · account-level" : (typeFilter !== "all" ? "booked · account-level" : "booked while sponsored")} delta={a?.deltas?.consultations} />
        <KpiCard icon={<Flame className="w-4 h-4" />} label="Hot leads" value={kpis?.hotLeads ?? 0} hint={scope === "all" ? "account-level" : (typeFilter !== "all" ? "while sponsored · account-level" : "while sponsored")} />
        {scope !== "all" && <KpiCard icon={<TrendingUp className="w-4 h-4" />} label="Slots used" value={`${kpis?.slotsUsed ?? 0}/${kpis?.slotsTotal ?? 0}`} />}
      </div>

      {/* Cost-per-result - what the spend is buying. */}
      {(kpis?.monthlySpendCents ?? 0) > 0 && (
        <Card>
          <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap" data-testid="cost-strip">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-muted-foreground" />
              <span className="t-helper">Monthly spend</span>
              <span className="font-heading text-foreground text-lg">{formatMoneyCents(kpis.monthlySpendCents)}</span>
            </div>
            <div className="flex gap-5 flex-wrap">
              <CostStat label="per impression" spendCents={kpis.monthlySpendCents} count={kpis.totalImpressions} />
              <CostStat label="per click" spendCents={kpis.monthlySpendCents} count={kpis.profileViews} />
              <CostStat label="per save" spendCents={kpis.monthlySpendCents} count={kpis.saves} />
              <CostStat label="per inquiry" spendCents={kpis.monthlySpendCents} count={kpis.inquiries} />
              <CostStat label="per consultation" spendCents={kpis.monthlySpendCents} count={kpis.consultations} />
            </div>
          </CardContent>
        </Card>
      )}

      <p className="t-helper -mt-3">
        {scope === "all"
          ? "Engagement across every marketplace profile you own. Impressions count every time a profile is shown (with unique parents reached shown beneath); clicks are click-throughs that opened the full profile; saves, inquiries and consultations are deeper engagement. Hot leads and consultations are account-level signals. Switch to \"Sponsored only\" to see your sponsorship ROI (lift, ranking, cost-per-result)."
          : 'All metrics are measured only while you have an active sponsorship. Impressions count every time a sponsored profile is shown (with unique parents reached shown beneath); clicks are click-throughs that opened the full profile; saves, inquiries and consultations are deeper engagement on your sponsored profiles. Hot leads are an account-level signal during the sponsored period. Lift compares your sponsored donor/surrogate profiles against your own non-sponsored ones.'}
      </p>

      {/* Encouraging empty state: active sponsorship but no engagement yet. */}
      {a && kpis?.windowStart && (kpis?.totalImpressions ?? 0) === 0 && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 flex items-start gap-3" data-testid="empty-state">
          <Sparkles className="w-5 h-5 text-accent shrink-0 mt-0.5" />
          <div className="text-sm">
            <span className="font-heading text-foreground">Your sponsorship is live - data is on its way.</span>
            <p className="text-muted-foreground mt-0.5">Impressions, saves and inquiries accrue as parents browse the marketplace. Sponsored profiles usually see their first impressions within 24-48 hours, and your numbers fill in here automatically.</p>
          </div>
        </div>
      )}

      {/* Trend + funnel */}
      {a && (a.timeSeries?.length > 0 || (kpis?.totalImpressions ?? 0) > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Impressions over time</CardTitle></CardHeader>
            <CardContent className="h-56">
              {a.timeSeries?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={a.timeSeries} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => String(d).slice(5)} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="impressions" stroke="hsl(var(--accent))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <EmptyHint text="No impressions yet in the current period." />}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Engagement funnel</CardTitle></CardHeader>
            <CardContent className="space-y-3 pt-2">
              {(a.funnel || []).map((f: any, i: number) => {
                const top = a.funnel[0]?.value || 0;
                // Centered, value-proportional bar: honest width (no triangle
                // distortion) but the centering gives a descending-funnel taper.
                const widthPct = Math.max(2, Math.round((f.value / (top || 1)) * 100));
                // Step-over-step conversion: this stage vs the one directly above.
                const prev = i > 0 ? a.funnel[i - 1] : null;
                const stepRate = prev && prev.value > 0 ? (f.value / prev.value) * 100 : null;
                const stepLabel = stepRate == null ? null : stepRate > 0 && stepRate < 1 ? stepRate.toFixed(1) : Math.round(stepRate).toString();
                // One brand color per stage (brand palette only, no hardcoded hues).
                const palette = ["hsl(var(--primary))", "hsl(var(--accent))", "hsl(var(--brand-success))", "hsl(var(--brand-warning))"];
                const color = palette[i % palette.length];
                return (
                  <div key={f.stage} className="flex items-center gap-3 text-xs">
                    <div className="w-56 shrink-0 whitespace-nowrap">
                      <span className="text-foreground">{f.stage}</span>
                      {stepLabel != null && prev && <span className="text-muted-foreground"> · {stepLabel}% of {String(prev.stage).toLowerCase()}</span>}
                    </div>
                    <div className="flex-1 flex justify-center min-w-0">
                      <div className="h-2.5 rounded-full" style={{ width: `${widthPct}%`, background: color }} />
                    </div>
                    <span className="w-8 shrink-0 text-right font-ui text-foreground">{f.value}</span>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Per-profile breakdown: filter by type, sort, top-performer highlight */}
      {a?.perProfile?.length > 0 && <PerformanceSection perProfile={a.perProfile} />}
      </>)}

      {/* GoStork admins charge / comp per plan (a different surface). The
          provider launcher lives at the top of the page. Management surfaces are
          hidden in the performance (all-profiles) view, which is analytics-only. */}
      {isAdmin && !isPerformance && (
        <PlansSection
          plans={plansQ.data || []}
          isAdmin={isAdmin}
          providerId={providerId}
          base={base}
          onChanged={refetchAll}
        />
      )}

      {/* Your sponsorships - current + history in one table with an Actions column */}
      {!isPerformance && (
        <SponsorshipsTable
          sponsorships={listQ.data || []}
          loading={listQ.isLoading}
          isAdmin={isAdmin}
          providerId={providerId}
          base={base}
          onChanged={refetchAll}
        />
      )}
    </div>
  );
}

function KpiCard({ icon, label, value, hint, delta }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; delta?: { pct: number | null } | null }) {
  const pct = delta?.pct;
  return (
    <Card>
      <CardContent className="p-3">
        <div className="t-helper flex items-center gap-1.5 mb-1">{icon}<span>{label}</span></div>
        <div className="flex items-baseline gap-1.5">
          <div className="text-2xl font-heading text-foreground">{value}</div>
          {pct != null && (
            <span className={`text-xs font-ui ${pct > 0 ? "text-[hsl(var(--brand-success))]" : pct < 0 ? "text-destructive" : "text-muted-foreground"}`}>
              {pct > 0 ? "▲" : pct < 0 ? "▼" : ""}{Math.abs(pct)}%
            </span>
          )}
        </div>
        {hint && <div className="t-helper">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/** Cost efficiency stat: spend / count, or a dash when there's no result yet. */
function CostStat({ label, spendCents, count }: { label: string; spendCents: number; count: number }) {
  return (
    <div className="text-sm">
      <span className="font-heading text-foreground">{count > 0 ? formatMoneyCents(Math.round(spendCents / count)) : "-"}</span>
      <span className="text-muted-foreground ml-1">{label}</span>
    </div>
  );
}

// Per-profile performance: type filter, sortable columns, top-performer highlight,
// and an impressions-by-type breakdown bar.
function PerformanceSection({ perProfile }: { perProfile: any[] }) {
  type PerfKey = "name" | "type" | "impressions" | "views" | "saves" | "saveRate" | "inquiries" | "trend";
  const [sortKey, setSortKey] = useState<PerfKey>("impressions");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  // Every column sorts by the value its own cell prints: save rate by the
  // ratio, not the raw saves, and Trend by the net movement the sparkline
  // draws (last point minus first) so "who is climbing" is one click.
  const perfValue = (p: any, key: PerfKey): string | number => {
    switch (key) {
      case "name": return (p.name || "").toLowerCase();
      case "type": return p.type || "";
      case "saveRate": return p.impressions ? (p.saves ?? 0) / p.impressions : -1;
      case "trend": {
        const series: number[] = p.series || [];
        return series.length > 1 ? series[series.length - 1] - series[0] : 0;
      }
      default: return (p[key] ?? 0) as number;
    }
  };

  // Type filtering is now page-level (perProfile arrives already scoped).
  const types = Array.from(new Set(perProfile.map((p) => p.type)));
  const sorted = [...perProfile].sort((a, b) => {
    const aV = perfValue(a, sortKey);
    const bV = perfValue(b, sortKey);
    const d = typeof aV === "number" && typeof bV === "number"
      ? bV - aV
      : String(bV).localeCompare(String(aV), undefined, { sensitivity: "base" });
    return sortDir === "desc" ? d : -d;
  });
  const topImpr = perProfile.reduce((m, p) => Math.max(m, p.impressions ?? 0), 0);
  const byType = types
    .map((t) => ({ type: t, impressions: perProfile.filter((p) => p.type === t).reduce((n, p) => n + (p.impressions ?? 0), 0) }))
    .sort((a, b) => b.impressions - a.impressions);
  const maxTypeImpr = byType.reduce((m, t) => Math.max(m, t.impressions), 1);

  const toggleSort = (k: PerfKey) => {
    if (sortKey === k) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setSortDir("desc"); }
  };
  const SortHead = ({ k, children, align = "right" }: { k: PerfKey; children: React.ReactNode; align?: "left" | "right" }) => (
    <TableHead className={`${align === "right" ? "text-right" : ""} cursor-pointer select-none`} onClick={() => toggleSort(k)} data-testid={`sort-${k}`}>
      <span className={`inline-flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>{children}{sortKey === k && (sortDir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />)}</span>
    </TableHead>
  );

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3 flex-wrap space-y-0">
        <CardTitle className="text-sm font-ui">Sponsored profile performance</CardTitle>
        <Button size="sm" variant="outline" onClick={() => downloadCsv(sorted, "sponsored-profile-performance.csv")} data-testid="export-csv">
          <Download className="w-3.5 h-3.5 mr-1.5" /> Export CSV
        </Button>
      </CardHeader>
      <CardContent>
        {byType.length > 1 && (
          <div className="mb-4 space-y-1.5">
            <div className="t-helper">Impressions by type</div>
            {byType.map((t) => (
              <div key={t.type} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 truncate">{t.type}</span>
                <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.round((t.impressions / maxTypeImpr) * 100))}%` }} /></div>
                <span className="w-8 text-right font-ui">{t.impressions}</span>
              </div>
            ))}
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead k="name" align="left">Profile</SortHead>
              <SortHead k="type" align="left">Type</SortHead>
              <SortHead k="impressions">Impressions</SortHead>
              <SortHead k="views">Clicks</SortHead>
              <SortHead k="saves">Saves</SortHead>
              <SortHead k="saveRate">Save rate</SortHead>
              <SortHead k="inquiries">Inquiries</SortHead>
              <SortHead k="trend">Trend</SortHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.slice(0, 50).map((p) => {
              const isTop = topImpr > 0 && (p.impressions ?? 0) === topImpr;
              return (
                <TableRow key={p.id} data-testid={`perprofile-${p.id}`} className={isTop ? "bg-accent/5" : ""}>
                  <TableCell>
                    <div className="flex items-center gap-2.5 min-w-0">
                      {p.photoUrl ? (
                        <img src={getPhotoSrc(p.photoUrl) ?? undefined} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 bg-secondary" loading="lazy" />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center shrink-0"><User className="w-4 h-4 text-muted-foreground" /></div>
                      )}
                      <span className="font-medium truncate">{p.name}</span>
                      {isTop && <Badge className="bg-accent/15 text-accent text-[10px] shrink-0">Top</Badge>}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{p.type}</Badge></TableCell>
                  <TableCell className="text-right">{p.impressions}</TableCell>
                  <TableCell className="text-right">{p.views ?? 0}</TableCell>
                  <TableCell className="text-right">{p.saves}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{p.impressions ? `${Math.round((p.saves / p.impressions) * 100)}%` : "-"}</TableCell>
                  <TableCell className="text-right">{p.inquiries ?? 0}</TableCell>
                  <TableCell className="text-right"><div className="flex justify-end"><Sparkline data={p.series} /></div></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <p className="t-helper mt-3">
          Hot leads aren't shown per profile - a hot lead is an account-level signal (a high-intent parent for your whole account, not tied to one profile). See the Hot leads KPI above.
        </p>
      </CardContent>
    </Card>
  );
}

/** "donor / surrogate" - only the entity types that actually have ranking data. */
function rankingNouns(types?: string[]): string {
  const map: Record<string, string> = { EGG_DONOR: "donor", SURROGATE: "surrogate", SPERM_DONOR: "sperm donor", DOCTOR: "doctor" };
  const nouns = (types || []).map((t) => map[t]).filter(Boolean);
  return nouns.length ? nouns.join(" / ") : "sponsored";
}

/** Tiny inline impressions sparkline (no chart lib) for a per-profile row. */
function Sparkline({ data }: { data?: number[] }) {
  if (!data || data.length < 2 || data.every((v) => v === 0)) return <span className="t-helper">-</span>;
  const w = 64, h = 18, max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden>
      <polyline points={pts} fill="none" stroke="hsl(var(--accent))" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Client-side CSV download of the (filtered + sorted) per-profile rows. */
function downloadCsv(rows: any[], filename: string) {
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Profile", "Type", "Impressions", "Clicks", "Saves", "Save rate", "Inquiries"].join(",")];
  for (const r of rows) {
    const rate = r.impressions ? `${Math.round((r.saves / r.impressions) * 100)}%` : "-";
    lines.push([r.name, r.type, r.impressions ?? 0, r.views ?? 0, r.saves ?? 0, rate, r.inquiries ?? 0].map(esc).join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function EmptyHint({ text }: { text: string }) {
  return <div className="t-helper h-full flex items-center justify-center">{text}</div>;
}

/** apiRequest throws errors like `400: {"message":"..."}`; surface just the message. */
function cleanError(e: any, fallback: string): string {
  const raw = e?.message || "";
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { const j = JSON.parse(m[0]); if (j?.message) return String(j.message); } catch { /* ignore */ }
  }
  return raw.replace(/^\d{3}:\s*/, "") || fallback;
}

// ─── Plans + checkout ────────────────────────────────────────────────────────

function PlansSection({ plans, isAdmin, providerId, base, onChanged }: {
  plans: any[]; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void;
}) {
  const [billingMode, setBillingMode] = useState<BillingMode>("AUTO_RENEW");
  const [checkout, setCheckout] = useState<{ plan: any; clientSecret: string; sponsorshipId: string } | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Saved card (Option B): if present, purchases auto-charge it with no re-entry.
  const pmUrl = isAdmin ? `${base}/payment-method?providerId=${providerId}` : `/api/sponsorship/payment-method`;
  const savedCardQ = useQuery<{ brand: string | null; last4: string | null } | null>({
    queryKey: [pmUrl],
    queryFn: async () => (await apiRequest("GET", pmUrl)).json(),
    enabled: !isAdmin || !!providerId,
    retry: false,
  });
  const savedCard = savedCardQ.data;

  const startCharge = async (plan: any) => {
    setError(null); setNotice(null); setBusyPlan(plan.id);
    try {
      if (isAdmin) {
        // Admin can't enter the provider's card - this sends them a payment
        // request to complete from their own dashboard.
        await apiRequest("POST", `${base}`, { providerId, planId: plan.id, billingMode, mode: "CHARGE" });
        setNotice("Payment request sent. The provider will complete payment from their Sponsorship page, then it activates.");
        onChanged();
        return;
      }
      const res = await apiRequest("POST", `${base}/checkout`, { planId: plan.id, billingMode });
      const data = await res.json();
      if (data.clientSecret) {
        setCheckout({ plan, clientSecret: data.clientSecret, sponsorshipId: data.sponsorshipId });
      } else {
        if (data.activated && data.savedCard?.last4) setNotice(`Charged your saved card ••••${data.savedCard.last4}. Sponsorship is now active.`);
        onChanged();
      }
    } catch (e: any) {
      setError(cleanError(e, "Could not start checkout"));
    } finally { setBusyPlan(null); }
  };

  const grantComp = async (planId: string, months: number) => {
    setError(null); setNotice(null); setBusyPlan(planId);
    try {
      await apiRequest("POST", `${base}`, { providerId, planId, mode: "COMP", months });
      setNotice(`Complimentary sponsorship granted free for ${months} month${months > 1 ? "s" : ""}.`);
      onChanged();
    } catch (e: any) {
      setError(cleanError(e, "Could not grant complimentary sponsorship"));
    } finally { setBusyPlan(null); }
  };

  // Whole-profile plans applicable to THIS provider's service types. A provider
  // that is both an IVF clinic and a surrogacy agency gets both; one that is
  // neither (egg-donor agency, sperm bank) gets none.
  const wpUrl = isAdmin ? `${base}/whole-profile-plans?providerId=${providerId}` : `/api/sponsorship/whole-profile-plans`;
  const wholeProfilePlansQ = useQuery<any[]>({
    queryKey: [wpUrl],
    queryFn: async () => (await apiRequest("GET", wpUrl)).json(),
    enabled: !isAdmin || !!providerId,
    retry: false,
  });
  const applicableWholeKeys = new Set((wholeProfilePlansQ.data || []).map((p: any) => p.tierKey));

  // The slot-fillable entity types this provider actually offers (donors,
  // surrogates, sperm donors, doctors) - drives the dynamic section label.
  const stUrl = isAdmin ? `${base}/slot-entity-types?providerId=${providerId}` : `/api/sponsorship/slot-entity-types`;
  const slotTypesQ = useQuery<{ type: string; label: string }[]>({
    queryKey: [stUrl],
    queryFn: async () => (await apiRequest("GET", stUrl)).json(),
    enabled: !isAdmin || !!providerId,
    retry: false,
  });
  const applicableSlotTypes = (slotTypesQ.data || []).map((t) => t.type);
  const hasClinic = applicableWholeKeys.has("whole_profile_ivf");
  const hasAgency = applicableWholeKeys.has("whole_profile_surrogacy");
  const wholeLabel = `Whole-profile boost (your ${[hasClinic && "clinic", hasAgency && "agency"].filter(Boolean).join(" / ") || "profile"})`;

  // Slot bundles are typed - show one group per sub-profile type the provider
  // offers, each with that type's tiers (egg/sperm donors are large, surrogates
  // and doctors small).
  const allBundles = plans.filter((p) => p.productType === "SLOT_BUNDLE");
  const bundleGroups = applicableSlotTypes
    .map((type) => ({
      type,
      label: SLOT_TYPE_HEADERS[type] || "Slots",
      tiers: allBundles.filter((p) => p.slotEntityType === type).sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .filter((g) => g.tiers.length > 0);
  const wholeProfiles = plans.filter((p) => p.productType === "WHOLE_PROFILE" && applicableWholeKeys.has(p.tierKey));

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Start a sponsorship</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {/* Billing mode toggle */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Billing:</span>
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            {(["AUTO_RENEW", "ONE_TIME"] as BillingMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setBillingMode(m)}
                className={`px-3 py-1.5 text-sm transition-colors ${billingMode === m ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
                data-testid={`billing-mode-${m}`}
              >
                {m === "AUTO_RENEW" ? "Auto-renew monthly" : "One month"}
              </button>
            ))}
          </div>
        </div>

        {savedCard?.last4 && (
          <div className="t-helper flex items-center gap-2">
            <CreditCard className="w-4 h-4" />
            <span>Paying with your saved card {savedCard.brand ? `${savedCard.brand} ` : ""}••••{savedCard.last4} - no need to re-enter it.</span>
          </div>
        )}
        {notice && <div className="text-sm rounded-lg px-3 py-2" style={{ background: "hsl(var(--brand-success) / 0.1)", color: "hsl(var(--brand-success))" }}>{notice}</div>}
        {error && <div className="text-sm rounded-lg px-3 py-2" style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}>{error}</div>}

        {bundleGroups.map((g) => (
          <div key={g.type}>
            <p className="text-base font-semibold text-foreground mb-2">{g.label}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {g.tiers.map((p) => (
                <PlanCard key={p.id} plan={p} busy={busyPlan === p.id} isAdmin={isAdmin}
                  onCharge={() => startCharge(p)} onComp={(months) => grantComp(p.id, months)} />
              ))}
            </div>
          </div>
        ))}

        {wholeProfiles.length > 0 && (
          <div>
            <p className="text-base font-semibold text-foreground mb-2">{wholeLabel}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {wholeProfiles.map((p) => (
                <PlanCard key={p.id} plan={p} busy={busyPlan === p.id} isAdmin={isAdmin}
                  onCharge={() => startCharge(p)} onComp={(months) => grantComp(p.id, months)} />
              ))}
            </div>
          </div>
        )}

      </CardContent>
      {checkout && (
        <SponsorshipCheckoutOverlay
          plan={checkout.plan}
          clientSecret={checkout.clientSecret}
          sponsorshipId={checkout.sponsorshipId}
          onClose={() => { setCheckout(null); onChanged(); setTimeout(() => savedCardQ.refetch(), 2500); }}
        />
      )}
    </Card>
  );
}

function PlanCard({ plan, busy, isAdmin, onCharge, onComp }: { plan: any; busy: boolean; isAdmin: boolean; onCharge: () => void; onComp: (months: number) => void }) {
  const [comping, setComping] = useState(false);
  const [months, setMonths] = useState(1);
  return (
    <div className="rounded-xl border border-border p-4 flex flex-col gap-2 bg-card" data-testid={`plan-${plan.tierKey}`}>
      <div className="flex items-baseline justify-between">
        <span className="font-heading text-foreground">{plan.displayName}</span>
        <span className="font-ui text-foreground">{formatMoneyCents(plan.priceCents, plan.currency)}<span className="t-helper">/mo</span></span>
      </div>
      <p className="t-helper">
        {plan.productType === "SLOT_BUNDLE" ? `Up to ${plan.slotCount} sponsored profiles` : "Boosts your top-level profile"}
      </p>
      <div className="flex gap-2 mt-auto pt-1">
        <Button size="sm" onClick={onCharge} disabled={busy} data-testid={`button-sponsor-${plan.tierKey}`}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CreditCard className="w-3.5 h-3.5 mr-1" /> {isAdmin ? "Charge" : "Sponsor"}</>}
        </Button>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => setComping((v) => !v)} disabled={busy} data-testid={`button-comp-${plan.tierKey}`}>
            <Gift className="w-3.5 h-3.5 mr-1" /> Complimentary
          </Button>
        )}
      </div>
      {isAdmin && comping && (
        <div className="mt-2 pt-2 border-t border-border flex items-center gap-2 flex-wrap">
          <span className="t-helper">Free for</span>
          <select value={months} onChange={(e) => setMonths(parseInt(e.target.value, 10))} className="h-8 rounded-md border border-input bg-background px-2 text-sm" data-testid={`comp-months-${plan.tierKey}`}>
            {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m} month{m > 1 ? "s" : ""}</option>)}
          </select>
          <Button size="sm" onClick={() => { onComp(months); setComping(false); }} disabled={busy} data-testid={`comp-grant-${plan.tierKey}`}>Grant free</Button>
          <Button size="sm" variant="ghost" onClick={() => setComping(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

// ─── Your sponsorships (current + history in one table) ──────────────────────

function SponsorshipsTable({ sponsorships, loading, isAdmin, providerId, base, onChanged }: {
  sponsorships: any[]; loading: boolean; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void;
}) {
  // Header sort on top of the server's newest-first order; Period sorts by when
  // the term started, which is what the date range in the cell leads with.
  // Declared above the loading/empty returns - a hook after an early return
  // changes the hook count between renders.
  const { sortConfig, handleSort, sortData } = useTableSort();
  // Show current/actionable sponsorships plus any that were ever activated (real
  // subscriptions). Hide discarded pendings that never activated, so the table
  // stays clean. Server already orders newest-first.
  const rows = sponsorships.filter((s) =>
    ["ACTIVE", "PENDING_PAYMENT", "PAST_DUE"].includes(s.status) || !!s.currentPeriodStart);

  const sortedRows = sortData(rows, (s: any, key) => {
    switch (key) {
      case "plan": return (s.plan?.displayName || "").toLowerCase();
      case "status": return s.status || "";
      case "billing": return s.billingMode === "AUTO_RENEW" ? "Auto-renew" : "One month";
      case "amount": return s.isComped ? 0 : (s.priceCentsSnapshot ?? s.priceCents ?? null);
      case "period": return s.currentPeriodStart ? new Date(s.currentPeriodStart).getTime() : null;
      default: return null;
    }
  });

  if (loading) return <div className="t-helper flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>;
  if (!rows.length) return null;

  return (
    // Flush table inside the card, heading above it - the Team table's
    // shape, so every settings table reads identically.
    <section className="space-y-3">
      <h3 className="font-semibold">Your Sponsorships</h3>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Plan" sortKey="plan" currentSort={sortConfig} onSort={handleSort} />
                <SortableTableHead label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} />
                <SortableTableHead label="Billing" sortKey="billing" currentSort={sortConfig} onSort={handleSort} />
                <SortableTableHead label="Amount" sortKey="amount" currentSort={sortConfig} onSort={handleSort} align="right" />
                <SortableTableHead label="Period" sortKey="period" currentSort={sortConfig} onSort={handleSort} />
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.map((s) => (
                <SponsorshipTableRow key={s.id} s={s} isAdmin={isAdmin} providerId={providerId} base={base} onChanged={onChanged} />
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </section>
  );
}

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))]",
  PENDING_PAYMENT: "bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]",
  PAST_DUE: "bg-destructive/15 text-destructive",
  EXPIRED: "bg-muted text-muted-foreground",
  CANCELED: "bg-muted text-muted-foreground",
};

const TAB_BY_TYPE: Record<string, string> = { EGG_DONOR: "egg-donors", SURROGATE: "surrogates", SPERM_DONOR: "sperm-donors", DOCTOR: "doctors" };

function SponsorshipTableRow({ s, isAdmin, providerId, base, onChanged }: { s: any; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  // Providers pick donors/surrogates/sperm donors/doctors in their full profile
  // tab (big cards, filters, search). The admin view keeps the inline picker.
  const profileTab = TAB_BY_TYPE[s.plan?.slotEntityType as string];
  const useTabPicker = !isAdmin && profileTab;
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState<string | null>(null);
  const isBundle = s.productType === "SLOT_BUNDLE";
  const isPending = s.status === "PENDING_PAYMENT";
  const isActive = s.status === "ACTIVE";
  const isAutoRenew = s.billingMode === "AUTO_RENEW";

  const cancel = async () => {
    setBusy(true);
    try {
      const body = isAdmin ? { providerId, immediate: false } : { immediate: false };
      await apiRequest("POST", `${base}/${s.id}/cancel`, body);
      onChanged();
    } finally { setBusy(false); }
  };

  // Provider-only: complete payment on a pending (e.g. admin-requested) sponsorship.
  const completePayment = async () => {
    setBusy(true);
    try {
      const { clientSecret } = await (await apiRequest("POST", `/api/sponsorship/${s.id}/pay`)).json();
      if (clientSecret) setPayment(clientSecret);
    } finally { setBusy(false); }
  };

  // Discard an unpaid pending sponsorship so the provider can start a fresh one.
  const discard = async () => {
    setBusy(true);
    try {
      const body = isAdmin ? { providerId, immediate: true } : { immediate: true };
      await apiRequest("POST", `${base}/${s.id}/cancel`, body);
      onChanged();
    } finally { setBusy(false); }
  };

  const fmtDate = (d: any) => (d ? new Date(d).toLocaleDateString() : null);
  const period = [fmtDate(s.currentPeriodStart), fmtDate(s.currentPeriodEnd)].filter(Boolean).join(" - ");

  // Actions available on this row (empty for terminal rows -> render a dash).
  const actions = (
    <>
      {isPending && !isAdmin && !payment && (
        <Button size="sm" onClick={completePayment} disabled={busy} data-testid={`button-complete-payment-${s.id}`}>
          <CreditCard className="w-3.5 h-3.5 mr-1" /> Complete payment
        </Button>
      )}
      {isPending && (
        <Button size="sm" variant="ghost" onClick={discard} disabled={busy} data-testid={`button-discard-${s.id}`}>Discard</Button>
      )}
      {isBundle && isActive && useTabPicker && (
        <Button size="sm" variant="ghost" onClick={() => navigate(`/account/${profileTab}?sponsor=${s.id}`)} data-testid={`button-add-profiles-${s.id}`}>
          {(s.slotsUsed ?? 0) >= (s.slotsTotal ?? 0) ? "Manage profiles" : "Add profiles"} <ChevronDown className="w-4 h-4 ml-1 -rotate-90" />
        </Button>
      )}
      {isBundle && isActive && !useTabPicker && (
        <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} data-testid={`button-manage-slots-${s.id}`}>
          Manage slots {expanded ? <ChevronUp className="w-4 h-4 ml-1" /> : <ChevronDown className="w-4 h-4 ml-1" />}
        </Button>
      )}
      {/* Only an auto-renewing, still-active sponsorship has a renewal to cancel. */}
      {isActive && isAutoRenew && !s.canceledAt && (
        <Button size="sm" variant="outline" onClick={cancel} disabled={busy} data-testid={`button-cancel-renew-${s.id}`}>Cancel auto-renew</Button>
      )}
    </>
  );
  const hasActions =
    (isPending) || (isBundle && isActive) || (isActive && isAutoRenew && !s.canceledAt);

  return (
    <>
      <TableRow data-testid={`sponsorship-${s.id}`}>
        <TableCell>
          <div className="font-medium text-foreground">{s.plan?.displayName}</div>
          <div className="flex items-center gap-2 mt-0.5">
            {s.isComped && <Badge variant="secondary" className="text-[11px]"><Gift className="w-3 h-3 mr-1" />Complimentary</Badge>}
            {isBundle && <span className="t-helper">{s.slotsUsed}/{s.slotsTotal} slots</span>}
          </div>
        </TableCell>
        <TableCell><Badge className={STATUS_STYLES[s.status] || ""}>{String(s.status).replace("_", " ")}</Badge></TableCell>
        <TableCell className="text-xs">
          {isAutoRenew ? "Auto-renew" : "One month"}
          {isAutoRenew && s.canceledAt && <div className="t-helper">(auto-renew off)</div>}
        </TableCell>
        <TableCell className="text-right">{s.isComped ? "Free" : formatMoneyCents(s.priceCentsSnapshot ?? s.priceCents)}</TableCell>
        <TableCell className="t-helper">{period || "-"}</TableCell>
        <TableCell className="text-right">
          {hasActions ? <div className="flex gap-2 justify-end flex-wrap">{actions}</div> : <span className="t-helper">-</span>}
        </TableCell>
      </TableRow>
      {payment && (
        <SponsorshipCheckoutOverlay plan={s.plan} clientSecret={payment} sponsorshipId={s.id} onClose={() => { setPayment(null); onChanged(); }} />
      )}
      {expanded && isBundle && (
        <TableRow>
          <TableCell colSpan={6} className="bg-secondary/20">
            <SlotManager s={s} isAdmin={isAdmin} providerId={providerId} base={base} onChanged={onChanged} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function SlotManager({ s, isAdmin, providerId, base, onChanged }: { s: any; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void }) {
  // A typed bundle has a single sub-profile type - fill it from that type only.
  const bundleType: EntityType = (s.plan?.slotEntityType as EntityType) || "EGG_DONOR";
  const eligibleUrl = isAdmin
    ? `${base}/eligible-entities?providerId=${providerId}&type=${bundleType}`
    : `/api/sponsorship/eligible-entities?type=${bundleType}`;
  const eligibleQ = useQuery<any[]>({
    queryKey: [eligibleUrl],
    queryFn: async () => (await apiRequest("GET", eligibleUrl)).json(),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const filledIds = new Set((s.items || []).map((it: any) => it.entityId));
  const slotsFull = (s.items?.length || 0) >= s.slotCountSnapshot;
  const nameById = new Map<string, string>(((eligibleQ.data as any[]) || []).map((e: any) => [e.id, e.displayName]));

  const addItem = async (entityId: string) => {
    setBusyId(entityId);
    try {
      const body = isAdmin ? { providerId, entityType: bundleType, entityId } : { entityType: bundleType, entityId };
      await apiRequest("POST", `${base}/${s.id}/items`, body);
      onChanged();
    } finally { setBusyId(null); }
  };
  const removeItem = async (item: any) => {
    setBusyId(item.id);
    try {
      const url = isAdmin ? `${base}/${s.id}/items/${item.id}?providerId=${providerId}` : `/api/sponsorship/${s.id}/items/${item.id}`;
      await apiRequest("DELETE", url);
      onChanged();
    } finally { setBusyId(null); }
  };

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-3">
      {/* Filled slots */}
      {s.items?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {s.items.map((it: any) => (
            <Badge key={it.id} variant="secondary" className="gap-1 pr-1">
              {nameById.get(it.entityId) || it.entityType.replace("_", " ").toLowerCase()}
              <button onClick={() => removeItem(it)} disabled={busyId === it.id} className="ml-1 hover:text-destructive" data-testid={`remove-item-${it.id}`}>
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {slotsFull && <p className="text-xs text-[hsl(var(--brand-warning))]">All slots filled. Remove one to add another.</p>}
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
        {eligibleQ.isLoading && <div className="t-helper p-3"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading...</div>}
        {eligibleQ.data?.length === 0 && <div className="t-helper p-3">No profiles of this type.</div>}
        {(eligibleQ.data || []).map((e: any) => {
          const filled = filledIds.has(e.id);
          return (
            <div key={e.id} className="flex items-center justify-between gap-2 px-3 py-2" data-testid={`eligible-${e.id}`}>
              <div className="flex items-center gap-2 min-w-0">
                {e.photoUrl ? (
                  <img src={getPhotoSrc(e.photoUrl ?? undefined) ?? undefined} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 bg-secondary" loading="lazy" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center shrink-0"><User className="w-4 h-4 text-muted-foreground" /></div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                    {e.displayName}{e.sponsored && <Sparkles className="w-3 h-3 text-accent shrink-0" />}
                  </div>
                  {e.subtitle && <div className="t-helper truncate">{e.subtitle}</div>}
                </div>
              </div>
              {filled ? (
                <Badge variant="secondary" className="text-xs shrink-0">In this bundle</Badge>
              ) : (
                <Button size="sm" variant="ghost" className="shrink-0" disabled={busyId === e.id || slotsFull} onClick={() => addItem(e.id)} data-testid={`add-eligible-${e.id}`}>
                  {busyId === e.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

