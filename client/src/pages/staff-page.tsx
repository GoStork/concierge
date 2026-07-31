import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, Search, Calendar, Ban, UserCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTableSort } from "@/components/sortable-table-head";
import MembersTable from "@/components/members-table";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import {
  JOURNEY_STATUS_LABELS,
  SERVICE_LABELS,
  matchesCrmFilters,
  toDateParam,
} from "@/components/parents";
import { ParentsTable } from "@/components/parents/parents-table";

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
  const serviceFilter = searchParams.get("svc") || "all";
  const statusFilter = searchParams.get("status") || "all";
  const ownerFilter = searchParams.get("owner") || "all";
  const nextFilter = searchParams.get("next") || "all";
  const tagFilter = searchParams.get("tag") || "all";

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

  const hasActiveFilters = searchQuery.trim() !== "" || dateFrom !== "" || dateTo !== "" || serviceFilter !== "all" || statusFilter !== "all" || ownerFilter !== "all" || nextFilter !== "all" || tagFilter !== "all";

  const filteredUsers = parentUsers.filter(member => {
    // Equality on enum keys, exactly like the provider table. This used to be a
    // substring match on free-text labels, so the same dropdown behaved
    // differently depending on which role was looking at it.
    if (serviceFilter !== "all" && !(overview[member.id]?.serviceKeys || []).includes(serviceFilter)) return false;
    if (statusFilter !== "all" && overview[member.id]?.matchStatus !== statusFilter) return false;
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
      for (const key of ["q", "from", "to", "svc", "status", "owner", "next", "tag"]) next.delete(key);
      return next;
    }, { replace: true });
  }

  const sortedUsers = sortData(filteredUsers, (item, key) => {
    switch (key) {
      case "name": return item.name || "";
      case "email": return item.email;
      case "mobile": return item.mobileNumber || "";
      case "created": return item.createdAt || "";
      case "updated": return overview[item.id]?.updatedAt || "";
      case "services": return (overview[item.id]?.serviceKeys || []).join(", ");
      case "status": return overview[item.id]?.matchStatus || "";
      case "owner": return overview[item.id]?.owner?.name || "";
      // sortData puts nulls last, which is what "no next step" should be.
      case "nextDue": return overview[item.id]?.nextStep?.dueAt || null;
      default: return "";
    }
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

      <div className="flex items-center gap-3">
      <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide flex-1 min-w-0" data-testid="card-parent-filters">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or phone..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
            data-testid="input-search-users"
          />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={dateFrom ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="filter-btn-date-from">
              <Calendar className="w-3 h-3" />
              {dateFrom || "From"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarPicker
              mode="single"
              selected={dateFrom ? new Date(`${dateFrom}T00:00:00`) : undefined}
              onSelect={(d) => setDateFrom(d ? toDateParam(d) : "")}
              data-testid="calendar-date-from"
            />
            {dateFrom && (
              <div className="border-t px-3 py-2">
                <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => setDateFrom("")}>
                  Clear
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={dateTo ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="filter-btn-date-to">
              <Calendar className="w-3 h-3" />
              {dateTo || "To"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarPicker
              mode="single"
              selected={dateTo ? new Date(`${dateTo}T00:00:00`) : undefined}
              onSelect={(d) => setDateTo(d ? toDateParam(d) : "")}
              data-testid="calendar-date-to"
            />
            {dateTo && (
              <div className="border-t px-3 py-2">
                <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => setDateTo("")}>
                  Clear
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <select
          value={serviceFilter}
          onChange={e => updateUsersParam("svc", e.target.value === "all" ? "" : e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="admin-parents-service-filter"
        >
          <option value="all">All services</option>
          {Object.entries(SERVICE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={e => updateUsersParam("status", e.target.value === "all" ? "" : e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="admin-parents-status-filter"
        >
          <option value="all">All statuses</option>
          {Object.entries(JOURNEY_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select
          value={tagFilter}
          onChange={e => updateUsersParam("tag", e.target.value === "all" ? "" : e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="admin-parents-tag-filter"
        >
          <option value="all">All tags</option>
          {tagVocabulary.map(t => <option key={t.id} value={t.label}>{t.label}</option>)}
        </select>
        <select
          value={ownerFilter}
          onChange={e => updateUsersParam("owner", e.target.value === "all" ? "" : e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="admin-parents-owner-filter"
        >
          <option value="all">All owners</option>
          <option value="me">My leads</option>
          <option value="unassigned">Unassigned</option>
          {ownerOptions.map(o => <option key={o.id} value={o.id}>{o.name || "Unnamed"}</option>)}
        </select>
      </div>
        <ClearFiltersButton pill show={hasActiveFilters} onClick={clearFilters} testId="button-clear-filters" />
      </div>

      {/* Quick filters on the same URL-param contract as the selects above,
          so a bookmarked "my overdue leads" view survives a reload. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="parents-quick-filters">
        {[
          { key: "all", label: "All", apply: { owner: "", next: "" } },
          { key: "mine", label: "My leads", apply: { owner: "me", next: "" } },
          { key: "overdue", label: "Overdue", apply: { owner: "", next: "overdue" } },
          { key: "unowned", label: "No owner", apply: { owner: "unassigned", next: "" } },
        ].map(pill => {
          // Normalise BOTH sides to "all" before comparing: the pills store a
          // cleared filter as "", the URL stores it as absent -> "all".
          const active =
            (pill.apply.owner || "all") === (ownerFilter || "all") &&
            (pill.apply.next || "all") === (nextFilter || "all");
          return (
            <button
              key={pill.key}
              type="button"
              className="text-xs font-ui px-2.5 py-1 rounded-full border transition-colors"
              style={active
                ? { background: "hsl(var(--primary) / 0.12)", color: "hsl(var(--primary))", borderColor: "hsl(var(--primary) / 0.4)" }
                : undefined}
              onClick={() => setSearchParams(prev => {
                const next = new URLSearchParams(prev);
                for (const [k, v] of Object.entries(pill.apply)) {
                  if (v) next.set(k, v); else next.delete(k);
                }
                return next;
              }, { replace: true })}
              data-testid={`quick-filter-${pill.key}`}
            >
              {pill.label}
            </button>
          );
        })}
      </div>

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
  const serviceFilter = searchParams.get("svc") || "all";
  const statusFilter = searchParams.get("status") || "all";
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
  const setSearchQuery = (v: string) => setParam("q", v);
  const ownerFilter = searchParams.get("owner") || "all";
  const nextFilter = searchParams.get("next") || "all";
  const tagFilter = searchParams.get("tag") || "all";
  const hasActiveFilters = !!(searchQuery || serviceFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo || ownerFilter !== "all" || nextFilter !== "all" || tagFilter !== "all");
  const clearFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      ["q", "svc", "status", "from", "to", "owner", "next", "tag"].forEach(k => next.delete(k));
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

  const filtered = sortData(
    (parents || []).filter(p => {
      if (serviceFilter !== "all" && p.serviceType !== serviceFilter) return false;
      if (statusFilter !== "all" && p.matchStatus !== statusFilter) return false;
      if (!matchesCrmFilters(p, { owner: ownerFilter, next: nextFilter, tag: tagFilter }, user?.id)) return false;
      if (dateFrom && (!p.sessionCreatedAt || new Date(p.sessionCreatedAt) < new Date(`${dateFrom}T00:00:00`))) return false;
      if (dateTo && (!p.sessionCreatedAt || new Date(p.sessionCreatedAt) > new Date(`${dateTo}T23:59:59`))) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      // Search both partners on a shared account, not just the primary login.
      const memberFields = (p.members || []).flatMap((m: any) => [m.name, m.email, m.mobileNumber]);
      return [p.name, p.email, p.mobileNumber, ...memberFields].filter(Boolean).some((f: string) => f.toLowerCase().includes(q));
    }),
    (p: any, key: string) => {
      switch (key) {
        case "name": return (p.name || "").toLowerCase();
        case "service": return p.serviceType || "";
        case "status": return p.matchStatus || "";
        case "created": return p.sessionCreatedAt ? new Date(p.sessionCreatedAt).getTime() : 0;
        case "updated": return p.sessionUpdatedAt ? new Date(p.sessionUpdatedAt).getTime() : 0;
        case "owner": return p.owner?.name || "";
        case "nextDue": return p.nextStep?.dueAt ? new Date(p.nextStep.dueAt).getTime() : null;
        default: return null;
      }
    },
  );

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display t-page-title text-primary" data-testid="text-page-title">Parents</h1>
        <p className="text-muted-foreground">Parents who have connected with you via the AI concierge or meetings.</p>
      </div>

      <div className="flex items-center gap-3">
      <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide flex-1 min-w-0">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
            data-testid="input-search-parents"
          />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={dateFrom ? "default" : "outline"} size="sm" className="shrink-0 h-9 text-xs rounded-full gap-1" data-testid="provider-parents-date-from">
              <Calendar className="w-3 h-3" />
              {dateFrom || "From"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarPicker
              mode="single"
              selected={dateFrom ? new Date(`${dateFrom}T00:00:00`) : undefined}
              onSelect={(d) => setParam("from", d ? toDateParam(d) : "")}
            />
            {dateFrom && (
              <div className="border-t px-3 py-2">
                <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => setParam("from", "")}>
                  Clear
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={dateTo ? "default" : "outline"} size="sm" className="shrink-0 h-9 text-xs rounded-full gap-1" data-testid="provider-parents-date-to">
              <Calendar className="w-3 h-3" />
              {dateTo || "To"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarPicker
              mode="single"
              selected={dateTo ? new Date(`${dateTo}T00:00:00`) : undefined}
              onSelect={(d) => setParam("to", d ? toDateParam(d) : "")}
            />
            {dateTo && (
              <div className="border-t px-3 py-2">
                <Button variant="ghost" size="sm" className="text-xs h-6 w-full" onClick={() => setParam("to", "")}>
                  Clear
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
        <select
          value={serviceFilter}
          onChange={e => setParam("svc", e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="parents-service-filter"
        >
          <option value="all">All services</option>
          {Object.entries(SERVICE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={e => setParam("status", e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="parents-status-filter"
        >
          <option value="all">All statuses</option>
          {Object.entries(JOURNEY_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select
          value={tagFilter}
          onChange={e => setParam("tag", e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="parents-tag-filter"
        >
          <option value="all">All tags</option>
          {tagVocabulary.map(t => <option key={t.id} value={t.label}>{t.label}</option>)}
        </select>
        <select
          value={ownerFilter}
          onChange={e => setParam("owner", e.target.value)}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm shrink-0"
          data-testid="parents-owner-filter"
        >
          <option value="all">All owners</option>
          <option value="me">My leads</option>
          <option value="unassigned">Unassigned</option>
          {ownerOptions.map(o => <option key={o.id} value={o.id}>{o.name || "Unnamed"}</option>)}
        </select>
      </div>
        <ClearFiltersButton pill show={hasActiveFilters} onClick={clearFilters} testId="provider-parents-clear-filters" />
      </div>

      {/* Quick filters on the same URL-param contract as the selects above,
          so a bookmarked "my overdue leads" view survives a reload. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="parents-quick-filters">
        {[
          { key: "all", label: "All", apply: { owner: "", next: "" } },
          { key: "mine", label: "My leads", apply: { owner: "me", next: "" } },
          { key: "overdue", label: "Overdue", apply: { owner: "", next: "overdue" } },
          { key: "unowned", label: "No owner", apply: { owner: "unassigned", next: "" } },
        ].map(pill => {
          // Normalise BOTH sides to "all" before comparing: the pills store a
          // cleared filter as "", the URL stores it as absent -> "all".
          const active =
            (pill.apply.owner || "all") === (ownerFilter || "all") &&
            (pill.apply.next || "all") === (nextFilter || "all");
          return (
            <button
              key={pill.key}
              type="button"
              className="text-xs font-ui px-2.5 py-1 rounded-full border transition-colors"
              style={active
                ? { background: "hsl(var(--primary) / 0.12)", color: "hsl(var(--primary))", borderColor: "hsl(var(--primary) / 0.4)" }
                : undefined}
              onClick={() => setSearchParams(prev => {
                const next = new URLSearchParams(prev);
                for (const [k, v] of Object.entries(pill.apply)) {
                  if (v) next.set(k, v); else next.delete(k);
                }
                return next;
              }, { replace: true })}
              data-testid={`quick-filter-${pill.key}`}
            >
              {pill.label}
            </button>
          );
        })}
      </div>

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
          services: row.serviceType ? [row.serviceType] : [],
          matchStatus: row.matchStatus ?? null,
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
