import { useState, useCallback, useMemo } from "react";
import { JOURNEY_STAGE_ORDER } from "@shared/journey-ladder";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, Ban, UserCheck, ShieldCheck } from "lucide-react";
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
  quietDaysOf,
  serviceEnumKey,
  isLiveInvoice,
} from "@/components/parents";
import { ParentsTable } from "@/components/parents/parents-table";
import { ParentsFilterBar } from "@/components/parents/parents-filter-bar";

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
  const formFilter = searchParams.get("form") || "all";
  const quietFilter = searchParams.get("quiet") || "all";
  const reviewFilter = searchParams.get("review") === "1";
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

  const hasActiveFilters = searchQuery.trim() !== "" || dateFrom !== "" || dateTo !== "" || serviceFilter.length > 0 || statusFilter.length > 0 || ownerFilter !== "all" || nextFilter !== "all" || formFilter !== "all" || quietFilter !== "all" || reviewFilter;

  // Signups flagged at creation (per-IP velocity, etc.). Count drives the pill.
  const reviewCount = parentUsers.filter(m => (overview[m.id]?.trustState) === "QUARANTINED").length;

  // #1 Search that reaches what people wrote: note bodies + task text, scoped
  // server-side. Fires only at 3+ chars, and only when the fast client-side
  // name/email/phone filter above finds few rows (so it stays a "reach deeper"
  // affordance, never noise on a common name).
  const trimmedQuery = searchQuery.trim();
  const { data: writtenSearch } = useQuery<{ results: { parentUserId: string; parentName: string; kind: string; snippet: string; at: string; entryId: string }[] }>({
    queryKey: ["/api/parents/search", trimmedQuery],
    queryFn: async () => (await fetch(`/api/parents/search?q=${encodeURIComponent(trimmedQuery)}`, { credentials: "include" })).json(),
    enabled: trimmedQuery.length >= 3,
    // Search must reflect the moment - the app's global staleTime is Infinity,
    // which cached a query string's first (possibly empty) result forever.
    staleTime: 0,
    refetchOnMount: "always",
  });
  const writtenResults = trimmedQuery.length >= 3 ? (writtenSearch?.results || []) : [];

  const filteredUsers = parentUsers.filter(member => {
    if (reviewFilter && overview[member.id]?.trustState !== "QUARANTINED") return false;
    // Equality on enum keys, exactly like the provider table. This used to be a
    // substring match on free-text labels, so the same dropdown behaved
    // differently depending on which role was looking at it.
    if (!matchesMultiAny(serviceFilter, overview[member.id]?.serviceKeys)) return false;
    if (!matchesMulti(statusFilter, overview[member.id]?.matchStatus)) return false;
    if (!matchesIpForm(formFilter, overview[member.id]?.ipFormStatus)) return false;
    if (!matchesCrmFilters(overview[member.id] || {}, { owner: ownerFilter, next: nextFilter }, user?.id)) return false;
    if (quietFilter !== "all") {
      const days = quietDaysOf(overview[member.id]?.lastTouchAt);
      if (days === null || days < Number(quietFilter)) return false;
    }
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
      for (const key of ["q", "from", "to", "svc", "status", "owner", "next", "form", "quiet", "review"]) next.delete(key);
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
      serviceStatuses: o.serviceStatuses,
      createdAt: item.createdAt, updatedAt: o.updatedAt,
      costSheets: o.costSheets, invoices: o.invoices, agreements: o.agreements,
      owner: o.owner, nextStep: o.nextStep, lastTouchAt: o.lastTouchAt,
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

  const approveTrustMutation = useMutation({
    mutationFn: async (userId: string) => {
      await apiRequest("POST", "/api/admin/security/trust-state", { userId, trustState: "TRUSTED" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/parents-overview"] });
      toast({ title: "Signup approved", description: "Cleared from the review queue.", variant: "success" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // #6 Bulk actions. Owner + task apply per-family through the same endpoints a
  // single row uses; every write reports how many landed.
  const bulkOwnerMutation = useMutation({
    mutationFn: async ({ ids, ownerUserId }: { ids: string[]; ownerUserId: string | null }) => {
      const results = await Promise.allSettled(ids.map(id =>
        apiRequest("PUT", `/api/parents/${id}/owner`, { scope: "GOSTORK", ownerUserId })));
      return results.filter(r => r.status === "fulfilled").length;
    },
    onSuccess: (n) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/parents-overview"] });
      setSelectedIds(new Set());
      toast({ title: `Owner assigned to ${n} famil${n === 1 ? "y" : "ies"}`, variant: "success" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  // #6/#3 Apply a playbook across the selection - for families who passed the
  // trigger stage before the playbook existed. The server dedupes per step
  // via the same systemKey the sweep uses, so re-applying is a no-op.
  const { data: playbookData } = useQuery<{ playbooks: { id: string; name: string; isActive: boolean }[] }>({
    queryKey: ["/api/playbooks"],
    queryFn: async () => {
      const res = await fetch("/api/playbooks", { credentials: "include" });
      if (!res.ok) return { playbooks: [] };
      return res.json();
    },
    staleTime: 0,
  });
  const applyPlaybookMutation = useMutation({
    mutationFn: async ({ playbookId, ids }: { playbookId: string; ids: string[] }) => {
      const res = await apiRequest("POST", `/api/playbooks/${playbookId}/apply`, { parentUserIds: ids });
      return res.json() as Promise<{ applied: number; tasksCreated: number; failed: string[] }>;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/parents-overview"] });
      setSelectedIds(new Set());
      toast({
        title: `Playbook applied to ${r.applied} famil${r.applied === 1 ? "y" : "ies"}`,
        description: `${r.tasksCreated} task${r.tasksCreated === 1 ? "" : "s"} created${r.failed.length ? `, ${r.failed.length} failed` : ""}.`,
        variant: r.failed.length ? "destructive" : "success",
      });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const [bulkTaskOpen, setBulkTaskOpen] = useState(false);
  const [bulkTaskTitle, setBulkTaskTitle] = useState("");
  const [bulkTaskDue, setBulkTaskDue] = useState("");
  const bulkTaskMutation = useMutation({
    mutationFn: async ({ ids, title, dueAt }: { ids: string[]; title: string; dueAt: string | null }) => {
      const results = await Promise.allSettled(ids.map(id =>
        apiRequest("POST", `/api/parents/${id}/tasks`, { title, scope: "GOSTORK", serviceLine: null, dueAt, priority: "MEDIUM", type: "TODO" })));
      return results.filter(r => r.status === "fulfilled").length;
    },
    onSuccess: (n) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/parents-overview"] });
      setSelectedIds(new Set()); setBulkTaskOpen(false); setBulkTaskTitle(""); setBulkTaskDue("");
      toast({ title: `Task created for ${n} famil${n === 1 ? "y" : "ies"}`, variant: "success" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  function exportSelectedCsv() {
    const rows = sortedUsers.filter(u => selectedIds.has(u.id));
    const header = ["Name", "Email", "Phone", "Match status", "Owner", "Created"];
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [header.join(",")].concat(rows.map(u => [
      u.name, u.email, u.mobileNumber, overview[u.id]?.matchStatus || "", overview[u.id]?.owner?.name || "", u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "",
    ].map(esc).join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `parents-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast({ title: `Exported ${rows.length} famil${rows.length === 1 ? "y" : "ies"}` });
  }

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
            <div className="flex items-center gap-2">
              <span className="t-helper mr-1">{selectedIds.size} selected</span>
              <Select value="" onValueChange={(v) => { if (v) bulkOwnerMutation.mutate({ ids: [...selectedIds], ownerUserId: v === "__none__" ? null : v }); }}>
                <SelectTrigger className="h-9 w-auto bg-card px-3 border rounded-[var(--radius)] text-sm font-medium text-foreground [&>span]:text-foreground" data-testid="bulk-assign-owner">
                  <span className="text-foreground">Assign owner</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Unassigned</SelectItem>
                  {ownerOptions.map((o: any) => <SelectItem key={o.id} value={o.id}>{o.name || "Unnamed"}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" className="bg-card" onClick={() => setBulkTaskOpen(true)} data-testid="bulk-create-task">New task</Button>
              {(playbookData?.playbooks || []).filter(p => p.isActive).length > 0 && (
                <Select value="" onValueChange={(v) => { if (v) applyPlaybookMutation.mutate({ playbookId: v, ids: [...selectedIds] }); }}>
                  <SelectTrigger className="h-9 w-auto bg-card px-3 border rounded-[var(--radius)] text-sm font-medium text-foreground [&>span]:text-foreground" data-testid="bulk-apply-playbook">
                    <span className="text-foreground">{applyPlaybookMutation.isPending ? "Applying…" : "Apply playbook"}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {(playbookData?.playbooks || []).filter(p => p.isActive).map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button variant="outline" className="bg-card" onClick={exportSelectedCsv} data-testid="bulk-export-csv">Export CSV</Button>
              <Button variant="destructive" onClick={() => setShowBulkDeleteConfirm(true)} data-testid="button-delete-selected">
                <Trash2 className="w-4 h-4 mr-2" /> Delete ({selectedIds.size})
              </Button>
            </div>
          )}
          <Button onClick={() => navigate("/users/new")} data-testid="button-add-staff">
            <Plus className="w-4 h-4 mr-2" /> Add Parent
          </Button>
        </div>
      </div>

      <ParentsFilterBar
        state={{ q: searchQuery, from: dateFrom, to: dateTo, services: serviceFilter, statuses: statusFilter, owner: ownerFilter, next: nextFilter, form: formFilter, quiet: quietFilter }}
        setParam={updateUsersParam}
        setParams={setParams}
        onClear={clearFilters}
        ownerOptions={ownerOptions}
        testIdPrefix="admin-parents"
        reviewPill={{
          active: reviewFilter,
          count: reviewCount,
          onToggle: () => updateUsersParam("review", reviewFilter ? "" : "1"),
        }}
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
            serviceStatuses: o.serviceStatuses || [],
            costSheets: o.costSheets || [],
            invoices: o.invoices || [],
            agreements: o.agreements || [],
            sessionId: null,
            createdAt: member.createdAt ?? null,
            updatedAt: o.updatedAt ?? null,
            isDisabled: member.isDisabled,
            owner: o.owner ?? null,
            nextStep: o.nextStep ?? null,
            trustState: o.trustState ?? "TRUSTED",
            trustReasons: o.trustReasons ?? [],
            lastTouchAt: o.lastTouchAt ?? null,
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
              {row.trustState === "QUARANTINED" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-success hover:text-success"
                  onClick={() => approveTrustMutation.mutate(member.id)}
                  disabled={approveTrustMutation.isPending}
                  title="Approve - clear from review queue"
                  data-testid={`button-approve-trust-${member.id}`}
                >
                  <ShieldCheck className="w-4 h-4" />
                </Button>
              )}
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

      {/* #1 Search: what the team wrote inside notes and tasks, unreachable by
          the name/email/phone filter above. */}
      {writtenResults.length > 0 && (
        <div className="mt-6 rounded-[var(--radius)] border bg-card p-4">
          <h3 className="t-section-title font-heading mb-3">Found in notes and tasks ({writtenResults.length})</h3>
          <div className="space-y-1.5">
            {writtenResults.map((r, i) => (
              <button
                key={`${r.parentUserId}-${i}`}
                type="button"
                className="w-full text-left flex items-start gap-2 rounded-md px-2.5 py-2 hover:bg-secondary transition-colors"
                onClick={() => navigate(`/parents/${r.parentUserId}?col=activity&focus=${r.entryId}`)}
                data-testid={`search-result-${i}`}
              >
                <span className="text-[10px] font-ui uppercase px-1.5 py-0.5 rounded-full bg-accent/15 shrink-0 mt-0.5" style={{ color: "hsl(var(--accent))" }}>{r.kind}</span>
                <span className="min-w-0">
                  <span className="text-sm font-medium">{r.parentName}</span>
                  <span className="block t-helper truncate">{r.snippet}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Dialog open={bulkTaskOpen} onOpenChange={setBulkTaskOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New task for {selectedIds.size} famil{selectedIds.size === 1 ? "y" : "ies"}</DialogTitle>
            <DialogDescription>One task is created on each selected record, each on its own timeline.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Task title" value={bulkTaskTitle} onChange={(e) => setBulkTaskTitle(e.target.value)} data-testid="bulk-task-title" />
            <div className="flex items-center gap-2">
              <span className="t-helper">Due</span>
              <Input type="date" value={bulkTaskDue} onChange={(e) => setBulkTaskDue(e.target.value)} className="w-auto" data-testid="bulk-task-due" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkTaskOpen(false)}>Cancel</Button>
            <Button
              disabled={!bulkTaskTitle.trim() || bulkTaskMutation.isPending}
              onClick={() => bulkTaskMutation.mutate({ ids: [...selectedIds], title: bulkTaskTitle.trim(), dueAt: bulkTaskDue ? new Date(bulkTaskDue).toISOString() : null })}
              data-testid="bulk-task-submit"
            >
              {bulkTaskMutation.isPending ? "Creating…" : "Create tasks"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  const formFilter = searchParams.get("form") || "all";
  const quietFilter = searchParams.get("quiet") || "all";
  const hasActiveFilters = !!(searchQuery || serviceFilter.length || statusFilter.length || dateFrom || dateTo || ownerFilter !== "all" || nextFilter !== "all" || formFilter !== "all" || quietFilter !== "all");
  const clearFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      ["q", "svc", "status", "from", "to", "owner", "next", "form", "quiet"].forEach(k => next.delete(k));
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
      // Everything the family asked for, own lines included. The table shows
      // the ones this org is NOT running as bare tags (no status, no money),
      // so a provider sees the full ask without seeing a rival's journey.
      g.interestServices = threads[0]?.profileServiceKeys || [];
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
      g.invoices = threads.flatMap((t: any) => t.invoices || []);
      // Money artifacts open service lines of their own: an invoice typed
      // "Surrogacy" inside an egg-donor thread means the org IS running a
      // surrogacy line for this family, and the admin view already shows it
      // that way - without this the two tables disagreed on the row's lines.
      // Untyped artifacts stay with their thread's session-derived status.
      const artifactBump = (svcText: string | null | undefined, st: string | null) => {
        if (!st) return;
        const key = serviceEnumKey(svcText);
        if (!key) return;
        const cur = byLine.get(key);
        if (!cur || stageRank(st) > stageRank(cur)) byLine.set(key, st);
      };
      for (const inv of g.invoices) {
        if (!isLiveInvoice(inv)) continue;
        artifactBump(inv.serviceType, inv.status === "PAID" ? "invoice_paid" : "invoice_sent");
      }
      for (const agr of threads.flatMap((t: any) => t.agreements || [])) {
        artifactBump(agr.serviceType, agr.status === "SIGNED" ? "agreement_signed" : "agreement_sent");
      }
      g.serviceStatuses = Array.from(byLine.entries()).map(([serviceKey, status]) => ({ serviceKey, status }));
      if (g.serviceStatuses.length === 0 && untypedBest) {
        g.serviceStatuses = [{ serviceKey: null, status: untypedBest }];
      }
      g.matchStatus = threads.reduce(
        (best: string | null, t: any) => (stageRank(t.matchStatus) > stageRank(best) ? t.matchStatus : best),
        null,
      );
      // Stamp each sheet with its thread's service line - quotes carry no
      // serviceType of their own, and the table aligns money chips to the
      // Services column line-for-line.
      g.costSheets = threads.flatMap((t: any) => (t.costSheets || []).map((cs: any) => ({ ...cs, serviceLine: t.serviceType ?? null })));
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
      if (!matchesCrmFilters(p, { owner: ownerFilter, next: nextFilter }, user?.id)) return false;
      if (quietFilter !== "all") {
        const days = quietDaysOf(p.lastTouchAt);
        if (days === null || days < Number(quietFilter)) return false;
      }
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
      owner: p.owner, nextStep: p.nextStep, lastTouchAt: p.lastTouchAt,
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
        state={{ q: searchQuery, from: dateFrom, to: dateTo, services: serviceFilter, statuses: statusFilter, owner: ownerFilter, next: nextFilter, form: formFilter, quiet: quietFilter }}
        setParam={setParam}
        setParams={setParams}
        onClear={clearFilters}
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
          interestServices: row.interestServices || [],
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
          lastTouchAt: row.lastTouchAt ?? null,
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
