/**
 * "AI Memory" account tab (parents): view/edit/delete the durable facts the
 * concierge remembers about the family across ALL chats (ConciergeMemory).
 * Ported UX intent from AI-Health: full visibility kills stale memories -
 * anything wrong or outdated can be corrected or removed right here.
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

export function ConciergeMemoryTab() {
  const q = useQuery<any[]>({
    queryKey: ["/api/my/concierge-memory"],
    queryFn: async () => {
      const res = await fetch("/api/my/concierge-memory", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load memory");
      return res.json();
    },
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/my/concierge-memory"] });

  const save = async (id: string) => {
    if (!editText.trim()) return;
    setPending(true);
    try {
      await apiRequest("PATCH", `/api/my/concierge-memory/${id}`, { text: editText.trim() });
      setEditingId(null);
      refresh();
    } finally {
      setPending(false);
    }
  };
  const remove = async (id: string) => {
    setPending(true);
    try {
      await apiRequest("DELETE", `/api/my/concierge-memory/${id}`);
      refresh();
    } finally {
      setPending(false);
    }
  };
  const add = async () => {
    if (!newText.trim()) return;
    setPending(true);
    try {
      await apiRequest("POST", "/api/my/concierge-memory", { text: newText.trim() });
      setNewText("");
      setAdding(false);
      refresh();
    } finally {
      setPending(false);
    }
  };

  const items = q.data || [];

  return (
    <Card className="p-6 space-y-4" data-testid="concierge-memory-tab">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-heading flex items-center gap-2"><Brain className="w-5 h-5 text-primary" /> What your concierge remembers</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
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

      {adding && (
        <div className="flex gap-2 items-center">
          <Input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder='e.g. "We prefer video calls in the evening"'
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
      )}

      {q.isLoading ? (
        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6">
          Nothing remembered yet. As you chat, your concierge will note the things worth carrying forward - or you
          can ask in any chat: "remember that we prefer morning calls."
        </p>
      ) : (
        <div className="divide-y">
          {items.map((m) => (
            <div key={m.id} className="py-3 flex items-start gap-3" data-testid={`memory-${m.id}`}>
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-secondary text-foreground shrink-0 mt-0.5">
                {KIND_LABELS[m.kind] || "Fact"}
              </span>
              {editingId === m.id ? (
                <div className="flex-1 flex gap-2 items-center">
                  <Input value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={500} autoFocus onKeyDown={(e) => { if (e.key === "Enter") save(m.id); }} data-testid={`input-edit-${m.id}`} />
                  <Button size="sm" disabled={pending || !editText.trim()} onClick={() => save(m.id)}>
                    {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="w-4 h-4" /></Button>
                </div>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground">{m.text}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {m.source === "MANUAL" ? "Added by you" : m.source === "USER_SAID" ? "You asked to remember this" : "Noticed in conversation"}
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
      )}
    </Card>
  );
}
