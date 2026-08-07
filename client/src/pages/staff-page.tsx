import { useState, useCallback, useMemo } from "react";
import { JOURNEY_STAGE_ORDER } from "@shared/journey-ladder";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, Ban, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTableSort } from "@/components/sortable-table-head";
import MembersTable from "@/components/members-table";
import {
  matchesCrmFilters,
  matchesIpForm,
  matchesMulti,
  matchesMultiAny,
  parentSortValue,
  parseMulti,
} from "@/components/parents";
import { ParentsTable } from "@/components/parents/parents-table";
import { ParentsFilterBar } from "@/components/parents/parents-filter-bar";

/**
 * The tag vocabulary this viewer may filter by. Scoped server-side: an admin
 * gets every scope, a provider only their own org's labels.
 */
function useOwnerOptions() {
  const { data = [] } = useQuery<any[]>({
    queryKey: ["/api/parents/crm/owner-options"],
    queryFn: async () => {
      const res = await fetch("/api/parents/crm/owner-options", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  return data as { id: string; name: string | null }[];
}

function useTagVocabulary() {
  const { data = [] } = useQuery<any[]>({
    queryKey: ["/api/parents/crm/tag-vocabulary"],
    queryFn: async () => {
      const res = await fetch("/api/parents/crm/tag-vocabulary", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  return data as { id: string; label: string }[];
}

type StaffMember = {
  id: string;
  name: string | null;
  email: string;
  roles: string[];
  mobileNumber: string | null;
  photoUrl: string | null;
  providerId: string | null;
  allLocations: boolean;
  createdAt?: string;
  provider?: { id: string; name: string } | null;
  assignedLocations?: any[];
  isDisabled?: boolean;
};

export default function StaffPage() {
  const { user } = useAuth();

  const providerId = (user as any)?.providerId;
  const userRoles: string[] = (user as any)?.roles || [];
  const isGostorkAdmin = userRoles.includes("GOSTORK_ADMIN");

  if (!isGostorkAdmin && providerId) {
    return <ProviderParentContactsView providerId={providerId} />;
  }

  if (!isGostorkAdmin) {
    return <div className="flex justify-center p-12 text-muted-foreground">You don't have access to this page.</div>;
  }

  return <GostorkAdminUsersView />;
}

function GostorkAdminUsersView() {
  const { user } = useAuth();
  const tagVocabulary = useTagVocabulary();
  const ownerOptions = useOwnerOptions();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [deleteMember, setDeleteMember] = useState<StaffMember | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = searchParams.get("q") || "";
  const dateFrom = searchParams.get("from") || "";
  const dateTo = searchParams.get("to") || "";
  const updateUsersParam = useCallback((key: string, value: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (!value) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const setSearchQuery = (v: string) => updateUsersParam("q", v);
  const setDateFrom = (v: string) => updateUsersParam("from", v);
  const setDateTo = (v: string) => updateUsersParam("to", v);
  // Services and statuses are comma lists so several can be on at once.
  const serviceFilter = parseMulti(searchParams.get("svc"));
  const statusFilter = parseMulti(searchParams.get("status"));
  const ownerFilter = searchParams.get("owner") || "all";
  const nextFilter = searchParams.get("next") || "all";
  const tagFilter = searchParams.get("tag") || "all";
  const formFilter = searchParams.get("form") || "all";
  const setParams = useCallback((entries: Record<string, string>) => {
    // One atomic update: successive single writes each build from the same
    // stale params, so only the last one survives.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(entries)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const { sortConfig, handleSort, sortData } = useTableSort("created", "desc");

  const { data: allUsers, isLoading } = useQuery<StaffMember[]>({
    queryKey: ["/api/users"],
    queryFn: async () => {
      const res = await fetch("/api/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
  });

  const parentUsers = (allUsers || []).filter(u => (u.roles || []).includes("PARENT"));

  // Journey aggregates (services / cost sheets / invoices / agreements /
  // last activity) per parent, across all providers.
  const { data: overview = {} } = useQuery<Record<string, any>>({
    queryKey: ["/api/admin/parents-overview"],
    queryFn: async () => {
      const res = await fetch("/api/admin/parents-overview", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const hasActiveFilters = searchQuery.trim() !== "" || dateFrom !== "" || dateTo !== "" || serviceFilter.length > 0 || statusFilter.length > 0 || ownerFilter !== "all" || nextFilter !== "all" || tagFilter !== "all" || formFilter !== "all";

  const filteredUsers = parentUsers.filter(member => {
    // Equality on enum keys, exactly like the provider table. This used to be a
    // substring match on free-text labels, so the same dropdown behaved
    // differently depending on which role was looking at it.
    if (!matchesMultiAny(serviceFilter, overview[member.id]?.serviceKeys)) return false;
    if (!matchesMulti(statusFilter, overview[member.id]?.matchStatus)) return false;
    if (!matchesIpForm(formFilter, overview[member.id]?.ipFormStatus)) return false;
    if (!matchesCrmFilters(overview[member.id] || {}, { owner: ownerFilter, next: nextFilter, tag: tagFilter }, user?.id)) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const fields = [
        member.name,
        member.email,
        member.mobileNumber,
      ].filter(Boolean).map(f => (f as string).toLowerCase());
      if (!fields.some(f => f.includes(q))) return false;
    }
    if (dateFrom && member.createdAt) {
      const created = new Date(member.createdAt);
      const from = new Date(dateFrom);
      if (created < from) return false;
    }
    if (dateTo && member.createdAt) {
      const created = new Date(member.createdAt);
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      if (created > to) return false;
    }
    return true;
  });

  function clearFilters() {
    // One atomic URL update - successive per-key updates raced each other
    // (each built from the same stale params), so only the last key cleared.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const key of ["q", "from", "to", "svc", "status", "owner", "next", "tag", "form"]) next.delete(key);
      return next;
    }, { replace: true });
  }

  // Every column resolves through the shared comparator, so the two tables
  // cannot answer to different sort keys again. sortData sinks nulls, which is
  // what "no owner" and "no next step" should do.
  const sortedUsers = sortData(filteredUsers, (item, key) => {
    const o = overview[item.id] || {};
    return parentSortValue(key, {
      name: item.name, email: item.email, mobile: item.mobileNumber,
      services: o.serviceKeys, matchStatus: o.matchStatus,
      createdAt: item.createdAt, updatedAt: o.updatedAt,
      costSheets: o.costSheets, invoices: o.invoices, agreements: o.agreements,
      owner: o.owner, nextStep: o.nextStep, tags: o.tags,
    });
  });

  // Couples stay visually together: after sorting, pull the remaining
  // household members up to sit directly under the first one encountered
  // so the pair renders as one connected block.
  const groupedUsers = (() => {
    const byId = new Map(sortedUsers.map(u => [u.id, u]));
    const emitted = new Set<string>();
    const out: StaffMember[] = [];
    for (const u of sortedUsers) {
      if (emitted.has(u.id)) continue;
      out.push(u);
      emitted.add(u.id);
      for (const mid of (overview[u.id]?.household?.memberIds || []) as string[]) {
        if (emitted.has(mid)) continue;
        const partner = byId.get(mid);
        if (partner) {
          out.push(partner);
          emitted.add(mid);
        }
      }
    }
    return out;
  })();

  const deleteMutation = useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest("DELETE", `/api/users/${userId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setDeleteMember(null);
      toast({ title: "User removed", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleDisabledMutation = useMutation({
    mutationFn: async (member: StaffMember) => {
      await apiRequest("PUT", `/api/users/${member.id}`, { isDisabled: !member.isDisabled });
      return !member.isDisabled;
    },
    onSuccess: (nowDisabled) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: nowDisabled ? "Parent disabled" : "Parent enabled", description: nowDisabled ? "They can no longer log in." : "They can log in again.", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map(id => apiRequest("DELETE", `/api/users/${id}`)));
      return ids.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setSelectedIds(new Set());
      setShowBulkDeleteConfirm(false);
      toast({ title: `${count} user${count !== 1 ? "s" : ""} removed`, variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const allVisibleSelected = sortedUsers.length > 0 && sortedUsers.every(u => selectedIds.has(u.id));
  const someSelected = sortedUsers.some(u => selectedIds.has(u.id));

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedUsers.map(u => u.id)));
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display t-page-title text-primary" data-testid="text-page-title">Parents</h1>
          <p className="text-muted-foreground">Manage intended parent accounts.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {selectedIds.size > 0 && (
            <Button variant="destructive" onClick={() => setShowBulkDeleteConfirm(true)} data-testid="button-delete-selected">
              <Trash2 className="w-4 h-4 mr-2" /> Delete Selected ({selectedIds.size})
            </Button>
          )}
          <Button onClick={() => navigate("/users/new")} data-testid="button-add-staff">
            <Plus className="w-4 h-4 mr-2" /> Add Parent
          </Button>
        </div>
      </div>

      <ParentsFilterBar
        state={{ q: searchQuery, from: dateFrom, to: dateTo, services: serviceFilter, statuses: statusFilter, tag: tagFilter, owner: ownerFilter, next: nextFilter, form: formFilter }}
        setParam={updateUsersParam}
        setParams={setParams}
        onClear={clearFilters}
        tagVocabulary={tagVocabulary}
        ownerOptions={ownerOptions}
        testIdPrefix="admin-parents"
      />

      <ParentsTable
        rows={groupedUsers.map(member => {
          const o = overview[member.id] || {};
          const household = o.household as { memberIds: string[]; memberNames: string[] } | undefined;
          return {
            key: member.id,
            id: member.id,
            name: member.name,
            email: member.email,
            mobileNumber: member.mobileNumber,
            photoUrl: member.photoUrl,
            members: [],
            householdNames: household?.memberNames,
            // GoStork staff are never behind Gate B.
            contactReleased: true,
            services: o.serviceKeys || [],
            matchStatus: o.matchStatus ?? null,
            costSheets: o.costSheets || [],
            invoices: o.invoices || [],
            agreements: o.agreements || [],
            sessionId: null,
            createdAt: member.createdAt ?? null,
            updatedAt: o.updatedAt ?? null,
            isDisabled: member.isDisabled,
            owner: o.owner ?? null,
            nextStep: o.nextStep ?? null,
            tags: o.tags || [],
          };
        })}
        sortConfig={sortConfig}
        onSort={handleSort}
        onRowClick={(row) => navigate(`/parents/${row.id}`)}
        isAdmin
        selectable
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
        allVisibleSelected={allVisibleSelected}
        someSelected={someSelected}
        rowActions={(row) => {
          const member = parentUsers.find(u => u.id === row.id);
          if (!member) return null;
          return (
            <div className="flex items-center justify-end gap-1">
              {/* No edit button - clicking anywhere on the row opens the record */}
              <Button
                variant="ghost"
                size="sm"
                className={member.isDisabled ? "text-success hover:text-success" : "text-warning hover:text-warning"}
                onClick={() => toggleDisabledMutation.mutate(member)}
                disabled={toggleDisabledMutation.isPending}
                title={member.isDisabled ? "Enable login" : "Disable login"}
                data-testid={`button-toggle-disabled-${member.id}`}
              >
                {member.isDisabled ? <UserCheck className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteMember(member)} data-testid={`button-delete-${member.id}`}><Trash2 className="w-4 h-4" /></Button>
            </div>
          );
        }}
        emptyMessage={hasActiveFilters ? "No parents match your filters." : "No parents found."}
      />

      <Dialog open={!!deleteMember} onOpenChange={(open) => { if (!open) setDeleteMember(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove User</DialogTitle>
            <DialogDescription>Are you sure you want to remove {deleteMember?.name || deleteMember?.email}? This action cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteMember(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteMember && deleteMutation.mutate(deleteMember.id)} disabled={deleteMutation.isPending} data-testid="button-confirm-delete">{deleteMutation.isPending ? "Removing..." : "Remove"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showBulkDeleteConfirm} onOpenChange={(open) => { if (!open) setShowBulkDeleteConfirm(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {selectedIds.size} User{selectedIds.size !== 1 ? "s" : ""}</DialogTitle>
            <DialogDescription>Are you sure you want to remove {selectedIds.size} selected user{selectedIds.size !== 1 ? "s" : ""}? This action cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))} disabled={bulkDeleteMutation.isPending} data-testid="button-confirm-bulk-delete">{bulkDeleteMutation.isPending ? "Removing..." : "Remove All"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProviderParentContactsView({ providerId }: { providerId: string }) {
  const { user } = useAuth();
  const tagVocabulary = useTagVocabulary();
  const ownerOptions = useOwnerOptions();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = searchParams.get("q") || "";
  const serviceFilter = parseMulti(searchParams.get("svc"));
  const statusFilter = parseMulti(searchParams.get("status"));
  const dateFrom = searchParams.get("from") || "";
  const dateTo = searchParams.get("to") || "";
  const setParam = (key: string, v: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (!v || v === "all") next.delete(key);
      else next.set(key, v);
      return next;
    }, { replace: true });
  };
  const setParams = (entries: Record<string, string>) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(entries)) { if (v) next.set(k, v); else next.delete(k); }
      return next;
    }, { replace: true });
  };
  const setSearchQuery = (v: string) => setParam("q", v);
  const ownerFilter = searchParams.get("owner") || "all";
  const nextFilter = searchParams.get("next") || "all";
  const tagFilter = searchParams.get("tag") || "all";
  const formFilter = searchParams.get("form") || "all";
  const hasActiveFilters = !!(searchQuery || serviceFilter.length || statusFilter.length || dateFrom || dateTo || ownerFilter !== "all" || nextFilter !== "all" || tagFilter !== "all" || formFilter !== "all");
  const clearFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      ["q", "svc", "status", "from", "to", "owner", "next", "tag", "form"].forEach(k => next.delete(k));
      return next;
    }, { replace: true });
  };
  const { sortConfig, handleSort, sortData } = useTableSort("updated", "desc");
  const navigate = useNavigate();

  const { data: parents, isLoading } = useQuery<any[]>({
    queryKey: [`/api/providers/${providerId}/parent-contacts`],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/parent-contacts`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // ── One row per FAMILY, like the admin table ─────────────────────────────
  // The endpoint returns one row per chat thread (the side panels need that
  // granularity), but three near-identical rows for one family made the table
  // read as three different parents. Collapse client-side: services become
  // the union, statuses become one most-advanced status PER SERVICE LINE
  // (a handed-off egg-donation journey and a fresh surrogacy consultation
  // are both true - show both), documents concatenate.
  const stageRank = (s: string | null | undefined) =>
    s ? (JOURNEY_STAGE_ORDER as readonly string[]).indexOf(s) : -1;
  const grouped = useMemo(() => {
    const map = new Map<string, any>();
    for (const p of parents || []) {
      const key = (p.members || []).length
        ? (p.members as any[]).map((m) => m.id).sort().join("|")
        : String(p.id || p.rowId);
      let g = map.get(key);
      if (!g) {
        g = { ...p, rowId: `acct-${key}`, threads: [] };
        map.set(key, g);
      }
      g.threads.push(p);
    }
    for (const g of map.values()) {
      const threads: any[] = g.threads;
      const svc = new Set<string>();
      for (const t of threads) if (t.serviceType) svc.add(t.serviceType);
      if (svc.size === 0) for (const k of threads[0]?.profileServiceKeys || []) svc.add(k);
      g.services = Array.from(svc);
      const byLine = new Map<string, string>();
      let untypedBest: string | null = null;
      for (const t of threads) {
        if (!t.matchStatus) continue;
        if (t.serviceType) {
          const cur = byLine.get(t.serviceType);
          if (!cur || stageRank(t.matchStatus) > stageRank(cur)) byLine.set(t.serviceType, t.matchStatus);
        } else if (stageRank(t.matchStatus) > stageRank(untypedBest)) {
          untypedBest = t.matchStatus;
        }
      }
      g.serviceStatuses = Array.from(byLine.entries()).map(([serviceKey, status]) => ({ serviceKey, status }));
      if (g.serviceStatuses.length === 0 && untypedBest) {
        g.serviceStatuses = [{ serviceKey: null, status: untypedBest }];
      }
      g.matchStatus = threads.reduce(
        (best: string | null, t: any) => (stageRank(t.matchStatus) > stageRank(best) ? t.matchStatus : best),
        null,
      );
      g.invoices = threads.flatMap((t: any) => t.invoices || []);
      g.costSheets = threads.flatMap((t: any) => t.costSheets || []);
      g.agreements = threads.flatMap((t: any) => t.agreements || []);
      g.sessionCreatedAt = threads.map((t: any) => t.sessionCreatedAt).filter(Boolean).sort()[0] || null;
      g.sessionUpdatedAt = threads.map((t: any) => t.sessionUpdatedAt).filter(Boolean).sort().pop() || null;
      g.ipFormStatus = threads.find((t: any) => t.ipFormStatus)?.ipFormStatus ?? null;
    }
    return Array.from(map.values());
  }, [parents]);

  const filtered = sortData(
    grouped.filter(p => {
      if (!matchesMultiAny(serviceFilter, p.services)) return false;
      // Status filter matches if ANY of the family's per-line statuses match.
      if (statusFilter.length && !(p.serviceStatuses || []).some((ss: any) => matchesMulti(statusFilter, ss.status))) return false;
      if (!matchesIpForm(formFilter, p.ipFormStatus)) return false;
      if (!matchesCrmFilters(p, { owner: ownerFilter, next: nextFilter, tag: tagFilter }, user?.id)) return false;
      if (dateFrom && (!p.sessionCreatedAt || new Date(p.sessionCreatedAt) < new Date(`${dateFrom}T00:00:00`))) return false;
      if (dateTo && (!p.sessionCreatedAt || new Date(p.sessionCreatedAt) > new Date(`${dateTo}T23:59:59`))) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      // Search both partners on a shared account, not just the primary login.
      const memberFields = (p.members || []).flatMap((m: any) => [m.name, m.email, m.mobileNumber]);
      return [p.name, p.email, p.mobileNumber, ...memberFields].filter(Boolean).some((f: string) => f.toLowerCase().includes(q));
    }),
    // Same comparator as the admin table. This switch used to answer to
    // "service" while the header sent "services", so that column's sort arrow
    // did nothing at all, and email and mobile were missing outright.
    (p: any, key: string) => parentSortValue(key, {
      name: p.name, email: p.email, mobile: p.mobileNumber,
      services: p.services || [],
      matchStatus: p.matchStatus,
      createdAt: p.sessionCreatedAt, updatedAt: p.sessionUpdatedAt,
      costSheets: p.costSheets, invoices: p.invoices, agreements: p.agreements,
      owner: p.owner, nextStep: p.nextStep, tags: p.tags,
    }),
  );

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display t-page-title text-primary" data-testid="text-page-title">Parents</h1>
        <p className="text-muted-foreground">Parents who have connected with you via the AI concierge or meetings.</p>
      </div>

      <ParentsFilterBar
        state={{ q: searchQuery, from: dateFrom, to: dateTo, services: serviceFilter, statuses: statusFilter, tag: tagFilter, owner: ownerFilter, next: nextFilter, form: formFilter }}
        setParam={setParam}
        setParams={setParams}
        onClear={clearFilters}
        tagVocabulary={tagVocabulary}
        ownerOptions={ownerOptions}
        testIdPrefix="provider-parents"
      />


      {/* overflow-x-auto so wide rows scroll horizontally instead of
          wrapping. whitespace-nowrap on every cell enforces single-line
          per column. Source column was removed - every parent in this
          table got here by booking a consultation through the AI chat,
          so "source" was always the same value and the column didn't
          earn its width. */}
      <ParentsTable
        rows={filtered.map((row: any) => ({
          key: row.rowId || row.id,
          id: row.id,
          name: row.name,
          email: row.email,
          mobileNumber: row.mobileNumber,
          photoUrl: row.photoUrl,
          members: row.members || [],
          householdNames: (row.members || []).length > 1 ? (row.members || []).map((m: any) => m.name) : undefined,
          contactReleased: !!row.contactReleased,
          services: row.services || [],
          matchStatus: row.matchStatus ?? null,
          serviceStatuses: row.serviceStatuses || [],
          costSheets: row.costSheets || [],
          invoices: row.invoices || [],
          agreements: row.agreements || [],
          sessionId: row.sessionId ?? null,
          createdAt: row.sessionCreatedAt ?? null,
          updatedAt: row.sessionUpdatedAt ?? null,
          owner: row.owner ?? null,
          nextStep: row.nextStep ?? null,
          tags: row.tags || [],
        }))}
        sortConfig={sortConfig}
        onSort={handleSort}
        onRowClick={(row) => navigate(`/parents/${row.id}`)}
        isAdmin={false}
        emptyMessage={hasActiveFilters
          ? "No parents match your filters."
          : "No parent contacts yet. Parents will appear here when the AI concierge connects them with you."}
      />
    </div>
  );
}
