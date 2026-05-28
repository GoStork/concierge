import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Plus, UserCircle, Trash2, Pencil, Loader2, Phone, Search, XCircle, Calendar, ChevronDown, Copy, Check } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { getPhotoSrc } from "@/lib/profile-utils";
import { parsePhoneNumber } from "libphonenumber-js";

function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try { return parsePhoneNumber(raw).formatInternational(); } catch { return raw; }
}
import { useToast } from "@/hooks/use-toast";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import MembersTable from "@/components/members-table";

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
};

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
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

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

  const hasActiveFilters = searchQuery.trim() !== "" || dateFrom !== "" || dateTo !== "";

  const filteredUsers = parentUsers.filter(member => {
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
    setSearchQuery("");
    setDateFrom("");
    setDateTo("");
  }

  const sortedUsers = sortData(filteredUsers, (item, key) => {
    switch (key) {
      case "name": return item.name || "";
      case "email": return item.email;
      case "mobile": return item.mobileNumber || "";
      case "created": return item.createdAt || "";
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

      <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide" data-testid="card-parent-filters">
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
          <PopoverContent className="w-56 p-3" align="start">
            <div className="space-y-2">
              <span className="text-sm font-medium">From Date</span>
              <Input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-date-from"
              />
              {dateFrom && (
                <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setDateFrom("")}>
                  Clear
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant={dateTo ? "default" : "outline"} size="sm" className="shrink-0 h-8 text-xs rounded-full gap-1" data-testid="filter-btn-date-to">
              <Calendar className="w-3 h-3" />
              {dateTo || "To"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-3" align="start">
            <div className="space-y-2">
              <span className="text-sm font-medium">To Date</span>
              <Input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-date-to"
              />
              {dateTo && (
                <Button variant="ghost" size="sm" className="text-xs h-6" onClick={() => setDateTo("")}>
                  Clear
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground hover:text-foreground h-8 px-2 shrink-0 rounded-full" data-testid="button-clear-filters">
            <XCircle className="w-4 h-4" />
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        <Table>
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
              <SortableTableHead label="Created" sortKey="created" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-created" />
              <TableHead className="text-right whitespace-nowrap">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedUsers.length > 0 ? sortedUsers.map((member) => (
              <TableRow key={member.id} data-testid={`row-staff-${member.id}`} className="cursor-pointer" onClick={() => navigate(`/users/${member.id}`)}>
                <TableCell className="pl-4 w-10" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(member.id)}
                    onCheckedChange={() => toggleSelect(member.id)}
                    aria-label={`Select ${member.name || member.email}`}
                    data-testid={`checkbox-select-${member.id}`}
                  />
                </TableCell>
                <TableCell className="font-ui">
                  <div className="flex items-center gap-3">
                    {getPhotoSrc(member.photoUrl) ? (
                      <img src={getPhotoSrc(member.photoUrl)!} alt="" className="w-8 h-8 rounded-[var(--radius)] object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded-[var(--radius)] bg-primary/10 flex items-center justify-center text-primary">
                        <UserCircle className="w-4 h-4" />
                      </div>
                    )}
                    <button type="button" className="text-left hover:text-primary hover:underline transition-colors cursor-pointer" onClick={(e) => { e.stopPropagation(); navigate(`/users/${member.id}`); }} data-testid={`link-user-name-${member.id}`}>{member.name || "-"}</button>
                    {member.name && <CopyButton value={member.name} testId={`btn-copy-name-${member.id}`} />}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell" data-testid={`text-email-${member.id}`}>
                  <div className="flex items-center gap-1.5">
                    <span>{member.email}</span>
                    <CopyButton value={member.email} testId={`btn-copy-email-${member.id}`} />
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell" data-testid={`text-mobile-${member.id}`}>
                  {member.mobileNumber ? (
                    <div className="flex items-center gap-1 text-sm">
                      <Phone className="w-3 h-3 text-muted-foreground" />
                      <span>{formatPhone(member.mobileNumber)}</span>
                      <CopyButton value={member.mobileNumber} testId={`btn-copy-mobile-${member.id}`} />
                    </div>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell" data-testid={`text-created-${member.id}`}>
                  {member.createdAt ? (
                    <span className="text-sm text-muted-foreground">{new Date(member.createdAt).toLocaleDateString()}</span>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/users/${member.id}`)} data-testid={`button-edit-${member.id}`}><Pencil className="w-4 h-4" /></Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteMember(member)} data-testid={`button-delete-${member.id}`}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
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

function ProviderParentContactsView({ providerId }: { providerId: string }) {
  const [searchQuery, setSearchQuery] = useState("");
  const navigate = useNavigate();

  const { data: parents, isLoading } = useQuery<any[]>({
    queryKey: [`/api/providers/${providerId}/parent-contacts`],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/parent-contacts`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const filtered = (parents || []).filter(p => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return [p.name, p.email, p.mobileNumber].filter(Boolean).some((f: string) => f.toLowerCase().includes(q));
  });

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">Parents</h1>
        <p className="text-muted-foreground">Parents who have connected with you via the AI concierge or meetings.</p>
      </div>

      <div className="flex items-center gap-3">
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
      </div>

      {/* overflow-x-auto so wide rows scroll horizontally instead of
          wrapping a single value across two lines (phone numbers and
          source pills used to break). whitespace-nowrap on every cell
          enforces single-line per column. */}
      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Name</TableHead>
              <TableHead className="hidden sm:table-cell whitespace-nowrap">Email</TableHead>
              <TableHead className="hidden md:table-cell whitespace-nowrap">Mobile</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Source</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Status</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Last Meeting</TableHead>
              <TableHead className="hidden lg:table-cell text-right whitespace-nowrap">Meetings</TableHead>
              <TableHead className="hidden lg:table-cell whitespace-nowrap">Invoices</TableHead>
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
                    <span>{row.email}</span>
                    <CopyButton value={row.email} testId={`btn-copy-email-${row.rowId}`} />
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap" data-testid={`text-parent-mobile-${row.id}`}>
                  {row.mobileNumber ? (
                    <div className="flex items-center gap-1 text-sm">
                      <Phone className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="whitespace-nowrap">{formatPhone(row.mobileNumber)}</span>
                      <CopyButton value={row.mobileNumber} testId={`btn-copy-mobile-${row.rowId}`} />
                    </div>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <span className={`text-xs font-ui px-2 py-0.5 rounded-full whitespace-nowrap ${
                    row.source === "chat" ? "bg-primary/10 text-primary" :
                    row.source === "both" ? "bg-emerald-100 text-emerald-700" :
                    "bg-muted text-muted-foreground"
                  }`} data-testid={`text-parent-source-${row.id}`}>
                    {row.source === "chat" ? "Concierge" : row.source === "both" ? "Chat + Meeting" : "Meeting"}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <MatchStatusBadge status={row.matchStatus} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  {row.lastMeetingAt ? (
                    <span className="text-sm text-muted-foreground">{new Date(row.lastMeetingAt).toLocaleDateString()}</span>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right whitespace-nowrap">
                  <span className="text-sm text-muted-foreground" data-testid={`text-meeting-count-${row.id}`}>{row.meetingCount}</span>
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <ParentInvoicesCell invoices={row.invoices || []} />
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
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
// Mirrors the labels used on the chat sidebar so providers see consistent
// wording across pages. Maps the AiChatSession.status enum onto the
// human-readable wording from CLAUDE.md's session-lifecycle spec:
//   ACTIVE              -> "Q&A"        (anonymous whisper Q&A pre-booking)
//   CONSULTATION_BOOKED -> "Call Booked"
//   PROVIDER_CONNECTED  -> "Connected"  (provider has chatted directly)
//   anything else / null -> "-"
function MatchStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-muted-foreground text-sm">-</span>;
  const map: Record<string, { label: string; tone: "muted" | "warning" | "success" }> = {
    ACTIVE: { label: "Q&A", tone: "muted" },
    CONSULTATION_BOOKED: { label: "Call Booked", tone: "warning" },
    PROVIDER_CONNECTED: { label: "Connected", tone: "success" },
  };
  const entry = map[status] || { label: status, tone: "muted" as const };
  const bg =
    entry.tone === "success" ? "hsl(var(--brand-success) / 0.12)"
    : entry.tone === "warning" ? "hsl(var(--brand-warning) / 0.15)"
    : "hsl(var(--secondary))";
  const fg =
    entry.tone === "success" ? "hsl(var(--brand-success))"
    : entry.tone === "warning" ? "hsl(var(--brand-warning))"
    : "hsl(var(--foreground))";
  return (
    <span className="text-xs font-ui px-2 py-0.5 rounded-full" style={{ background: bg, color: fg }}>
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
  return (
    <div className="flex flex-wrap gap-1.5">
      {invoices.map(inv => {
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
    </div>
  );
}
