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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Plus, UserCircle, Trash2, Pencil, Loader2, Phone, Search, XCircle, Calendar, ChevronDown, Copy, Check, CheckCircle2, Ban, UserCheck } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { getPhotoSrc } from "@/lib/profile-utils";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import { useToast } from "@/hooks/use-toast";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import MembersTable from "@/components/members-table";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";

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

// yyyy-mm-dd in LOCAL time (toISOString would shift the day near midnight)
function toDateParam(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function CopyButton({ value, testId }: { value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
      data-testid={testId}
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-primary" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

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

  const hasActiveFilters = searchQuery.trim() !== "" || dateFrom !== "" || dateTo !== "" || serviceFilter !== "all" || statusFilter !== "all";

  const filteredUsers = parentUsers.filter(member => {
    if (serviceFilter !== "all") {
      const svcs: string[] = overview[member.id]?.services || [];
      if (!svcs.some(sv => sv.toLowerCase().includes(serviceFilter.toLowerCase()))) return false;
    }
    if (statusFilter !== "all" && overview[member.id]?.matchStatus !== statusFilter) return false;
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
      for (const key of ["q", "from", "to", "svc", "status"]) next.delete(key);
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
      case "services": return (overview[item.id]?.services || []).join(", ");
      case "status": return overview[item.id]?.matchStatus || "";
      default: return "";
    }
  });

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
          <h1 className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">Parents</h1>
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
          <option value="Surrogate">Surrogacy</option>
          <option value="Egg Donor">Egg Donation</option>
          <option value="Sperm">Sperm Donation</option>
          <option value="IVF">IVF Clinic</option>
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
      </div>
        <ClearFiltersButton pill show={hasActiveFilters} onClick={clearFilters} testId="button-clear-filters" />
      </div>

      <Card className="overflow-x-auto">
        <Table className="[&_th]:px-2 [&_td]:px-2 [&_th]:text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pl-4">
                <Checkbox
                  checked={allVisibleSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all"
                  data-testid="checkbox-select-all"
                />
              </TableHead>
              <SortableTableHead label="Name" sortKey="name" currentSort={sortConfig} onSort={handleSort} data-testid="sort-name" />
              <SortableTableHead label="Email" sortKey="email" currentSort={sortConfig} onSort={handleSort} className="hidden sm:table-cell" data-testid="sort-email" />
              <SortableTableHead label="Mobile" sortKey="mobile" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden md:table-cell" data-testid="sort-mobile" />
              <SortableTableHead label="Services" sortKey="services" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-services" />
              <SortableTableHead label="Match Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-status" />
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Cost Sheets</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Invoices</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Agreements</TableHead>
              <SortableTableHead label="Created" sortKey="created" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-created" />
              <SortableTableHead label="Updated" sortKey="updated" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-updated" />
              <TableHead className="text-right whitespace-nowrap">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedUsers.length > 0 ? sortedUsers.map((member) => (
              <TableRow key={member.id} data-testid={`row-staff-${member.id}`} className={`cursor-pointer ${member.isDisabled ? "opacity-60" : ""}`} onClick={() => navigate(`/users/${member.id}`)}>
                <TableCell className="pl-4 w-10" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(member.id)}
                    onCheckedChange={() => toggleSelect(member.id)}
                    aria-label={`Select ${member.name || member.email}`}
                    data-testid={`checkbox-select-${member.id}`}
                  />
                </TableCell>
                <TableCell className="font-ui whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    {getPhotoSrc(member.photoUrl) ? (
                      <img src={getPhotoSrc(member.photoUrl)!} alt="" className="w-8 h-8 rounded-[var(--radius)] object-cover" />
                    ) : (
                      <DoctorMonogram name={member.name} size={32} rounded="var(--radius)" />
                    )}
                    <button type="button" className="text-left hover:text-primary hover:underline transition-colors cursor-pointer" onClick={(e) => { e.stopPropagation(); navigate(`/users/${member.id}`); }} data-testid={`link-user-name-${member.id}`}>{member.name || "-"}</button>
                    {member.name && <CopyButton value={member.name} testId={`btn-copy-name-${member.id}`} />}
                    {member.isDisabled && (
                      <span className="shrink-0 inline-flex items-center text-[10px] font-ui px-2 py-0.5 rounded-full whitespace-nowrap bg-destructive text-destructive-foreground" data-testid={`badge-disabled-${member.id}`}>Disabled</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell" data-testid={`text-email-${member.id}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate max-w-[150px] inline-block align-middle" title={member.email}>{member.email}</span>
                    <CopyButton value={member.email} testId={`btn-copy-email-${member.id}`} />
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap" data-testid={`text-mobile-${member.id}`}>
                  {member.mobileNumber ? (
                    <div className="flex items-center gap-1 text-sm">
                      <span className="whitespace-nowrap">{formatPhoneDisplay(member.mobileNumber)}</span>
                      <CopyButton value={member.mobileNumber} testId={`btn-copy-mobile-${member.id}`} />
                    </div>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  {(overview[member.id]?.services || []).length > 0 ? (
                    <div className="flex flex-wrap gap-1 items-center">
                      {(overview[member.id].services as string[]).slice(0, 2).map(svc => (
                        <span key={svc} className="text-xs font-ui px-2 py-0.5 rounded-full" style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}>
                          {svc}
                        </span>
                      ))}
                      {(overview[member.id].services as string[]).length > 2 && (
                        <span
                          className="text-xs font-ui px-1.5 py-0.5 rounded-full"
                          style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
                          title={(overview[member.id].services as string[]).slice(2).join(", ")}
                        >
                          +{(overview[member.id].services as string[]).length - 2}
                        </span>
                      )}
                    </div>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <MatchStatusBadge status={overview[member.id]?.matchStatus} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentCostSheetsCell costSheets={overview[member.id]?.costSheets || []} sessionId={null} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentInvoicesCell invoices={overview[member.id]?.invoices || []} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentAgreementsCell agreements={overview[member.id]?.agreements || []} />
                </TableCell>
                <TableCell className="hidden lg:table-cell" data-testid={`text-created-${member.id}`}>
                  {member.createdAt ? (
                    <span className="text-sm text-muted-foreground">{new Date(member.createdAt).toLocaleDateString()}</span>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap">
                  {overview[member.id]?.updatedAt ? (
                    <span className="text-sm text-muted-foreground">{new Date(overview[member.id].updatedAt).toLocaleDateString()}</span>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {/* No edit button - clicking anywhere on the row opens the edit page */}
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
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                  {hasActiveFilters ? "No parents match your filters." : "No parents found."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

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

const SERVICE_LABELS: Record<string, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
};

const JOURNEY_STATUS_LABELS: Record<string, string> = {
  CONSULTATION_BOOKED: "Call Booked",
  PROVIDER_CONNECTED: "Connected",
  MATCH_CALL: "Match Call",
  MATCHED: "Matched",
  DEPOSIT_PAID: "Deposit Paid",
  AGREEMENT_SIGNED: "Agreement Signed",
};

function ProviderParentContactsView({ providerId }: { providerId: string }) {
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
  const hasActiveFilters = !!(searchQuery || serviceFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo);
  const clearFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      ["q", "svc", "status", "from", "to"].forEach(k => next.delete(k));
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
      if (dateFrom && (!p.sessionCreatedAt || new Date(p.sessionCreatedAt) < new Date(`${dateFrom}T00:00:00`))) return false;
      if (dateTo && (!p.sessionCreatedAt || new Date(p.sessionCreatedAt) > new Date(`${dateTo}T23:59:59`))) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return [p.name, p.email, p.mobileNumber].filter(Boolean).some((f: string) => f.toLowerCase().includes(q));
    }),
    (p: any, key: string) => {
      switch (key) {
        case "name": return (p.name || "").toLowerCase();
        case "service": return p.serviceType || "";
        case "status": return p.matchStatus || "";
        case "created": return p.sessionCreatedAt ? new Date(p.sessionCreatedAt).getTime() : 0;
        case "updated": return p.sessionUpdatedAt ? new Date(p.sessionUpdatedAt).getTime() : 0;
        default: return null;
      }
    },
  );

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">Parents</h1>
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
      </div>
        <ClearFiltersButton pill show={hasActiveFilters} onClick={clearFilters} testId="provider-parents-clear-filters" />
      </div>

      {/* overflow-x-auto so wide rows scroll horizontally instead of
          wrapping. whitespace-nowrap on every cell enforces single-line
          per column. Source column was removed - every parent in this
          table got here by booking a consultation through the AI chat,
          so "source" was always the same value and the column didn't
          earn its width. */}
      <Card className="overflow-x-auto">
        <Table className="[&_th]:px-2 [&_td]:px-2 [&_th]:text-xs">
          <TableHeader>
            <TableRow>
              <SortableTableHead label="Name" sortKey="name" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
              <TableHead className="hidden sm:table-cell whitespace-nowrap">Email</TableHead>
              <TableHead className="hidden md:table-cell whitespace-nowrap">Mobile</TableHead>
              <SortableTableHead label="Services" sortKey="service" currentSort={sortConfig} onSort={handleSort} className="hidden lg:table-cell whitespace-nowrap" />
              <SortableTableHead label="Match Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} className="hidden lg:table-cell whitespace-nowrap" />
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Cost Sheets</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Invoices</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Agreements</TableHead>
              <SortableTableHead label="Created" sortKey="created" currentSort={sortConfig} onSort={handleSort} className="hidden xl:table-cell whitespace-nowrap" />
              <SortableTableHead label="Updated" sortKey="updated" currentSort={sortConfig} onSort={handleSort} className="hidden xl:table-cell whitespace-nowrap" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length > 0 ? filtered.map((row: any) => (
              <TableRow
                // Row key has to include the sessionId/rowId so a parent
                // with multiple matches (e.g. surrogacy + egg donation
                // sessions) renders as multiple distinct rows.
                key={row.rowId || row.id}
                data-testid={`row-match-${row.rowId || row.id}`}
                className="cursor-pointer hover:bg-secondary/30"
                onClick={() => {
                  // Click anywhere on the row navigates into the parent
                  // detail page. The session-specific chat link is
                  // implicit since most parents only have one session.
                  navigate(`/parents/${row.id}`);
                }}
              >
                <TableCell className="font-ui whitespace-nowrap">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-[var(--radius)] bg-primary/10 flex items-center justify-center text-primary shrink-0">
                      <UserCircle className="w-4 h-4" />
                    </div>
                    <span data-testid={`text-parent-name-${row.id}`}>{row.name || "-"}</span>
                    {row.name && <CopyButton value={row.name} testId={`btn-copy-name-${row.rowId}`} />}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell whitespace-nowrap" data-testid={`text-parent-email-${row.id}`}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate max-w-[150px] inline-block align-middle" title={row.email}>{row.email}</span>
                    <CopyButton value={row.email} testId={`btn-copy-email-${row.rowId}`} />
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap" data-testid={`text-parent-mobile-${row.id}`}>
                  {row.mobileNumber ? (
                    <div className="flex items-center gap-1 text-sm">
                      <span className="whitespace-nowrap">{formatPhoneDisplay(row.mobileNumber)}</span>
                      <CopyButton value={row.mobileNumber} testId={`btn-copy-mobile-${row.rowId}`} />
                    </div>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  {row.serviceType ? (
                    <span className="text-xs font-ui px-2 py-0.5 rounded-full" style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}>
                      {SERVICE_LABELS[row.serviceType] || row.serviceType}
                    </span>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <MatchStatusBadge status={row.matchStatus} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <ParentCostSheetsCell costSheets={row.costSheets || []} sessionId={row.sessionId} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <ParentInvoicesCell invoices={row.invoices || []} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <ParentAgreementsCell agreements={row.agreements || []} />
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap">
                  <span className="text-sm text-muted-foreground">{row.sessionCreatedAt ? new Date(row.sessionCreatedAt).toLocaleDateString() : "-"}</span>
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap">
                  <span className="text-sm text-muted-foreground">{row.sessionUpdatedAt ? new Date(row.sessionUpdatedAt).toLocaleDateString() : "-"}</span>
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  {searchQuery ? "No parents match your search." : "No parent contacts yet. Parents will appear here when the AI concierge connects them with you."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

// ─── Match status badge ─────────────────────────────────────────────────────
//
// Mirrors the chat right-pane "Match Status" pill exactly so providers see
// the same label + color treatment whether they're looking at the chat or
// the Parents table.
//   CONSULTATION_BOOKED -> "Call Booked" (success / green)
//   PROVIDER_CONNECTED  -> "Connected"   (success / green)
// ACTIVE (anonymous Q&A) shouldn't reach the table - the server filters it
// out so the agency only sees parents who've actually committed to a
// consultation. Anything unexpected falls through to a neutral pill.
function MatchStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-muted-foreground text-sm">-</span>;
  // Journey ladder (server derives the most-advanced stage per session):
  // Call Booked -> Connected -> Match Call -> Matched -> Deposit Paid ->
  // Agreement Signed. Early stages green, match milestones accent/primary.
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    CONSULTATION_BOOKED: { label: "Call Booked", bg: "hsl(var(--brand-success) / 0.12)", fg: "hsl(var(--brand-success))" },
    PROVIDER_CONNECTED: { label: "Connected", bg: "hsl(var(--brand-success) / 0.12)", fg: "hsl(var(--brand-success))" },
    MATCH_CALL: { label: "Match Call", bg: "hsl(var(--brand-warning) / 0.15)", fg: "hsl(var(--brand-warning))" },
    MATCHED: { label: "Matched", bg: "hsl(var(--accent) / 0.15)", fg: "hsl(var(--accent))" },
    DEPOSIT_PAID: { label: "Deposit Paid", bg: "hsl(var(--primary) / 0.12)", fg: "hsl(var(--primary))" },
    AGREEMENT_SIGNED: { label: "Agreement Signed", bg: "hsl(var(--primary) / 0.12)", fg: "hsl(var(--primary))" },
  };
  const entry = map[status];
  if (!entry) {
    return (
      <span
        className="text-xs font-ui px-2 py-0.5 rounded-full"
        style={{ background: "hsl(var(--secondary))", color: "hsl(var(--foreground))" }}
      >
        {status}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full"
      style={{ background: entry.bg, color: entry.fg }}
    >
      <CheckCircle2 className="w-3 h-3" />
      {entry.label}
    </span>
  );
}

// ─── Invoices cell ──────────────────────────────────────────────────────────
//
// Each invoice is a clickable chip that opens the provider-side invoice
// document. The backend chooses what to serve:
//   - PAID    -> the receipt PDF that was emailed to parent + agency
//   - UNPAID  -> a branded HTML document styled like the payment-request
//                email body (no payment buttons - provider is just viewing).
// Real <a target="_blank"> so cmd-click / middle-click opens in a new tab
// without leaving the Parents list.
function ParentInvoicesCell({ invoices }: { invoices: any[] }) {
  if (!invoices || invoices.length === 0) {
    return <span className="text-muted-foreground text-sm">-</span>;
  }
  // Cap at 2 chips + "+N" so a busy journey doesn't blow up the row
  const shown = invoices.slice(0, 2);
  const extra = invoices.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {shown.map(inv => {
        const isPaid = inv.status === "PAID";
        const isAwaiting = inv.status === "AWAITING_PAYMENT" || inv.status === "PAYMENT_PROCESSING";
        const tone = isPaid ? "success" : isAwaiting ? "warning" : "muted";
        const bg =
          tone === "success" ? "hsl(var(--brand-success) / 0.12)"
          : tone === "warning" ? "hsl(var(--brand-warning) / 0.15)"
          : "hsl(var(--secondary))";
        const fg =
          tone === "success" ? "hsl(var(--brand-success))"
          : tone === "warning" ? "hsl(var(--brand-warning))"
          : "hsl(var(--foreground))";
        return (
          <a
            key={inv.id}
            href={`/api/provider/invoices/${inv.id}/document`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs font-ui px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity"
            style={{ background: bg, color: fg }}
            title={`${inv.serviceType?.replace(/_/g, " ")} - $${(inv.serviceAmount / 100).toLocaleString()} - ${inv.status}${isPaid ? " (opens receipt PDF)" : " (opens invoice document)"}`}
          >
            ${(inv.serviceAmount / 100).toLocaleString()}
          </a>
        );
      })}
      {extra > 0 && (
        <span
          className="text-xs font-ui px-1.5 py-0.5 rounded-full"
          style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
          title={invoices.slice(2).map(inv => `$${(inv.serviceAmount / 100).toLocaleString()} - ${inv.status}`).join("\n")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

// ─── Cost sheets cell ───────────────────────────────────────────────────────
//
// One chip per cost sheet on the session, colored by state. Click deep-links
// into the chat scrolled to that cost-sheet card (?msg=quote:<id>).
function ParentCostSheetsCell({ costSheets, sessionId }: { costSheets: any[]; sessionId: string | null }) {
  const navigate = useNavigate();
  if (!costSheets || costSheets.length === 0) {
    return <span className="text-muted-foreground text-sm">-</span>;
  }
  // Cap at 2 chips + "+N" (some journeys accumulate many superseded quotes)
  const shown = costSheets.slice(0, 2);
  const extra = costSheets.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {shown.map(cs => {
        const superseded = !!cs.supersededAt;
        const acked = !superseded && !!cs.parentAcknowledgedAt;
        const bg = acked ? "hsl(var(--brand-success) / 0.12)"
          : superseded ? "hsl(var(--secondary))"
          : "hsl(var(--brand-warning) / 0.15)";
        const fg = acked ? "hsl(var(--brand-success))"
          : superseded ? "hsl(var(--muted-foreground))"
          : "hsl(var(--brand-warning))";
        return (
          <button
            key={cs.id}
            type="button"
            onClick={e => {
              e.stopPropagation();
              const sid = cs.sessionId || sessionId;
              if (sid) navigate(`/chat/${sid}?msg=quote:${cs.id}`);
            }}
            className="text-xs font-ui px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity"
            style={{ background: bg, color: fg, opacity: superseded ? 0.75 : 1 }}
            title={`${superseded ? "Superseded" : acked ? "Acknowledged" : "Awaiting review"} - ${new Date(cs.createdAt).toLocaleDateString()}`}
          >
            ${((cs.totalCostCents || 0) / 100).toLocaleString()}
          </button>
        );
      })}
      {extra > 0 && (
        <span
          className="text-xs font-ui px-1.5 py-0.5 rounded-full"
          style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
          title={costSheets.slice(2).map(cs => `$${((cs.totalCostCents || 0) / 100).toLocaleString()}${cs.supersededAt ? " (superseded)" : ""}`).join("\n")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

// ─── Agreements cell ────────────────────────────────────────────────────────
//
// One chip per agreement on the session, colored by signing state. Click
// opens the agreement page in a new tab without leaving the Parents list.
function ParentAgreementsCell({ agreements }: { agreements: any[] }) {
  if (!agreements || agreements.length === 0) {
    return <span className="text-muted-foreground text-sm">-</span>;
  }
  const shown = agreements.slice(0, 2);
  const extra = agreements.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {shown.map(agr => {
        const isSigned = agr.status === "SIGNED";
        const isSent = agr.status === "SENT";
        const bg = isSigned
          ? "hsl(var(--brand-success) / 0.12)"
          : isSent ? "hsl(var(--brand-warning) / 0.15)"
          : "hsl(var(--secondary))";
        const fg = isSigned
          ? "hsl(var(--brand-success))"
          : isSent ? "hsl(var(--brand-warning))"
          : "hsl(var(--foreground))";
        const label = isSigned ? "Signed" : isSent ? "Awaiting Signature" : agr.status.charAt(0) + agr.status.slice(1).toLowerCase();
        return (
          <a
            key={agr.id}
            href={`/agreements/${agr.id}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs font-ui px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity"
            style={{ background: bg, color: fg }}
            title={`${agr.documentType} - ${agr.status}`}
          >
            {label}
          </a>
        );
      })}
      {extra > 0 && (
        <span
          className="text-xs font-ui px-1.5 py-0.5 rounded-full"
          style={{ background: "hsl(var(--secondary))", color: "hsl(var(--muted-foreground))" }}
          title={agreements.slice(2).map(agr => `${agr.documentType} - ${agr.status}`).join("\n")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
