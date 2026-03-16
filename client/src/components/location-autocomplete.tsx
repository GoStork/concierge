import { useState, useRef, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { MapPin, Loader2 } from "lucide-react";

type LocationResult = {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  display: string;
};

type Props = {
  value: { address: string; city: string; state: string; zip: string; country: string };
  onChange: (loc: { address: string; city: string; state: string; zip: string; country: string }) => void;
  placeholder?: string;
  className?: string;
  "data-testid"?: string;
};

export default function LocationAutocomplete({ value, onChange, placeholder, className, ...props }: Props) {
  const [query, setQuery] = useState(() => [value.address, value.city, value.state, value.zip].filter(Boolean).join(", "));
  const [results, setResults] = useState<LocationResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const display = [value.address, value.city, value.state, value.zip].filter(Boolean).join(", ");
    setQuery(display);
  }, [value.address, value.city, value.state, value.zip]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const search = useCallback(async (q: string) => {
    if (q.length < 3) {
      setResults([]);
      setIsOpen(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q,
        format: "json",
        addressdetails: "1",
        limit: "5",
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { "Accept-Language": "en" },
      });
      const data = await res.json();
      const mapped: LocationResult[] = data
        .filter((item: any) => item.address)
        .map((item: any) => {
          const a = item.address;
          const houseNumber = a.house_number || "";
          const road = a.road || "";
          const streetAddr = [houseNumber, road].filter(Boolean).join(" ");
          const city = a.city || a.town || a.village || a.hamlet || a.county || "";
          const state = a.state || a.region || "";
          const zip = a.postcode || "";
          const country = a.country || "";
          const isUS = a.country_code === "us";
          return {
            address: streetAddr,
            city,
            state: isUS ? state : [state, country].filter(Boolean).join(", "),
            zip,
            country,
            display: item.display_name,
          };
        });
      setResults(mapped);
      setIsOpen(mapped.length > 0);
      setHighlightIdx(-1);
    } catch {
      setResults([]);
      setIsOpen(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 400);
  };

  const selectResult = (r: LocationResult) => {
    onChange({ address: r.address, city: r.city, state: r.state, zip: r.zip, country: r.country });
    setQuery([r.address, r.city, r.state, r.zip].filter(Boolean).join(", "));
    setIsOpen(false);
    setResults([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0) {
      e.preventDefault();
      selectResult(results[highlightIdx]);
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  const handleBlur = () => {
    if (query && !isOpen) {
      const parts = query.split(",").map(s => s.trim());
      if (parts.length === 1) {
        onChange({ address: "", city: parts[0], state: "", zip: "", country: value.country || "" });
      } else if (parts.length === 2) {
        onChange({ address: "", city: parts[0], state: parts[1], zip: "", country: value.country || "" });
      } else {
        onChange({
          address: parts[0] || "",
          city: parts[1] || "",
          state: parts[2] || "",
          zip: parts[3] || "",
          country: value.country || "",
        });
      }
    }
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <Input
        value={query}
        onChange={e => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setIsOpen(true); }}
        onBlur={handleBlur}
        placeholder={placeholder || "Start typing an address..."}
        className={className}
        data-testid={props["data-testid"]}
      />
      {loading && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
      )}
      {isOpen && results.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {results.map((r, idx) => (
            <button
              key={idx}
              type="button"
              className={`w-full text-left px-3 py-2 text-sm flex items-start gap-2 hover:bg-accent ${highlightIdx === idx ? "bg-accent" : ""}`}
              onMouseDown={e => { e.preventDefault(); selectResult(r); }}
              data-testid={`location-suggestion-${idx}`}
            >
              <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="font-ui truncate">{[r.address, r.city].filter(Boolean).join(", ")}</div>
                <div className="text-xs text-muted-foreground truncate">{[r.state, r.zip].filter(Boolean).join(" ")}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
