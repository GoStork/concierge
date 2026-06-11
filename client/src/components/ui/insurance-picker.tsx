import { useState } from "react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, Plus, ShieldCheck, ChevronLeft, Search } from "lucide-react";
import {
  INSURANCE_CARRIERS, ALL_PLANS, PLAN_SEPARATOR, plansForCarrier, makeInsuranceValue,
  parseInsuranceValue, popularCarriers, logoUrl, type InsuranceCarrier,
} from "@shared/insurance-data";

interface InsurancePickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  /** "multi" = clinic accepted insurance; "single" = a parent's own plan. */
  mode?: "multi" | "single";
  disabled?: boolean;
  "data-testid"?: string;
}

// Optional logo.dev publishable token (client-safe) for full wordmark logos;
// falls back to the Google favicon marks in logoUrl() when unset.
const LOGODEV_TOKEN = (import.meta as any).env?.VITE_LOGODEV_TOKEN as string | undefined;

function CarrierLogo({ carrier, size = 32 }: { carrier: InsuranceCarrier; size?: number }) {
  const [errored, setErrored] = useState(false);
  const url = logoUrl(carrier.domain, LOGODEV_TOKEN);
  const initials = carrier.carrier.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  if (url && !errored) {
    return (
      <img
        src={url}
        alt=""
        style={{ width: size, height: size }}
        className="object-contain rounded bg-background shrink-0"
        onError={() => setErrored(true)}
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size }}
      className="rounded bg-secondary flex items-center justify-center text-[10px] font-ui text-muted-foreground shrink-0"
    >
      {initials}
    </div>
  );
}

/**
 * Two-step carrier -> plan insurance picker (ZocDoc-style): a Popular carriers
 * logo grid plus a searchable full list, then a plan dropdown. Backed by the
 * curated shared/insurance-data list. Reused for provider/admin "accepted
 * insurance" (multi) and the parent's own plan (single).
 */
export function InsurancePicker({ value, onChange, mode = "multi", disabled, ...rest }: InsurancePickerProps) {
  const [carrier, setCarrier] = useState<string>("");
  const [plan, setPlan] = useState<string>(ALL_PLANS);
  const [search, setSearch] = useState("");

  const carrierObj = INSURANCE_CARRIERS.find((c) => c.carrier === carrier);
  const plans = carrier ? plansForCarrier(carrier) : [];

  function pick(c: string) {
    setCarrier(c);
    setPlan(ALL_PLANS);
    setSearch("");
  }
  function add() {
    if (!carrier) return;
    const v = makeInsuranceValue(carrier, plan);
    if (mode === "single") {
      onChange([v]);
    } else if (!value.includes(v)) {
      onChange([...value, v]);
    }
    setPlan(ALL_PLANS); // keep carrier so several plans can be added quickly
  }
  function remove(v: string) {
    onChange(value.filter((x) => x !== v));
  }

  const q = search.trim().toLowerCase();
  const filtered = q ? INSURANCE_CARRIERS.filter((c) => c.carrier.toLowerCase().includes(q)) : INSURANCE_CARRIERS;

  return (
    <div className="space-y-3" data-testid={rest["data-testid"]}>
      {!carrier ? (
        <>
          {/* Popular carriers - big logo grid */}
          <div className="space-y-2">
            <p className="text-xs font-ui text-muted-foreground">Popular carriers</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {popularCarriers().map((c) => (
                <button
                  key={c.carrier}
                  type="button"
                  disabled={disabled}
                  onClick={() => pick(c.carrier)}
                  className="flex items-center gap-2.5 border border-border/50 rounded-[var(--radius)] p-2.5 text-left hover:border-primary hover:bg-secondary/30 transition-colors disabled:opacity-50"
                  data-testid={`insurance-popular-${c.carrier}`}
                >
                  <CarrierLogo carrier={c} size={36} />
                  <span className="text-sm leading-tight">{c.carrier}</span>
                </button>
              ))}
            </div>
          </div>

          {/* All carriers - searchable text list, no logos */}
          <div className="space-y-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search all carriers..."
                className="h-9 pl-8 text-sm"
                disabled={disabled}
                data-testid="insurance-search"
              />
            </div>
            <div className="max-h-48 overflow-y-auto rounded-[var(--radius)] border border-border/40 divide-y divide-border/30">
              {filtered.map((c) => (
                <button
                  key={c.carrier}
                  type="button"
                  disabled={disabled}
                  onClick={() => pick(c.carrier)}
                  className="block w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/40 transition-colors"
                >
                  {c.carrier}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">No carriers match "{search}".</p>
              )}
            </div>
          </div>
        </>
      ) : (
        /* Carrier chosen - pick the plan */
        <div className="flex flex-wrap items-end gap-2">
          <button
            type="button"
            onClick={() => setCarrier("")}
            disabled={disabled}
            className="flex items-center gap-2 border border-border/50 rounded-[var(--radius)] px-2.5 py-1.5 hover:bg-secondary/30 transition-colors"
            data-testid="insurance-change-carrier"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-muted-foreground" />
            {carrierObj && <CarrierLogo carrier={carrierObj} size={24} />}
            <span className="text-sm">{carrier}</span>
          </button>
          {plans.length > 0 && (
            <div className="space-y-1 flex-1 min-w-[160px]">
              <label className="text-xs text-muted-foreground">Plan</label>
              <Select value={plan} onValueChange={setPlan} disabled={disabled}>
                <SelectTrigger className="h-9" data-testid="select-insurance-plan"><SelectValue placeholder={ALL_PLANS} /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={ALL_PLANS}>{ALL_PLANS}</SelectItem>
                  {plans.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button type="button" variant="default" size="sm" className="h-9 gap-1.5" onClick={add} disabled={disabled} data-testid="button-insurance-add">
            <Plus className="w-3.5 h-3.5" /> {mode === "single" ? "Set" : "Add"}
          </Button>
        </div>
      )}

      {value.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {value.map((v) => {
            const parsed = parseInsuranceValue(v);
            return (
              <Badge key={v} variant="secondary" className="gap-1.5">
                <ShieldCheck className="w-3 h-3 text-[hsl(var(--brand-success))] shrink-0" />
                {parsed.plan ? `${parsed.carrier}${PLAN_SEPARATOR}${parsed.plan}` : parsed.carrier}
                {!disabled && (
                  <button type="button" onClick={() => remove(v)} className="ml-0.5 hover:text-foreground" aria-label={`Remove ${v}`}>
                    <X className="w-3 h-3" />
                  </button>
                )}
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
