/**
 * "AI Memory" list (ConciergeMemory): view/edit/delete the durable facts the
 * concierge remembers about a family across ALL chats.
 * Ported UX intent from AI-Health: full visibility kills stale memories -
 * anything wrong or outdated can be corrected or removed right here.
 *
 * Two variants, one component (never fork):
 * - Parent (default): full Card on /account/concierge, /api/my endpoints.
 * - Admin (`admin` prop): compact list for the concierge-monitor sidebar
 *   (narrow column, no Card shell), /api/admin endpoints scoped by
 *   parentAccountId. Edits are shared state - the parent sees them too.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Loader2, Pencil, Trash2, Plus, Check, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";

const KIND_LABELS: Record<string, string> = {
  PREFERENCE: "Preference",
  CONSTRAINT: "Constraint",
  GOAL: "Goal",
  FACT: "Fact",
  DECISION: "Decision",
};

export function ConciergeMemoryTab({ admin }: { admin?: { parentAccountId: string } } = {}) {
  const listUrl = admin
    ? `/api/admin/concierge-memory?parentAccountId=${encodeURIComponent(admin.parentAccountId)}`
    : "/api/my/concierge-memory";
  const itemBase = admin ? "/api/admin/concierge-memory" : "/api/my/concierge-memory";
  const queryKey = admin ? ["/api/admin/concierge-memory", admin.parentAccountId] : ["/api/my/concierge-memory"];

  const q = useQuery<any[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(listUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load memory");
      return res.json();
    },
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const save = async (id: string) => {
    if (!editText.trim()) return;
    setPending(true);
    try {
      await apiRequest("PATCH", `${itemBase}/${id}`, { text: editText.trim() });
      setEditingId(null);
      refresh();
    } finally {
      setPending(false);
    }
  };
  const remove = async (id: string) => {
    setPending(true);
    try {
      await apiRequest("DELETE", `${itemBase}/${id}`);
      refresh();
    } finally {
      setPending(false);
    }
  };
  const add = async () => {
    if (!newText.trim()) return;
    setPending(true);
    try {
      await apiRequest("POST", itemBase, {
        text: newText.trim(),
        ...(admin ? { parentAccountId: admin.parentAccountId } : {}),
      });
      setNewText("");
      setAdding(false);
      refresh();
    } finally {
      setPending(false);
    }
  };

  const items = q.data || [];

  const sourceLabel = (m: any) =>
    admin
      ? m.source === "MANUAL" ? "Added manually" : m.source === "USER_SAID" ? "Parent asked to remember" : "Extracted from chat"
      : m.source === "MANUAL" ? "Added by you" : m.source === "USER_SAID" ? "You asked to remember this" : "Noticed in conversation";

  const list = q.isLoading ? (
    <div className={admin ? "py-4 flex justify-center" : "py-10 flex justify-center"}><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
  ) : items.length === 0 ? (
    <p className={admin ? "t-helper py-2" : "t-helper py-6"}>
      {admin
        ? "No memory notes for this family yet - Eva extracts them as the conversation grows."
        : 'Nothing remembered yet. As you chat, your concierge will note the things worth carrying forward - or you can ask in any chat: "remember that we prefer morning calls."'}
    </p>
  ) : (
    <div className="divide-y">
      {items.map((m) => (
        <div key={m.id} className={`flex items-start gap-2 ${admin ? "py-2" : "py-3 gap-3"}`} data-testid={`memory-${m.id}`}>
          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-secondary text-foreground shrink-0 mt-0.5">
            {KIND_LABELS[m.kind] || "Fact"}
          </span>
          {editingId === m.id ? (
            <div className="flex-1 flex gap-2 items-center min-w-0">
              <Input value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={500} autoFocus onKeyDown={(e) => { if (e.key === "Enter") save(m.id); }} data-testid={`input-edit-${m.id}`} />
              <Button size="sm" disabled={pending || !editText.trim()} onClick={() => save(m.id)}>
                {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="w-4 h-4" /></Button>
            </div>
          ) : (
            <>
              <div className="flex-1 min-w-0">
                <p className={admin ? "text-xs text-foreground" : "text-sm text-foreground"}>{m.text}</p>
                <p className="t-helper mt-0.5">
                  {sourceLabel(m)}
                  {" · "}{new Date(m.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </p>
              </div>
              <button type="button" className="text-muted-foreground hover:text-foreground p-1" onClick={() => { setEditingId(m.id); setEditText(m.text); }} aria-label="Edit" data-testid={`btn-edit-${m.id}`}>
                <Pencil className="w-4 h-4" />
              </button>
              <button type="button" className="text-muted-foreground hover:text-destructive p-1" onClick={() => remove(m.id)} aria-label="Delete" data-testid={`btn-delete-${m.id}`}>
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );

  const addRow = adding ? (
    <div className="flex gap-2 items-center">
      <Input
        value={newText}
        onChange={(e) => setNewText(e.target.value)}
        placeholder={admin ? 'e.g. "Mentioned on our call: wants to start in the fall"' : 'e.g. "We prefer video calls in the evening"'}
        maxLength={500}
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        data-testid="input-new-memory"
      />
      <Button size="sm" disabled={pending || !newText.trim()} onClick={add} data-testid="btn-save-new-memory">
        {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setNewText(""); }}><X className="w-4 h-4" /></Button>
    </div>
  ) : null;

  if (admin) {
    return (
      <div className="space-y-2" data-testid="concierge-memory-admin">
        {!adding && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdding(true)} data-testid="btn-add-memory">
            <Plus className="w-3.5 h-3.5 mr-1" /> Add a note
          </Button>
        )}
        {addRow}
        {list}
      </div>
    );
  }

  return (
    <Card className="p-6 space-y-4" data-testid="concierge-memory-tab">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-heading flex items-center gap-2"><Brain className="w-5 h-5 text-primary" /> What your concierge remembers</h2>
          <p className="t-helper mt-1 max-w-2xl">
            Small notes your AI concierge keeps about your family across all your conversations - soft preferences,
            decisions, and context that make the guidance feel personal. You're in full control: edit or remove
            anything here, or add something you'd like remembered. Your intake answers (services, preferences,
            budget) live separately in your profile.
          </p>
        </div>
        {!adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-testid="btn-add-memory">
            <Plus className="w-4 h-4 mr-1" /> Add a note
          </Button>
        )}
      </div>
      {addRow}
      {list}
    </Card>
  );
}
