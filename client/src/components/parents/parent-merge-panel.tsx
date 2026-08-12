/**
 * Merge / link two families (CRM Phase 9 §2b) - the record's Actions menu
 * and the inline picker panel behind it. Manual only: the platform never
 * suggests duplicates (the bot wave makes automatic suggestion dangerous);
 * a human searches, reads what each record holds, and decides.
 *
 * Merge is admin-only and irreversible - the confirmation names both
 * records and states plainly what moves. Link-as-household is the lighter,
 * undoable action available to providers.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GitMerge, Link2, Link2Off, Loader2, MoreHorizontal, Search, Users, X } from "lucide-react";
import type { ParentRecord } from "./parent-record-types";
import { SERVICE_LINE_LABELS } from "./parent-crm-ui";
import { journeyStageLabel } from "@shared/journey-ladder";

export type MergeLinkMode = "merge" | "link";

interface Candidate {
  parentUserId: string;
  name: string | null;
  email: string | null;
  mobileNumber: string | null;
  createdAt: string;
  holdings: {
    notes: number; tasks: number; invoices: number; agreements: number; sessions: number;
    lines: { serviceLine: string; stage: string }[];
  };
}

export function MergeLinkMenu({ isAdmin, onOpen }: {
  isAdmin: boolean;
  onOpen: (mode: MergeLinkMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="btn-record-actions-menu">
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isAdmin && (
          <DropdownMenuItem onClick={() => onOpen("merge")} data-testid="menu-merge-family">
            <GitMerge className="w-4 h-4 mr-2" /> Merge with another family
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onOpen("link")} data-testid="menu-link-household">
          <Link2 className="w-4 h-4 mr-2" /> Link as household
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HoldingsSummary({ c }: { c: Candidate }) {
  const bits = [
    c.holdings.sessions && `${c.holdings.sessions} conversation${c.holdings.sessions === 1 ? "" : "s"}`,
    c.holdings.notes && `${c.holdings.notes} note${c.holdings.notes === 1 ? "" : "s"}`,
    c.holdings.tasks && `${c.holdings.tasks} task${c.holdings.tasks === 1 ? "" : "s"}`,
    c.holdings.invoices && `${c.holdings.invoices} invoice${c.holdings.invoices === 1 ? "" : "s"}`,
    c.holdings.agreements && `${c.holdings.agreements} agreement${c.holdings.agreements === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <span className="block t-helper">
      {c.holdings.lines.map((l) =>
        `${SERVICE_LINE_LABELS[l.serviceLine] || l.serviceLine}: ${journeyStageLabel(l.stage) || l.stage}`,
      ).join(" · ")}
      {c.holdings.lines.length > 0 && bits.length > 0 && " · "}
      {bits.join(", ") || (c.holdings.lines.length ? "" : "no activity yet")}
    </span>
  );
}

export function ParentMergePanel({ record, mode, onClose }: {
  record: ParentRecord;
  mode: MergeLinkMode;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Candidate | null>(null);
  const parentId = record.parent.id;

  const { data: search, isFetching } = useQuery<{ candidates: Candidate[] }>({
    queryKey: ["/api/parents/merge-candidates", q, parentId],
    queryFn: async () => {
      const res = await fetch(
        `/api/parents/merge-candidates?q=${encodeURIComponent(q.trim())}&exclude=${parentId}`,
        { credentials: "include" },
      );
      if (!res.ok) return { candidates: [] };
      return res.json();
    },
    enabled: q.trim().length >= 2,
    staleTime: 0,
  });

  const { data: linkInfo } = useQuery<{ links: { id: string; otherMembers: { id: string; name: string | null; email: string }[] }[] }>({
    queryKey: ["/api/parents", parentId, "household-link"],
    queryFn: async () => {
      const res = await fetch(`/api/parents/${parentId}/household-link`, { credentials: "include" });
      if (!res.ok) return { links: [] };
      return res.json();
    },
    staleTime: 0,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/parents", parentId, "record"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/parents-overview"] });
    queryClient.invalidateQueries({ queryKey: ["/api/parents", parentId, "household-link"] });
  };

  const act = useMutation({
    mutationFn: async (other: Candidate) => {
      if (mode === "merge") {
        const res = await apiRequest("POST", `/api/parents/${parentId}/merge`, { absorbedParentUserId: other.parentUserId });
        return res.json();
      }
      const res = await apiRequest("POST", `/api/parents/${parentId}/household-link`, { otherParentUserId: other.parentUserId });
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({
        title: mode === "merge" ? "Families merged" : "Linked as household",
        description: mode === "merge"
          ? "Everything now lives on this record. The other login still works and lands here."
          : "The two records stay separate and now wear one household badge.",
        variant: "success",
      });
      onClose();
      if (mode === "merge") navigate(0);
    },
    onError: (e: any) => toast({ title: "Action failed", description: e?.message, variant: "destructive" }),
  });

  const unlink = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/parents/${parentId}/household-link`),
    onSuccess: () => {
      invalidate();
      toast({ title: "Household unlinked" });
    },
    onError: (e: any) => toast({ title: "Could not unlink", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-3" data-testid="merge-link-panel">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-heading flex items-center gap-2">
          {mode === "merge" ? <GitMerge className="w-4 h-4 text-primary" /> : <Users className="w-4 h-4 text-primary" />}
          {mode === "merge" ? "Merge with another family" : "Link as household"}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="btn-close-merge-panel"><X className="w-4 h-4" /></Button>
      </div>
      <p className="t-helper">
        {mode === "merge"
          ? "Merging is irreversible: the other record's conversations, notes, tasks, owners, invoices, agreements, cost sheets, releases and journey events all move onto this one, and its logins become members of this family."
          : "Linking keeps both records separate - they simply show as one family on the parents table. You can unlink at any time."}
      </p>

      {mode === "link" && (linkInfo?.links?.length || 0) > 0 && (
        <div className="rounded-[var(--radius)] bg-secondary p-3 space-y-1.5">
          {linkInfo!.links.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2 text-sm font-ui">
              <span>
                Linked with {l.otherMembers.map((m) => m.name || m.email).join(", ") || "another family"}
              </span>
              <Button variant="outline" size="sm" disabled={unlink.isPending} onClick={() => unlink.mutate()} data-testid={`btn-unlink-${l.id}`}>
                <Link2Off className="w-3.5 h-3.5 mr-1.5" /> Unlink
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPicked(null); }}
          placeholder="Search by name, email or phone..."
          className="pl-8"
          data-testid="input-merge-search"
        />
      </div>

      {isFetching && <p className="t-helper flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching...</p>}

      {!picked && (search?.candidates || []).map((c) => (
        <button
          key={c.parentUserId}
          type="button"
          className="w-full text-left rounded-[var(--radius)] border border-border bg-card hover:bg-secondary transition-colors p-3"
          onClick={() => setPicked(c)}
          data-testid={`merge-candidate-${c.parentUserId}`}
        >
          <span className="text-sm font-ui font-medium">{c.name || "Unnamed"}</span>
          <span className="t-helper"> · {c.email}{c.mobileNumber ? ` · ${c.mobileNumber}` : ""}</span>
          <HoldingsSummary c={c} />
        </button>
      ))}
      {q.trim().length >= 2 && !isFetching && (search?.candidates || []).length === 0 && !picked && (
        <p className="t-helper">No matching families.</p>
      )}

      {picked && (
        <div className="rounded-[var(--radius)] border p-3 space-y-2"
          style={{ borderColor: mode === "merge" ? "hsl(var(--destructive) / 0.5)" : "hsl(var(--border))" }}
          data-testid="merge-confirm"
        >
          <p className="text-sm font-ui">
            {mode === "merge" ? (
              <>
                Merge <strong>{picked.name || picked.email}</strong> into{" "}
                <strong>{record.parent.name || "this record"}</strong>? Everything listed below moves here,
                the other logins join this family, and this cannot be undone.
              </>
            ) : (
              <>
                Show <strong>{picked.name || picked.email}</strong> and{" "}
                <strong>{record.parent.name || "this record"}</strong> as one household?
              </>
            )}
          </p>
          <HoldingsSummary c={picked} />
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant={mode === "merge" ? "destructive" : "default"}
              size="sm"
              disabled={act.isPending}
              onClick={() => act.mutate(picked)}
              data-testid="btn-confirm-merge"
            >
              {act.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
              {mode === "merge" ? "Merge families" : "Link as household"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>Back</Button>
          </div>
        </div>
      )}
    </div>
  );
}
