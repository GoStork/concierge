import { useState } from "react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { X, Plus, ShieldCheck, ChevronLeft, Search } from "lucide-react";
import {
  INSURANCE_CARRIERS, ALL_PLANS, plansForCarrier, makeInsuranceValue,
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
  const [checked, setChecked] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const carrierObj = INSURANCE_CARRIERS.find((c) => c.carrier === carrier);
  const plans = carrier ? plansForCarrier(carrier) : [];

  function pick(c: string) {
    setCarrier(c);
    setPlan(ALL_PLANS);
    setSearch("");
    // Pre-check the plans already accepted for this carrier (edit-in-place).
    setChecked(
      value
        .filter((v) => parseInsuranceValue(v).carrier === c)
        .map((v) => parseInsuranceValue(v).plan ?? ALL_PLANS),
    );
  }

  function toggleChecked(p: string) {
    setChecked((prev) => {
      if (p === ALL_PLANS) return prev.includes(ALL_PLANS) ? [] : [ALL_PLANS];
      return prev.includes(p)
        ? prev.filter((x) => x !== p)
        : [...prev.filter((x) => x !== ALL_PLANS), p];
    });
  }

  // multi: replace this carrier's entries with all currently-checked plans.
  function addSelected() {
    if (!carrier) return;
    const newValues = checked.includes(ALL_PLANS)
      ? [carrier]
      : checked.map((p) => makeInsuranceValue(carrier, p));
    const others = value.filter((v) => parseInsuranceValue(v).carrier !== carrier);
    onChange([...others, ...newValues]);
    setCarrier("");
    setChecked([]);
  }

  // single (parent): one carrier + plan.
  function setSingle() {
    if (!carrier) return;
    onChange([makeInsuranceValue(carrier, plan)]);
    setCarrier("");
  }

  function removeCarrier(c: string) {
    onChange(value.filter((v) => parseInsuranceValue(v).carrier !== c));
  }

  // Group the selected values by carrier for the summary cards below.
  const grouped = new Map<string, string[]>();
  for (const v of value) {
    const { carrier: c, plan: p } = parseInsuranceValue(v);
    grouped.set(c, [...(grouped.get(c) || []), p ?? ALL_PLANS]);
  }

  const q = search.trim().toLowerCase();
  const filtered = q ? INSURANCE_CARRIERS.filter((c) => c.carrier.toLowerCase().includes(q)) : INSURANCE_CARRIERS;

  return (
    <div className="space-y-3" data-testid={rest["data-testid"]}>
      {/* Selected insurances - compact bubbles at the top */}
      {grouped.size > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[...grouped.entries()].map(([c, planList]) => {
            const cObj = INSURANCE_CARRIERS.find((x) => x.carrier === c);
            const isAll = planList.includes(ALL_PLANS) || planList.length === 0;
            const summaryShort = isAll ? "All plans" : planList.length === 1 ? planList[0] : `${planList.length} plans`;
            const summaryFull = isAll ? "All plans" : planList.join(", ");
            const editing = carrier === c;
            return (
              <div
                key={c}
                title={`${c} - ${summaryFull}`}
                className={`inline-flex items-center gap-1.5 rounded-full border pl-1.5 pr-1 py-0.5 max-w-full ${editing ? "border-primary bg-secondary/40" : "border-border/50 bg-secondary/20"}`}
                data-testid={`insurance-card-${c}`}
              >
                {cObj ? <CarrierLogo carrier={cObj} size={18} /> : <ShieldCheck className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />}
                <button type="button" onClick={() => pick(c)} disabled={disabled} className="text-xs text-left truncate max-w-[220px]" title="Click to edit plans">
                  <span className="font-ui">{c}</span>
                  <span className="text-muted-foreground"> · {summaryShort}</span>
                </button>
                {!disabled && (
                  <button type="button" onClick={() => removeCarrier(c)} className="text-muted-foreground hover:text-foreground shrink-0 p-0.5" aria-label={`Remove ${c}`}>
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!carrier ? (
        <>
          {/* Search at the top */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search for insurance..."
              className="h-9 pl-8 text-sm"
              disabled={disabled}
              data-testid="insurance-search"
            />
          </div>

          {/* Popular carriers - big logo grid (hidden while searching) */}
          {!search.trim() && (
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
          )}

          {/* All carriers - text list, no logos */}
          <div className="space-y-1">
            {!search.trim() && <p className="text-xs font-ui text-muted-foreground">All carriers</p>}
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
        /* Carrier chosen */
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => { setCarrier(""); setChecked([]); }}
            disabled={disabled}
            className="flex items-center gap-2 border border-border/50 rounded-[var(--radius)] px-2.5 py-1.5 hover:bg-secondary/30 transition-colors"
            data-testid="insurance-change-carrier"
          >
            <ChevronLeft className="w-3.5 h-3.5 text-muted-foreground" />
            {carrierObj && <CarrierLogo carrier={carrierObj} size={24} />}
            <span className="text-sm">{carrier}</span>
            <span className="text-xs text-muted-foreground">· change</span>
          </button>

          {plans.length === 0 ? (
            <Button
              type="button" size="sm" className="h-9 gap-1.5" disabled={disabled} data-testid="button-insurance-add"
              onClick={() => {
                const others = value.filter((v) => parseInsuranceValue(v).carrier !== carrier);
                onChange(mode === "single" ? [carrier] : [...others, carrier]);
                setCarrier(""); setChecked([]);
              }}
            >
              <Plus className="w-3.5 h-3.5" /> {mode === "single" ? "Set" : "Add"}
            </Button>
          ) : mode === "single" ? (
            <div className="flex flex-wrap items-end gap-2">
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
              <Button type="button" size="sm" className="h-9 gap-1.5" onClick={setSingle} disabled={disabled} data-testid="button-insurance-add">
                <Plus className="w-3.5 h-3.5" /> Set
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Select the plans you accept:</p>
              <div className="max-h-52 overflow-y-auto rounded-[var(--radius)] border border-border/40 p-2.5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox checked={checked.includes(ALL_PLANS)} onCheckedChange={() => toggleChecked(ALL_PLANS)} disabled={disabled} data-testid="checkbox-plan-all" />
                  <span className="font-ui">All plans</span>
                </label>
                {plans.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={checked.includes(p)}
                      onCheckedChange={() => toggleChecked(p)}
                      disabled={disabled || checked.includes(ALL_PLANS)}
                      data-testid={`checkbox-plan-${p}`}
                    />
                    <span className={checked.includes(ALL_PLANS) ? "text-muted-foreground" : ""}>{p}</span>
                  </label>
                ))}
              </div>
              <Button type="button" size="sm" className="h-9 gap-1.5" onClick={addSelected} disabled={disabled} data-testid="button-insurance-add">
                <Plus className="w-3.5 h-3.5" /> Add{checked.length > 0 ? ` (${checked.includes(ALL_PLANS) ? "all plans" : checked.length})` : ""}
              </Button>
            </>
          )}
        </div>
      )}

    </div>
  );
}
