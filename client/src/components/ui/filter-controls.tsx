/**
 * THE filter controls. One search field, one dropdown, one date pill - shared
 * by every filtered list in the product (parents, providers, billing,
 * agreements, analytics, calendar).
 *
 * Extracted from the parents filter bar, which was the only place these shapes
 * were right. Every other page had grown its own: h-8 pills next to h-9 pills,
 * native <select> arrows hard against the pill edge beside custom triggers,
 * search fields with and without an icon. Same page, four different control
 * languages. These are now the only definitions, so a shape fix lands
 * everywhere at once.
 *
 * Surface: controls sit on `bg-card`, not the page. The app background is
 * cream, and a transparent control on cream reads as a label someone forgot to
 * style rather than something you can click into.
 */
import { useState, type ReactNode } from "react";
import { CalendarIcon, Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";

/** The row every filter bar sits in. Scrolls sideways rather than wrapping. */
export function FilterRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className || ""}`}>
      {children}
    </div>
  );
}

/** Search field with the magnifier inside it. */
export function FilterSearch({ value, onChange, placeholder = "Search...", testId, className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div className={`relative w-full sm:w-auto ${className || ""}`}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full sm:w-[260px] rounded-full bg-card pl-9"
        data-testid={testId}
      />
    </div>
  );
}

/**
 * The one dropdown filter. `single` swaps checkboxes for radios and closes on
 * pick; picking the current value again clears it, so there is always a way
 * back to "all" without a separate reset row.
 */
export function FilterDropdown({
  label, options, selected, onChange, testId, single = false, renderOption, width = "w-60",
}: {
  label: string;
  options: [string, string][];
  selected: string[];
  onChange: (next: string[]) => void;
  testId?: string;
  single?: boolean;
  /** Extra mark before the option text (e.g. a service identity dot). */
  renderOption?: (key: string, text: string) => ReactNode;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = selected.length > 0;
  const summary = selected.length === 0
    ? label
    : selected.length === 1
      ? (options.find(([k]) => k === selected[0])?.[1] || selected[0])
      : `${selected.length} selected`;

  const toggle = (key: string) => {
    if (single) {
      onChange(selected[0] === key ? [] : [key]);
      setOpen(false);
      return;
    }
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={`h-9 px-3 rounded-full bg-card font-normal justify-between gap-2 shrink-0 ${active ? "border-primary text-primary" : ""}`}
          data-testid={testId}
        >
          <span className="truncate max-w-[150px]">{summary}</span>
          <ChevronDown className="w-3.5 h-3.5 opacity-60 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className={`${width} p-1.5`} align="start">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="t-helper">{label}</span>
          {active && (
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => onChange([])}
              data-testid={testId ? `${testId}-clear` : undefined}
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
                role={single ? "radio" : "checkbox"}
                aria-checked={on}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[var(--radius)] text-sm text-left hover:bg-secondary transition-colors"
                onClick={() => toggle(key)}
                data-testid={testId ? `${testId}-opt-${key}` : undefined}
              >
                <span
                  className={`w-4 h-4 border flex items-center justify-center shrink-0 ${single ? "rounded-full" : "rounded-[4px]"}`}
                  style={on
                    ? { background: "hsl(var(--primary))", borderColor: "hsl(var(--primary))" }
                    : undefined}
                >
                  {on && (single
                    ? <span className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                    : <Check className="w-3 h-3 text-primary-foreground" />)}
                </span>
                {renderOption?.(key, text)}
                <span className="truncate">{text}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Date pill. Value is the YYYY-MM-DD string the URL carries. */
export function FilterDate({ value, onChange, placeholder, testId }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={`h-9 px-3 rounded-full bg-card font-normal gap-2 shrink-0 ${value ? "border-primary text-primary" : ""}`}
          data-testid={testId}
        >
          <CalendarIcon className="w-3.5 h-3.5" />
          {value || placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          // "T00:00:00" forces local parsing. A bare "2026-08-09" is parsed as
          // UTC, so west of UTC the calendar highlighted the day BEFORE the one
          // the filter was set to.
          selected={value ? new Date(`${value}T00:00:00`) : undefined}
          onSelect={(d) => onChange(d ? toDateParam(d) : "")}
          data-testid={testId ? `calendar-${testId}` : undefined}
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

/**
 * Local-time YYYY-MM-DD. toISOString() would shift the picked day backwards for
 * anyone west of UTC, so a date filter set to "today" silently dropped today's
 * rows.
 */
export function toDateParam(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** from-inclusive start of day / to-inclusive end of day. */
export function inDateRange(iso: string | null | undefined, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

/** From/To pair - the shape most list pages want. */
export function FilterDateRange({ from, to, onFrom, onTo, testIdPrefix = "date" }: {
  from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void; testIdPrefix?: string;
}) {
  return (
    <>
      <FilterDate value={from} placeholder="From" onChange={onFrom} testId={`${testIdPrefix}-from`} />
      <FilterDate value={to} placeholder="To" onChange={onTo} testId={`${testIdPrefix}-to`} />
    </>
  );
}
