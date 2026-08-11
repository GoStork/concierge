/**
 * The CRM controls on a parent record: notes, tasks, lead owner.
 *
 * Everything is inline. No dialogs, no popovers for content editing - the app
 * is built with native mobile in mind, where both translate badly, and a value
 * you are editing should not be hidden behind a layer.
 *
 * Scope is the spine of this file. Every row is either GOSTORK (GoStork staff
 * only) or PROVIDER (GoStork staff plus that one org). An admin picks; a
 * provider has exactly one possible answer and is shown a locked chip rather
 * than a choice they cannot make. The server enforces all of it - nothing here
 * is load-bearing for privacy.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { OptionPills } from "@/components/ui/option-pills";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { DoctorAvatar } from "@/components/marketplace/doctor-monogram";
import { useToast } from "@/hooks/use-toast";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import type { CrmScope, ParentRecord, ProviderOrg } from "./parent-record-types";

interface ScopeChoice {
  key: string;
  scope: CrmScope;
  providerId: string | null;
  label: string;
}

/** The audiences this viewer may write to. */
function scopeChoices(record: ParentRecord, isAdmin: boolean): ScopeChoice[] {
  if (!isAdmin) {
    const org = record.providerOrgs[0];
    return [{
      key: "own",
      scope: "PROVIDER",
      providerId: record.viewer.providerId,
      label: `Visible to GoStork and ${org?.providerName || "your team"}`,
    }];
  }
  return [
    { key: "gostork", scope: "GOSTORK", providerId: null, label: "GoStork internal" },
    ...record.providerOrgs.map((o: ProviderOrg) => ({
      key: o.providerId,
      scope: "PROVIDER" as CrmScope,
      providerId: o.providerId,
      label: `Share with ${o.providerName}`,
    })),
  ];
}

