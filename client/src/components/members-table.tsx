import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getPhotoSrc } from "@/lib/profile-utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { Plus, UserCircle, Trash2, Pencil, Loader2, Phone, MapPin, Video, Calendar, Copy, Check } from "lucide-react";

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
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";

const PROVIDER_ROLES: Record<string, string> = {
  PROVIDER_ADMIN: "Provider Admin",
  SURROGACY_COORDINATOR: "Surrogacy Coordinator",
  EGG_DONOR_COORDINATOR: "Egg Donor Coordinator",
  SPERM_DONOR_COORDINATOR: "Sperm Donor Coordinator",
  IVF_CLINIC_COORDINATOR: "IVF Clinic Coordinator",
  DOCTOR: "Doctor",
  BILLING_MANAGER: "Billing Manager",
};

const GOSTORK_ROLES: Record<string, string> = {
  GOSTORK_ADMIN: "Admin",
  GOSTORK_CONCIERGE: "Concierge",
  GOSTORK_DEVELOPER: "Developer",
};

const PARENT_ROLES: Record<string, string> = {
  INTENDED_PARENT_1: "Intended Parent 1",
  INTENDED_PARENT_2: "Intended Parent 2",
  VIEWER: "Viewer",
};

export type MembersTableContext = "provider" | "gostork" | "parent";

type MemberData = {
  id: string;
  name: string | null;
  email: string;
  roles?: string[];
  mobileNumber: string | null;
  photoUrl: string | null;
  dailyRoomUrl?: string | null;
  calendarLink?: string | null;
  calendarConnections?: { id: string; provider: string; email: string | null; label: string | null; tokenValid?: boolean; connected?: boolean }[];
  scheduleConfig?: { bookingPageSlug: string | null } | null;
  allLocations?: boolean;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  parentAccountRole?: string;
  assignedLocations?: { id: string; locationId: string; location: { id: string; city: string; state: string; address?: string; zip?: string } }[];
};

type MembersTableProps = {
  context: MembersTableContext;
  providerId?: string;
  currentUserId: string;
  canManage: boolean;
  isAdmin?: boolean;
  compact?: boolean;
};

function getRoleLabel(role: string, context: MembersTableContext): string {
  if (context === "parent") return PARENT_ROLES[role] || role;
  if (context === "gostork") return GOSTORK_ROLES[role] || role;
  return PROVIDER_ROLES[role] || role;
}

function getRelevantRoles(roles: string[], context: MembersTableContext): string[] {
  if (context === "gostork") return roles.filter(r => r in GOSTORK_ROLES);
  if (context === "provider") return roles.filter(r => r in PROVIDER_ROLES);
  return roles;
}

function getAddUrl(context: MembersTableContext, providerId?: string): string {
  if (context === "provider") return `/users/new?provider=${providerId}`;
  if (context === "gostork") return `/users/new?team=gostork`;
  return `/users/new?parentAccount=true`;
}

function getEditUrl(memberId: string, context: MembersTableContext, providerId?: string): string {
  if (context === "provider") return `/users/${memberId}?provider=${providerId}`;
  if (context === "gostork") return `/users/${memberId}?team=gostork`;
  return `/users/${memberId}?parentAccount=true`;
}

function getAddLabel(context: MembersTableContext): string {
  if (context === "parent") return "Add Member";
  return "Add Team Member";
}

function showLocationColumn(_context: MembersTableContext): boolean {
  return true;
}

function showVideoColumn(context: MembersTableContext): boolean {
  return context === "provider" || context === "gostork";
}

function showCalendarColumn(context: MembersTableContext): boolean {
  return context === "provider" || context === "gostork";
}

