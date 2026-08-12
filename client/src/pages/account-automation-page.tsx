/**
 * /account/automation - the silence signal's settings (CRM Phase 9 §5).
 *
 * Per-stage "quiet after N days" counts, an on/off per service line, and
 * whether Eva's check-in step runs at all. A provider edits their own org's
 * settings; GoStork admin edits the platform defaults every org inherits.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NumberInput } from "@/components/ui/number-input";
import { SERVICE_LINE_LABELS } from "@/components/parents/parent-crm-ui";
import { JOURNEY_STAGE_ORDER, JOURNEY_STAGE_LABELS, type JourneyStageId } from "@shared/journey-ladder";
import { Loader2, MoonStar } from "lucide-react";

interface SilenceSettings {
  isAdmin: boolean;
  enabled: boolean;
  evaEnabled: boolean;
  shadowSince: string | null;
  shadowActive: boolean;
  thresholds: Record<string, number | null>;
  lineEnabled: Record<string, boolean>;
}

export default function AccountAutomationPage() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<SilenceSettings>({
    queryKey: ["/api/automation/silence"],
    queryFn: async () => {
      const res = await fetch("/api/automation/silence", { credentials: "include" });
      if (!res.ok) throw new Error("Could not load automation settings");
      return res.json();
    },
    staleTime: 0,
  });

  const [enabled, setEnabled] = useState(true);
  const [evaEnabled, setEvaEnabled] = useState(true);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setEvaEnabled(data.evaEnabled);
    setThresholds(Object.fromEntries(
      Object.entries(data.thresholds).map(([k, v]) => [k, v === null ? "" : String(v)]),
    ));
    setLines(data.lineEnabled);
    setDirty(false);
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/automation/silence", {
        enabled,
        evaEnabled,
        thresholds: Object.fromEntries(
          Object.entries(thresholds).map(([k, v]) => [k, v === "" ? null : Number(v)]),
        ),
        lineEnabled: lines,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation/silence"] });
      toast({ title: "Automation settings saved" });
      setDirty(false);
    },
    onError: (e: any) => toast({ title: "Could not save", description: e?.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-sm font-ui text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading automation settings...
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl" data-testid="automation-page">
      <div>
        <h2 className="text-xl font-heading">Silence signal</h2>
        <p className="text-sm font-ui text-muted-foreground mt-1">
          When a family goes quiet past their stage's threshold, Eva sends one warm check-in in their
          thread. If the quiet continues, a task lands on the lead owner - and both stop the instant
          the family replies.
          {data.isAdmin && " You are editing the platform defaults; each agency can override them."}
        </p>
      </div>

      {data.shadowActive && (
        <div className="rounded-[var(--radius)] border border-border bg-secondary p-3 flex items-start gap-2">
          <MoonStar className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--accent))" }} />
          <p className="text-sm font-ui">
            Eva's check-in is in its 7-day shadow period: it records who it would message, and sends
            nothing yet. The coordinator task is live already. Sending starts automatically when the
            window ends.
          </p>
        </div>
      )}

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-3">
        <label className="flex items-center justify-between gap-2 text-sm font-ui">
          <span>Silence automation</span>
          <Switch checked={enabled} onCheckedChange={(v) => { setEnabled(v); setDirty(true); }} data-testid="switch-silence-enabled" />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm font-ui">
          <span>
            Eva's check-in step
            <span className="block t-helper">Off = the coordinator task only, no message to the family.</span>
          </span>
          <Switch checked={evaEnabled} onCheckedChange={(v) => { setEvaEnabled(v); setDirty(true); }} data-testid="switch-silence-eva" />
        </label>
      </div>

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-2">
        <h3 className="text-sm font-heading">Quiet after, per stage</h3>
        <p className="t-helper">Days of quiet before the ladder starts. Leave blank for never.</p>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
          {JOURNEY_STAGE_ORDER.map((stage) => (
            <label key={stage} className="flex items-center justify-between gap-2 text-sm font-ui">
              <span>{JOURNEY_STAGE_LABELS[stage as JourneyStageId]}</span>
              <span className="flex items-center gap-1.5">
                <NumberInput
                  value={thresholds[stage] ?? ""}
                  onChange={(v) => { setThresholds((prev) => ({ ...prev, [stage]: v })); setDirty(true); }}
                  allowDecimal={false}
                  placeholder="never"
                  className="w-20 h-8 text-right"
                  data-testid={`input-threshold-${stage}`}
                />
                <span className="t-helper w-8">days</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-2">
        <h3 className="text-sm font-heading">Service lines</h3>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
          {Object.entries(SERVICE_LINE_LABELS).map(([line, label]) => (
            <label key={line} className="flex items-center justify-between gap-2 text-sm font-ui">
              <span>{label}</span>
              <Switch
                checked={lines[line] !== false}
                onCheckedChange={(v) => { setLines((prev) => ({ ...prev, [line]: v })); setDirty(true); }}
                data-testid={`switch-line-${line}`}
              />
            </label>
          ))}
        </div>
      </div>

      <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="btn-save-automation">
        {save.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
        Save settings
      </Button>
    </div>
  );
}
