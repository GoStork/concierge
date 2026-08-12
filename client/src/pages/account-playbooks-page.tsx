/**
 * /account/playbooks - stage playbooks authoring (CRM Phase 9 §3).
 *
 * "When a family reaches a stage, raise the steps that always follow."
 * A list of the org's playbooks plus GoStork starters with "Copy to my
 * agency". The editor is one page - name, service line, trigger stage, and
 * the steps with add / remove / reorder - all inline, no dialogs.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Switch } from "@/components/ui/switch";
import { ServiceTag } from "@/components/ui/service-tag";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { SelectField, SERVICE_LINE_LABELS } from "@/components/parents/parent-crm-ui";
import { JOURNEY_STAGE_ORDER, JOURNEY_STAGE_LABELS, type JourneyStageId } from "@shared/journey-ladder";
import {
  BookOpenCheck, ChevronDown, ChevronUp, Copy, Loader2, Pencil, Plus, Trash2, X,
} from "lucide-react";

const TASK_TYPES: [string, string][] = [["TODO", "To-do"], ["CALL", "Call"], ["EMAIL", "Email"]];
const TASK_PRIORITIES: [string, string][] = [
  ["NONE", "No priority"], ["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"],
];
const REMINDER_CHOICES: [string, string][] = [
  ["none", "No reminder"], ["0", "At due time"], ["30", "30 min before"],
  ["60", "1 hour before"], ["1440", "1 day before"],
];

interface StepDraft {
  id?: string;
  title: string;
  notes: string;
  type: string;
  priority: string;
  dueOffsetDays: string;
  dueTime: string;
  reminderMinutesBefore: string;
}

export interface Playbook {
  id: string;
  providerId: string | null;
  isStarter: boolean;
  name: string;
  serviceLine: string | null;
  triggerStage: string;
  isActive: boolean;
  steps: Array<{
    id: string; title: string; notes: string | null; type: string; priority: string;
    dueOffsetDays: number; dueTime: string | null; reminderMinutesBefore: number | null; sortOrder: number;
  }>;
}

const emptyStep = (): StepDraft => ({
  title: "", notes: "", type: "TODO", priority: "NONE",
  dueOffsetDays: "0", dueTime: "09:00", reminderMinutesBefore: "none",
});

const toDraftStep = (s: Playbook["steps"][number]): StepDraft => ({
  id: s.id,
  title: s.title,
  notes: s.notes || "",
  type: s.type,
  priority: s.priority,
  dueOffsetDays: String(s.dueOffsetDays ?? 0),
  dueTime: s.dueTime || "",
  reminderMinutesBefore: s.reminderMinutesBefore === null || s.reminderMinutesBefore === undefined
    ? "none" : String(s.reminderMinutesBefore),
});

function stageLabel(id: string): string {
  return JOURNEY_STAGE_LABELS[id as JourneyStageId] || id;
}

/** The plain sentence the spec asks for: what will actually happen. */
function previewSentence(name: string, serviceLine: string | null, triggerStage: string, steps: StepDraft[]): string {
  const line = serviceLine ? SERVICE_LINE_LABELS[serviceLine] || serviceLine : "any service";
  const offsets = steps.map((s) => Math.max(0, Math.round(Number(s.dueOffsetDays) || 0)));
  const lo = offsets.length ? Math.min(...offsets) : 0;
  const hi = offsets.length ? Math.max(...offsets) : 0;
  const when = lo === hi
    ? (lo === 0 ? "the same day" : `${lo} day${lo === 1 ? "" : "s"} later`)
    : `${lo}-${hi} days later`;
  const n = steps.filter((s) => s.title.trim()).length;
  return `When a family reaches ${stageLabel(triggerStage)} on ${line}, ${n === 1 ? "this task appears" : `these ${n} tasks appear`}, due ${when}, on the lead owner.`;
}

