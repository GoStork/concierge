import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Loader2, Users, Route, CheckCircle2, PauseCircle, TrendingUp, Calendar, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";

/**
 * Phase 7C: the journey funnel dashboard - shared by the GoStork admin
 * analytics page (aggregate + per-provider filter + comparison table) and
 * the provider's Performance page (force-scoped server-side to their org).
 * Data comes fully aggregated from /api/journey/funnel (journey-funnel.ts).
 * Filters mirror the Parents page idiom: From/To calendar chips + selects.
 */

interface FunnelStage {
  id: string;
  label: string;
  count: number;
  conversionFromPrev: number | null;
  medianDaysFromPrev: number | null;
}

interface DetailRow {
  parentUserId: string | null;
  parentName: string;
  providerName: string | null;
  at: string;
  reason?: string;
}

const TYPE_OPTIONS: Record<string, string> = {
  surrogacy: "Surrogacy",
  egg_donation: "Egg Donation",
  ivf: "IVF",
  bank: "Egg Donation",
  legal: "Legal",
};

interface FunnelData {
  availableTypes?: string[];
  kpis: {
    registeredAccounts: number;
    accountsWithJourney: number;
    journeysInFlight: number;
    handedOffTotal: number;
    handedOff30d: number;
    dormant: number;
    overallConversionPct: number | null;
  };
  funnels: { journeyType: string; typeLabel: string; journeys: number; stages: FunnelStage[] }[];
  leaks: {
    consultationsScheduled: number;
    noShowParent: number;
    noShowProvider: number;
    canceledNotRebooked: number;
    churnReasons: Record<string, number>;
    details?: { noShows: DetailRow[]; notRebooked: DetailRow[]; churned: DetailRow[] };
  };
  winback: {
    sent: number;
    responses: Record<string, number>;
    reengaged: number;
    recoveryPct: number | null;
    details?: { awaitingReply: DetailRow[] };
  };
  providers: any[];
}

const CHURN_LABELS: Record<string, string> = {
  found_elsewhere: "Found a match elsewhere",
  costs: "Costs",
  timing: "Not the right timing",
  exploring: "Just exploring",
  unknown: "Not specified",
};
const RESPONSE_LABELS: Record<string, string> = {
  reschedule: "Rescheduled",
  later: "Asked for more time",
  not_interested: "Not interested",
  other: "Other",
};

