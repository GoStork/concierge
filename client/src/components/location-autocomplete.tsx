import { useState, useRef, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { MapPin, Loader2, Navigation } from "lucide-react";

type LocationResult = {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  display: string;
};

type LocationValue = { address: string; city: string; state: string; zip: string; country: string };

type Props = {
  value: LocationValue;
  onChange: (loc: LocationValue) => void;
  placeholder?: string;
  className?: string;
  variant?: "default" | "onboarding";
  showCurrentLocation?: boolean;
  autoFocus?: boolean;
  "data-testid"?: string;
};

function parseNominatimAddress(a: any) {
  const houseNumber = a.house_number || "";
  const road = a.road || "";
  const streetAddr = [houseNumber, road].filter(Boolean).join(" ");
  const city = a.city || a.town || a.village || a.hamlet || a.county || "";
  const state = a.state || a.region || "";
  const zip = a.postcode || "";
  const country = a.country || "";
  return { address: streetAddr, city, state, zip, country };
}

function buildDisplayQuery(value: LocationValue, isOnboarding: boolean): string {
  if (isOnboarding) {
    return [value.city, value.state, value.country].filter(Boolean).join(", ");
  }
  return [value.address, value.city, value.state, value.zip].filter(Boolean).join(", ");
}

export default function LocationAutocomplete({ value, onChange, placeholder, className, variant = "default", showCurrentLocation = false, autoFocus, ...props }: Props) {
  const isOnboarding = variant === "onboarding";
  const [query, setQuery] = useState(() => buildDisplayQuery(value, isOnboarding));
  const [results, setResults] = useState<LocationResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(buildDisplayQuery(value, isOnboarding));
  }, [value.address, value.city, value.state, value.zip, value.country, isOnboarding]);

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
          const parsed = parseNominatimAddress(item.address);
          return { ...parsed, display: item.display_name };
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
    setGeoError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 400);
  };

  const selectResult = (r: LocationResult) => {
    onChange({ address: r.address, city: r.city, state: r.state, zip: r.zip, country: r.country });
    setQuery(buildDisplayQuery(r, isOnboarding));
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
      if (isOnboarding) {
        onChange({
          address: "",
          city: parts[0] || "",
          state: parts[1] || "",
          zip: "",
          country: parts[2] || value.country || "",
        });
      } else {
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
    }
  };

  const [geoError, setGeoError] = useState<string | null>(null);

  const getPosition = (): Promise<GeolocationPosition> =>
    new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 600000,
      });
    });

  const handleUseCurrentLocation = async () => {
    if (!navigator.geolocation) {
      setGeoError("Location services are not available in this browser.");
      return;
    }
    setGeoLoading(true);
    setGeoError(null);
    try {
      let position: GeolocationPosition;
      try {
        position = await getPosition();
      } catch {
        position = await getPosition();
      }
      const { latitude, longitude } = position.coords;
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&addressdetails=1`,
        { headers: { "Accept-Language": "en", "User-Agent": "GoStork/1.0" } }
      );
      if (!res.ok) {
        setGeoError("Could not determine your location. Please type your city instead.");
        return;
      }
      const data = await res.json();
      if (data.address) {
        const parsed = parseNominatimAddress(data.address);
        onChange(parsed);
        setQuery(buildDisplayQuery(parsed, isOnboarding));
        setGeoError(null);
      } else {
        setGeoError("Could not determine your city. Please type it instead.");
      }
    } catch (err: any) {
      if (err?.code === 1) {
        setGeoError("Location access was denied. Please allow location access or type your city.");
      } else if (err?.code === 2) {
        setGeoError("Could not determine your location. Please type your city instead.");
      } else if (err?.code === 3) {
        setGeoError("Location request timed out. Please type your city instead.");
      } else {
        setGeoError("Could not get your location. Please type your city instead.");
      }
    } finally {
      setGeoLoading(false);
    }
  };

  const inputClasses = isOnboarding
    ? "w-full text-lg border-0 border-b-2 border-border focus:border-primary outline-none pb-3 bg-transparent placeholder:text-muted-foreground/40 transition-colors rounded-none px-0"
    : className || "";

  return (
    <div ref={containerRef} className="relative flex-1">
      <div className="relative">
        {isOnboarding ? (
          <input
            type="text"
            value={query}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (results.length > 0) setIsOpen(true); }}
            onBlur={handleBlur}
            placeholder={placeholder || "Start typing your city..."}
            className={inputClasses}
            autoFocus={autoFocus}
            data-testid={props["data-testid"]}
          />
        ) : (
          <Input
            value={query}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (results.length > 0) setIsOpen(true); }}
            onBlur={handleBlur}
            placeholder={placeholder || "Start typing an address..."}
            className={className}
            autoFocus={autoFocus}
            data-testid={props["data-testid"]}
          />
        )}
        {loading && (
          <Loader2 className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground ${isOnboarding ? "top-3 translate-y-0" : ""}`} />
        )}
      </div>

      {showCurrentLocation && (
        <>
          <button
            type="button"
            onClick={handleUseCurrentLocation}
            disabled={geoLoading}
            className="mt-4 flex items-center gap-2 text-sm text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
            data-testid="btn-use-current-location"
          >
            {geoLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Navigation className="w-4 h-4" />
            )}
            {geoLoading ? "Finding your location..." : "Use my current location"}
          </button>
          {geoError && (
            <p className="mt-2 text-destructive text-sm" data-testid="text-geo-error">{geoError}</p>
          )}
        </>
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
                <div className="font-ui truncate">
                  {isOnboarding
                    ? [r.city, r.state].filter(Boolean).join(", ")
                    : [r.address, r.city].filter(Boolean).join(", ")
                  }
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {isOnboarding
                    ? r.country
                    : [r.state, r.zip].filter(Boolean).join(" ")
                  }
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
