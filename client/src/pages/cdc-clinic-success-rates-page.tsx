import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Award, ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdminReportLayout } from "@/components/admin-report-layout";

interface MetricEntry {
  metricCode: string;
  ageGroup: string | null;
  submetric: string | null;
  isNewPatient: boolean;
  successRate: number | null;
  cycleCount: number;
  percentile: number | null;
  top10pct: boolean;
  nationalAverage: number | null;
}

interface ClinicSuccessRatesData {
  year: number;
  provider: {
    id: string;
    name: string;
    cdcClinicId: string | null;
    city: string | null;
    state: string | null;
    address: string | null;
    zip: string | null;
  };
  totalRecords: number;
  ownEggs: { allPatients: MetricEntry[]; newPatients: MetricEntry[] };
  donorEggs: Record<string, MetricEntry[]>;
  allMetrics: Record<string, MetricEntry[]>;
}

const AGE_GROUPS = ["under_35", "35_37", "38_40", "over_40"] as const;
const AGE_LABELS: Record<string, string> = {
  under_35: "< 35",
  "35_37": "35–37",
  "38_40": "38–40",
  over_40: "> 40",
};

const SUBMETRICS = [
  "fresh_embryos_fresh_eggs",
  "fresh_embryos_frozen_eggs",
  "frozen_embryos",
  "donated_embryos",
] as const;
const SUBMETRIC_LABELS: Record<string, string> = {
  fresh_embryos_fresh_eggs: "Fresh Embryos, Fresh Eggs",
  fresh_embryos_frozen_eggs: "Fresh Embryos, Frozen Eggs",
  frozen_embryos: "Frozen Embryos",
  donated_embryos: "Donated Embryos",
};

function formatPct(val: number | null | undefined): string {
  if (val === null || val === undefined) return "-";
  return `${(val * 100).toFixed(1)}%`;
}

function formatAvg(val: number | null | undefined): string {
  if (val === null || val === undefined) return "-";
  return val.toFixed(1);
}

function formatCount(val: number | null | undefined): string {
  if (val === null || val === undefined) return "-";
  return val.toLocaleString();
}

function Top10Badge() {
  return (
    <Badge
      variant="outline"
      className="text-[10px] px-1 py-0 border-success/30 text-success bg-success/5 dark:bg-success/10 no-default-hover-elevate no-default-active-elevate inline-flex items-center gap-0.5 ml-1"
    >
      <Award className="w-2.5 h-2.5" />
      Top 10%
    </Badge>
  );
}

function MetricValue({ entry, isAvg }: { entry: MetricEntry | undefined; isAvg?: boolean }) {
  if (!entry || entry.successRate === null) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="font-heading">{isAvg ? formatAvg(entry.successRate) : formatPct(entry.successRate)}</span>
      {entry.top10pct && <Top10Badge />}
    </span>
  );
}

function NatAvgValue({ entry, isAvg }: { entry: MetricEntry | undefined; isAvg?: boolean }) {
  if (!entry || entry.nationalAverage === null) return null;
  return (
    <span className="text-muted-foreground text-[11px]">
      {isAvg ? formatAvg(entry.nationalAverage) : formatPct(entry.nationalAverage)}
    </span>
  );
}

function PercentileValue({ entry }: { entry: MetricEntry | undefined }) {
  if (!entry || entry.percentile === null) return null;
  return (
    <span className="text-muted-foreground text-[11px]">
      {Math.round(entry.percentile * 100)}th pctl
    </span>
  );
}

type MetricLookup = Record<string, Record<string, MetricEntry>>;

function buildLookup(allMetrics: Record<string, MetricEntry[]>, keyField: "ageGroup" | "submetric"): MetricLookup {
  const lookup: MetricLookup = {};
  for (const [code, entries] of Object.entries(allMetrics)) {
    lookup[code] = {};
    for (const e of entries) {
      const key = (keyField === "ageGroup" ? e.ageGroup : e.submetric) || "unknown";
      lookup[code][key] = e;
    }
  }
  return lookup;
}

type RowDef = { label: string; code: string; isCount?: boolean; isAvg?: boolean };