function fmtShort(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toDateParam(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function KpiTile({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-[var(--radius)] border bg-secondary/40 p-3 flex items-start gap-2.5 min-w-0">
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="t-micro-label whitespace-nowrap truncate" title={label}>{label}</p>
        <p className="text-xl font-heading leading-6">{value}</p>
        {sub && <p className="t-helper truncate" title={sub}>{sub}</p>}
      </div>
    </div>
  );
}

/** Collapsible "who is behind this number" list - each row links to the parent. */
function DetailList({ title, rows, emptyText }: { title: string; rows: DetailRow[]; emptyText: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-semibold font-ui text-foreground hover:text-primary"
        onClick={() => setOpen((v) => !v)}
        data-testid={`detail-toggle-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
      >
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {title} {rows.length > 0 ? `(${rows.length})` : ""}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {rows.length === 0 && <p className="t-helper">{emptyText}</p>}
          {rows.map((r, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate">
                {r.parentUserId ? (
                  <Link to={`/parents/${r.parentUserId}`} className="text-primary hover:underline font-medium">{r.parentName}</Link>
                ) : (
                  <span className="font-medium">{r.parentName}</span>
                )}
                {r.providerName && <span className="text-muted-foreground"> · {r.providerName}</span>}
                {r.reason && <span className="text-muted-foreground"> · {CHURN_LABELS[r.reason] || r.reason}</span>}
              </span>
              <span className="text-muted-foreground shrink-0">{fmtShort(r.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FunnelBars({ funnel }: { funnel: FunnelData["funnels"][number] }) {
  const max = Math.max(1, ...funnel.stages.map((s) => s.count));
  return (
    <div data-testid={`funnel-${funnel.journeyType}`}>
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-accent/15 text-[hsl(var(--accent))] text-[10px] font-semibold uppercase tracking-wide">
          {funnel.typeLabel}
        </span>
        <span className="t-helper">{funnel.journeys} journey{funnel.journeys !== 1 ? "s" : ""}</span>
      </div>
      <div className="space-y-1.5">
        {funnel.stages.map((st) => (
          <div key={st.id} className="grid items-center gap-2" style={{ gridTemplateColumns: "170px 1fr 120px" }}>
            <p className="text-xs font-ui text-foreground truncate">{st.label}</p>
            <div className="h-5 rounded-full bg-secondary/60 overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/80 flex items-center justify-end pr-2"
                style={{ width: `${Math.max(st.count > 0 ? 8 : 0, (st.count / max) * 100)}%` }}
              >
                {st.count > 0 && <span className="text-[10px] font-semibold text-primary-foreground">{st.count}</span>}
              </div>
            </div>
            <p className="t-helper whitespace-nowrap">
              {st.conversionFromPrev !== null ? `${st.conversionFromPrev}%` : ""}
              {st.medianDaysFromPrev !== null ? ` · ~${Math.round(st.medianDaysFromPrev)}d` : ""}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DateChip({ value, placeholder, onChange, testId }: { value: string; placeholder: string; onChange: (v: string) => void; testId: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={value ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid={testId}>
          <Calendar className="w-3 h-3" />
          {value || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <CalendarPicker
          mode="single"
          selected={value ? new Date(`${value}T00:00:00`) : undefined}
          onSelect={(d) => onChange(d ? toDateParam(d) : "")}
        />
        {value && (
          <div className="border-t px-3 py-2">
            <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => onChange("")}>
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function JourneyFunnelDashboard({ scope }: { scope: "admin" | "provider" }) {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [journeyType, setJourneyType] = useState<string>("");
  const [providerId, setProviderId] = useState<string>("");

  const params = new URLSearchParams();
  if (fromDate) params.set("from", new Date(`${fromDate}T00:00:00`).toISOString());
  if (toDate) params.set("to", new Date(`${toDate}T23:59:59`).toISOString());
  if (journeyType) params.set("journeyType", journeyType);
  if (scope === "admin" && providerId) params.set("providerId", providerId);

  const funnelQuery = useQuery({
    queryKey: ["journey-funnel", scope, fromDate, toDate, journeyType, providerId],
    queryFn: async () => {
      const res = await fetch(`/api/journey/funnel?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load funnel");
      return res.json() as Promise<FunnelData>;
    },
    staleTime: 60_000,
  });
  // Unfiltered fetch feeds the admin provider dropdown (server caches it).
  const optionsQuery = useQuery({
    queryKey: ["journey-funnel-options"],
    queryFn: async () => {
      const res = await fetch(`/api/journey/funnel`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load options");
      return res.json() as Promise<FunnelData>;
    },
    enabled: scope === "admin",
    staleTime: 5 * 60_000,
  });

  const data = funnelQuery.data;
  if (funnelQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10" data-testid="funnel-loading">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return <p className="t-helper">Couldn't load analytics.</p>;

  const churnEntries = Object.entries(data.leaks.churnReasons || {});
  const responseEntries = Object.entries(data.winback.responses || {});
  const selectCls = "h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0";

  return (
    <div className="space-y-6" data-testid="journey-funnel-dashboard">
      {/* Filters - same idiom as the Parents page: From/To chips + selects */}
      <div className="flex items-center gap-3 flex-wrap" data-testid="funnel-filter-bar">
        <DateChip value={fromDate} placeholder="From" onChange={setFromDate} testId="funnel-date-from" />
        <DateChip value={toDate} placeholder="To" onChange={setToDate} testId="funnel-date-to" />
        {/* Providers only see journey types their approved services can
            produce (server-derived); admin sees all. Hidden entirely when
            there is just one type - nothing to filter. */}
        {(data.availableTypes?.length ?? 5) > 1 && (
          <select className={selectCls} value={journeyType} onChange={(e) => setJourneyType(e.target.value)} data-testid="funnel-type">
            <option value="">All journey types</option>
            {(data.availableTypes || Object.keys(TYPE_OPTIONS)).map((t) => (
              <option key={t} value={t}>{TYPE_OPTIONS[t] || t}</option>
            ))}
          </select>
        )}
        {scope === "admin" && (
          <select className={selectCls} value={providerId} onChange={(e) => setProviderId(e.target.value)} data-testid="funnel-provider">
            <option value="">All providers</option>
            {(optionsQuery.data?.providers || []).map((p: any) => (
              <option key={p.providerId} value={p.providerId}>{p.providerName}</option>
            ))}
          </select>
        )}
      </div>

      {/* KPIs */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        {scope === "provider" ? (
          <KpiTile icon={<Users className="w-4 h-4" />} label="Engaged parents" value={data.kpis.accountsWithJourney} sub="connected with you" />
        ) : (
          <KpiTile icon={<Users className="w-4 h-4" />} label="Registered" value={data.kpis.registeredAccounts} sub={`${data.kpis.accountsWithJourney} started a journey`} />
        )}
        <KpiTile icon={<Route className="w-4 h-4" />} label="Active journeys" value={Math.max(0, data.kpis.journeysInFlight)} sub="started, not handed off yet" />
        <KpiTile icon={<CheckCircle2 className="w-4 h-4" />} label="Handed off" value={data.kpis.handedOffTotal} sub={`${data.kpis.handedOff30d} in last 30d`} />
        <KpiTile icon={<PauseCircle className="w-4 h-4" />} label="Paused by parent" value={data.kpis.dormant} sub="stepped back after follow-up" />
        <KpiTile icon={<TrendingUp className="w-4 h-4" />} label="Conversion" value={data.kpis.overallConversionPct !== null ? `${data.kpis.overallConversionPct}%` : "-"} sub={scope === "provider" ? "engaged to handed off" : "registered to handed off"} />
      </div>

      {/* Leaks + win-back - right under the headline numbers (user decision):
          this is the actionable part, with the WHO behind every number. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 space-y-3" data-testid="funnel-leaks">
          <h3 className="font-heading text-base">Where journeys leak</h3>
          <div className="grid grid-cols-3 gap-2">
            <KpiTile icon={<Users className="w-4 h-4" />} label="Parent no-shows" value={data.leaks.noShowParent} />
            <KpiTile icon={<Users className="w-4 h-4" />} label="Provider no-shows" value={data.leaks.noShowProvider} />
            <KpiTile icon={<PauseCircle className="w-4 h-4" />} label="Not rebooked" value={data.leaks.canceledNotRebooked} sub="canceled, no new time" />
          </div>
          <div className="space-y-2">
            <DetailList title="Parents who missed calls" rows={data.leaks.details?.noShows || []} emptyText="Nobody has missed a call." />
            <DetailList title="Canceled without rebooking" rows={data.leaks.details?.notRebooked || []} emptyText="Everyone rebooked after canceling." />
            <DetailList title="Paused, and why" rows={data.leaks.details?.churned || []} emptyText="No one has paused their journey." />
          </div>
          {churnEntries.length > 0 && (
            <div>
              <p className="text-xs font-semibold font-ui mb-1.5">Pause reasons</p>
              {churnEntries.map(([reason, n]) => (
                <div key={reason} className="flex items-center justify-between py-0.5">
                  <span className="text-xs font-ui">{CHURN_LABELS[reason] || reason}</span>
                  <span className="text-xs font-semibold">{n}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card className="p-5 space-y-3" data-testid="funnel-winback">
          <h3 className="font-heading text-base">Win-back performance</h3>
          <div className="grid grid-cols-3 gap-2">
            <KpiTile icon={<Route className="w-4 h-4" />} label="Follow-ups" value={data.winback.sent} />
            <KpiTile icon={<CheckCircle2 className="w-4 h-4" />} label="Re-engaged" value={data.winback.reengaged} />
            <KpiTile icon={<TrendingUp className="w-4 h-4" />} label="Recovery" value={data.winback.recoveryPct !== null ? `${data.winback.recoveryPct}%` : "-"} />
          </div>
          <DetailList title="Still waiting for a reply" rows={data.winback.details?.awaitingReply || []} emptyText="Every follow-up got an answer." />
          <div>
            <p className="text-xs font-semibold font-ui mb-1.5">Replies</p>
            {responseEntries.length === 0 && <p className="t-helper">No replies recorded yet.</p>}
            {responseEntries.map(([r, n]) => (
              <div key={r} className="flex items-center justify-between py-0.5">
                <span className="text-xs font-ui">{RESPONSE_LABELS[r] || r}</span>
                <span className="text-xs font-semibold">{n}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Funnels */}
      <Card className="p-5 space-y-6">
        <h3 className="font-heading text-base">Journey funnel{data.funnels.length !== 1 ? "s" : ""}</h3>
        {data.funnels.length === 0 && <p className="t-helper">No journeys in this cohort yet.</p>}
        {data.funnels.map((f) => <FunnelBars key={f.journeyType} funnel={f} />)}
        <p className="t-helper">Per stage: count · conversion from previous stage · median days from previous stage.</p>
      </Card>

      {/* Provider comparison (admin only) */}
      {scope === "admin" && (
        <Card className="p-5" data-testid="funnel-providers">
          <h3 className="font-heading text-base mb-3">Providers</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-ui">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Provider</th>
                  <th className="py-1.5 pr-3 font-medium">Journeys</th>
                  <th className="py-1.5 pr-3 font-medium">Consults</th>
                  <th className="py-1.5 pr-3 font-medium">Completed</th>
                  <th className="py-1.5 pr-3 font-medium">No-shows (P/Pr)</th>
                  <th className="py-1.5 pr-3 font-medium">Matched</th>
                  <th className="py-1.5 pr-3 font-medium">Paid</th>
                  <th className="py-1.5 pr-3 font-medium">Signed</th>
                  <th className="py-1.5 pr-3 font-medium">Handed off</th>
                  <th className="py-1.5 font-medium">~Days to handoff</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((p: any) => (
                  <tr key={p.providerId} className="border-t">
                    <td className="py-1.5 pr-3">
                      <span className="font-medium">{p.providerName}</span>
                      <span className="text-muted-foreground"> · {p.journeyTypes.join(", ")}</span>
                    </td>
                    <td className="py-1.5 pr-3">{p.journeys}</td>
                    <td className="py-1.5 pr-3">{p.consultScheduled}</td>
                    <td className="py-1.5 pr-3">{p.consultCompleted}</td>
                    <td className="py-1.5 pr-3">{p.noShowsParent}/{p.noShowsProvider}</td>
                    <td className="py-1.5 pr-3">{p.matched}</td>
                    <td className="py-1.5 pr-3">{p.invoicePaid}</td>
                    <td className="py-1.5 pr-3">{p.agreementSigned}</td>
                    <td className="py-1.5 pr-3">{p.handedOff}</td>
                    <td className="py-1.5">{p.medianDaysToHandoff ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
