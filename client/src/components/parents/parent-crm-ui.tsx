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
import { AlertTriangle, Check, ExternalLink, Loader2, MessageSquare, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionPills } from "@/components/ui/option-pills";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { DoctorAvatar, DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ActivityBody } from "./parent-cells";
import { ServiceTag } from "@/components/ui/service-tag";
import { RichTextEditor, isRichNoteHtml } from "@/components/ui/rich-text-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CrmScope, ParentRecord, ProviderOrg } from "./parent-record-types";

/** The record's service lines, in the vocabulary the scope filter uses. */
export const SERVICE_LINE_LABELS: Record<string, string> = {
  surrogacy: "Surrogacy",
  egg_donation: "Egg Donation",
  sperm_donation: "Sperm Donation",
  ivf: "IVF",
  legal: "Legal",
};

/**
 * Which line a new note or task should start on.
 *
 * The filter you are looking through is the strongest signal - file it where
 * you are working. Failing that, a coordinator who covers exactly one line has
 * only one answer, and a family with only one line likewise. Anything else is
 * a real choice and stays empty until it is made.
 */
export function defaultServiceLine(record: ParentRecord, activeLine?: string, lines?: string[]): string {
  if (activeLine && activeLine !== "all") return activeLine;
  const mine = record.viewer.serviceLines;
  if (mine?.length === 1) return mine[0];
  const options = pickerServiceLines(lines, record.viewer.serviceLines);
  return options.length === 1 ? options[0] : "";
}

/**
 * The lines the picker offers.
 *
 * These come from the page's UNFILTERED view of the family. Deriving them from
 * the record the composer is handed would offer only the line you are already
 * looking through - and filing a note against a different one is exactly what
 * you would open the picker to do.
 */
export function pickerServiceLines(lines?: string[], viewerLines?: string[] | null): string[] {
  const all = Object.keys(SERVICE_LINE_LABELS);
  const known = (lines || []).filter((l) => all.includes(l));
  if (known.length) return known;
  // Nothing filed for this family yet: offer the lines the VIEWER covers
  // rather than every line the platform has. Only a viewer who covers
  // everything - an admin, a provider admin - sees the full list, which is
  // the same rule the Activity filter follows.
  const mine = (viewerLines || []).filter((l) => all.includes(l));
  return mine.length ? mine : all;
}

/** The picker itself - one control, both composers. */
export function ServiceLineSelect({ value, onChange, lines, viewerLines, className, testId }: {
  value: string;
  onChange: (v: string) => void;
  /** The family's lines, from the page's unfiltered view. */
  lines?: string[];
  /** The lines this viewer covers, for a family with nothing filed yet. */
  viewerLines?: string[] | null;
  className?: string;
  testId?: string;
}) {
  return (
    <SelectField
      value={value}
      onChange={onChange}
      placeholder="Which service?"
      options={pickerServiceLines(lines, viewerLines).map((l) => [l, SERVICE_LINE_LABELS[l]] as [string, string])}
      className={className}
      testId={testId}
    />
  );
}

/**
 * The app's own dropdown, in the shape the task editor needs.
 *
 * These were native selects, which is fine on a desktop and wrong on a phone:
 * iOS answers a <select> with its own full-width dark wheel, so picking a
 * priority left GoStork entirely. The rest of the product uses this dropdown -
 * the same one behind every filter - so the editor uses it too.
 *
 * Values are plain strings and never empty: Radix reserves the empty value for
 * "nothing chosen", which is what `placeholder` is for.
 */