const OWN_EGGS_ALL_PATIENTS_ROWS: RowDef[] = [
  { label: "Number of intended retrievals", code: "pct_intended_retrievals_live_births", isCount: true },
  { label: "Percentage of intended retrievals resulting in live-birth deliveries", code: "pct_intended_retrievals_live_births" },
  { label: "Percentage of intended retrievals resulting in singleton live-birth deliveries", code: "pct_intended_retrievals_singleton_live_births" },
  { label: "Number of actual retrievals", code: "pct_actual_retrievals_live_births", isCount: true },
  { label: "Percentage of actual retrievals resulting in live-birth deliveries", code: "pct_actual_retrievals_live_births" },
  { label: "Percentage of actual retrievals resulting in singleton live-birth deliveries", code: "pct_actual_retrievals_singleton_live_births" },
  { label: "Number of transfers", code: "pct_transfers_live_births", isCount: true },
  { label: "Percentage of transfers resulting in live-birth deliveries", code: "pct_transfers_live_births" },
  { label: "Percentage of transfers resulting in singleton live-birth deliveries", code: "pct_transfers_singleton_live_births" },
  { label: "Average number of intended retrievals per live-birth delivery", code: "avg_intended_retrievals_per_live_birth", isAvg: true },
  { label: "Average number of transfers per intended retrieval", code: "avg_transfers_per_intended_retrieval", isAvg: true },
];

const NEW_PATIENTS_ROWS: RowDef[] = [
  { label: "Percentage of new patients having live-birth deliveries after 1 intended retrieval", code: "pct_new_patients_live_birth_after_1_retrieval" },
  { label: "Percentage of new patients having live-birth deliveries after 1 or 2 intended retrievals", code: "pct_new_patients_live_birth_after_1_or_2_retrievals" },
  { label: "Percentage of new patients having live-birth deliveries after all intended retrievals", code: "pct_new_patients_live_birth_after_all_retrievals" },
  { label: "Average number of intended retrievals per new patient", code: "avg_intended_retrievals_per_new_patient", isAvg: true },
  { label: "Average number of transfers per intended retrieval", code: "avg_transfers_per_intended_retrieval_new", isAvg: true },
];

const DONOR_ROWS: RowDef[] = [
  { label: "Number of transfers", code: "pct_transfers_live_births_donor", isCount: true },
  { label: "Percentage of transfers resulting in live-birth deliveries", code: "pct_transfers_live_births_donor" },
  { label: "Percentage of transfers resulting in singleton live-birth deliveries", code: "pct_transfers_singleton_live_births_donor" },
];

function AgeGroupHeader() {
  return (
    <tr className="bg-muted text-foreground border-b border-border">
      <th className="text-left px-4 py-2 text-xs font-heading" style={{ width: "52%" }} />
      {AGE_GROUPS.map((ag) => (
        <th key={ag} className="text-center px-3 py-2 text-xs font-heading" style={{ width: "12%" }}>
          {AGE_LABELS[ag]}
        </th>
      ))}
    </tr>
  );
}

function MetricRow({
  row,
  lookup,
  keyField,
  keys,
}: {
  row: { label: string; code: string; isCount?: boolean; isAvg?: boolean };
  lookup: MetricLookup;
  keyField: "ageGroup" | "submetric";
  keys: readonly string[];
}) {
  const metricData = lookup[row.code] || {};

  if (row.isCount) {
    const firstEntry = Object.values(metricData)[0];
    const count = firstEntry ? formatCount(firstEntry.cycleCount) : "-";
    return (
      <tr className="border-t border-border bg-primary/5 dark:bg-primary/10">
        <td className="px-4 py-2 text-xs font-heading text-foreground/80">{row.label} (total)</td>
        <td colSpan={keys.length} className="text-center px-3 py-2 text-sm font-heading tabular-nums">
          {count}
        </td>
      </tr>
    );
  }

  if (row.isAvg) {
    return (
      <tr className="border-t border-border/50 bg-muted/20 hover:bg-muted/40 transition-colors">
        <td className="px-4 py-2.5 text-xs leading-snug italic text-muted-foreground">{row.label}</td>
        {keys.map((k) => {
          const entry = metricData[k];
          return (
            <td key={k} className="text-center px-3 py-2.5" data-testid={`cell-${row.code}-${k}`}>
              <MetricValue entry={entry} isAvg />
            </td>
          );
        })}
      </tr>
    );
  }

  return (
    <tr className="border-t border-border/30 hover:bg-muted/30 transition-colors">
      <td className="px-4 py-2.5 text-xs leading-snug text-muted-foreground">{row.label}</td>
      {keys.map((k) => {
        const entry = metricData[k];
        return (
          <td key={k} className="text-center px-3 py-2.5" data-testid={`cell-${row.code}-${k}`}>
            <MetricValue entry={entry} isAvg={row.isAvg} />
          </td>
        );
      })}
    </tr>
  );
}

