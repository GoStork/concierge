/**
 * The one parents filter bar.
 *
 * Both views had their own copy of these eight controls, so the multi-select
 * work below would otherwise have had to be written - and kept in step - twice.
 * The two tables already share their cells, their sort comparator and their
 * filter predicates; this closes the last seam.
 *
 * Everything lives in URL search params, per the tab-state rule: a filtered
 * view survives a reload, a bookmark, and the back button.
 */
import { Button } from "@/components/ui/button";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { FilterRow, FilterSearch, FilterDropdown, FilterDate } from "@/components/ui/filter-controls";
import { SERVICE_LABELS, IP_FORM_FILTER_LABELS } from "./parent-cells";
import { ServiceDot } from "@/components/ui/service-tag";
import { JOURNEY_STAGE_LABELS, MATCHED_ELSEWHERE_STAGE, MATCHED_ELSEWHERE_LABEL, CALL_EXPIRED_STAGE, CALL_EXPIRED_LABEL } from "@shared/journey-ladder";

export interface ParentsFilterState {
  q: string;
  from: string;
  to: string;
  services: string[];
  statuses: string[];
  owner: string;
  next: string;
  /** "submitted" | "missing" | "all" - Intended Parent form state. */
  form: string;
  /** #5 Silence: minimum days quiet ("3" | "7" | "14" | "30"), "all" = off. */
  quiet?: string;
}

export const QUIET_FILTER_LABELS: Record<string, string> = {
  "3": "Quiet 3+ days",
  "7": "Quiet 7+ days",
  "14": "Quiet 14+ days",
  "30": "Quiet 30+ days",
};

