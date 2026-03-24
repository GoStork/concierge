import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";

export interface IvfSuccessRate {
  successRate: number | null;
  nationalAverage: number | null;
  ageGroup: string | null;
  profileType: string | null;
  metricCode?: string | null;
  submetric?: string | null;
  isNewPatient?: boolean;
  top10pct?: boolean;
}

export interface IvfFilterContext {
  eggSource?: string;
  ageGroup?: string;
  isNewPatient?: string;
}

const AGE_GROUPS = ["under_35", "35_37", "38_40", "over_40"] as const;
const AGE_LABELS: Record<string, string> = {
  under_35: "<35",
  "35_37": "35-37",
  "38_40": "38-40",
  over_40: ">40",
};
const AGE_FULL_LABELS: Record<string, string> = {
  under_35: "Under 35",
  "35_37": "35–37",
  "38_40": "38–40",
  over_40: "Over 40",
};

const DONOR_SUBMETRICS = [
  "fresh_embryos_fresh_eggs",
  "fresh_embryos_frozen_eggs",
  "frozen_embryos",
  "donated_embryos",
] as const;
const DONOR_LABELS: Record<string, string> = {
  fresh_embryos_fresh_eggs: "Fresh Eggs",
  fresh_embryos_frozen_eggs: "Frozen Eggs",
  frozen_embryos: "Frozen Embryos",
  donated_embryos: "Donated Embryos",
};

const OWN_METRIC = "pct_intended_retrievals_live_births";
const OWN_NEW_METRIC = "pct_new_patients_live_birth_after_1_retrieval";
const DONOR_METRIC = "pct_transfers_live_births_donor";