export function useCrmMutation(parentUserId: string, onDone?: () => void) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ url, method, body }: { url: string; method: string; body?: any }) => {
      const res = await fetch(url, {
        method,
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.message || `Request failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/parents", parentUserId, "record"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/parents-overview"] });
      onDone?.();
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
}

// ─── Notes ──────────────────────────────────────────────────────────────────

/**
 * The note composer on its own.
 *
 * Split out of the notes feed when the record page became one activity
 * timeline: the timeline renders note cards itself, interleaved with
 * everything else that happened, so it needs the box to type in without a
 * second copy of the list underneath it.
 */
export function NoteComposer({ record, onPosted, onCancel }: {
  record: ParentRecord;
  onPosted?: () => void;
  /** Closes the composer without posting. Omit where it is always open. */
  onCancel?: () => void;
}) {
  const isAdmin = record.viewer.role === "admin";
  const choices = scopeChoices(record, isAdmin);
  const [scopeKey, setScopeKey] = useState(choices[0]?.key || "gostork");
  const [body, setBody] = useState("");
  // Remounting the editor is how it clears - it is uncontrolled by design.
  const [editorKey, setEditorKey] = useState(0);
  const mut = useCrmMutation(record.parent.id, () => { setBody(""); setEditorKey((k) => k + 1); onPosted?.(); });
  const chosen = choices.find((c) => c.key === scopeKey) || choices[0];
  const hasText = !!body.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();

  return (
    <div className="space-y-2">
      <RichTextEditor
        key={editorKey}
        onChange={setBody}
        placeholder="What should the next person to open this record know?"
        testId="input-crm-note"
      />
      {/* Scope pills sit on their own row now. The actions below them mirror
          the edit-a-note controls exactly - same order, same variants, same
          bottom-left position - so posting a new note and saving an edited one
          are the same gesture in the same place. */}
      <div className="flex items-center gap-2 flex-wrap">
        {isAdmin ? (
          <OptionPills
            // One line per pill. A provider like "Sperm Bank California |
            // Fertility Center of California" wrapped inside the rounded pill
            // and made it two rows tall with the text centred oddly. Truncating
            // here rather than in OptionPills, which is shared and has callers
            // whose labels should still wrap.
            options={choices.map((c) => ({
              value: c.key,
              label: <span className="block truncate max-w-[200px] sm:max-w-[280px]" title={c.label}>{c.label}</span>,
            }))}
            value={scopeKey}
            onChange={(v: string) => setScopeKey(v)}
            testIdPrefix="pill-note-scope"
          />
        ) : (
          // A provider has only one audience, so there is nothing to pick and
          // nothing to say - the visibility chip was removed as noise. The
          // scope still travels on the WRITE below; this was display only.
          null
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!hasText || mut.isPending}
          onClick={() => mut.mutate({
            url: `/api/parents/${record.parent.id}/notes`,
            method: "POST",
            body: { body, scope: chosen?.scope, providerId: chosen?.providerId },
          })}
          data-testid="btn-post-note"
        >
          {mut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          Post note
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} data-testid="btn-cancel-note">
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

const TASK_TYPES: [string, string][] = [["TODO", "To-do"], ["CALL", "Call"], ["EMAIL", "Email"]];
const TASK_PRIORITIES: [string, string][] = [
  ["NONE", "None"], ["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"],
];
const REMINDER_CHOICES: [string, string][] = [
  ["", "No reminder"], ["0", "At due time"], ["30", "30 minutes before"],
  ["60", "1 hour before"], ["1440", "1 day before"], ["10080", "1 week before"],
];
/** Priority is a STATUS, so it uses the status tones, not the service palette. */
const PRIORITY_TONE: Record<string, string | null> = {
  NONE: null,
  LOW: "hsl(var(--brand-success))",
  MEDIUM: "hsl(var(--brand-warning))",
  HIGH: "hsl(var(--destructive))",
};

export function taskTypeLabel(t: string): string {
  return TASK_TYPES.find(([v]) => v === t)?.[1] || "To-do";
}

/** Due date + time in ONE control pair, kept as a real instant. */
function dueParts(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Create or edit one task.
 *
 * Everything inline, no dialogs. The due date is stored as an absolute instant
 * and every surface renders it with toLocaleString, so a task set by an owner
 * in New York shows 8:00 AM to them and 5:00 AM to a coordinator in
 * California - each person reads their own clock, which is the whole point.
 */
export function TaskEditor({ record, existing, onDone, onCancel }: {
  record: ParentRecord;
  existing?: ParentRecord["crm"]["tasks"][number];
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const isAdmin = record.viewer.role === "admin";
  const choices = scopeChoices(record, isAdmin);
  const initial = existing ? new Date(existing.dueAt) : (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  })();
  const p0 = dueParts(initial);
  const [title, setTitle] = useState(existing?.title || "");
  const [notes, setNotes] = useState(existing?.notes || "");
  const [type, setType] = useState(existing?.type || "TODO");
  const [priority, setPriority] = useState(existing?.priority || "NONE");
  const [date, setDate] = useState(p0.date);
  const [time, setTime] = useState(p0.time);
  const [remind, setRemind] = useState(
    existing?.reminderMinutesBefore === null || existing?.reminderMinutesBefore === undefined
      ? "" : String(existing.reminderMinutesBefore),
  );
  const [assignee, setAssignee] = useState(existing?.assigneeUserId || "");
  const [scopeKey, setScopeKey] = useState(choices[0]?.key || "gostork");
  const chosen = choices.find((c) => c.key === scopeKey) || choices[0];
  const mut = useCrmMutation(record.parent.id, () => onDone?.());

  // Who this task can be handed to. GoStork may assign across orgs, so an
  // admin sees every staff member on the record; a provider sees their own.
  const { data: assignable } = useQuery<{ users: { id: string; name: string | null; email: string; providerName?: string | null }[] }>({
    queryKey: ["/api/parents", record.parent.id, "assignable"],
    queryFn: async () => {
      const res = await fetch(`/api/parents/${record.parent.id}/assignable`, { credentials: "include" });
      if (!res.ok) return { users: [] };
      return res.json();
    },
  });

  const quick = (days: number, hour = 9) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    const p = dueParts(d);
    setDate(p.date);
    setTime(p.time);
  };

  const save = () => {
    const dueAt = new Date(`${date}T${time || "09:00"}`);
    if (!title.trim() || isNaN(dueAt.getTime())) return;
    const payload = {
      title: title.trim(),
      notes: notes.trim() || null,
      type, priority,
      dueAt: dueAt.toISOString(),
      reminderMinutesBefore: remind === "" ? null : Number(remind),
      assigneeUserId: assignee || null,
      scope: chosen?.scope,
      providerId: chosen?.providerId,
    };
    mut.mutate(existing
      ? { url: `/api/parents/${record.parent.id}/tasks/${existing.id}`, method: "PATCH", body: payload }
      : { url: `/api/parents/${record.parent.id}/tasks`, method: "POST", body: payload });
  };

  const field = "h-9 rounded-[var(--radius)] border border-border bg-card px-2 text-sm font-ui";

  return (
    <div className="space-y-2" data-testid="task-editor">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs doing?"
        data-testid="input-task-title"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {[["Today", 0], ["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]].map(([label, d]) => (
          <button
            key={label as string}
            type="button"
            onClick={() => quick(d as number)}
            className="text-xs font-ui px-2.5 py-1 rounded-full border border-border bg-card hover:bg-secondary transition-colors"
            data-testid={`btn-task-quick-${d}`}
          >
            {label as string}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} data-testid="input-task-date" />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} data-testid="input-task-time" />
        <select value={type} onChange={(e) => setType(e.target.value)} className={field} data-testid="select-task-type">
          {TASK_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className={field} data-testid="select-task-priority">
          {TASK_PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l === "None" ? "No priority" : l}</option>)}
        </select>
        <select value={remind} onChange={(e) => setRemind(e.target.value)} className={field} data-testid="select-task-reminder">
          {REMINDER_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={field} data-testid="select-task-assignee">
          <option value="">Unassigned</option>
          {(assignable?.users || []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}{u.providerName ? ` - ${u.providerName}` : ""}
            </option>
          ))}
        </select>
      </div>
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        className="min-h-[60px] bg-card"
        data-testid="input-task-notes"
      />
      {isAdmin && choices.length > 1 && (
        <OptionPills
          options={choices.map((c) => ({
            value: c.key,
            label: <span className="block truncate max-w-[200px] sm:max-w-[280px]" title={c.label}>{c.label}</span>,
          }))}
          value={scopeKey}
          onChange={(v: string) => setScopeKey(v)}
          testIdPrefix="pill-task-scope"
        />
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!title.trim() || mut.isPending} onClick={save} data-testid="btn-save-task">
          {mut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          {existing ? "Save task" : "Create task"}
        </Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel} data-testid="btn-cancel-task">Cancel</Button>}
      </div>
    </div>
  );
}

/**
 * One open task, with its complete / edit controls.
 *
 * Completing a SYSTEM task whose artifact is still unresolved asks first -
 * INLINE, the way deleting a note does, not in a dialog. If they go ahead the
 * row records `dismissedUnresolved` so the history says what really happened:
 * marked done, work not actually finished.
 */
export function TaskRow({ record, task, onChanged }: {
  record: ParentRecord;
  task: ParentRecord["crm"]["tasks"][number];
  onChanged?: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const mut = useCrmMutation(record.parent.id, () => { setMode("view"); onChanged?.(); });
  const due = new Date(task.dueAt);
  const tone = PRIORITY_TONE[task.priority] || null;

  const complete = (force: boolean) => mut.mutate({
    url: `/api/parents/${record.parent.id}/tasks/${task.id}/complete`,
    method: "POST",
    body: { force },
  });

  if (mode === "edit") {
    return (
      <div className="rounded-[var(--radius)] border bg-card p-3">
        <TaskEditor record={record} existing={task} onDone={() => { setMode("view"); onChanged?.(); }} onCancel={() => setMode("view")} />
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius)] border bg-card p-3 space-y-1.5" data-testid={`task-${task.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{task.title}</p>
          <p className="t-helper mt-0.5">
            {taskTypeLabel(task.type)} - due {due.toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            })}
            {task.assigneeName ? ` - ${task.assigneeName}` : ""}
          </p>
        </div>
        <span className="shrink-0 inline-flex items-center gap-2">
          {tone && (
            <span className="text-[10px] uppercase tracking-wide font-medium" style={{ color: tone }}>
              {task.priority}
            </span>
          )}
          {task.overdue && (
            <span className="text-[10px] uppercase tracking-wide font-medium" style={{ color: "hsl(var(--brand-warning))" }}>
              Overdue
            </span>
          )}
        </span>
      </div>
      {task.notes && <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{task.notes}</p>}
      {mode === "confirm" ? (
        <div className="rounded-[var(--radius)] border p-2.5 space-y-1.5" style={{ background: "hsl(var(--brand-warning) / 0.1)", borderColor: "hsl(var(--brand-warning) / 0.3)" }}>
          <p className="text-xs font-medium" style={{ color: "hsl(var(--brand-warning))" }}>
            This has not actually been done yet.
          </p>
          <p className="text-xs" style={{ color: "hsl(var(--brand-warning))", opacity: 0.9 }}>
            {task.title} is still waiting. Mark it done anyway? The record will show it was
            closed without the work being completed.
          </p>
          <div className="flex items-center gap-2 pt-0.5">
            <Button size="sm" disabled={mut.isPending} onClick={() => complete(true)} data-testid={`btn-task-force-${task.id}`}>
              Mark done anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Keep it open</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="bg-card"
            disabled={mut.isPending}
            onClick={() => (task.source === "SYSTEM" ? setMode("confirm") : complete(false))}
            data-testid={`btn-task-complete-${task.id}`}
          >
            <Check className="w-3.5 h-3.5 mr-1.5" /> Done
          </Button>
          {task.deepLink && (
            <Button size="sm" variant="ghost" onClick={() => { window.location.href = task.deepLink as string; }} data-testid={`btn-task-open-${task.id}`}>
              Open
            </Button>
          )}
          {task.source !== "SYSTEM" && (
            <Button size="sm" variant="ghost" onClick={() => setMode("edit")} data-testid={`btn-task-edit-${task.id}`}>
              Edit
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Owner ──────────────────────────────────────────────────────────────────

export function OwnerPicker({ record, isAdmin, choice }: { record: ParentRecord; isAdmin: boolean; choice: ScopeChoice }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const mut = useCrmMutation(record.parent.id, () => setOpen(false));
  const current = record.crm.owners.find((o) => o.scope === choice.scope && o.providerId === choice.providerId);

  const { data: options = [] } = useQuery<any[]>({
    queryKey: ["/api/parents/crm/owner-options"],
    queryFn: async () => {
      const res = await fetch("/api/parents/crm/owner-options", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const filtered = options.filter((u) => !q || (u.name || "").toLowerCase().includes(q.toLowerCase()));

  return (
    <div data-testid={`owner-${choice.key}`}>
      {!open ? (
        // Label above, then the person and the button together on one line -
        // the button belongs beside the name it acts on, not stranded under it.
        <div className="space-y-1">
          <p className="t-micro-label">Lead owner</p>
          <div className="flex items-center gap-2 flex-wrap">
            {current ? (
              <span className="flex items-center gap-1.5 text-sm min-w-0">
                <DoctorAvatar name={current.ownerName || "?"} photoUrl={(current as any).ownerPhotoUrl} size={22} rounded="999px" />
                <span className="truncate">{current.ownerName || "Assigned"}</span>
              </span>
            ) : (
              <span className="t-helper">Unassigned</span>
            )}
            <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`btn-owner-${choice.key}`}>
              {current ? "Change" : "Assign"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 rounded-[var(--radius)] border bg-card p-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" data-testid={`input-owner-search-${choice.key}`} />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filtered.map((u) => (
              <button
                key={u.id}
                type="button"
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius)] hover:bg-secondary text-left text-sm"
                onClick={() => mut.mutate({
                  url: `/api/parents/${record.parent.id}/owner`,
                  method: "PUT",
                  body: { ownerUserId: u.id, scope: choice.scope, providerId: choice.providerId },
                })}
                data-testid={`option-owner-${u.id}`}
              >
                {/* DoctorAvatar, not DoctorMonogram: the endpoint returns
                    photoUrl and the collapsed chip already shows it, so the
                    list this chip is chosen FROM was the one place still
                    drawing initials for someone with a photo. */}
                <DoctorAvatar name={u.name || "?"} photoUrl={u.photoUrl} size={22} rounded="999px" />
                <span className="flex-1 truncate">{u.name || "Unnamed"}</span>
                {current?.ownerUserId === u.id && <Check className="w-3.5 h-3.5" />}
              </button>
            ))}
            {filtered.length === 0 && <p className="t-helper px-2">No matches.</p>}
          </div>
          <div className="flex gap-2">
            {current && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => mut.mutate({
                  url: `/api/parents/${record.parent.id}/owner`,
                  method: "PUT",
                  body: { ownerUserId: null, scope: choice.scope, providerId: choice.providerId },
                })}
              >
                Unassign
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

/**
 * The lead owner on its own, for the always-visible record header. Ownership is
 * the first thing anyone opening a record asks about, so it should not be
 * behind a collapsed section - and it is deliberately NOT repeated inside the
 * notes panel below, because two controls for one setting is what made the
 * owners filter confusing in the first place.
 */
export function ParentLeadOwner({ record }: { record: ParentRecord }) {
  const isAdmin = record.viewer.role === "admin";
  const primary = scopeChoices(record, isAdmin)[0];
  if (!primary) return null;
  return <OwnerPicker record={record} isAdmin={isAdmin} choice={primary} />;
}

/**
 * Next steps: the open tasks on this family, soonest first.
 *
 * Creating one lives on the activity toolbar beside Create Note - a task is
 * something you DO to the record, the same kind of act as writing a note, so
 * it belongs with the other actions rather than buried inside the list of
 * tasks that already exist.
 */
export function ParentTaskPanel({ record }: { record: ParentRecord }) {
  // Soonest first - a task list is read as "what is next", never as history.
  const open = [...record.crm.tasks].sort(
    (a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
  );
  if (!open.length) {
    return (
      <p className="t-helper" data-testid="tasks-empty">
        Nothing scheduled. Create a task to give this family a next step.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {open.map((t) => <TaskRow key={t.id} record={record} task={t} />)}
    </div>
  );
}

/** The task composer on its own, for the activity toolbar's Create Task. */
export function ParentTaskComposer({
  record, onDone, onCancel,
}: { record: ParentRecord; onDone: () => void; onCancel: () => void }) {
  return <TaskEditor record={record} onDone={onDone} onCancel={onCancel} />;
}