export default function MembersTable({ context, providerId, currentUserId, canManage, isAdmin, compact }: MembersTableProps) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [deleteMember, setDeleteMember] = useState<MemberData | null>(null);
  const { sortConfig, handleSort, sortData } = useTableSort();

  const queryKey: (string | undefined)[] =
    context === "provider" ? ["/api/providers", providerId, "users"] :
    context === "gostork" ? ["/api/users"] :
    ["/api/parent-account/members"];

  const { data: rawMembers, isLoading } = useQuery<MemberData[]>({
    queryKey,
    queryFn: async () => {
      if (context === "provider") {
        const res = await fetch(`/api/providers/${providerId}/users`, { credentials: "include" });
        if (!res.ok) throw new Error("Failed to fetch members");
        return res.json();
      }
      if (context === "gostork") {
        const res = await fetch("/api/users", { credentials: "include" });
        if (!res.ok) throw new Error("Failed to fetch members");
        const all = await res.json();
        return all.filter((u: MemberData) => (u.roles || []).some((r: string) => r in GOSTORK_ROLES));
      }
      const res = await fetch("/api/parent-account/members", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch members");
      return res.json();
    },
    enabled: context !== "provider" || !!providerId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (userId: string) => {
      if (context === "parent") {
        await apiRequest("DELETE", `/api/parent-account/members/${userId}`);
      } else if (context === "provider") {
        const url = isAdmin ? `/api/users/${userId}` : `/api/providers/${providerId}/users/${userId}`;
        await apiRequest("DELETE", url);
      } else {
        await apiRequest("DELETE", `/api/users/${userId}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      setDeleteMember(null);
      toast({ title: context === "parent" ? "Member removed" : "Team member removed", variant: "success" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });


  const members = rawMembers || [];
  const baseSorted = [...members].sort((a, b) => {
    if (a.id === currentUserId) return -1;
    if (b.id === currentUserId) return 1;
    return 0;
  });
  const sortedMembers = sortData(baseSorted, (item, key) => {
    switch (key) {
      case "name": return item.name || "";
      case "email": return item.email;
      case "mobile": return item.mobileNumber || "";
      case "roles": {
        if (context === "parent") return getRoleLabel(item.parentAccountRole || "", context);
        return getRelevantRoles(item.roles || [], context).map(r => getRoleLabel(r, context)).join(", ");
      }
      default: return "";
    }
  });

  const hasLocations = showLocationColumn(context);
  const hasVideo = showVideoColumn(context);
  const hasCalendar = showCalendarColumn(context);
  const showActionsColumn = canManage || members?.some(m => m.id === currentUserId);
  const colCount = 4 + (hasLocations ? 1 : 0) + (hasVideo ? 1 : 0) + (hasCalendar ? 1 : 0) + (showActionsColumn ? 1 : 0);

  if (isLoading) return <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;

  const canEditMember = (member: MemberData) => {
    if (member.id === currentUserId) return true;
    if (!canManage) return false;
    return true;
  };

  const canDeleteMember = (member: MemberData) => {
    if (!canManage) return false;
    if (member.id === currentUserId) return false;
    if (context === "parent") return member.parentAccountRole !== "INTENDED_PARENT_1";
    return true;
  };

  const handleEdit = (member: MemberData) => {
    navigate(getEditUrl(member.id, context, providerId));
  };

  return (
    <div className="space-y-4">
      {!compact && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{sortedMembers.length} {context === "parent" ? "member" : "team member"}{sortedMembers.length !== 1 ? "s" : ""}</p>
          {canManage && (
            <Button size="sm" onClick={() => navigate(getAddUrl(context, providerId))} data-testid="button-add-member">
              <Plus className="w-4 h-4 mr-1" /> {getAddLabel(context)}
            </Button>
          )}
        </div>
      )}

      {compact && canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => navigate(getAddUrl(context, providerId))} data-testid="button-add-member">
            <Plus className="w-4 h-4 mr-1" /> {getAddLabel(context)}
          </Button>
        </div>
      )}

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead label="Name" sortKey="name" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
              <SortableTableHead label="Email" sortKey="email" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden sm:table-cell" />
              <SortableTableHead label="Mobile" sortKey="mobile" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden md:table-cell" />
              {hasLocations && <TableHead className="whitespace-nowrap hidden lg:table-cell">Location</TableHead>}
              <SortableTableHead label={context === "parent" ? "Role" : "Roles"} sortKey="roles" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap hidden sm:table-cell" />
              {hasVideo && <TableHead className="whitespace-nowrap hidden lg:table-cell">Video Room</TableHead>}
              {hasCalendar && <TableHead className="whitespace-nowrap hidden lg:table-cell">Calendar</TableHead>}
              {showActionsColumn && <TableHead className="text-right whitespace-nowrap">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedMembers.length > 0 ? sortedMembers.map((member) => {
              const isSelf = member.id === currentUserId;

              return (
                <TableRow key={member.id} data-testid={`row-member-${member.id}`} className={`cursor-pointer ${isSelf ? "bg-primary/5" : ""}`} onClick={() => canEditMember(member) && handleEdit(member)}>
                  <TableCell className="font-ui">
                    <div className="flex items-center gap-2">
                      {member.photoUrl ? (
                        <img src={getPhotoSrc(member.photoUrl)!} alt="" className="w-7 h-7 rounded-[var(--radius)] object-cover shrink-0" />
                      ) : (
                        <div className="w-7 h-7 rounded-[var(--radius)] bg-primary/10 flex items-center justify-center text-primary shrink-0">
                          <UserCircle className="w-4 h-4" />
                        </div>
                      )}
                      <div className="truncate flex items-center gap-1">
                        {canEditMember(member) ? (
                          <button type="button" className="text-left hover:text-primary hover:underline transition-colors cursor-pointer" onClick={(e) => { e.stopPropagation(); handleEdit(member); }} data-testid={`link-member-name-${member.id}`}>{member.name || "-"}</button>
                        ) : (
                          <span data-testid={`text-member-name-${member.id}`}>{member.name || "-"}</span>
                        )}
                        {member.name && <CopyButton value={member.name} testId={`btn-copy-name-${member.id}`} />}
                        {isSelf && <span className="text-xs text-muted-foreground ml-1">(you)</span>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm whitespace-nowrap hidden sm:table-cell" data-testid={`text-member-email-${member.id}`}>
                    <span className="inline-flex items-center gap-1">
                      {member.email}
                      <CopyButton value={member.email} testId={`btn-copy-email-${member.id}`} />
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap hidden md:table-cell" data-testid={`text-member-mobile-${member.id}`}>
                    {member.mobileNumber ? (
                      <span className="flex items-center gap-1 text-sm">
                        <Phone className="w-3 h-3 text-muted-foreground" />{member.mobileNumber}
                        <CopyButton value={member.mobileNumber} testId={`btn-copy-mobile-${member.id}`} />
                      </span>
                    ) : <span className="text-muted-foreground text-sm">-</span>}
                  </TableCell>
                  {hasLocations && (
                    <TableCell className="hidden lg:table-cell" data-testid={`text-member-location-${member.id}`}>
                      {context === "provider" ? (
                        member.allLocations ? (
                          <span className="flex items-center gap-1 text-sm whitespace-nowrap"><MapPin className="w-3 h-3 text-muted-foreground shrink-0" />All Locations</span>
                        ) : member.assignedLocations && member.assignedLocations.length > 0 ? (
                          <div className="flex flex-col gap-0.5">
                            {member.assignedLocations.map(al => (
                              <span key={al.id} className="flex items-center gap-1 text-sm whitespace-nowrap">
                                <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />{al.location.city}, {al.location.state}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )
                      ) : (
                        member.city || member.state || member.country ? (
                          <span className="flex items-center gap-1 text-sm whitespace-nowrap">
                            <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                            {[member.city, member.state, member.country].filter(Boolean).join(", ")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )
                      )}
                    </TableCell>
                  )}
                  <TableCell className="hidden sm:table-cell">
                    {context === "parent" ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-ui bg-primary/10 text-primary" data-testid={`badge-role-${member.id}`}>
                        {getRoleLabel(member.parentAccountRole || "", context)}
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {getRelevantRoles(member.roles || [], context).map(r => (
                          <span key={r} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-ui bg-primary/10 text-primary" data-testid={`badge-role-${member.id}-${r}`}>
                            {getRoleLabel(r, context)}
                          </span>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  {hasVideo && (
                    <TableCell className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()} data-testid={`text-member-video-${member.id}`}>
                      {member.dailyRoomUrl ? (
                        <a href={member.dailyRoomUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-primary hover:underline truncate max-w-[180px]" title={member.dailyRoomUrl}>
                          <Video className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{member.dailyRoomUrl.split("/").pop()}</span>
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-sm">-</span>
                      )}
                    </TableCell>
                  )}
                  {hasCalendar && (
                    <TableCell className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()} data-testid={`text-member-calendar-${member.id}`}>
                      {member.scheduleConfig?.bookingPageSlug ? (
                        <a href={`/book/${member.scheduleConfig.bookingPageSlug}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-primary hover:underline truncate max-w-[180px]" title={`${window.location.origin}/book/${member.scheduleConfig.bookingPageSlug}`}>
                          <Calendar className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{member.scheduleConfig.bookingPageSlug}</span>
                        </a>
                      ) : member.calendarConnections && member.calendarConnections.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {member.calendarConnections.map((conn) => (
                            <span key={conn.id} className="flex items-center gap-1 text-sm text-primary truncate max-w-[180px]" title={`${conn.label || conn.provider}${conn.email ? ` (${conn.email})` : ""}`}>
                              <Calendar className="w-3.5 h-3.5 shrink-0" />
                              <span className="truncate">{conn.label || conn.provider}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">-</span>
                      )}
                    </TableCell>
                  )}
                  {showActionsColumn && (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {canEditMember(member) && (
                          <Button variant="ghost" size="sm" onClick={() => handleEdit(member)} data-testid={`button-edit-member-${member.id}`}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                        )}
                        {canDeleteMember(member) && (
                          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteMember(member)} data-testid={`button-delete-member-${member.id}`}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            }) : (
              <TableRow>
                <TableCell colSpan={colCount} className="text-center text-muted-foreground py-8">
                  No {context === "parent" ? "members" : "team members"} found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={!!deleteMember} onOpenChange={(open) => { if (!open) setDeleteMember(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {context === "parent" ? "Member" : "Team Member"}</DialogTitle>
            <DialogDescription>Are you sure you want to remove {deleteMember?.name || deleteMember?.email}? This action cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteMember(null)} data-testid="button-cancel-delete">Cancel</Button>
            <Button variant="destructive" onClick={() => deleteMember && deleteMutation.mutate(deleteMember.id)} disabled={deleteMutation.isPending} data-testid="button-confirm-delete">
              {deleteMutation.isPending ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
