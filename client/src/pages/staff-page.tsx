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
import { getPhotoSrc } from "@/lib/profile-utils";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { sortConfig, handleSort, sortData } = useTableSort();

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

  if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-heading text-primary" data-testid="text-page-title">Parents</h1>
          <p className="text-muted-foreground">Manage intended parent accounts.</p>
        </div>
        <Button onClick={() => navigate("/users/new")} className="shrink-0" data-testid="button-add-staff">
          <Plus className="w-4 h-4 mr-2" /> Add Parent
        </Button>
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
                      <span>{member.mobileNumber}</span>
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
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
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
    </div>
  );
}

function ProviderParentContactsView({ providerId }: { providerId: string }) {
  const [searchQuery, setSearchQuery] = useState("");

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

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">Email</TableHead>
              <TableHead className="hidden md:table-cell">Mobile</TableHead>
              <TableHead className="hidden lg:table-cell">Source</TableHead>
              <TableHead className="hidden lg:table-cell">Last Meeting</TableHead>
              <TableHead className="hidden lg:table-cell text-right">Meetings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length > 0 ? filtered.map((parent: any) => (
              <TableRow key={parent.id} data-testid={`row-parent-contact-${parent.id}`}>
                <TableCell className="font-ui">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-[var(--radius)] bg-primary/10 flex items-center justify-center text-primary">
                      <UserCircle className="w-4 h-4" />
                    </div>
                    <span data-testid={`text-parent-name-${parent.id}`}>{parent.name || "-"}</span>
                    {parent.name && <CopyButton value={parent.name} testId={`btn-copy-name-${parent.id}`} />}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell" data-testid={`text-parent-email-${parent.id}`}>
                  <div className="flex items-center gap-1.5">
                    <span>{parent.email}</span>
                    <CopyButton value={parent.email} testId={`btn-copy-email-${parent.id}`} />
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell" data-testid={`text-parent-mobile-${parent.id}`}>
                  {parent.mobileNumber ? (
                    <div className="flex items-center gap-1 text-sm">
                      <Phone className="w-3 h-3 text-muted-foreground" />
                      <span>{parent.mobileNumber}</span>
                      <CopyButton value={parent.mobileNumber} testId={`btn-copy-mobile-${parent.id}`} />
                    </div>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className={`text-xs font-ui px-2 py-0.5 rounded-full ${
                    parent.source === "chat" ? "bg-primary/10 text-primary" :
                    parent.source === "both" ? "bg-emerald-100 text-emerald-700" :
                    "bg-muted text-muted-foreground"
                  }`} data-testid={`text-parent-source-${parent.id}`}>
                    {parent.source === "chat" ? "Concierge" : parent.source === "both" ? "Chat + Meeting" : "Meeting"}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {parent.lastMeetingAt ? (
                    <span className="text-sm text-muted-foreground">{new Date(parent.lastMeetingAt).toLocaleDateString()}</span>
                  ) : <span className="text-muted-foreground text-sm">-</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right">
                  <span className="text-sm text-muted-foreground" data-testid={`text-meeting-count-${parent.id}`}>{parent.meetingCount}</span>
                </TableCell>
              </TableRow>
            )) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
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
