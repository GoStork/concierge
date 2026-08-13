/**
 * The one persistent home for an @mention.
 *
 * A mention is not a task, so it never joins the work queue - but it should not
 * vanish with a toast either. This card lists the mentions the current user has
 * not yet cleared (server: GET /api/me/mentions, the CRM_MENTION notifications
 * still marked unseen). Opening one jumps to the exact note or task via the
 * same ?focus=<entryId> scroll the search results use, and both opening and
 * dismissing clear it. When there is nothing to show, the card renders nothing,
 * so it never adds noise to a quiet home page.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign } from "lucide-react";
import { Card } from "@/components/ui/card";
import { QueueRow, SectionHeader } from "@/components/home/home-sections";
import { useNavigate } from "react-router-dom";

interface Mention {
  id: string;
  parentUserId: string;
  parentName?: string | null;
  mentioner?: string | null;
  snippet?: string | null;
  entryId?: string | null;
}

export function MentionsCard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery<{ mentions: Mention[] }>({
    queryKey: ["/api/me/mentions"],
    queryFn: async () => {
      const res = await fetch("/api/me/mentions", { credentials: "include" });
      if (!res.ok) return { mentions: [] };
      return res.json();
    },
    // A mention is a notification, not a cached fact - always refetch on mount
    // so a page the toast deep-linked to shows the freshly cleared state.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const clear = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/me/mentions/${id}/seen`, { method: "POST", credentials: "include" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/me/mentions"] }),
  });

  const mentions = data?.mentions || [];
  if (!mentions.length) return null;

  const open = (m: Mention) => {
    clear.mutate(m.id);
    const focus = m.entryId ? `&focus=${encodeURIComponent(m.entryId)}` : "";
    navigate(`/parents/${m.parentUserId}?sec=crm${focus}`);
  };

  return (
    <Card className="p-5 space-y-3">
      <SectionHeader
        icon={<AtSign className="w-5 h-5 text-primary" />}
        title={`Mentions (${mentions.length})`}
      />
      <div className="space-y-2">
        {mentions.map((m) => (
          <QueueRow
            key={m.id}
            icon={<AtSign className="w-4 h-4" />}
            title={`${m.mentioner || "A colleague"} mentioned you`}
            detail={[m.parentName || "A family", m.snippet].filter(Boolean).join(" - ")}
            onClick={() => open(m)}
            onDismiss={() => clear.mutate(m.id)}
          />
        ))}
      </div>
    </Card>
  );
}
