import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AsYouType, isValidPhoneNumber, type CountryCode } from "libphonenumber-js";
import { ChevronDown, Globe, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ALL_COUNTRIES,
  POPULAR_COUNTRIES,
  getCountryByIso,
  type PhoneCountry,
} from "@/lib/phone-countries";

export interface PhoneInputChange {
  e164: string;
  display: string;
  isValid: boolean;
  isoCode: string;
}

export interface PhoneInputProps {
  value: string;
  displayValue?: string;
  onChange: (params: PhoneInputChange) => void;
  defaultIsoCode?: string | null;
  error?: string;
  disabled?: boolean;
  placeholder?: string;
  variant?: "default" | "onboarding";
  loadingCountry?: boolean;
  "data-testid"?: string;
}

function countToDigitIndex(str: string, caret: number): number {
  let count = 0;
  for (let i = 0; i < caret && i < str.length; i++) {
    if (/\d/.test(str[i])) count++;
  }
  return count;
}

function digitIndexToCaret(str: string, digitIndex: number): number {
  if (digitIndex <= 0) return 0;
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (/\d/.test(str[i])) {
      count++;
      if (count === digitIndex) return i + 1;
    }
  }
  return str.length;
}

function formatNational(digits: string, isoCode: string | null): string {
  if (!isoCode || !digits) return digits;
  try {
    const formatter = new AsYouType(isoCode as CountryCode);
    return formatter.input(digits);
  } catch {
    return digits;
  }
}

function buildDisplay(formatted: string, country: PhoneCountry | undefined): string {
  if (!formatted) return "";
  if (!country) return formatted;
  return `${country.callingCode} ${formatted}`.trim();
}

function buildE164(digits: string, isoCode: string | null): string {
  if (!digits || !isoCode) return "";
  const country = getCountryByIso(isoCode);
  if (!country) return "";
  return `${country.callingCode}${digits}`;
}

function validate(e164: string, isoCode: string | null): boolean {
  if (!e164 || !isoCode) return false;
  try {
    return isValidPhoneNumber(e164, isoCode as CountryCode);
  } catch {
    return false;
  }
}

