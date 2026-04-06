import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCountryFlag } from "@/lib/country-flag";

const COUNTRIES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda",
  "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain",
  "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan",
  "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria",
  "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada",
  "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros",
  "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark",
  "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador",
  "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji",
  "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece",
  "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras",
  "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel",
  "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati",
  "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia",
  "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi",
  "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania",
  "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia",
  "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal",
  "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea",
  "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama",
  "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
  "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia",
  "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe",
  "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore",
  "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea",
  "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland",
  "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo",
  "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
  "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States",
  "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam",
  "Yemen", "Zambia", "Zimbabwe",
];

interface CountryAutocompleteInputProps {
  value: string[];
  onChange: (countries: string[]) => void;
  "data-testid"?: string;
}

export function CountryAutocompleteInput({
  value: selectedCountries,
  onChange,
  "data-testid": testId,
}: CountryAutocompleteInputProps) {
  const [inputValue, setInputValue] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const suggestions = React.useMemo(() => {
    if (!inputValue.trim()) return [];
    const query = inputValue.toLowerCase();
    return COUNTRIES.filter(
      c => c.toLowerCase().includes(query) && !selectedCountries.includes(c)
    ).slice(0, 8);
  }, [inputValue, selectedCountries]);

  React.useEffect(() => {
    setHighlightedIndex(0);
    setOpen(suggestions.length > 0);
  }, [suggestions]);

  function addCountry(country: string) {
    if (!selectedCountries.includes(country)) {
      onChange([...selectedCountries, country]);
    }
    setInputValue("");
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex(i => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && suggestions[highlightedIndex]) {
        e.preventDefault();
        addCountry(suggestions[highlightedIndex]);
        return;
      }
    }
    if ((e.key === "Enter" || e.key === ",") && inputValue.trim()) {
      e.preventDefault();
      const match = COUNTRIES.find(c => c.toLowerCase() === inputValue.trim().toLowerCase());
      if (match) {
        addCountry(match);
      } else {
        addCountry(inputValue.trim());
      }
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }

  React.useEffect(() => {
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="relative flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
            placeholder="Type a country name..."
            data-testid={testId}
            className="flex h-9 w-full rounded-[var(--container-radius)] border border-border bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          {open && suggestions.length > 0 && (
            <ul className="absolute z-50 mt-1 w-full rounded-[var(--container-radius)] border border-border bg-background shadow-md">
              {suggestions.map((country, i) => (
                <li
                  key={country}
                  className={cn(
                    "cursor-pointer px-3 py-2 text-sm flex items-center gap-2",
                    i === highlightedIndex
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-muted"
                  )}
                  onMouseDown={e => {
                    e.preventDefault();
                    addCountry(country);
                  }}
                  onMouseEnter={() => setHighlightedIndex(i)}
                >
                  {getCountryFlag(country) && <span>{getCountryFlag(country)}</span>}
                  {country}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (inputValue.trim()) {
              const match = COUNTRIES.find(c => c.toLowerCase() === inputValue.trim().toLowerCase());
              addCountry(match ?? inputValue.trim());
            }
          }}
        >
          Add
        </Button>
      </div>
      {selectedCountries.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedCountries.map((c, i) => (
            <Badge key={i} variant="outline" className="flex items-center gap-1">
              {getCountryFlag(c) && <span>{getCountryFlag(c)}</span>}
              {c}
              <button
                type="button"
                onClick={() => onChange(selectedCountries.filter((_, j) => j !== i))}
                className="ml-1 text-muted-foreground hover:text-destructive"
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

interface SingleCountryAutocompleteInputProps {
  value: string;
  onChange: (country: string) => void;
  placeholder?: string;
  "data-testid"?: string;
}

export function SingleCountryAutocompleteInput({
  value,
  onChange,
  placeholder = "Type a country name...",
  "data-testid": testId,
}: SingleCountryAutocompleteInputProps) {
  const [inputValue, setInputValue] = React.useState(value);
  const [open, setOpen] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setInputValue(value);
  }, [value]);

  const suggestions = React.useMemo(() => {
    if (!inputValue.trim()) return [];
    const query = inputValue.toLowerCase();
    if (COUNTRIES.some(c => c.toLowerCase() === query)) return [];
    return COUNTRIES.filter(c => c.toLowerCase().includes(query)).slice(0, 8);
  }, [inputValue]);

  React.useEffect(() => {
    setHighlightedIndex(0);
    setOpen(suggestions.length > 0);
  }, [suggestions]);

  function selectCountry(country: string) {
    onChange(country);
    setInputValue(country);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHighlightedIndex(i => Math.min(i + 1, suggestions.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHighlightedIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Escape") { setOpen(false); return; }
      if ((e.key === "Enter" || e.key === "Tab") && suggestions[highlightedIndex]) {
        e.preventDefault();
        selectCountry(suggestions[highlightedIndex]);
        return;
      }
    }
    if (e.key === "Enter" && inputValue.trim()) {
      e.preventDefault();
      const match = COUNTRIES.find(c => c.toLowerCase() === inputValue.trim().toLowerCase());
      selectCountry(match ?? inputValue.trim());
    }
  }

  function handleClickOutside(e: MouseEvent) {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }

  React.useEffect(() => {
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={inputValue}
        onChange={e => { setInputValue(e.target.value); if (!e.target.value) onChange(""); }}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        placeholder={placeholder}
        data-testid={testId}
        className="flex h-9 w-full rounded-[var(--container-radius)] border border-border bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-[var(--container-radius)] border border-border bg-background shadow-md">
          {suggestions.map((country, i) => (
            <li
              key={country}
              className={cn(
                "cursor-pointer px-3 py-2 text-sm flex items-center gap-2",
                i === highlightedIndex ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              )}
              onMouseDown={e => { e.preventDefault(); selectCountry(country); }}
              onMouseEnter={() => setHighlightedIndex(i)}
            >
              {getCountryFlag(country) && <span>{getCountryFlag(country)}</span>}
              {country}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