export function SelectField({ value, onChange, options, placeholder, className, testId }: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  placeholder?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className={cn("w-auto gap-1.5 bg-card px-2.5", className)} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

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
export function NoteComposer({ record, activeLine, serviceLines, onPosted, onCancel }: {
  record: ParentRecord;
  /** The line being viewed, which is where a new note files itself. */
  activeLine?: string;
  /** Every line this family has, unfiltered - the picker's options. */
  serviceLines?: string[];
  onPosted?: () => void;
  /** Closes the composer without posting. Omit where it is always open. */
  onCancel?: () => void;
}) {
  const isAdmin = record.viewer.role === "admin";
  const choices = scopeChoices(record, isAdmin);
  const [scopeKey, setScopeKey] = useState(choices[0]?.key || "gostork");
  const [body, setBody] = useState("");
  const [serviceLine, setServiceLine] = useState(defaultServiceLine(record, activeLine, serviceLines));
  // #4 Log a call: a note with a kind. CALL reveals outcome + duration; any
  // non-NOTE reveals "when did this happen".
  const [kind, setKind] = useState<"NOTE" | "CALL" | "EMAIL" | "MEETING">("NOTE");
  const [outcome, setOutcome] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  // Same split date + time inputs the task composer uses (not the combined
  // datetime-local, which is a different, uglier native widget).
  const [occurredDate, setOccurredDate] = useState("");
  const [occurredTime, setOccurredTime] = useState("");
  const occurredAtIso = occurredDate ? new Date(`${occurredDate}T${occurredTime || "09:00"}`).toISOString() : "";
  // Remounting the editor is how it clears - it is uncontrolled by design.
  const [editorKey, setEditorKey] = useState(0);
  const mut = useCrmMutation(record.parent.id, () => {
    setBody(""); setEditorKey((k) => k + 1); setKind("NOTE"); setOutcome(""); setDurationMinutes(""); setOccurredDate(""); setOccurredTime("");
    onPosted?.();
  });
  const chosen = choices.find((c) => c.key === scopeKey) || choices[0];
  const hasText = !!body.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();

  return (
    <div className="space-y-2">
      <RichTextEditor
        key={editorKey}
        onChange={setBody}
        placeholder="What should the next person to open this record know? Type @ to mention a colleague."
        testId="input-crm-note"
        mentionSource={async () => {
          const params = new URLSearchParams({ scope: chosen?.scope || "GOSTORK", ...(chosen?.providerId ? { providerId: chosen.providerId } : {}) });
          const res = await fetch(`/api/parents/${record.parent.id}/mentionable?${params}`, { credentials: "include" });
          const d = await res.json();
          return (d.users || []).map((u: any) => ({ id: u.id, name: u.name || "Unnamed" }));
        }}
      />
      {/* Scope pills sit on their own row now. The actions below them mirror
          the edit-a-note controls exactly - same order, same variants, same
          bottom-left position - so posting a new note and saving an edited one
          are the same gesture in the same place. */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Which line the note is about - the same question the task composer
            asks, and the same reason: the record filters by it. */}
        <ServiceLineSelect
          value={serviceLine}
          onChange={setServiceLine}
          lines={serviceLines}
          viewerLines={record.viewer.serviceLines}
          className="h-9 rounded-[var(--radius)] border border-border bg-card px-2 text-sm font-ui"
          testId="select-note-service"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as any)}
          className="h-9 rounded-[var(--radius)] border border-border bg-card px-2 text-sm font-ui"
          data-testid="select-note-kind"
        >
          <option value="NOTE">Note</option>
          <option value="CALL">Call</option>
          <option value="EMAIL">Email</option>
          <option value="MEETING">Meeting</option>
        </select>
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
      {/* Log-a-call detail: outcome + duration for a call, "when" for anything
          that isn't a plain note (you log yesterday's call today). */}
      {kind !== "NOTE" && (
        <div className="flex items-center gap-2 flex-wrap">
          {kind === "CALL" && (
            <>
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                className="h-9 rounded-[var(--radius)] border border-border bg-card px-2 text-sm font-ui"
                data-testid="select-note-outcome"
              >
                <option value="">Outcome…</option>
                <option value="reached">Reached</option>
                <option value="voicemail">Voicemail</option>
                <option value="no_answer">No answer</option>
                <option value="rescheduled">Rescheduled</option>
              </select>
              <input
                type="number" min={0} placeholder="min"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(e.target.value)}
                className="h-9 w-20 rounded-[var(--radius)] border border-border bg-card px-2 text-sm font-ui"
                data-testid="input-note-duration"
              />
            </>
          )}
          <input
            type="date"
            value={occurredDate}
            onChange={(e) => setOccurredDate(e.target.value)}
            className="h-9 rounded-[var(--radius)] border border-border bg-card px-2 text-sm font-ui"
            data-testid="input-note-occurred-date"
          />
          <input
            type="time"
            value={occurredTime}
            onChange={(e) => setOccurredTime(e.target.value)}
            className="h-9 rounded-[var(--radius)] border border-border bg-card px-2 text-sm font-ui"
            data-testid="input-note-occurred-time"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!hasText || !serviceLine || mut.isPending}
          onClick={() => mut.mutate({
            url: `/api/parents/${record.parent.id}/notes`,
            method: "POST",
            body: {
              body, serviceLine, scope: chosen?.scope, providerId: chosen?.providerId,
              kind,
              ...(kind === "CALL" ? { outcome: outcome || undefined, durationMinutes: durationMinutes ? Number(durationMinutes) : undefined } : {}),
              ...(kind !== "NOTE" && occurredAtIso ? { occurredAt: occurredAtIso } : {}),
            },
          })}
          data-testid="btn-post-note"
        >
          {mut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          {kind === "NOTE" ? "Post note" : `Log ${kind.toLowerCase()}`}
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

export function taskPriorityLabel(p: string): string {
  return TASK_PRIORITIES.find(([v]) => v === p)?.[1] || "";
}

/** view | edit | confirm - hoisted so a host card can own the state. */
export type TaskMode = "view" | "edit" | "confirm";

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
export function TaskEditor({ record, existing, activeLine, serviceLines, onDone, onCancel }: {
  record: ParentRecord;
  existing?: ParentRecord["crm"]["tasks"][number];
  /** The line being viewed, which is where a new task files itself. */
  activeLine?: string;
  /** Every line this family has, unfiltered - the picker's options. */
  serviceLines?: string[];
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
  // Somebody owns every task. A new one starts with whoever is creating it
  // rather than in an "Unassigned" pile that no queue ever surfaces.
  const [serviceLine, setServiceLine] = useState(
    existing?.serviceLine || defaultServiceLine(record, activeLine, serviceLines),
  );
  // Remounting is how the uncontrolled editor clears after a save.
  const [editorKey] = useState(0);
  const [assignee, setAssignee] = useState(
    existing?.assigneeUserId
      || (existing?.assigneeName && !existing?.assigneeUserId ? "keep" : "")
      || record.viewer.userId
      || "",
  );
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

  /** What a quick-pick resolves to, so the pill can show it is the one chosen. */
  const quickParts = (days: number, hour = 9) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return dueParts(d);
  };
  const quick = (days: number) => {
    const p = quickParts(days);
    setDate(p.date);
    setTime(p.time);
  };

  const save = () => {
    const dueAt = new Date(`${date}T${time || "09:00"}`);
    // A task belongs to a line of work. Nothing is filed nowhere.
    if (!title.trim() || !serviceLine || isNaN(dueAt.getTime())) return;
    const payload = {
      title: title.trim(),
      notes: notes.trim() || null,
      type, priority,
      serviceLine,
      dueAt: dueAt.toISOString(),
      reminderMinutesBefore: remind === "" ? null : Number(remind),
      // "keep" means the name it already wears - do not reassign it.
      assigneeUserId: assignee === "keep" ? undefined : (assignee || null),
      scope: chosen?.scope,
      providerId: chosen?.providerId,
    };
    mut.mutate(existing
      ? { url: `/api/parents/${record.parent.id}/tasks/${existing.id}`, method: "PATCH", body: payload }
      : { url: `/api/parents/${record.parent.id}/tasks`, method: "POST", body: payload });
  };

  const field = "h-9 rounded-[var(--radius)] border border-border bg-card pl-2 pr-2 text-sm font-ui";

  return (
    <div className="space-y-2" data-testid="task-editor">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs doing?"
        data-testid="input-task-title"
      />
      {/* What the task IS - its subject, then its words - reads first and
          together. The scheduling controls are settings ABOUT that, so they
          come after it rather than splitting it in half. */}
      {/* The same editor a note gets. A task's notes are notes - bold, lists,
          links and attachments are as useful under "call her back" as they are
          on the record's own timeline. */}
      <RichTextEditor
        key={editorKey}
        initialHtml={existing?.notes || ""}
        onChange={setNotes}
        placeholder="Notes (optional)"
        testId="input-task-notes"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {([["Today", 0], ["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]] as [string, number][]).map(([label, d]) => {
          // Selected when the date AND time still match what this pill sets -
          // pick Tomorrow, then edit the time, and it stops claiming to be
          // Tomorrow-at-nine, because it no longer is.
          const p = quickParts(d);
          const on = date === p.date && time === p.time;
          return (
            <button
              key={label}
              type="button"
              onClick={() => quick(d)}
              className={cn(
                "text-xs font-ui px-2.5 py-1 rounded-full border transition-colors",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card hover:bg-secondary",
              )}
              aria-pressed={on}
              data-testid={`btn-task-quick-${d}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} data-testid="input-task-date" />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} data-testid="input-task-time" />
        <ServiceLineSelect
          value={serviceLine}
          onChange={setServiceLine}
          lines={serviceLines}
          viewerLines={record.viewer.serviceLines}
          className={field}
          testId="select-task-service"
        />
        <SelectField value={type} onChange={setType} options={TASK_TYPES} className={field} testId="select-task-type" />
        <SelectField
          value={priority}
          onChange={setPriority}
          options={TASK_PRIORITIES.map(([v, l]) => [v, l === "None" ? "No priority" : l] as [string, string])}
          className={field}
          testId="select-task-priority"
        />
        <SelectField
          // "" is a real choice here (no reminder) but not a legal dropdown
          // value, so it travels as a word and converts back on the way out.
          value={remind === "" ? "none" : remind}
          onChange={(v) => setRemind(v === "none" ? "" : v)}
          options={REMINDER_CHOICES.map(([v, l]) => [v === "" ? "none" : v, l] as [string, string])}
          className={field}
          testId="select-task-reminder"
        />
        <SelectField
          value={assignee}
          onChange={setAssignee}
          placeholder="Assign to"
          options={[
            // A task that came in wearing a name we cannot offer back (the
            // family, on work that is theirs) keeps it rather than silently
            // changing hands.
            ...(existing?.assigneeName && !existing?.assigneeUserId
              ? [["keep", existing.assigneeName] as [string, string]] : []),
            ...(assignable?.users || []).map((u) => [
              u.id,
              `${u.name || u.email}${u.providerName ? ` - ${u.providerName}` : ""}`,
            ] as [string, string]),
          ]}
          className={field}
          testId="select-task-assignee"
        />
      </div>
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
        <Button size="sm" disabled={!title.trim() || !serviceLine || mut.isPending} onClick={save} data-testid="btn-save-task">
          {mut.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          {existing ? "Save task" : "Create task"}
        </Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel} data-testid="btn-cancel-task">Cancel</Button>}
      </div>
    </div>
  );
}

/**
 * What the deep link on a task actually opens, so the button can say so.
 *
 * "Open" told you nothing: the same word took you to a chat, an agreement or
 * the reviews page. Naming the destination - with the same icon pairing the
 * interested-profiles rail uses - means the button is readable before you
 * press it.
 */
export function taskLinkTarget(href: string): { label: string; chat: boolean } {
  if (href.startsWith("/chat")) return { label: "Open chat", chat: true };
  if (href.startsWith("/agreements")) return { label: "Open agreement", chat: false };
  if (href.startsWith("/invoices")) return { label: "Open invoice", chat: false };
  if (href.startsWith("/performance")) return { label: "Open reviews", chat: false };
  return { label: "Open", chat: false };
}

/**
 * The chips that describe a task: what kind of thing it is, when it is due,
 * whose it is, how urgent.
 *
 * One fact per chip rather than a single grey sentence - "Call - due Aug 12,
 * 9:00 AM - Jered Mercer" made four separate answers read as one run-on, and
 * the urgent one was in a different corner of the card entirely.
 */
export function TaskChips({ task }: { task: ParentRecord["crm"]["tasks"][number] }) {
  const due = new Date(task.dueAt);
  const tone = PRIORITY_TONE[task.priority] || null;
  // Tighter on a phone so all the facts stay on one line: the chips shrink,
  // the date goes numeric and the assignee goes first-name. None of that costs
  // anything on a desktop, where there is room for the long forms.
  const chip = "text-[11px] sm:text-xs font-ui px-1.5 sm:px-2 py-0.5 rounded-full whitespace-nowrap";
  const finished = task.status !== "OPEN";
  // A finished task is not overdue, whatever its due date says - the deadline
  // stopped mattering the moment the work was done.
  const late = task.overdue && !finished;
  const time = { hour: "numeric", minute: "2-digit" } as const;
  const longDate = due.toLocaleString(undefined, { month: "short", day: "numeric", ...time });
  const shortDate = due.toLocaleString(undefined, { month: "numeric", day: "numeric", ...time });
  const firstName = (task.assigneeName || "").split(" ")[0];

  /**
   * The row reads who, by when, what it is about, how urgent - and last, how
   * it ended.
   *
   * The colours deliberately avoid the service palette: those six MEAN a
   * service - --accent is literally --service-surrogacy and --primary is a
   * shade off --service-ivf - so a chip wearing one says "surrogacy" whatever
   * its text reads. Kind and date take the neutrals, and the person takes a
   * face instead of a colour, which cannot collide with a palette at all.
   */
  return (
    <div className="flex flex-wrap items-center gap-1 sm:gap-1.5" data-testid={`task-chips-${task.id}`}>
      {task.assigneeName && (
        <span className={cn(chip, "inline-flex items-center gap-1.5 border pl-1")}>
          <DoctorAvatar
            name={task.assigneeName}
            photoUrl={task.assigneePhotoUrl || null}
            size={16}
            rounded="9999px"
          />
          <span className="sm:hidden">{firstName}</span>
          <span className="hidden sm:inline">{task.assigneeName}</span>
        </span>
      )}
      <span
        className={cn(chip, "inline-flex items-center gap-1")}
        style={late
          ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }
          : { background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}
      >
        {/* No "Due": a date on a task is its due date, and the word was the
            longest thing in the chip. Late still says so, because that is the
            part you would otherwise have to work out. */}
        {late && <AlertTriangle className="w-3 h-3" />}
        {late ? "Overdue " : ""}
        <span className="sm:hidden">{shortDate}</span>
        <span className="hidden sm:inline">{longDate}</span>
      </span>
      {/* The line it belongs to, in the platform's own per-service colour - the
          same tag the tables and the Interested In row use. */}
      {task.serviceLine && <ServiceTag service={SERVICE_LINE_LABELS[task.serviceLine]} />}
      <span className={chip} style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}>
        {taskTypeLabel(task.type)}
      </span>
      {/* Priority sits WITH the others rather than in the far corner: it is one
          more fact about the task, and reading it meant crossing the card. */}
      {tone && (
        <span className={chip} style={{ background: `color-mix(in srgb, ${tone} 15%, transparent)`, color: tone }}>
          {taskPriorityLabel(task.priority)}
        </span>
      )}
      {finished && (
        <span
          className={cn(chip, "inline-flex items-center gap-1")}
          style={task.dismissedUnresolved
            ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }
            : { background: "hsl(var(--brand-success) / 0.15)", color: "hsl(var(--brand-success))" }}
        >
          {task.dismissedUnresolved ? <AlertTriangle className="w-3 h-3" /> : <Check className="w-3 h-3" />}
          {task.dismissedUnresolved ? "Marked done - work not finished" : "Done"}
        </span>
      )}
    </div>
  );
}

/**
 * A task's insides: chips, its note, and the controls - without any card
 * chrome, so the activity timeline can host it inside an entry card and the
 * Next step view can show the same thing.
 *
 * Completing a SYSTEM task whose artifact is still unresolved asks first -
 * INLINE, the way deleting a note does, not in a dialog. If they go ahead the
 * row records `dismissedUnresolved` so the history says what really happened:
 * marked done, work not actually finished.
 */
export function TaskCardBody({ record, task, mode, setMode, serviceLines, onChanged, readOnly }: {
  record: ParentRecord;
  task: ParentRecord["crm"]["tasks"][number];
  mode: TaskMode;
  setMode: (m: TaskMode) => void;
  /** The family's lines, so editing offers what creating offers. */
  serviceLines?: string[];
  onChanged?: () => void;
  /** The Next step view shows the same task; acting on it happens on its card. */
  readOnly?: boolean;
}) {
  const mut = useCrmMutation(record.parent.id, () => { setMode("view"); onChanged?.(); });
  /**
   * Work that is the FAMILY's, not the org's. Closing it is still allowed -
   * agreements get signed on paper, deals move offline, and a queue with no
   * way out is a queue that lies forever - but the question has to say whose
   * work it is, because "mark it done" here means "stop tracking whether they
   * did it", which is a different thing from having done it yourself.
   */
  const waitingOnParent = task.source === "SYSTEM"
    && !!task.systemKey?.startsWith("agreement:")
    && !task.assigneeUserId;

  const complete = (force: boolean) => mut.mutate({
    url: `/api/parents/${record.parent.id}/tasks/${task.id}/complete`,
    method: "POST",
    body: { force },
  });

  if (mode === "edit") {
    return (
      <TaskEditor
        record={record}
        existing={task}
        serviceLines={serviceLines}
        onDone={() => { setMode("view"); onChanged?.(); }}
        onCancel={() => setMode("view")}
      />
    );
  }

  return (
    <div className="space-y-1.5">
      {/* Subject, then the task's own words, then the facts about it - the same
          order the composer asks for them in, and the same reason: what the
          task IS reads as one thought, rather than being split in half by
          its type, date, assignee and priority. */}
      {task.notes && (
        <ActivityBody testId={`task-notes-${task.id}`}>
          {isRichNoteHtml(task.notes) ? (
            <div
              className="[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:underline [&_a]:text-primary [&_img]:max-w-full [&_img]:rounded-[var(--radius)] [&_img]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:pl-3"
              // Sanitized server-side on write and on read - see note-html.ts.
              dangerouslySetInnerHTML={{ __html: task.notes }}
            />
          ) : (
            <span className="whitespace-pre-wrap">{task.notes}</span>
          )}
        </ActivityBody>
      )}
      <TaskChips task={task} />
      {readOnly || task.status !== "OPEN" ? (
        // Finished: the link to the artifact is still worth having, the
        // controls for doing the work are not.
        task.status !== "OPEN" && (task.deepLink || task.chatSessionId) ? (
          <div className="flex items-center gap-2">
            {task.deepLink && <TaskOpenLink task={task} />}
            {task.chatSessionId && !task.deepLink?.startsWith("/chat") && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { window.location.href = `/chat/${record.parent.id}/${task.chatSessionId}`; }}
                data-testid={`btn-task-open-chat-${task.id}`}
              >
                <MessageSquare className="w-3.5 h-3.5 mr-1.5" /> Open chat
              </Button>
            )}
          </div>
        ) : null
      ) : mode === "confirm" ? (
        <div className="rounded-[var(--radius)] border p-2.5 space-y-1.5" style={{ background: "hsl(var(--brand-warning) / 0.1)", borderColor: "hsl(var(--brand-warning) / 0.3)" }}>
          <p className="text-xs font-medium" style={{ color: "hsl(var(--brand-warning))" }}>
            {waitingOnParent
              ? `${task.assigneeName || "The family"} has not signed this yet.`
              : "This has not actually been done yet."}
          </p>
          <p className="text-xs" style={{ color: "hsl(var(--brand-warning))", opacity: 0.9 }}>
            {waitingOnParent
              ? "Closing it stops GoStork tracking the signature - it will not come back when they sign. Only do this if it was handled another way. The record will say it was closed unsigned."
              : `${task.title} is still waiting. Mark it done anyway? The record will show it was closed without the work being completed.`}
          </p>
          <div className="flex items-center gap-2 pt-0.5">
            <Button size="sm" disabled={mut.isPending} onClick={() => complete(true)} data-testid={`btn-task-force-${task.id}`}>
              {waitingOnParent ? "Stop tracking it" : "Mark done anyway"}
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
          {task.deepLink && <TaskOpenLink task={task} />}
          {/* Its conversation, when the artifact link points somewhere else -
              an agreement task opens the agreement AND the thread it was sent
              from, beside Done where a task keeps its actions. */}
          {task.chatSessionId && !task.deepLink?.startsWith("/chat") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { window.location.href = `/chat/${record.parent.id}/${task.chatSessionId}`; }}
              data-testid={`btn-task-open-chat-${task.id}`}
            >
              <MessageSquare className="w-3.5 h-3.5 mr-1.5" /> Open chat
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The task's link to wherever its work actually happens. */
function TaskOpenLink({ task }: { task: ParentRecord["crm"]["tasks"][number] }) {
  const target = taskLinkTarget(task.deepLink as string);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => { window.location.href = task.deepLink as string; }}
      data-testid={`btn-task-open-${task.id}`}
    >
      {target.chat
        ? <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
        : <ExternalLink className="w-3.5 h-3.5 mr-1.5" />}
      {target.label}
    </Button>
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

/** The task composer on its own, for the activity toolbar's Create Task. */
export function ParentTaskComposer({
  record, activeLine, serviceLines, onDone, onCancel,
}: {
  record: ParentRecord; activeLine?: string; serviceLines?: string[];
  onDone: () => void; onCancel: () => void;
}) {
  return (
    <TaskEditor
      record={record}
      activeLine={activeLine}
      serviceLines={serviceLines}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}
