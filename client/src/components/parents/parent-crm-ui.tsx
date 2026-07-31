/**
 * The CRM controls on a parent record: notes, next step, lead owner, tags.
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
import { DoctorAvatar, DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { useToast } from "@/hooks/use-toast";
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

function useCrmMutation(parentUserId: string, onDone?: () => void) {
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

function NotesFeed({ record, isAdmin }: { record: ParentRecord; isAdmin: boolean }) {
  const choices = scopeChoices(record, isAdmin);
  const [scopeKey, setScopeKey] = useState(choices[0]?.key || "gostork");
  const [body, setBody] = useState("");
  const mut = useCrmMutation(record.parent.id, () => setBody(""));
  const chosen = choices.find((c) => c.key === scopeKey) || choices[0];

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="space-y-2">
        <Textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What should the next person to open this record know?"
          data-testid="input-crm-note"
        />
        {isAdmin ? (
          <OptionPills
            options={choices.map((c) => ({ value: c.key, label: c.label }))}
            value={scopeKey}
            onChange={(v: string) => setScopeKey(v)}
            testIdPrefix="pill-note-scope"
          />
        ) : (
          <div className="space-y-1">
            <span
              className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
              style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
              data-testid="chip-note-scope-locked"
            >
              {chosen?.label}
            </span>
            <p className="t-helper">GoStork can see notes you write here.</p>
          </div>
        )}
        <Button
          size="sm"
          disabled={!body.trim() || mut.isPending}
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
      </div>

      {record.crm.notes.length === 0 ? (
        <div className="rounded-[var(--radius)] bg-secondary p-4">
          <p className="t-helper">No notes yet. The first note is usually why this family came in.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {record.crm.notes.map((n) => {
            const org = record.providerOrgs.find((o) => o.providerId === n.providerId);
            const internal = n.scope === "GOSTORK";
            return (
              <div key={n.id} className="rounded-[var(--radius)] border p-3 space-y-1.5" data-testid={`note-${n.id}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-xs font-ui px-2 py-0.5 rounded-full"
                    style={internal
                      ? { background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" }
                      : { background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
                  >
                    {internal ? "GoStork internal" : `Shared with ${org?.providerName || "provider"}`}
                  </span>
                  <span className="t-helper ml-auto">
                    {n.authorName || "Staff"} · {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{n.body}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Next step ──────────────────────────────────────────────────────────────

function NextStepCard({
  record, isAdmin, choice, existing,
}: { record: ParentRecord; isAdmin: boolean; choice: ScopeChoice; existing: ParentRecord["crm"]["followUps"][number] | undefined }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(existing?.body || "");
  const [dueAt, setDueAt] = useState<Date | undefined>(existing ? new Date(existing.dueAt) : undefined);
  const mut = useCrmMutation(record.parent.id, () => setEditing(false));
  const editable = isAdmin || choice.providerId === record.viewer.providerId;

  const quick = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    // End of the chosen DAY, not 5pm. A "Today" that lands at 17:00 is already
    // overdue for anyone who clicks it after five, which turns the quick-pick
    // into a way to manufacture a red chip.
    d.setHours(23, 59, 59, 999);
    setDueAt(d);
  };

  if (!editing) {
    return (
      // A bordered card on the page's own surface, like every other block on
      // this record. The cream fill made three small tinted rectangles float
      // against white for no reason - overdue is the only state that earns a
      // tint, because it means something.
      <div
        className="rounded-[var(--radius)] border bg-card p-4 space-y-2"
        style={existing?.overdue
          ? { background: "hsl(var(--brand-warning) / 0.06)", borderColor: "hsl(var(--brand-warning) / 0.4)" }
          : undefined}
        data-testid={`next-step-${choice.key}`}
      >
        <p className="t-micro-label">{isAdmin ? choice.label.replace("Share with ", "") : "Next step"}</p>
        {existing ? (
          <>
            <p className="text-sm flex items-start gap-1.5">
              {existing.overdue && <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-warning))" }} />}
              {existing.body}
            </p>
            <p className="t-helper" style={existing.overdue ? { color: "hsl(var(--brand-warning))" } : undefined}>
              Due {new Date(existing.dueAt).toLocaleDateString()}
            </p>
            {editable && (
              <div className="flex gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid={`btn-next-step-edit-${choice.key}`}>Edit</Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => mut.mutate({ url: `/api/parents/${record.parent.id}/follow-up/${existing.id}/complete`, method: "POST" })}
                  data-testid={`btn-next-step-done-${choice.key}`}
                >
                  Mark done
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="t-helper">Nothing scheduled.</p>
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid={`btn-next-step-set-${choice.key}`}>
                Set next step
              </Button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius)] border p-3 space-y-2" data-testid={`next-step-edit-${choice.key}`}>
      <Input
        value={body}
        maxLength={120}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Send the updated cost sheet"
        data-testid={`input-next-step-${choice.key}`}
      />
      <OptionPills
        options={[
          { value: "0", label: "Today" },
          { value: "1", label: "Tomorrow" },
          { value: "3", label: "+3 days" },
          { value: "7", label: "Next week" },
        ]}
        value=""
        onChange={(v: string) => quick(Number(v))}
        testIdPrefix={`pill-next-step-${choice.key}`}
      />
      {/* Inline, not inside a Popover: content being edited should not hide
          behind a layer, and this has to survive the future native apps. */}
      <CalendarPicker
        mode="single"
        selected={dueAt}
        onSelect={setDueAt}
        data-testid={`calendar-next-step-${choice.key}`}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!body.trim() || !dueAt || mut.isPending}
          onClick={() => mut.mutate({
            url: `/api/parents/${record.parent.id}/follow-up`,
            method: "PUT",
            body: { body, dueAt: dueAt?.toISOString(), scope: choice.scope, providerId: choice.providerId },
          })}
          data-testid={`btn-next-step-save-${choice.key}`}
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
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
    // A labelled value on one line, the same shape as "EMAIL foo@bar.com" and
    // "LOCATION New York" elsewhere on this record - not a block of its own.
    <div data-testid={`owner-${choice.key}`}>
      {!open ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="t-micro-label">Lead owner</span>
          {current ? (
            <span className="flex items-center gap-1.5 text-sm">
              <DoctorAvatar name={current.ownerName || "?"} photoUrl={(current as any).ownerPhotoUrl} size={22} rounded="999px" />
              {current.ownerName || "Assigned"}
            </span>
          ) : (
            <span className="t-helper">Unassigned</span>
          )}
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`btn-owner-${choice.key}`}>
            {current ? "Change" : "Assign"}
          </Button>
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
                <DoctorMonogram name={u.name || "?"} size={22} rounded="999px" />
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

