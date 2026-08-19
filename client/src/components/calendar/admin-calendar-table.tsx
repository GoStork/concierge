/**
 * GoStork admin calendar management.
 *
 * A table of every user who can hold a calendar (provider staff + GoStork
 * staff) with their connection status. Clicking a row opens that user's full
 * calendar configuration inline (CalendarSettings in forUser mode) - no
 * dialogs, and the selected user lives in a URL search param so the browser
 * back button returns to the table.
 *
 * Used in two places (never fork - pass providerId to scope):
 *  - GoStork admin /account/calendar: all users platform-wide.
 *  - Admin provider edit page Calendar tab: that provider's team only.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CalendarSettings } from "@/components/calendar/calendar-settings";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Calendar, Loader2, Search } from "lucide-react";

interface CalendarUserRow {
  id: string;
  name: string | null;
  email: string;
  roles: string[];
  providerId: string | null;
  providerName: string | null;
  isGoStorkStaff: boolean;
  timezone: string | null;
  bookingPageSlug: string | null;
  hasScheduleConfig: boolean;
  connections: Array<{
    provider: string;
    email: string | null;
    connected: boolean;
    tokenValid: boolean;
    isBookingCalendar: boolean;
  }>;
  connected: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Outlook",
  apple: "Apple",
};

function statusFor(u: CalendarUserRow): { label: string; className: string } {
  const live = u.connections.filter(c => c.connected);
  if (live.length === 0) {
    return { label: "Not connected", className: "bg-muted text-muted-foreground" };
  }
  if (live.some(c => c.tokenValid === false)) {
    return { label: "Expired", className: "bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))]" };
  }
  return { label: "Connected", className: "bg-[hsl(var(--brand-success)/0.15)] text-[hsl(var(--brand-success))]" };
}

export function AdminCalendarTable({ providerId }: { providerId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const selectedUserId = searchParams.get("calendarUser") || "";
  const { user: authUser } = useAuth();
  // Opening YOUR OWN row must mount the settings in owner mode (forUserId
  // undefined): in for-another-user mode the Google/Microsoft/Apple connect
  // flows are hidden because only the owner can authorize them - which left
  // GoStork admins unable to connect a second calendar (the /calendar banner
  // disappears after the first one). Found on the first prod smoke test.
  const forUserId = selectedUserId && selectedUserId !== (authUser as any)?.id ? selectedUserId : undefined;

  const { data: users, isLoading } = useQuery<CalendarUserRow[]>({
    queryKey: ["/api/calendar/admin/users", providerId || "all"],
    queryFn: async () => {
      const url = providerId
        ? `/api/calendar/admin/users?providerId=${encodeURIComponent(providerId)}`
        : "/api/calendar/admin/users";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load calendar users");
      return res.json();
    },
  });

  const selectUser = (id: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (id) next.set("calendarUser", id);
      else next.delete("calendarUser");
      return next;
    }, { replace: true });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = users || [];
    if (q) {
      list = list.filter(u =>
        (u.name || "").toLowerCase().includes(q)
        || u.email.toLowerCase().includes(q)
        || (u.providerName || "").toLowerCase().includes(q),
      );
    }
    // Connected calendars first, then alphabetical - the connected rows are
    // the ones an admin most often needs to inspect.
    return [...list].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (a.name || a.email).localeCompare(b.name || b.email);
    });
  }, [users, search]);

  const selectedUser = (users || []).find(u => u.id === selectedUserId);

  if (selectedUserId) {
    return (
      <div className="space-y-4" data-testid="admin-calendar-user-config">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => selectUser(null)} data-testid="button-back-to-calendar-table">
            <ArrowLeft className="w-4 h-4 mr-1" /> All calendars
          </Button>
          <div>
            <h2 className="text-lg font-heading">
              {selectedUser ? (selectedUser.name || selectedUser.email) : "Calendar configuration"}
            </h2>
            {selectedUser && (
              <p className="t-helper">
                {selectedUser.email}
                {selectedUser.providerName ? ` - ${selectedUser.providerName}` : selectedUser.isGoStorkStaff ? " - GoStork" : ""}
              </p>
            )}
          </div>
        </div>
        <CalendarSettings forUserId={forUserId} />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="admin-calendar-table">
      <div>
        <h2 className="text-lg font-heading">Team Calendars</h2>
        <p className="t-helper mt-1">
          Everyone who can hold a calendar, and whether theirs is connected. Click a row to open and edit that person's calendar configuration.
        </p>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, email, or provider"
          className="pl-9"
          data-testid="input-calendar-user-search"
        />
      </div>

      <Card className="overflow-x-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-6">
            <Calendar className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="t-helper">No users found.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                {!providerId && <TableHead>Organization</TableHead>}
                <TableHead>Connected calendars</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(u => {
                const status = statusFor(u);
                const live = u.connections.filter(c => c.connected);
                return (
                  <TableRow
                    key={u.id}
                    className="cursor-pointer"
                    onClick={() => selectUser(u.id)}
                    data-testid={`row-calendar-user-${u.id}`}
                  >
                    <TableCell className="font-ui font-medium">{u.name || "-"}</TableCell>
                    <TableCell className="t-helper">{u.email}</TableCell>
                    {!providerId && (
                      <TableCell className="t-helper">
                        {u.providerName || (u.isGoStorkStaff ? "GoStork" : "-")}
                      </TableCell>
                    )}
                    <TableCell>
                      {live.length === 0 ? (
                        <span className="t-helper">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {live.map((c, i) => (
                            <Badge key={i} variant="outline" className="bg-secondary font-ui font-normal">
                              {PROVIDER_LABELS[c.provider] || c.provider}
                              {c.email ? ` (${c.email})` : ""}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge className={`font-ui font-normal border-transparent ${status.className}`}>
                        {status.label}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
