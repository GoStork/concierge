import { useState } from "react";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, Plus, ShieldCheck } from "lucide-react";
import {
  INSURANCE_CARRIERS, ALL_PLANS, plansForCarrier, makeInsuranceValue, parseInsuranceValue, PLAN_SEPARATOR,
} from "@shared/insurance-data";

interface InsurancePickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  /** "multi" = clinic accepted insurance; "single" = a parent's own plan. */
  mode?: "multi" | "single";
  disabled?: boolean;
  "data-testid"?: string;
}

/**
 * Two-step carrier -> plan insurance picker (ZocDoc-style), backed by the curated
 * shared/insurance-data list. Reused for provider "accepted insurance", the admin
 * editor, and (Phase 5) the parent insurance filter.
 */
export function InsurancePicker({ value, onChange, mode = "multi", disabled, ...rest }: InsurancePickerProps) {
  const [carrier, setCarrier] = useState<string>("");
  const [plan, setPlan] = useState<string>(ALL_PLANS);
  const plans = carrier ? plansForCarrier(carrier) : [];
  const fertilityCarriers = INSURANCE_CARRIERS.filter((c) => c.fertilityBenefit);
  const medicalCarriers = INSURANCE_CARRIERS.filter((c) => !c.fertilityBenefit);

  function add() {
    if (!carrier) return;
    const v = makeInsuranceValue(carrier, plan);
    if (mode === "single") {
      onChange([v]);
      return;
    }
    if (!value.includes(v)) onChange([...value, v]);
    setPlan(ALL_PLANS); // keep carrier so several plans can be added quickly
  }

  function remove(v: string) {
    onChange(value.filter((x) => x !== v));
  }

  return (
    <div className="space-y-2" data-testid={rest["data-testid"]}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1 flex-1 min-w-[200px]">
          <label className="text-xs text-muted-foreground">Insurance carrier</label>
          <Select value={carrier} onValueChange={(c) => { setCarrier(c); setPlan(ALL_PLANS); }} disabled={disabled}>
            <SelectTrigger className="h-9" data-testid="select-insurance-carrier"><SelectValue placeholder="Select carrier" /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectGroup>
                <SelectLabel>Fertility benefits</SelectLabel>
                {fertilityCarriers.map((c) => <SelectItem key={c.carrier} value={c.carrier}>{c.carrier}</SelectItem>)}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>Medical carriers</SelectLabel>
                {medicalCarriers.map((c) => <SelectItem key={c.carrier} value={c.carrier}>{c.carrier}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 flex-1 min-w-[180px]">
          <label className="text-xs text-muted-foreground">Plan</label>
          <Select value={plan} onValueChange={setPlan} disabled={disabled || !carrier || plans.length === 0}>
            <SelectTrigger className="h-9" data-testid="select-insurance-plan"><SelectValue placeholder={ALL_PLANS} /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={ALL_PLANS}>{ALL_PLANS}</SelectItem>
              {plans.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-9 gap-1.5" onClick={add} disabled={disabled || !carrier} data-testid="button-insurance-add">
          <Plus className="w-3.5 h-3.5" /> {mode === "single" ? "Set" : "Add"}
        </Button>
      </div>

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
