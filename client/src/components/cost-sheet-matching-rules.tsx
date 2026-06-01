import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2, Save, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Phase 1: AI cost-sheet auto-selection metadata editor. Renders inside the
// provider Costs tab. The matching rules drive the Phase 2 auto-draft - the
// AI picks the highest-specificity matching ProviderCostSheet when a parent
// books a consultation. AND-combined: every rule must match.

export type MatchingRule = {
  field: string;
  operator: "=" | "contains" | "in";
  value: unknown;
};

export interface CostSheetMatchingRulesProps {
  sheetId: string;
  initial: {
    category?: string | null;
    description?: string | null;
    matchingRules?: MatchingRule[] | null;
  };
  onSaved?: () => void;
}

// IntendedParentProfile fields the AI knows about. Keep this list in sync
// with prisma/schema.prisma's IntendedParentProfile model.
const IP_PROFILE_FIELDS = [
  "journeyStage",
  "interestedServices",
  "isFirstIvf",
  "eggSource",
  "spermSource",
  "carrier",
  "hasEmbryos",
  "embryoCount",
  "embryosTested",
  "needsClinic",
  "needsEggDonor",
  "needsSurrogate",
  "surrogateCountries",
  "surrogateBudget",
  "surrogateMedPrefs",
  "donorPreferences",
  "donorEthnicity",
  "donorEyeColor",
  "donorHairColor",
  "donorHeight",
  "donorEducation",
  "spermDonorType",
  "clinicPriority",
  "currentClinicName",
  "currentAgencyName",
  "currentAttorneyName",
  "detectedLegalNeeds",
] as const;

const OPERATORS: Array<{ value: MatchingRule["operator"]; label: string; hint: string }> = [
  { value: "=", label: "equals", hint: "field exactly equals value" },
  { value: "contains", label: "contains", hint: "array field contains value (or text contains substring)" },
  { value: "in", label: "in", hint: "field value is one of comma-separated values" },
];

export function CostSheetMatchingRules({ sheetId, initial, onSaved }: CostSheetMatchingRulesProps) {
  const { toast } = useToast();
  const [category, setCategory] = useState<string>(initial.category ?? "");
  const [description, setDescription] = useState<string>(initial.description ?? "");
  const [rules, setRules] = useState<MatchingRule[]>(initial.matchingRules ?? []);

  const addRule = () => {
    setRules(prev => [...prev, { field: IP_PROFILE_FIELDS[0], operator: "=", value: "" }]);
  };

  const removeRule = (idx: number) => {
    setRules(prev => prev.filter((_, i) => i !== idx));
  };

  const updateRule = (idx: number, patch: Partial<MatchingRule>) => {
    setRules(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      // For "in" operator, split the value by comma into a string[] at save time.
      const normalised: MatchingRule[] = rules.map(r => {
        if (r.operator === "in" && typeof r.value === "string") {
          return {
            ...r,
            value: r.value
              .split(",")
              .map(s => s.trim())
              .filter(Boolean),
          };
        }
        return r;
      });
      return apiRequest("PATCH", `/api/costs/sheet/${sheetId}/matching`, {
        category: category.trim() || null,
        description: description.trim() || null,
        matchingRules: normalised,
      });
    },
    onSuccess: () => {
      toast({ title: "Matching rules saved", description: "The AI will use these when picking a cost sheet for new parents." });
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider"] });
      onSaved?.();
    },
    onError: (err: any) => {
      toast({ title: "Failed to save", description: err?.message || "Try again or contact support.", variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4 rounded-[var(--radius)] border border-border bg-card p-4 text-card-foreground">
      <div className="space-y-1">
        <h4 className="font-semibold text-sm" style={{ fontFamily: "var(--font-display)" }}>
          Auto-matching rules
        </h4>
        <p className="text-xs text-muted-foreground">
          When a parent books a consultation, the AI picks the highest-specificity cost sheet whose rules ALL match the parent's profile. Leave blank to opt out of auto-selection.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">Category</label>
          <Input
            placeholder="e.g. Surrogacy - International - Colombia"
            value={category}
            onChange={e => setCategory(e.target.value)}
            data-testid="input-cost-sheet-category"
          />
          <p className="text-[11px] text-muted-foreground">A short human-readable label shown to admins.</p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground">Description</label>
          <Textarea
            placeholder="Notes for the AI: when should this cost sheet apply?"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={2}
            data-testid="textarea-cost-sheet-description"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">Rules (all must match)</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addRule}
            data-testid="btn-add-matching-rule"
            className="h-7 gap-1 text-xs"
          >
            <Plus className="h-3 w-3" />
            Add rule
          </Button>
        </div>

        {rules.length === 0 ? (
          <div className="rounded-[var(--radius)] bg-secondary px-3 py-4 text-center text-xs text-muted-foreground">
            No rules yet. Add one to start auto-selecting this cost sheet.
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map((rule, idx) => {
              const opMeta = OPERATORS.find(o => o.value === rule.operator);
              return (
                <div
                  key={idx}
                  className="grid grid-cols-1 gap-2 rounded-[var(--radius)] border border-border bg-background p-2 sm:grid-cols-[1fr_140px_1fr_auto]"
                  data-testid={`matching-rule-${idx}`}
                >
                  <Select value={rule.field} onValueChange={v => updateRule(idx, { field: v })}>
                    <SelectTrigger className="h-9 text-xs" data-testid={`select-rule-field-${idx}`}>
                      <SelectValue placeholder="Field" />
                    </SelectTrigger>
                    <SelectContent>
                      {IP_PROFILE_FIELDS.map(f => (
                        <SelectItem key={f} value={f} className="text-xs">
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Select
                    value={rule.operator}
                    onValueChange={v => updateRule(idx, { operator: v as MatchingRule["operator"] })}
                  >
                    <SelectTrigger className="h-9 text-xs" data-testid={`select-rule-operator-${idx}`}>
                      <SelectValue placeholder="Operator" />
                    </SelectTrigger>
                    <SelectContent>
                      {OPERATORS.map(o => (
                        <SelectItem key={o.value} value={o.value} className="text-xs">
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    placeholder={rule.operator === "in" ? "comma-separated values" : "value"}
                    value={typeof rule.value === "string" ? rule.value : Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value ?? "")}
                    onChange={e => updateRule(idx, { value: e.target.value })}
                    className="h-9 text-xs"
                    data-testid={`input-rule-value-${idx}`}
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRule(idx)}
                    aria-label="Remove rule"
                    className="h-9 w-9 p-0 text-muted-foreground hover:text-foreground"
                    data-testid={`btn-remove-rule-${idx}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>

                  {opMeta && (
                    <p className="col-span-full text-[11px] text-muted-foreground">{opMeta.hint}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          size="sm"
          className="gap-1.5"
          data-testid="btn-save-matching-rules"
        >
          {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save matching rules
        </Button>
      </div>
    </div>
  );
}
