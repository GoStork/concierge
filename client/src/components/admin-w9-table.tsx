/**
 * Admin W-9 tracking table - rendered at the bottom of the /account/legal-identity
 * ("W-9") tab's admin view. One row per approved provider that has at least one
 * user account (scraped/CDC profiles with no login are excluded - nobody there
 * can sign). Lets the admin:
 *  - see every provider's W-9 status at a glance,
 *  - download completed W-9 PDFs,
 *  - send the initial W-9 request (NOT_SENT / ERROR rows),
 *  - raise a "Complete your W-9 form" reminder task on the provider's Home
 *    page work queue (SENT rows). The task auto-closes when the PandaDoc
 *    completion webhook lands.
 *
 * Same table design as Your Sponsorships / Invoice History (Card + Table +
 * SortableTableHead + status pill).
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Download, Send, BellRing, CheckCircle2, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface W9Row {
  providerId: string;
  name: string;
  serviceTypes: string[];
  country?: string;
  requiredForm?: "W9" | "W8BENE";
  w9Id: string | null;
  status: "NOT_SENT" | "SENT" | "COMPLETED" | "ERROR";
  requestedAt: string | null;
  completedAt: string | null;
  signerEmail: string | null;
  reminderOpen: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  COMPLETED: "bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))]",
  SENT: "bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]",
  ERROR: "bg-destructive/15 text-destructive",
  NOT_SENT: "bg-muted text-muted-foreground",
};

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: "Completed",
  SENT: "Sent - awaiting signature",
  ERROR: "Error",
  NOT_SENT: "Not sent",
};

// Sort rank so the Status column orders by urgency, not alphabet.
const STATUS_RANK: Record<string, number> = { NOT_SENT: 0, ERROR: 1, SENT: 2, COMPLETED: 3 };

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString() : null);

export function AdminW9Table() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { sortConfig, handleSort, sortData } = useTableSort();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ providers: W9Row[] }>({
    queryKey: ["/api/admin/w9/providers"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/w9/providers")).json(),
  });

  const rows = data?.providers || [];
  // Free-text search + status filter, applied before sorting.
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!q) return true;
      return [r.name, r.signerEmail, r.serviceTypes.join(" ")].some(v => (v || "").toLowerCase().includes(q));
    });
  }, [rows, search, statusFilter]);
  const sorted = sortData(filtered, (r, key) => {
    switch (key) {
      case "provider": return r.name;
      case "services": return r.serviceTypes.join(", ");
      case "status": return STATUS_RANK[r.status] ?? 99;
      case "requested": return r.requestedAt ? new Date(r.requestedAt).getTime() : null;
      case "completed": return r.completedAt ? new Date(r.completedAt).getTime() : null;
      default: return null;
    }
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/w9/providers"] });

  const sendRequest = async (r: W9Row) => {
    setBusyId(r.providerId);
    try {
      await apiRequest("POST", `/api/admin/providers/${r.providerId}/w9/send`, {});
      toast({ title: "W-9 request sent", description: `${r.name} was asked to sign their W-9.` });
      refresh();
    } catch (e: any) {
      toast({ title: "Could not send W-9 request", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const remind = async (r: W9Row) => {
    setBusyId(r.providerId);
    try {
      await apiRequest("POST", `/api/admin/providers/${r.providerId}/w9/remind`, {});
      toast({ title: "Reminder task created", description: `"Complete your W-9 form" now sits on ${r.name}'s Home page.` });
      refresh();
    } catch (e: any) {
      toast({ title: "Could not create reminder", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const download = async (r: W9Row) => {
    if (!r.w9Id) return;
    setBusyId(r.providerId);
    try {
      const res = await fetch(`/api/w9/${r.w9Id}/download`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `W-9 - ${r.name}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Could not download W-9", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-semibold">Provider tax forms (W-9 / W-8BEN-E)</h3>
        <p className="t-helper mt-0.5">
          Every approved provider with a user account, and where their W-9 stands. Download
          completed forms, or nudge the ones still outstanding - a reminder shows up as a task
          on the provider's Home page.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search provider, email, service..."
            className="pl-9 bg-card"
            data-testid="w9-search"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[220px] bg-card" data-testid="w9-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="NOT_SENT">Not sent</SelectItem>
            <SelectItem value="SENT">Sent - awaiting signature</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
            <SelectItem value="ERROR">Error</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading providers...
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableTableHead label="Provider" sortKey="provider" currentSort={sortConfig} onSort={handleSort} />
                  <SortableTableHead label="Services" sortKey="services" currentSort={sortConfig} onSort={handleSort} />
                  <TableHead>Form</TableHead>
                  <SortableTableHead label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} />
                  <SortableTableHead label="Requested" sortKey="requested" currentSort={sortConfig} onSort={handleSort} />
                  <SortableTableHead label="Completed" sortKey="completed" currentSort={sortConfig} onSort={handleSort} />
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => {
                  const busy = busyId === r.providerId;
                  return (
                    <TableRow key={r.providerId} data-testid={`w9-row-${r.providerId}`}>
                      <TableCell>
                        <div className="font-medium">{r.name}</div>
                        {r.signerEmail && <div className="t-helper">{r.signerEmail}</div>}
                      </TableCell>
                      <TableCell className="text-sm">{r.serviceTypes.join(", ") || "-"}</TableCell>
                      {/* Which IRS form this provider owes, from the Legal tab's country. */}
                      <TableCell className="text-sm whitespace-nowrap" title={r.country ? `Legal entity country: ${r.country}` : undefined}>
                        {r.requiredForm === "W8BENE" ? "W-8BEN-E" : "W-9"}
                        {r.country && r.country !== "US" && <span className="t-helper ml-1">({r.country})</span>}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLES[r.status] || STATUS_STYLES.NOT_SENT}`}>
                          {STATUS_LABELS[r.status] || r.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{fmtDate(r.requestedAt) || "-"}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {r.completedAt ? (
                          <span className="inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--brand-success))]" />
                            {fmtDate(r.completedAt)}
                          </span>
                        ) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1.5">
                          {r.status === "COMPLETED" && r.w9Id && (
                            <Button size="sm" variant="outline" onClick={() => download(r)} disabled={busy} data-testid={`w9-download-${r.providerId}`}>
                              {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1" />}
                              Download
                            </Button>
                          )}
                          {(r.status === "NOT_SENT" || r.status === "ERROR") && (
                            <Button size="sm" onClick={() => sendRequest(r)} disabled={busy} data-testid={`w9-send-${r.providerId}`}>
                              {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                              Send request
                            </Button>
                          )}
                          {r.status === "SENT" && (
                            <Button size="sm" variant="outline" onClick={() => remind(r)} disabled={busy} data-testid={`w9-remind-${r.providerId}`}>
                              {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <BellRing className="w-3.5 h-3.5 mr-1" />}
                              {r.reminderOpen ? "Remind again" : "Send reminder"}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!sorted.length && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">
                      {rows.length
                        ? "No providers match your search or filter."
                        : "No approved providers with user accounts yet."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </section>
  );
}