function OwnEggsSection({ allMetrics }: { allMetrics: Record<string, MetricEntry[]> }) {
  const allPatientsMetrics: Record<string, MetricEntry[]> = {};
  const newPatientsMetrics: Record<string, MetricEntry[]> = {};

  for (const [code, entries] of Object.entries(allMetrics)) {
    const allP = entries.filter((e) => e.ageGroup && !e.isNewPatient && !e.submetric);
    const newP = entries.filter((e) => e.ageGroup && e.isNewPatient && !e.submetric);
    if (allP.length > 0) allPatientsMetrics[code] = allP;
    if (newP.length > 0) newPatientsMetrics[code] = newP;
  }

  const allPLookup = buildLookup(allPatientsMetrics, "ageGroup");
  const newPLookup = buildLookup(newPatientsMetrics, "ageGroup");

  const hasAllPatients = OWN_EGGS_ALL_PATIENTS_ROWS.some((r) => allPLookup[r.code]);
  const hasNewPatients = NEW_PATIENTS_ROWS.some((r) => newPLookup[r.code]);

  if (!hasAllPatients && !hasNewPatients) return null;

  return (
    <Card>
      <CardContent className="pt-5 pb-4 px-5 space-y-6">
        <h3 className="text-lg font-heading" data-testid="section-own-eggs">
          Cumulative ART Success Rates for Intended Retrievals - Own Eggs
        </h3>

        {hasAllPatients && (
          <div data-testid="own-eggs-table-all-patients">
            <div className="border rounded-[var(--radius)] overflow-hidden">
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="bg-muted text-foreground border-b border-border">
                    <th className="text-left px-4 py-2 text-xs font-heading" style={{ width: "52%" }}>
                      All patients (with or without prior ART cycles)
                    </th>
                    {AGE_GROUPS.map((ag) => (
                      <th key={ag} className="text-center px-3 py-2 text-xs font-heading" style={{ width: "12%" }}>
                        {AGE_LABELS[ag]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {OWN_EGGS_ALL_PATIENTS_ROWS.map((row) => (
                    <MetricRow
                      key={`${row.code}-${row.isCount ? "count" : "rate"}`}
                      row={row}
                      lookup={allPLookup}
                      keyField="ageGroup"
                      keys={AGE_GROUPS}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {hasNewPatients && (
          <div data-testid="own-eggs-table-new-patients">
            <div className="border rounded-[var(--radius)] overflow-hidden">
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="bg-muted text-foreground border-b border-border">
                    <th className="text-left px-4 py-2 text-xs font-heading" style={{ width: "52%" }}>
                      New patients (with no prior ART cycles)
                    </th>
                    {AGE_GROUPS.map((ag) => (
                      <th key={ag} className="text-center px-3 py-2 text-xs font-heading" style={{ width: "12%" }}>
                        {AGE_LABELS[ag]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {NEW_PATIENTS_ROWS.map((row) => (
                    <MetricRow
                      key={`${row.code}-${row.isCount ? "count" : "rate"}`}
                      row={row}
                      lookup={newPLookup}
                      keyField="ageGroup"
                      keys={AGE_GROUPS}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DonorEggsSection({ allMetrics }: { allMetrics: Record<string, MetricEntry[]> }) {
  const donorMetrics: Record<string, MetricEntry[]> = {};
  for (const [code, entries] of Object.entries(allMetrics)) {
    const donor = entries.filter((e) => e.submetric && !e.ageGroup);
    if (donor.length > 0) donorMetrics[code] = donor;
  }

  const lookup = buildLookup(donorMetrics, "submetric");
  const hasData = DONOR_ROWS.some((r) => lookup[r.code]);
  if (!hasData) return null;

  const availableSubmetrics = SUBMETRICS.filter((s) => {
    return DONOR_ROWS.some((r) => lookup[r.code]?.[s]);
  });

  if (availableSubmetrics.length === 0) return null;

  return (
    <Card>
      <CardContent className="pt-5 pb-4 px-5 space-y-4">
        <h3 className="text-lg font-heading" data-testid="section-donor-eggs">
          Noncumulative ART Success Rates for Transfers - Donor Eggs
        </h3>
        <div className="border rounded-[var(--radius)] overflow-hidden" data-testid="donor-eggs-table">
          <table className="w-full text-sm table-fixed">
            <thead>
              <tr className="bg-muted text-foreground border-b border-border">
                <th className="text-left px-4 py-2 text-xs font-heading w-[40%]" />
                {availableSubmetrics.map((s) => (
                  <th key={s} className="text-center px-3 py-2 text-xs font-heading">
                    {SUBMETRIC_LABELS[s]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DONOR_ROWS.map((row) => (
                <MetricRow
                  key={`${row.code}-${row.isCount ? "count" : "rate"}`}
                  row={row}
                  lookup={lookup}
                  keyField="submetric"
                  keys={availableSubmetrics}
                />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function CdcClinicSuccessRatesPage() {
  const { id, providerId } = useParams<{ id: string; providerId: string }>();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery<ClinicSuccessRatesData>({
    queryKey: ["/api/scrapers/cdc-syncs", id, "clinic", providerId, "success-rates"],
    enabled: !!id && !!providerId,
  });

  if (isLoading) {
    return (
      <AdminReportLayout
        breadcrumbs={[
          { label: "Scrapers", href: "/admin/scrapers" },
          { label: "CDC Sync", href: `/admin/scrapers/cdc-sync/${id}/report` },
          { label: "Clinic Details" },
        ]}
        title="Clinic Success Rates"
      >
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      </AdminReportLayout>
    );
  }

  if (!data) {
    return (
      <AdminReportLayout
        breadcrumbs={[
          { label: "Scrapers", href: "/admin/scrapers" },
          { label: "CDC Sync", href: `/admin/scrapers/cdc-sync/${id}/report` },
          { label: "Clinic Details" },
        ]}
        title="Clinic Success Rates"
      >
        <p className="text-muted-foreground text-sm" data-testid="text-no-data">No data found for this clinic.</p>
      </AdminReportLayout>
    );
  }

  const { provider, allMetrics, year } = data;
  const location = [provider.city, provider.state].filter(Boolean).join(", ");
  const hasAnyData = Object.keys(allMetrics).length > 0;

  return (
    <AdminReportLayout
      breadcrumbs={[
        { label: "Scrapers", href: "/admin/scrapers" },
        { label: `CDC Sync \u2014 ${year}`, href: `/admin/scrapers/cdc-sync/${id}/report` },
        { label: provider.name },
      ]}
      title={provider.name}
      subtitle={location || undefined}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => navigate(`/admin/scrapers/cdc-sync/${id}/report`)}
          data-testid="button-back-to-report"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Report
        </Button>
        <a
          href={provider.cdcClinicId ? `https://art.cdc.gov/?clinicid=${provider.cdcClinicId}` : `https://www.cdc.gov/art/artdata/index.html`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
          data-testid="link-cdc-website"
        >
          <ExternalLink className="w-3 h-3" />
          View on CDC
        </a>
        <div className="flex items-center gap-4 text-sm text-muted-foreground ml-auto flex-wrap">
          <span data-testid="text-total-records">{data.totalRecords} total records</span>
          {provider.address && (
            <span data-testid="text-address">{provider.address}{provider.zip ? `, ${provider.zip}` : ""}</span>
          )}
        </div>
      </div>

      {hasAnyData ? (
        <>
          <OwnEggsSection allMetrics={allMetrics} />
          <DonorEggsSection allMetrics={allMetrics} />
        </>
      ) : (
        <Card>
          <CardContent className="pt-5 pb-4 px-5">
            <p className="text-sm text-muted-foreground" data-testid="text-no-rates">No success rate data available for this clinic.</p>
          </CardContent>
        </Card>
      )}
    </AdminReportLayout>
  );
}
