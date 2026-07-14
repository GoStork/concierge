import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Flag, EyeOff, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { StarDisplay } from "@/components/reviews/reviews-ui";

/**
 * Phase 8 admin review queue (/admin/reviews). Reviews auto-publish after AI
 * screening; this page is the human backstop - filter by flagged / private /
 * low-rating, remove or restore. Filter state lives in the URL.
 */
export default function AdminReviewsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("filter") || "all";
  const setFilter = (f: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("filter", f);
    setSearchParams(next, { replace: true });
  };

  const query = (() => {
    if (filter === "flagged") return "?flagged=true";
    if (filter === "private") return "?visibility=PRIVATE_FEEDBACK";
    if (filter === "low") return "?maxRating=2";
    if (filter === "removed") return "?status=REJECTED";
    return "";
  })();

  const q = useQuery<any[]>({
    queryKey: ["/api/admin/reviews", filter],
    queryFn: async () => {
      const res = await fetch(`/api/admin/reviews${query}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load reviews");
      return res.json();
    },
    staleTime: 15_000,
  });

  const [pendingId, setPendingId] = useState<string | null>(null);
  const act = async (id: string, action: "remove" | "restore") => {
    setPendingId(id);
    try {
      await apiRequest("POST", `/api/admin/reviews/${id}/${action}`, {});
      queryClient.invalidateQueries({ queryKey: ["/api/admin/reviews"] });
    } finally {
      setPendingId(null);
    }
  };

  const rows = q.data || [];

  return (
    <div className="max-w-[1100px] mx-auto w-full px-4 sm:px-6 py-6 space-y-5">
      <div>
        <h1 className="font-display text-2xl font-heading">Parent Reviews</h1>
        <p className="text-sm text-muted-foreground mt-1">Reviews auto-publish after AI screening. Remove anything that slipped through, restore anything removed in error, and follow up on private feedback.</p>
      </div>

      <div className="inline-flex rounded-lg border border-border overflow-hidden" data-testid="admin-reviews-filters">
        {([["all", "All"], ["flagged", "Flagged by provider"], ["private", "Private feedback"], ["low", "1-2 stars"], ["removed", "Removed"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`px-3.5 py-2 text-sm font-ui transition-colors ${filter === v ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
            data-testid={`admin-reviews-filter-${v}`}
          >
            {label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8">No reviews match this filter.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-[var(--radius)] border bg-card p-4" data-testid={`admin-review-${r.id}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StarDisplay value={r.rating} />
                    <span className="text-sm font-medium">{r.providerName}</span>
                    {r.memberName && <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent/15 text-[hsl(var(--accent))]">Doctor: {r.memberName}</span>}
                    {r.visibility === "PRIVATE_FEEDBACK" && (
                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-secondary text-foreground"><EyeOff className="w-3 h-3" /> Private feedback</span>
                    )}
                    {r.status === "REJECTED" && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive">Removed</span>}
                    {r.flaggedByProviderAt && (
                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]"><Flag className="w-3 h-3" /> Provider flagged</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.authorName || "Unknown"} ({r.authorEmail}){r.anonymous ? " - posts anonymously" : ""} · {r.stage || "no stage"} · {new Date(r.updatedAt || r.createdAt).toLocaleString()}
                  </p>
                  {r.text && <p className="text-sm whitespace-pre-wrap">{r.text}</p>}
                  {r.flagReason && <p className="text-xs text-[hsl(var(--brand-warning))]">Flag reason: {r.flagReason}</p>}
                  {r.aiScreenNotes && <p className="text-xs text-muted-foreground">AI screening: {r.aiScreenNotes}</p>}
                  {r.providerReply && (
                    <div className="pl-3 border-l-2 border-primary/30">
                      <p className="text-xs text-muted-foreground">Provider reply: {r.providerReply}</p>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {r.status === "PUBLISHED" ? (
                    <Button size="sm" variant="outline" className="text-xs text-destructive" disabled={pendingId === r.id} onClick={() => act(r.id, "remove")} data-testid={`btn-remove-${r.id}`}>
                      <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove
                    </Button>
                  ) : r.status === "REJECTED" ? (
                    <Button size="sm" variant="outline" className="text-xs" disabled={pendingId === r.id} onClick={() => act(r.id, "restore")} data-testid={`btn-restore-${r.id}`}>
                      <RotateCcw className="w-3.5 h-3.5 mr-1" /> Restore
                    </Button>
                  ) : null}
                  {r.flaggedByProviderAt && r.status === "PUBLISHED" && (
                    <Button size="sm" variant="ghost" className="text-xs" disabled={pendingId === r.id} onClick={() => act(r.id, "restore")} data-testid={`btn-clear-flag-${r.id}`}>
                      Clear flag
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