export function PhoneInput({
  value,
  displayValue,
  onChange,
  defaultIsoCode,
  error,
  disabled,
  placeholder,
  variant = "default",
  loadingCountry,
  "data-testid": dataTestId,
}: PhoneInputProps) {
  const isOnboarding = variant === "onboarding";
  const [isoCode, setIsoCode] = useState<string | null>(defaultIsoCode ?? null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [focused, setFocused] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const country = useMemo(() => (isoCode ? getCountryByIso(isoCode) : undefined), [isoCode]);

  const derivedDigits = useMemo(() => {
    if (!value) return "";
    if (!isoCode) return value.replace(/\D/g, "");
    const cc = getCountryByIso(isoCode)?.callingCode ?? "";
    const raw = value.startsWith(cc) ? value.slice(cc.length) : value;
    return raw.replace(/\D/g, "");
  }, [value, isoCode]);

  const [nationalDisplay, setNationalDisplay] = useState<string>(() => formatNational(derivedDigits, isoCode));

  useEffect(() => {
    if (defaultIsoCode && !isoCode) {
      setIsoCode(defaultIsoCode);
    }
  }, [defaultIsoCode, isoCode]);

  useEffect(() => {
    setNationalDisplay(formatNational(derivedDigits, isoCode));
  }, [derivedDigits, isoCode]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && searchRef.current) {
      searchRef.current.focus();
    }
    if (!isOpen) {
      setSearch("");
      setHighlightIdx(-1);
    }
  }, [isOpen]);

  const filteredPopular = useMemo(() => filterCountries(POPULAR_COUNTRIES, search), [search]);
  const filteredAll = useMemo(() => filterCountries(ALL_COUNTRIES, search), [search]);

  const flatList = useMemo(() => {
    if (search) return filteredAll;
    const popularIsos = new Set(filteredPopular.map(c => c.isoCode));
    const remaining = filteredAll.filter(c => !popularIsos.has(c.isoCode));
    return [...filteredPopular, ...remaining];
  }, [search, filteredPopular, filteredAll]);

  const emitChange = useCallback(
    (digits: string, nextIso: string | null) => {
      const e164 = buildE164(digits, nextIso);
      const country = nextIso ? getCountryByIso(nextIso) : undefined;
      const formatted = formatNational(digits, nextIso);
      const display = digits ? buildDisplay(formatted, country) : "";
      onChange({
        e164,
        display,
        isValid: validate(e164, nextIso),
        isoCode: nextIso ?? "",
      });
    },
    [onChange],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawValue = e.target.value;
    const caret = e.target.selectionStart ?? rawValue.length;
    const digitIndex = countToDigitIndex(rawValue, caret);
    const digits = rawValue.replace(/\D/g, "");
    setHasInteracted(true);

    const formatted = formatNational(digits, isoCode);
    setNationalDisplay(formatted);

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const nextCaret = digitIndexToCaret(formatted, digitIndex);
        try {
          inputRef.current.setSelectionRange(nextCaret, nextCaret);
        } catch {
          // ignore
        }
      }
    });

    emitChange(digits, isoCode);
  };

  const handleCountrySelect = (nextIso: string) => {
    setIsoCode(nextIso);
    setIsOpen(false);
    setNationalDisplay("");
    setHasInteracted(false);
    emitChange("", nextIso);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleDropdownKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, flatList.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" && highlightIdx >= 0 && flatList[highlightIdx]) {
      e.preventDefault();
      handleCountrySelect(flatList[highlightIdx].isoCode);
    }
  };

  const digits = nationalDisplay.replace(/\D/g, "");
  const e164 = buildE164(digits, isoCode);
  const isValid = validate(e164, isoCode);
  const showValidationError = hasInteracted && digits.length >= 3 && !isValid && !!isoCode;
  const externalError = error && error.trim().length > 0 ? error : null;
  const validationError = showValidationError
    ? `Please enter a valid ${country?.name ?? "phone"} phone number`
    : null;
  const errorToShow = externalError ?? validationError;
  const hasError = !!errorToShow;

  const buttonClasses = cn(
    "flex items-center gap-2 min-w-0 shrink-0 whitespace-nowrap",
    isOnboarding
      ? "text-lg border-0 border-b-2 border-border pb-3 hover:border-primary transition-colors"
      : cn(
          "h-9 px-3 rounded-[var(--container-radius)] border border-border bg-transparent text-sm",
          hasError ? "border-destructive" : "",
          disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-accent",
        ),
  );

  const inputClasses = isOnboarding
    ? cn(
        "flex-1 min-w-0 text-lg border-0 border-b-2 pb-3 bg-transparent outline-none transition-colors placeholder:text-muted-foreground/40",
        hasError ? "border-destructive focus:border-destructive" : "border-border focus:border-primary",
      )
    : undefined;

  const containerClasses = cn("relative w-full", isOnboarding ? "" : "");

  const renderCountryButtonContent = () => {
    if (loadingCountry) {
      return (
        <>
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          <span className={cn("truncate", isOnboarding ? "text-lg" : "text-sm")}>Detecting...</span>
          <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
        </>
      );
    }
    if (!country) {
      return (
        <>
          <Globe className="w-4 h-4 text-muted-foreground" />
          <span className={cn("truncate", isOnboarding ? "text-lg" : "text-sm")}>Select country</span>
          <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
        </>
      );
    }
    return (
      <>
        <span className={isOnboarding ? "text-xl" : "text-base"} aria-hidden="true">{country.flag}</span>
        <span className={cn("truncate", isOnboarding ? "text-lg" : "text-sm")}>{country.callingCode}</span>
        <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
      </>
    );
  };

  const phonePlaceholder = placeholder ?? country?.exampleFormat ?? "";

  return (
    <div className={containerClasses} ref={containerRef}>
      <div className={cn("flex items-stretch gap-2", isOnboarding ? "items-end" : "items-stretch")}>
        <button
          type="button"
          className={buttonClasses}
          onClick={() => !disabled && setIsOpen(v => !v)}
          disabled={disabled || loadingCountry}
          data-testid={dataTestId ? `${dataTestId}-country-button` : "phone-country-button"}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          {renderCountryButtonContent()}
        </button>

        {isOnboarding ? (
          <input
            ref={inputRef}
            type="tel"
            value={nationalDisplay}
            onChange={handleInputChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={phonePlaceholder}
            disabled={disabled}
            className={inputClasses}
            data-testid={dataTestId ? `${dataTestId}-input` : "phone-input"}
            autoComplete="tel"
          />
        ) : (
          <Input
            ref={inputRef}
            type="tel"
            value={nationalDisplay}
            onChange={handleInputChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={phonePlaceholder}
            disabled={disabled}
            className={cn("flex-1", hasError ? "border-destructive focus-visible:ring-destructive" : "")}
            data-testid={dataTestId ? `${dataTestId}-input` : "phone-input"}
            autoComplete="tel"
          />
        )}
      </div>

      {!isoCode && focused && !loadingCountry && (
        <p className="mt-2 text-xs text-muted-foreground">Please select a country first</p>
      )}

      {errorToShow && (
        <p className="mt-2 text-xs text-destructive" data-testid={dataTestId ? `${dataTestId}-error` : "phone-error"}>
          {errorToShow}
        </p>
      )}

      {isOpen && (
        <div
          className="absolute z-50 top-full left-0 mt-1 bg-popover border border-border rounded-[var(--radius)] shadow-lg min-w-[320px] max-h-[300px] overflow-hidden flex flex-col"
          role="listbox"
        >
          <div className="p-2 border-b border-border bg-background">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setHighlightIdx(e.target.value ? 0 : -1); }}
                onKeyDown={handleDropdownKeyDown}
                placeholder="Search country or code"
                className="w-full h-8 pl-8 pr-2 text-sm bg-transparent border border-border rounded-[var(--radius)] outline-none focus:ring-2 focus:ring-ring"
                data-testid="phone-country-search"
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {!search && filteredPopular.length > 0 && (
              <>
                <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Popular
                </div>
                {filteredPopular.map((c, idx) => (
                  <CountryRow
                    key={`pop-${c.isoCode}`}
                    country={c}
                    isSelected={c.isoCode === isoCode}
                    isHighlighted={highlightIdx === idx}
                    onSelect={() => handleCountrySelect(c.isoCode)}
                  />
                ))}
                <hr className="my-1 border-border" />
              </>
            )}
            {(() => {
              const rest = search ? filteredAll : filteredAll.filter(c => !POPULAR_COUNTRIES.some(p => p.isoCode === c.isoCode));
              const offset = search ? 0 : filteredPopular.length;
              return rest.map((c, idx) => (
                <CountryRow
                  key={c.isoCode}
                  country={c}
                  isSelected={c.isoCode === isoCode}
                  isHighlighted={highlightIdx === offset + idx}
                  onSelect={() => handleCountrySelect(c.isoCode)}
                />
              ));
            })()}
            {flatList.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">No countries found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function filterCountries(list: PhoneCountry[], query: string): PhoneCountry[] {
  if (!query) return list;
  const q = query.trim().toLowerCase();
  const digitsOnly = q.replace(/\D/g, "");
  return list.filter(c => {
    if (c.name.toLowerCase().includes(q)) return true;
    if (c.isoCode.toLowerCase().includes(q)) return true;
    if (digitsOnly) {
      const ccDigits = c.callingCode.replace(/\D/g, "");
      if (ccDigits.startsWith(digitsOnly) || digitsOnly.startsWith(ccDigits)) return true;
    }
    return false;
  });
}

interface CountryRowProps {
  country: PhoneCountry;
  isSelected: boolean;
  isHighlighted: boolean;
  onSelect: () => void;
}

function CountryRow({ country, isSelected, isHighlighted, onSelect }: CountryRowProps) {
  return (
    <button
      type="button"
      onMouseDown={e => { e.preventDefault(); onSelect(); }}
      className={cn(
        "w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors",
        isSelected ? "bg-primary/10 text-primary" : isHighlighted ? "bg-accent" : "hover:bg-accent",
      )}
      role="option"
      aria-selected={isSelected}
      data-testid={`phone-country-${country.isoCode.toLowerCase()}`}
    >
      <span className="text-base shrink-0" aria-hidden="true">{country.flag}</span>
      <span className="flex-1 truncate">{country.name}</span>
      <span className="text-muted-foreground shrink-0">{country.callingCode}</span>
    </button>
  );
}