function PlaybookEditor({ existing, isAdmin, onClose }: {
  existing: Playbook | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name || "");
  const [serviceLine, setServiceLine] = useState(existing?.serviceLine || "any");
  const [triggerStage, setTriggerStage] = useState(existing?.triggerStage || "matched");
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [isStarter, setIsStarter] = useState(existing?.isStarter ?? false);
  const [steps, setSteps] = useState<StepDraft[]>(
    existing?.steps.length ? existing.steps.map(toDraftStep) : [emptyStep()],
  );

  const mut = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        serviceLine: serviceLine === "any" ? null : serviceLine,
        triggerStage,
        isActive,
        ...(isAdmin ? { isStarter } : {}),
        steps: steps
          .filter((s) => s.title.trim())
          .map((s) => ({
            id: s.id,
            title: s.title.trim(),
            notes: s.notes || null,
            type: s.type,
            priority: s.priority,
            dueOffsetDays: Math.max(0, Math.round(Number(s.dueOffsetDays) || 0)),
            dueTime: /^\d{2}:\d{2}$/.test(s.dueTime) ? s.dueTime : null,
            reminderMinutesBefore: s.reminderMinutesBefore === "none" ? null : Number(s.reminderMinutesBefore),
          })),
      };
      const res = await apiRequest(
        existing ? "PATCH" : "POST",
        existing ? `/api/playbooks/${existing.id}` : "/api/playbooks",
        payload,
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbooks"] });
      toast({ title: existing ? "Playbook saved" : "Playbook created" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Could not save playbook", description: e?.message, variant: "destructive" }),
  });

  const setStep = (i: number, patch: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const field = "h-9 rounded-[var(--radius)] border border-border bg-card pl-2 pr-2 text-sm font-ui";
  const canSave = name.trim().length > 0 && steps.some((s) => s.title.trim());

  return (
    <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-4" data-testid="playbook-editor">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-heading">{existing ? "Edit playbook" : "New playbook"}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="btn-close-playbook-editor">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='Name, e.g. "Matched - surrogacy handoff"'
          className="max-w-md"
          data-testid="input-playbook-name"
        />
        <SelectField
          value={serviceLine}
          onChange={setServiceLine}
          options={[["any", "Any service line"], ...Object.entries(SERVICE_LINE_LABELS) as [string, string][]]}
          className={field}
          testId="select-playbook-line"
        />
        <SelectField
          value={triggerStage}
          onChange={setTriggerStage}
          options={JOURNEY_STAGE_ORDER.map((id) => [id, stageLabel(id)] as [string, string])}
          className={field}
          testId="select-playbook-stage"
        />
        <label className="flex items-center gap-2 text-sm font-ui">
          <Switch checked={isActive} onCheckedChange={setIsActive} data-testid="switch-playbook-active" />
          Active
        </label>
        {isAdmin && (
          <label className="flex items-center gap-2 text-sm font-ui" title="Starters never fire; agencies copy them.">
            <Switch checked={isStarter} onCheckedChange={setIsStarter} data-testid="switch-playbook-starter" />
            Offer as GoStork starter
          </label>
        )}
      </div>

      <div className="space-y-3">
        {steps.map((s, i) => (
          <div key={s.id || `new-${i}`} className="rounded-[var(--radius)] border border-border bg-secondary/40 p-3 space-y-2" data-testid={`playbook-step-${i}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-ui text-muted-foreground w-5 text-center">{i + 1}.</span>
              <Input
                value={s.title}
                onChange={(e) => setStep(i, { title: e.target.value })}
                placeholder='Step, e.g. "Send the intended parent form"'
                data-testid={`input-step-title-${i}`}
              />
              <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} data-testid={`btn-step-up-${i}`}>
                <ChevronUp className="w-4 h-4" />
              </Button>
              <Button variant="ghost" size="sm" disabled={i === steps.length - 1} onClick={() => move(i, 1)} data-testid={`btn-step-down-${i}`}>
                <ChevronDown className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost" size="sm"
                disabled={steps.length === 1}
                onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                data-testid={`btn-step-remove-${i}`}
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
            <RichTextEditor
              initialHtml={s.notes}
              onChange={(html) => setStep(i, { notes: html })}
              placeholder="Notes (optional)"
              testId={`input-step-notes-${i}`}
            />
            <div className="flex flex-wrap items-center gap-2">
              <SelectField value={s.type} onChange={(v) => setStep(i, { type: v })} options={TASK_TYPES} className={field} testId={`select-step-type-${i}`} />
              <SelectField value={s.priority} onChange={(v) => setStep(i, { priority: v })} options={TASK_PRIORITIES} className={field} testId={`select-step-priority-${i}`} />
              <label className="flex items-center gap-1.5 text-sm font-ui text-muted-foreground">
                Due
                <NumberInput
                  value={s.dueOffsetDays}
                  onChange={(v) => setStep(i, { dueOffsetDays: v })}
                  allowDecimal={false}
                  className="w-16 h-9"
                  data-testid={`input-step-offset-${i}`}
                />
                day(s) after the stage, at
                <input
                  type="time"
                  value={s.dueTime}
                  onChange={(e) => setStep(i, { dueTime: e.target.value })}
                  className={field}
                  data-testid={`input-step-time-${i}`}
                />
              </label>
              <SelectField
                value={s.reminderMinutesBefore}
                onChange={(v) => setStep(i, { reminderMinutesBefore: v })}
                options={REMINDER_CHOICES}
                className={field}
                testId={`select-step-reminder-${i}`}
              />
            </div>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setSteps((prev) => [...prev, emptyStep()])} data-testid="btn-add-step">
          <Plus className="w-4 h-4 mr-1.5" /> Add step
        </Button>
      </div>

      <p className="text-sm font-ui text-muted-foreground italic" data-testid="playbook-preview">
        {previewSentence(name, serviceLine === "any" ? null : serviceLine, triggerStage, steps)}
      </p>

      <div className="flex items-center gap-2">
        <Button disabled={!canSave || mut.isPending} onClick={() => mut.mutate()} data-testid="btn-save-playbook">
          {mut.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
          {existing ? "Save playbook" : "Create playbook"}
        </Button>
        <Button variant="ghost" onClick={onClose} data-testid="btn-cancel-playbook">Cancel</Button>
      </div>
    </div>
  );
}

function PlaybookCard({ pb, isAdmin, onEdit }: { pb: Playbook; isAdmin: boolean; onEdit?: () => void }) {
  const { toast } = useToast();
  const readOnly = pb.isStarter && !isAdmin;

  const del = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/playbooks/${pb.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbooks"] });
      toast({ title: "Playbook deleted" });
    },
    onError: (e: any) => toast({ title: "Could not delete", description: e?.message, variant: "destructive" }),
  });
  const copy = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/playbooks/${pb.id}/copy`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbooks"] });
      toast({ title: "Copied to your agency", description: "The copy is yours to edit and is active now." });
    },
    onError: (e: any) => toast({ title: "Could not copy", description: e?.message, variant: "destructive" }),
  });
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rounded-[var(--radius)] border border-border bg-card p-3 flex flex-wrap items-center gap-2" data-testid={`playbook-card-${pb.id}`}>
      <BookOpenCheck className="w-4 h-4 text-primary shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-ui font-medium">{pb.name}</span>
          {pb.serviceLine && <ServiceTag service={SERVICE_LINE_LABELS[pb.serviceLine] || pb.serviceLine} />}
          {!pb.isActive && (
            <span className="text-xs font-ui px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">Paused</span>
          )}
        </div>
        <p className="text-xs font-ui text-muted-foreground mt-0.5">
          Fires at {stageLabel(pb.triggerStage)} · {pb.steps.length} step{pb.steps.length === 1 ? "" : "s"}
        </p>
      </div>
      {readOnly ? (
        <Button variant="outline" size="sm" disabled={copy.isPending} onClick={() => copy.mutate()} data-testid={`btn-copy-playbook-${pb.id}`}>
          {copy.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
          Copy to my agency
        </Button>
      ) : (
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onEdit} data-testid={`btn-edit-playbook-${pb.id}`}>
            <Pencil className="w-4 h-4" />
          </Button>
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" disabled={del.isPending} onClick={() => del.mutate()} data-testid={`btn-confirm-delete-playbook-${pb.id}`}>
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep</Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} data-testid={`btn-delete-playbook-${pb.id}`}>
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function AccountPlaybooksPage() {
  const [editing, setEditing] = useState<Playbook | null | "new">(null);

  const { data, isLoading } = useQuery<{ playbooks: Playbook[]; starters: Playbook[]; isAdmin: boolean }>({
    queryKey: ["/api/playbooks"],
    queryFn: async () => {
      const res = await fetch("/api/playbooks", { credentials: "include" });
      if (!res.ok) throw new Error("Could not load playbooks");
      return res.json();
    },
    staleTime: 0,
  });

  const isAdmin = !!data?.isAdmin;

  return (
    <div className="space-y-6 max-w-4xl" data-testid="playbooks-page">
      <div>
        <h2 className="text-xl font-heading">Stage playbooks</h2>
        <p className="text-sm font-ui text-muted-foreground mt-1">
          When a family reaches a stage, the steps that always follow appear as tasks on the lead owner -
          automatically, once per family.
        </p>
      </div>

      {editing !== null ? (
        <PlaybookEditor
          existing={editing === "new" ? null : editing}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
        />
      ) : (
        <Button onClick={() => setEditing("new")} data-testid="btn-new-playbook">
          <Plus className="w-4 h-4 mr-1.5" /> New playbook
        </Button>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm font-ui text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading playbooks...
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-heading text-muted-foreground">
              {isAdmin ? "GoStork playbooks" : "Your playbooks"}
            </h3>
            {(data?.playbooks || []).length === 0 && (
              <p className="text-sm font-ui text-muted-foreground">
                None yet. Create one, or copy a starter below.
              </p>
            )}
            {(data?.playbooks || []).map((pb) => (
              <PlaybookCard key={pb.id} pb={pb} isAdmin={isAdmin} onEdit={() => setEditing(pb)} />
            ))}
          </div>

          {(data?.starters || []).length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-heading text-muted-foreground">GoStork starters</h3>
              {(data?.starters || []).map((pb) => (
                <PlaybookCard key={pb.id} pb={pb} isAdmin={isAdmin} onEdit={isAdmin ? () => setEditing(pb) : undefined} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