export function ParentsFilterBar({
  state, setParam, setParams, onClear, ownerOptions, testIdPrefix, reviewPill,
}: {
  state: ParentsFilterState;
  /** Write one param. An empty value removes it. */
  setParam: (key: string, value: string) => void;
  /** Write several params in ONE update - successive single writes race. */
  setParams: (entries: Record<string, string>) => void;
  onClear: () => void;
  ownerOptions: { id: string; name?: string | null }[];
  /** Admin only: the "Needs review" signup-quarantine quick filter. */
  reviewPill?: { active: boolean; count: number; onToggle: () => void };
  testIdPrefix: string;
}) {
  const hasActive = !!(state.q.trim() || state.from || state.to || state.services.length
    || state.statuses.length || state.owner !== "all" || state.next !== "all"
    || state.form !== "all" || (state.quiet && state.quiet !== "all"));

  // "My leads" and "No owner" are owner+next-step combinations, and they used to
  // sit BOTH here as pills and inside the owners dropdown, which read as two
  // controls fighting over one setting. The pills keep them, because they are
  // one click; the dropdown is now purely "which person owns this".
  const pills = [
    { key: "all", label: "All", apply: { owner: "", next: "" } },
    { key: "mine", label: "My leads", apply: { owner: "me", next: "" } },
    { key: "overdue", label: "Overdue", apply: { owner: "", next: "overdue" } },
    { key: "unowned", label: "No owner", apply: { owner: "unassigned", next: "" } },
  ];

  return (
    <>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Full width on a phone: a fixed 260px search left just enough room
              for the From pill to hang off the right edge of the screen instead
              of wrapping onto the next line with the others. */}
          <FilterSearch
            placeholder="Search by name, email, or phone..."
            value={state.q}
            onChange={(v) => setParam("q", v)}
            testId={`${testIdPrefix}-search`}
          />

          <FilterDate value={state.from} onChange={(v) => setParam("from", v)} placeholder="From" testId={`${testIdPrefix}-date-from`} />
          <FilterDate value={state.to} onChange={(v) => setParam("to", v)} placeholder="To" testId={`${testIdPrefix}-date-to`} />

          <FilterDropdown
            label="All services"
            options={Object.entries(SERVICE_LABELS)}
            selected={state.services}
            onChange={(next) => setParam("svc", next.join(","))}
            testId={`${testIdPrefix}-service-filter`}
            renderOption={(_k, text) => <ServiceDot service={text} />}
          />
          <FilterDropdown
            label="All statuses"
            // The two branch outcomes are appended rather than living in
            // JOURNEY_STAGE_LABELS: they are forks, not rungs on the order
            // ladder. Both are filterable because "who have I lost?" and "whose
            // call never got confirmed?" are the first two things an agency
            // wants to pull out of their pipeline.
            options={[
              ...Object.entries(JOURNEY_STAGE_LABELS),
              [MATCHED_ELSEWHERE_STAGE, MATCHED_ELSEWHERE_LABEL] as [string, string],
              [CALL_EXPIRED_STAGE, CALL_EXPIRED_LABEL] as [string, string],
            ]}
            selected={state.statuses}
            onChange={(next) => setParam("status", next.join(","))}
            testId={`${testIdPrefix}-status-filter`}
          />
          <FilterDropdown
            single
            label="IP form"
            options={Object.entries(IP_FORM_FILTER_LABELS)}
            selected={state.form === "all" ? [] : [state.form]}
            onChange={(next) => setParam("form", next[0] || "")}
            testId={`${testIdPrefix}-form-filter`}
          />
          <FilterDropdown
            single
            label="Quiet for"
            options={Object.entries(QUIET_FILTER_LABELS)}
            selected={!state.quiet || state.quiet === "all" ? [] : [state.quiet]}
            onChange={(next) => setParam("quiet", next[0] || "")}
            testId={`${testIdPrefix}-quiet-filter`}
          />
          <FilterDropdown
            single
            label="All owners"
            options={ownerOptions.map((o) => [o.id, o.name || "Unnamed"] as [string, string])}
            // "me" and "unassigned" belong to the pills below, not to a person
            // picker, so neither shows as a selected owner here.
            selected={state.owner === "all" || state.owner === "me" || state.owner === "unassigned" ? [] : [state.owner]}
            onChange={(next) => setParam("owner", next[0] || "")}
            testId={`${testIdPrefix}-owner-filter`}
          />
        </div>
        <ClearFiltersButton pill show={hasActive} onClick={onClear} testId={`${testIdPrefix}-clear-filters`} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="parents-quick-filters">
        {pills.map((pill) => {
          // Normalise BOTH sides to "all" before comparing: the pills store a
          // cleared filter as "", the URL stores it as absent -> "all".
          const active =
            (pill.apply.owner || "all") === (state.owner || "all") &&
            (pill.apply.next || "all") === (state.next || "all");
          return (
            <button
              key={pill.key}
              type="button"
              // bg-card when inactive, like every other control in this bar -
              // transparent would let the sand page through and make these
              // read as labels rather than buttons.
              className="text-xs font-ui px-2.5 py-1 rounded-full border bg-card transition-colors"
              style={active
                ? { background: "hsl(var(--primary) / 0.12)", color: "hsl(var(--primary))", borderColor: "hsl(var(--primary) / 0.4)" }
                : undefined}
              onClick={() => setParams(pill.apply)}
              data-testid={`quick-filter-${pill.key}`}
            >
              {pill.label}
            </button>
          );
        })}
        {reviewPill && (reviewPill.count > 0 || reviewPill.active) && (
          <button
            type="button"
            className="text-xs font-ui px-2.5 py-1 rounded-full border bg-card transition-colors inline-flex items-center gap-1.5"
            style={reviewPill.active
              ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))", borderColor: "hsl(var(--brand-warning) / 0.5)" }
              : { color: "hsl(var(--brand-warning))", borderColor: "hsl(var(--brand-warning) / 0.35)" }}
            onClick={reviewPill.onToggle}
            data-testid="quick-filter-review"
          >
            Needs review
            <span
              className="rounded-full px-1.5 text-[10px] font-medium"
              style={{ background: "hsl(var(--brand-warning) / 0.2)" }}
            >
              {reviewPill.count}
            </span>
          </button>
        )}
      </div>
    </>
  );
}
