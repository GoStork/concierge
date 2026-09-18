import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

// The booker's timezone for a booking calendar: one line naming the zone the
// times are shown in, with a Change control that opens a searchable list
// inline (no popover - see CLAUDE.md "No dialogs/modals/popups"). Shared by
// the chat's inline calendar and the public /book/:slug page, which used to
// have a picker while chat could only read the zone.

export function utcOffsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value?.replace("GMT", "UTC") || "";
  } catch {
    return "";
  }
}

export function timezoneLabel(tz: string): string {
  const offset = utcOffsetLabel(tz);
  return `${tz.replace(/_/g, " ")}${offset ? ` (${offset})` : ""}`;
}

const ALL_ZONES: string[] = (() => {
  try {
    return (Intl as any).supportedValuesOf("timeZone") as string[];
  } catch {
    return [];
  }
})();

export function TimezonePicker({ value, onChange, idPrefix = "tz" }: { value: string; onChange: (tz: string) => void; idPrefix?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "_");
    if (!q) return ALL_ZONES;
    return ALL_ZONES.filter((tz) => tz.toLowerCase().includes(q) || utcOffsetLabel(tz).toLowerCase().includes(q.replace(/_/g, "")));
  }, [query]);
  const listId = `${idPrefix}-list`;
  const searchId = `${idPrefix}-search`;

  return (
    <div className="space-y-2">
      <p className="t-helper text-center" data-testid="text-booking-timezone">
        Times shown in {timezoneLabel(value)}
        {ALL_ZONES.length > 0 && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={listId}
              className="inline-flex items-center gap-0.5 min-h-6 font-medium text-primary hover:underline"
              data-testid="button-change-timezone"
            >
              {open ? "Done" : "Change"}
              {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </>
        )}
      </p>
      {open && (
        <div className="rounded-[var(--radius)] border bg-card p-2 space-y-2">
          <label htmlFor={searchId} className="sr-only">Search time zones</label>
          <input
            id={searchId}
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by city or region"
            className="w-full h-10 rounded-[var(--radius)] border border-border bg-transparent px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="input-booker-timezone-search"
          />
          <ul id={listId} role="listbox" aria-label="Time zones" className="max-h-56 overflow-auto">
            {matches.length === 0 && <li className="t-helper px-2 py-2">No time zone matches "{query}".</li>}
            {matches.map((tz) => {
              const selected = tz === value;
              return (
                <li key={tz} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => { onChange(tz); setOpen(false); setQuery(""); }}
                    className={`w-full min-h-10 flex items-center gap-2 px-2 rounded-[var(--radius)] text-left text-sm hover:bg-muted ${selected ? "font-semibold" : ""}`}
                  >
                    <Check className={`w-4 h-4 shrink-0 text-primary ${selected ? "opacity-100" : "opacity-0"}`} />
                    {timezoneLabel(tz)}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
