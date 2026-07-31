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
import { CalendarIcon, Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { SERVICE_LABELS, JOURNEY_STATUS_LABELS, toDateParam } from "./parent-cells";

/**
 * A checkbox list behind a trigger, so several services (or statuses) can be on
 * at once. The trigger reports the selection rather than making you open it:
 * one pick names itself, several show a count.
 */
function MultiFilter({
  label, options, selected, onChange, testId,
}: {
  label: string;
  options: [string, string][];
  selected: string[];
  onChange: (next: string[]) => void;
  testId: string;
}) {
  const active = selected.length > 0;
  const summary = selected.length === 0
    ? label
    : selected.length === 1
      ? (options.find(([k]) => k === selected[0])?.[1] || selected[0])
      : `${selected.length} selected`;

  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={`h-9 px-3 rounded-[var(--radius)] font-normal justify-between gap-2 shrink-0 ${active ? "border-primary text-primary" : ""}`}
          data-testid={testId}
        >
          <span className="truncate max-w-[150px]">{summary}</span>
          <ChevronDown className="w-3.5 h-3.5 opacity-60 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-1.5" align="start">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="t-helper">{label}</span>
          {active && (
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => onChange([])}
              data-testid={`${testId}-clear`}
            >
              Clear
            </button>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto">
          {options.map(([key, text]) => {
            const on = selected.includes(key);
            return (
              <button
                key={key}
                type="button"
                role="checkbox"
                aria-checked={on}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[var(--radius)] text-sm text-left hover:bg-secondary transition-colors"
                onClick={() => toggle(key)}
                data-testid={`${testId}-opt-${key}`}
              >
                <span
                  className="w-4 h-4 rounded-[4px] border flex items-center justify-center shrink-0"
                  style={on
                    ? { background: "hsl(var(--primary))", borderColor: "hsl(var(--primary))" }
                    : undefined}
                >
                  {on && <Check className="w-3 h-3 text-primary-foreground" />}
                </span>
                <span className="truncate">{text}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DateFilter({ value, onChange, placeholder, testId }: {
  value: string; onChange: (v: string) => void; placeholder: string; testId: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={`h-9 px-3 rounded-full font-normal gap-2 shrink-0 ${value ? "border-primary text-primary" : ""}`}
          data-testid={testId}
        >
          <CalendarIcon className="w-3.5 h-3.5" />
          {value || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value ? new Date(value) : undefined}
          onSelect={(d) => onChange(d ? toDateParam(d) : "")}
          data-testid={`calendar-${testId}`}
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

export interface ParentsFilterState {
  q: string;
  from: string;
  to: string;
  services: string[];
  statuses: string[];
  tag: string;
  owner: string;
  next: string;
}

export function ParentsFilterBar({
  state, setParam, setParams, onClear, tagVocabulary, ownerOptions, testIdPrefix,
}: {
  state: ParentsFilterState;
  /** Write one param. An empty value removes it. */
  setParam: (key: string, value: string) => void;
  /** Write several params in ONE update - successive single writes race. */
  setParams: (entries: Record<string, string>) => void;
  onClear: () => void;
  tagVocabulary: { id: string; label: string }[];
  ownerOptions: { id: string; name?: string | null }[];
  testIdPrefix: string;
}) {
  const hasActive = !!(state.q.trim() || state.from || state.to || state.services.length
    || state.statuses.length || state.tag !== "all" || state.owner !== "all" || state.next !== "all");

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
          <div className="relative">
            <Input
              placeholder="Search by name, email, or phone..."
              value={state.q}
              onChange={(e) => setParam("q", e.target.value)}
              className="h-9 w-[260px] rounded-full"
              data-testid={`${testIdPrefix}-search`}
            />
          </div>

          <DateFilter value={state.from} onChange={(v) => setParam("from", v)} placeholder="From" testId={`${testIdPrefix}-date-from`} />
          <DateFilter value={state.to} onChange={(v) => setParam("to", v)} placeholder="To" testId={`${testIdPrefix}-date-to`} />

          <MultiFilter
            label="All services"
            options={Object.entries(SERVICE_LABELS)}
            selected={state.services}
            onChange={(next) => setParam("svc", next.join(","))}
            testId={`${testIdPrefix}-service-filter`}
          />
          <MultiFilter
            label="All statuses"
            options={Object.entries(JOURNEY_STATUS_LABELS)}
            selected={state.statuses}
            onChange={(next) => setParam("status", next.join(","))}
            testId={`${testIdPrefix}-status-filter`}
          />

          <select
            value={state.tag}
            onChange={(e) => setParam("tag", e.target.value === "all" ? "" : e.target.value)}
            className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
            data-testid={`${testIdPrefix}-tag-filter`}
          >
            <option value="all">All tags</option>
            {tagVocabulary.map((t) => <option key={t.id} value={t.label}>{t.label}</option>)}
          </select>
          <select
            value={state.owner === "me" || state.owner === "unassigned" ? "all" : state.owner}
            onChange={(e) => setParam("owner", e.target.value === "all" ? "" : e.target.value)}
            className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
            data-testid={`${testIdPrefix}-owner-filter`}
          >
            <option value="all">All owners</option>
            {ownerOptions.map((o) => <option key={o.id} value={o.id}>{o.name || "Unnamed"}</option>)}
          </select>
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
              className="text-xs font-ui px-2.5 py-1 rounded-full border transition-colors"
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
      </div>
    </>
  );
}
