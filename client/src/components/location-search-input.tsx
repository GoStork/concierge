import { useCallback, useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatLocationDisplay } from "@/lib/format-location";
import { cn } from "@/lib/utils";

export interface LocationSuggestion {
  /** Display label, e.g. "Boston, Massachusetts, USA". */
  label: string;
  /** Most-specific value to store, e.g. "Boston". */
  commit: string;
}

/**
 * Debounced Nominatim/OSM city-state-country autocomplete. This is the single
 * source of truth for location suggestions across the app - the admin Providers
 * filter, the marketplace location filter (desktop popover + mobile drawer), and
 * the marketplace inline location filter all share it so behaviour is identical
 * everywhere.
 */
export function useLocationSuggestions(debounceMs = 350) {
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const runSearch = useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q,
        format: "json",
        addressdetails: "1",
        limit: "5",
        "accept-language": "en",
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { "Accept-Language": "en" },
      });
      const data = await res.json();
      const mapped: LocationSuggestion[] = (data || [])
        .filter((item: any) => item.address)
        .map((item: any) => {
          const a = item.address;
          const city = a.city || a.town || a.village || a.hamlet || a.county || "";
          const state = a.state || a.region || "";
          const country = a.country || "";
          const rawLabel = [city, state, country].filter(Boolean).join(", ");
          const label = formatLocationDisplay(rawLabel) || rawLabel;
          // Filters store a single string; commit the most-specific non-empty
          // match (city, then state, then country).
          const commit = city || state || country || rawLabel;
          return { label, commit };
        })
        .filter((s: LocationSuggestion) => s.label);
      // Nominatim returns several geographic entries (country, ISO entity,
      // admin boundary) that collapse to the same display label after our
      // city/state/country reduction - dedupe by label, keeping the first.
      const seen = new Set<string>();
      setSuggestions(
        mapped.filter((s) => {
          if (seen.has(s.label)) return false;
          seen.add(s.label);
          return true;
        }),
      );
    } catch {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const search = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => runSearch(q), debounceMs);
    },
    [runSearch, debounceMs],
  );

  const clear = useCallback(() => setSuggestions([]), []);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  return { suggestions, loading, search, clear };
}

export interface LocationSearchInputProps {
  value: string;
  /** Fires on every keystroke (free-text typing is always allowed). */
  onValueChange: (value: string) => void;
  /** Fires when a suggestion is picked, or Enter is pressed. */
  onSelect: (commit: string, label: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Adds data-vaul-no-drag so the input works inside a vaul Drawer. */
  noDrag?: boolean;
  /** Absolute-positioned overlay dropdown instead of pushing content down. */
  overlayDropdown?: boolean;
  inputClassName?: string;
  testId?: string;
  /** Test id for each suggestion; defaults to `${testId}-suggestion-${i}`. */
  suggestionTestId?: (index: number) => string;
}

/**
 * A single-line location filter input with shared Nominatim autocomplete.
 * Purely presentational - each call site wires its own commit behaviour via
 * `onSelect` (Redux dispatch, URL param, chip list, etc.).
 */
export function LocationSearchInput({
  value,
  onValueChange,
  onSelect,
  placeholder = "City, state, or country",
  autoFocus,
  noDrag,
  overlayDropdown,
  inputClassName,
  testId,
  suggestionTestId,
}: LocationSearchInputProps) {
  const { suggestions, loading, search, clear } = useLocationSuggestions();
  const dragProps = noDrag ? { "data-vaul-no-drag": "" } : {};
  const suggestionId = suggestionTestId ?? ((i: number) => (testId ? `${testId}-suggestion-${i}` : undefined));

  const pick = (s: LocationSuggestion) => {
    onSelect(s.commit, s.label);
    clear();
  };

  return (
    <div className="relative" {...dragProps}>
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          {...dragProps}
          autoFocus={autoFocus}
          className={cn("pl-9", inputClassName)}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            onValueChange(v);
            search(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (suggestions[0]) pick(suggestions[0]);
              else if (value.trim()) {
                onSelect(value.trim(), value.trim());
                clear();
              }
            }
          }}
          data-testid={testId}
        />
      </div>
      {(suggestions.length > 0 || loading) && (
        <div
          className={cn(
            overlayDropdown
              ? "absolute left-0 right-0 top-full mt-1 z-20 bg-card border border-border rounded-[var(--radius)] shadow-lg max-h-64 overflow-y-auto"
              : "mt-2 border rounded-md bg-background shadow-sm max-h-60 overflow-y-auto",
          )}
          {...dragProps}
          data-testid="location-suggestions"
        >
          {loading && suggestions.length === 0 && (
            <div className="px-3 py-2 text-sm font-ui text-muted-foreground">Searching...</div>
          )}
          {suggestions.map((s, i) => (
            <button
              key={`${s.label}-${i}`}
              type="button"
              className="w-full text-left px-3 py-2 text-sm font-ui hover:bg-muted active:bg-muted flex items-center gap-2"
              onClick={() => pick(s)}
              data-testid={suggestionId(i)}
            >
              <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-foreground">{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