// ─── Tags ───────────────────────────────────────────────────────────────────

const WARNING_TAGS = new Set(["at-risk", "overdue", "vip", "at risk"]);

function TagEditor({ record, isAdmin, choice }: { record: ParentRecord; isAdmin: boolean; choice: ScopeChoice }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const mut = useCrmMutation(record.parent.id, () => { setAdding(false); setLabel(""); });

  const { data: vocabulary = [] } = useQuery<any[]>({
    queryKey: ["/api/parents/crm/tag-vocabulary"],
    queryFn: async () => {
      const res = await fetch("/api/parents/crm/tag-vocabulary", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: adding,
    staleTime: 5 * 60_000,
  });

  const assignedIds = new Set(record.crm.tags.map((t) => t.tagId));
  const suggestions = vocabulary.filter(
    (v) => !assignedIds.has(v.id) && (!label || v.label.toLowerCase().includes(label.toLowerCase())),
  );

  async function createAndAssign() {
    const created = await fetch("/api/parents/crm/tag-vocabulary", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, scope: choice.scope, providerId: choice.providerId }),
    }).then((r) => r.json());
    if (created?.id) {
      mut.mutate({ url: `/api/parents/${record.parent.id}/tags`, method: "POST", body: { tagId: created.id } });
    }
  }

  return (
    <div className="rounded-[var(--radius)] border bg-card p-4 space-y-2" data-testid="tag-editor">
      <p className="t-micro-label">Tags</p>
      <div className="flex flex-wrap gap-1.5">
        {record.crm.tags.map((t) => {
          const warn = WARNING_TAGS.has(t.label.toLowerCase());
          return (
            <span
              key={t.id}
              className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
              style={warn
                ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }
                : { background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))" }}
              data-testid={`tag-${t.tagId}`}
            >
              {t.label}
              <button
                type="button"
                onClick={() => mut.mutate({ url: `/api/parents/${record.parent.id}/tags/${t.tagId}`, method: "DELETE" })}
                data-testid={`btn-remove-tag-${t.tagId}`}
                aria-label={`Remove ${t.label}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          );
        })}
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid="btn-add-tag">
            <Plus className="w-3 h-3 mr-1" /> Add
          </Button>
        )}
      </div>
      {adding && (
        <div className="space-y-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Tag name" data-testid="input-parent-tag" />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.slice(0, 8).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className="text-xs font-ui px-2 py-0.5 rounded-full border"
                  onClick={() => mut.mutate({ url: `/api/parents/${record.parent.id}/tags`, method: "POST", body: { tagId: v.id } })}
                  data-testid={`suggest-tag-${v.id}`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={!label.trim()} onClick={createAndAssign} data-testid="btn-create-tag">Create and add</Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
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

export function ParentCrmPanel({ record }: { record: ParentRecord }) {
  const isAdmin = record.viewer.role === "admin";
  const choices = scopeChoices(record, isAdmin);
  const primary = choices[0];

  return (
    // flex-col-reverse on mobile so the scannable state (owner / next step /
    // tags) comes first and the notes feed second.
    <div className="flex flex-col-reverse lg:grid lg:grid-cols-[1fr_320px] gap-6">
      <NotesFeed record={record} isAdmin={isAdmin} />
      <div className="space-y-3">
        {/* Lead owner lives in the record header now - see ParentLeadOwner. */}
        {choices.map((c) => (
          <NextStepCard
            key={c.key}
            record={record}
            isAdmin={isAdmin}
            choice={c}
            existing={record.crm.followUps.find((f) => f.scope === c.scope && f.providerId === c.providerId)}
          />
        ))}
        {primary && <TagEditor record={record} isAdmin={isAdmin} choice={primary} />}
      </div>
    </div>
  );
}