function BarChart({
  bars,
  xAxisLabel,
  highlightIndex,
}: {
  bars: { label: string; value: number; natAvg: number; testId: string }[];
  xAxisLabel: string;
  highlightIndex?: number;
}) {
  const yTicks = [0, 20, 40, 60, 80, 100];
  const chartHeight = 200;
  const barWidth = 56;
  const gap = 24;

  return (
    <div className="flex items-end gap-0" data-testid="chart-bars">
      <div className="flex flex-col justify-between items-end pr-2 shrink-0" style={{ height: chartHeight }}>
        {yTicks.slice().reverse().map((tick) => (
          <span key={tick} className="text-[10px] text-muted-foreground leading-none">{tick}</span>
        ))}
      </div>

      <div className="flex-1 min-w-0">
        <div className="relative" style={{ height: chartHeight }}>
          {yTicks.map((tick) => (
            <div
              key={tick}
              className="absolute left-0 right-0 border-t border-border/30"
              style={{ bottom: `${(tick / 100) * chartHeight}px` }}
            />
          ))}

          <div
            className="absolute bottom-0 left-0 right-0 flex justify-start pl-4"
            style={{ gap: `${gap}px` }}
          >
            {bars.map((bar, idx) => {
              const clinicH = Math.max((bar.value / 100) * chartHeight, 1);
              const natH = Math.max((bar.natAvg / 100) * chartHeight, 1);
              const dimmed = highlightIndex !== undefined && idx !== highlightIndex;
              return (
                <div key={bar.testId} className="flex flex-col items-center" style={{ width: barWidth }}>
                  <div className="flex items-end gap-1 relative" style={{ height: chartHeight }}>
                    <div className="relative group" style={{ width: (barWidth - 4) / 2 }}>
                      <div
                        className="w-full rounded-t-sm transition-all duration-500"
                        style={{
                          height: `${clinicH}px`,
                          backgroundColor: dimmed ? "hsl(var(--primary) / 0.2)" : "hsl(var(--primary))",
                        }}
                        data-testid={`bar-clinic-${bar.testId}`}
                      />
                      <div className={`absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] font-heading whitespace-nowrap ${dimmed ? "text-muted-foreground/40" : "text-foreground"}`}>
                        {bar.value.toFixed(0)}%
                      </div>
                    </div>
                    <div className="relative group" style={{ width: (barWidth - 4) / 2 }}>
                      <div
                        className="w-full rounded-t-sm transition-all duration-500"
                        style={{
                          height: `${natH}px`,
                          backgroundColor: dimmed ? "hsl(var(--accent) / 0.25)" : "hsl(var(--accent))",
                        }}
                        data-testid={`bar-natavg-${bar.testId}`}
                      />
                      <div className={`absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] whitespace-nowrap ${dimmed ? "text-muted-foreground/30" : "text-muted-foreground"}`}>
                        {bar.natAvg.toFixed(0)}%
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center border-t border-border/50 pt-2 pl-4">
          <div className="flex justify-start" style={{ gap: `${gap}px` }}>
            {bars.map((bar, idx) => {
              const dimmed = highlightIndex !== undefined && idx !== highlightIndex;
              return (
                <div key={bar.testId} className="text-center" style={{ width: barWidth }}>
                  <span className={`text-xs font-ui ${dimmed ? "text-muted-foreground/40" : highlightIndex !== undefined && idx === highlightIndex ? "text-foreground font-heading" : "text-muted-foreground"}`} data-testid={`label-${bar.testId}`}>
                    {bar.label}
                  </span>
                </div>
              );
            })}
          </div>
          <span className="text-[10px] text-muted-foreground font-ui pl-3 shrink-0">{xAxisLabel}</span>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-ui rounded-md transition-colors ${
        active
          ? "bg-primary text-white"
          : "bg-secondary/50 text-muted-foreground hover:bg-secondary"
      }`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function PersonalizedView({ rates, filterContext }: { rates: IvfSuccessRate[]; filterContext: IvfFilterContext }) {
  const isDonor = filterContext.eggSource === "donor" || filterContext.eggSource === "donated_embryos";
  const isNew = filterContext.isNewPatient === "true" || filterContext.isNewPatient === "yes";

  const matchedRate = useMemo(() => {
    if (isDonor) {
      const submetric = filterContext.eggSource === "donated_embryos" ? "donated_embryos" : undefined;
      const candidates = rates.filter(
        (r) => r.profileType === "donor" && r.metricCode === DONOR_METRIC &&
          (submetric ? r.submetric === submetric : true) && r.successRate != null
      );
      if (candidates.length === 0) return null;
      return candidates.reduce((a, b) => Number(b.successRate) > Number(a.successRate) ? b : a);
    }

    const metric = isNew ? OWN_NEW_METRIC : OWN_METRIC;
    return rates.find(
      (r) =>
        r.profileType === "own_eggs" &&
        r.metricCode === metric &&
        r.ageGroup === filterContext.ageGroup &&
        (isNew ? r.isNewPatient === true : !r.isNewPatient) &&
        r.successRate != null
    ) || null;
  }, [rates, filterContext, isDonor, isNew]);

  const profileParts: string[] = [];
  if (isDonor) {
    profileParts.push(filterContext.eggSource === "donated_embryos" ? "Donated embryos" : "Donor eggs");
  } else {
    profileParts.push("Own eggs");
    if (filterContext.ageGroup && AGE_FULL_LABELS[filterContext.ageGroup]) {
      profileParts.push(`Age ${AGE_FULL_LABELS[filterContext.ageGroup]}`);
    }
    if (isNew) profileParts.push("First-time IVF");
    else profileParts.push("All patients");
  }
  const profileLabel = profileParts.join(" · ");

  if (!matchedRate) {
    return (
      <div className="text-center py-6 text-sm text-muted-foreground" data-testid="text-no-personalized-data">
        No CDC success rate data available for your profile ({profileLabel})
      </div>
    );
  }

  const clinicPct = Number(matchedRate.successRate) * 100;
  const natPct = Number(matchedRate.nationalAverage) * 100;
  const diff = clinicPct - natPct;

  return (
    <div className="space-y-4" data-testid="personalized-rate-view">
      <p className="text-xs text-muted-foreground font-ui" data-testid="text-profile-label">
        Your profile: {profileLabel}
      </p>

      <div className="flex items-baseline gap-3">
        <span className="text-4xl font-heading text-foreground" data-testid="text-personalized-rate">
          {Math.round(clinicPct)}%
        </span>
        <span className="text-sm text-muted-foreground">live birth rate</span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground w-28 shrink-0">This Clinic</span>
          <div className="flex-1 h-5 bg-secondary/30 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${clinicPct}%`, backgroundColor: "hsl(var(--primary))" }}
            />
          </div>
          <span className="text-xs font-heading text-foreground w-12 text-right">{Math.round(clinicPct)}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground w-28 shrink-0">National Average</span>
          <div className="flex-1 h-5 bg-secondary/30 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${natPct}%`, backgroundColor: "hsl(var(--accent))" }}
            />
          </div>
          <span className="text-xs text-muted-foreground w-12 text-right">{Math.round(natPct)}%</span>
        </div>
      </div>

      <div className={`text-sm font-heading ${diff >= 0 ? "text-[hsl(var(--brand-success))]" : "text-destructive"}`} data-testid="text-rate-diff">
        {diff >= 0 ? "+" : ""}{Math.round(diff)}% vs. national average
      </div>

      {matchedRate.top10pct && (
        <div className="inline-flex items-center gap-1.5 bg-[hsl(var(--brand-success)/0.08)] text-[hsl(var(--brand-success))] border border-[hsl(var(--brand-success)/0.3)] rounded-full px-3 py-1 text-xs font-ui" data-testid="badge-top-10">
          Top 10% nationally for your profile
        </div>
      )}
    </div>
  );
}

export function IvfSuccessRatesSection({ rates, filterContext }: { rates: IvfSuccessRate[]; filterContext?: IvfFilterContext }) {
  const [tab, setTab] = useState<"own" | "donor">(() =>
    filterContext?.eggSource === "donor" ? "donor" : "own"
  );
  const [patientType, setPatientType] = useState<"all" | "new">(() =>
    filterContext?.isNewPatient === "true" || filterContext?.isNewPatient === "yes" ? "new" : "all"
  );

  const hasFilterContext = filterContext && (filterContext.eggSource || filterContext.ageGroup);

  const hasDonorData = useMemo(
    () => rates.some((r) => r.profileType === "donor" && r.metricCode === DONOR_METRIC && r.successRate != null),
    [rates]
  );

  const hasOwnData = useMemo(
    () => rates.some((r) => r.profileType === "own_eggs" && (r.metricCode === OWN_METRIC || r.metricCode === OWN_NEW_METRIC) && r.successRate != null),
    [rates]
  );

  const hasNewPatientData = useMemo(
    () => rates.some((r) => r.profileType === "own_eggs" && r.metricCode === OWN_NEW_METRIC && r.isNewPatient && r.successRate != null),
    [rates]
  );

  const effectivePatientType = hasFilterContext && (filterContext?.isNewPatient === "true" || filterContext?.isNewPatient === "yes") ? "new" : patientType;

  const ownBars = useMemo(() => {
    const metric = effectivePatientType === "new" ? OWN_NEW_METRIC : OWN_METRIC;
    const isNew = effectivePatientType === "new";
    return AGE_GROUPS.map((ag) => {
      const row = rates.find(
        (r) =>
          r.profileType === "own_eggs" &&
          r.metricCode === metric &&
          r.ageGroup === ag &&
          (isNew ? r.isNewPatient === true : !r.isNewPatient)
      );
      return {
        label: AGE_LABELS[ag],
        value: row ? Number(row.successRate) * 100 : 0,
        natAvg: row ? Number(row.nationalAverage) * 100 : 0,
        testId: ag,
      };
    });
  }, [rates, effectivePatientType]);

  const donorBars = useMemo(() => {
    return DONOR_SUBMETRICS.map((sm) => {
      const row = rates.find(
        (r) =>
          r.profileType === "donor" &&
          r.metricCode === DONOR_METRIC &&
          r.submetric === sm
      );
      return {
        label: DONOR_LABELS[sm],
        value: row ? Number(row.successRate) * 100 : 0,
        natAvg: row ? Number(row.nationalAverage) * 100 : 0,
        testId: sm,
      };
    });
  }, [rates]);

  const highlightIndex = useMemo(() => {
    if (!hasFilterContext) return undefined;
    if (filterContext.eggSource === "own_eggs" && filterContext.ageGroup) {
      return AGE_GROUPS.indexOf(filterContext.ageGroup as any);
    }
    return undefined;
  }, [hasFilterContext, filterContext]);

  if (!hasOwnData && !hasDonorData) return null;

  const activeTab = (!hasOwnData && hasDonorData) ? "donor" : (tab === "donor" && hasDonorData ? "donor" : "own");

  return (
    <Card className="overflow-hidden" data-testid="section-ivf-success-rates">
      <div className="px-4 py-2.5 border-b bg-muted/50">
        <h3 className="text-sm font-heading font-semibold text-foreground" data-testid="section-header-cdc-success-rates">
          CDC Success Rates
        </h3>
      </div>

      <div className="p-5 space-y-4">
        {hasFilterContext ? (
          <>
            <PersonalizedView rates={rates} filterContext={filterContext!} />
            <div className="border-t border-border/30 pt-4 mt-4">
              <p className="text-xs font-ui text-muted-foreground mb-3">All age groups comparison</p>
              <BarChart
                bars={filterContext!.eggSource === "donor" || filterContext!.eggSource === "donated_embryos" ? donorBars : ownBars}
                xAxisLabel={filterContext!.eggSource === "donor" || filterContext!.eggSource === "donated_embryos" ? "Egg Source" : "Age"}
                highlightIndex={highlightIndex}
              />
              <div className="flex items-center gap-4 text-[10px] text-muted-foreground pt-1">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-primary" />
                  This Clinic
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-3 rounded-sm bg-accent" />
                  National Average
                </span>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center flex-wrap gap-3">
              <div className="flex gap-1.5">
                <TabButton active={activeTab === "own"} onClick={() => setTab("own")} testId="tab-own-eggs">
                  Own Eggs
                </TabButton>
                {hasDonorData && (
                  <TabButton active={activeTab === "donor"} onClick={() => setTab("donor")} testId="tab-donor-eggs">
                    Donor Eggs
                  </TabButton>
                )}
              </div>

              {activeTab === "own" && hasNewPatientData && (
                <>
                  <div className="w-px h-5 bg-border/60" />
                  <div className="flex gap-1.5">
                    <TabButton active={patientType === "all"} onClick={() => setPatientType("all")} testId="tab-all-patients">
                      All Patients
                    </TabButton>
                    <TabButton active={patientType === "new"} onClick={() => setPatientType("new")} testId="tab-new-patients">
                      New Patients
                    </TabButton>
                  </div>
                </>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              {activeTab === "own"
                ? patientType === "new"
                  ? "Live birth rate after first egg retrieval for new patients"
                  : "Live birth rate per intended egg retrieval (all patients)"
                : "Live birth rate per embryo transfer using donor eggs"}
            </p>

            <BarChart
              bars={activeTab === "own" ? ownBars : donorBars}
              xAxisLabel={activeTab === "own" ? "Age" : "Egg Source"}
            />

            <div className="flex items-center gap-4 text-[10px] text-muted-foreground pt-1">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm bg-primary" />
                This Clinic
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-sm bg-accent" />
                National Average
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
