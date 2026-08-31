import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { ExternalLink, FileSignature, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

// Shared agreement status badge + row list. Used by the provider Documents
// tab, the provider Billing > Agreements tab, and the parent Billing >
// Agreements tab - one renderer so status colors and row layout never drift.

export function agreementStatusBadge(status: string) {
  switch (status) {
    case "SIGNED":
      return (
        <Badge className="bg-[hsl(var(--brand-success)/0.15)] text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success)/0.3)] border">
          Signed
        </Badge>
      );
    case "SENT":
      return (
        <Badge variant="outline" className="text-[hsl(var(--foreground)/0.7)]">
          Sent - Awaiting Signature
        </Badge>
      );
    case "REJECTED":
      return (
        <Badge className="bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)] border">
          Rejected
        </Badge>
      );
    case "EXPIRED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Expired
        </Badge>
      );
    case "CREATED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Created - Not Sent
        </Badge>
      );
    case "ERROR":
      return (
        <Badge className="bg-destructive/10 text-destructive border-destructive/30 border">
          Error
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export interface AgreementListItem {
  id: string;
  status: string;
  documentType: string;
  createdAt: string;
  signedAt?: string | null;
  /** Who/what the row is about: the parent's name (provider view) or the provider's name (parent view). */
  title: string;
  /**
   * Admin only: the provider on the other side. When any row carries one the
   * table grows a Provider column - a provider's own list would print their
   * own name on every line, so the column stays absent there.
   */
  providerName?: string | null;
  /** Optional signer progress, e.g. "1/2 signed" - shown next to the status badge. */
  progressLabel?: string | null;
}

export function AgreementRows({
  items,
  emptyText = "No agreements yet.",
  isLoading = false,
  variant = "list",
}: {
  items: AgreementListItem[];
  emptyText?: string;
  isLoading?: boolean;
  /**
   * "table" renders the Team-table shape (flush shadcn Table in a Card) -
   * the settings Documents tab uses it so every settings table matches.
   * "list" keeps the compact divided rows the home pages embed in their
   * own cards. One component, both contexts - never fork this.
   */
  variant?: "list" | "table";
}) {
  const navigate = useNavigate();
  // The list variant keeps the caller's order (home pages show "latest first");
  // only the settings table exposes headers, so only it re-orders - and only
  // it gets the search + status filter bar.
  const { sortConfig, handleSort, sortData } = useTableSort();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  // Agreement Type options come from the rows themselves - each provider only
  // sees the document types they actually send.
  const typeOptions = useMemo(
    () => Array.from(new Set(items.map(i => i.documentType).filter(Boolean))).sort(),
    [items],
  );
  const filteredItems = useMemo(() => {
    if (variant !== "table") return items;
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (statusFilter !== "all" && i.status !== statusFilter) return false;
      if (typeFilter !== "all" && i.documentType !== typeFilter) return false;
      if (!q) return true;
      return [i.title, i.providerName, i.documentType].some(v => (v || "").toLowerCase().includes(q));
    });
  }, [items, variant, search, statusFilter, typeFilter]);
  const sortedItems = sortData(filteredItems, (item, key) => {
    switch (key) {
      case "name": return (item.title || "").toLowerCase();
      case "provider": return (item.providerName || "").toLowerCase();
      case "type": return (item.documentType || "").toLowerCase();
      case "sent": return item.createdAt ? new Date(item.createdAt).getTime() : null;
      case "signed": return item.signedAt ? new Date(item.signedAt).getTime() : null;
      case "status": return item.status || "";
      default: return null;
    }
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-12 bg-muted rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="py-10 text-center space-y-2">
        <FileSignature className="w-8 h-8 mx-auto text-muted-foreground/50" />
        <p className="t-helper">{emptyText}</p>
      </div>
    );
  }

  if (variant === "table") {
    const hasProvider = items.some((i) => !!i.providerName);
    const fmtDate = (d: string) =>
      new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return (
      <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, agreement..."
            className="pl-9 bg-card"
            data-testid="agreements-list-search"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[220px] bg-card" data-testid="agreements-list-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="SENT">Sent - Awaiting Signature</SelectItem>
            <SelectItem value="SIGNED">Signed</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="EXPIRED">Expired</SelectItem>
            <SelectItem value="CREATED">Created - Not Sent</SelectItem>
            <SelectItem value="ERROR">Error</SelectItem>
          </SelectContent>
        </Select>
        {typeOptions.length > 1 && (
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[220px] bg-card" data-testid="agreements-list-type-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agreement types</SelectItem>
              {typeOptions.map(t => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Name" sortKey="name" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                {hasProvider && <SortableTableHead label="Provider" sortKey="provider" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />}
                <SortableTableHead label="Agreement" sortKey="type" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Sent" sortKey="sent" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Signed" sortKey="signed" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <TableHead className="text-right whitespace-nowrap">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedItems.map(item => (
                <TableRow
                  key={item.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/agreements/${item.id}`)}
                  data-testid={`agreement-row-${item.id}`}
                >
                  <TableCell className="font-medium whitespace-nowrap">{item.title}</TableCell>
                  {hasProvider && <TableCell className="t-helper whitespace-nowrap">{item.providerName || "-"}</TableCell>}
                  <TableCell className="t-helper whitespace-nowrap">{item.documentType}</TableCell>
                  <TableCell className="t-helper whitespace-nowrap">{fmtDate(item.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {agreementStatusBadge(item.status)}
                    {item.progressLabel && (
                      <span className="text-xs font-medium ml-2" style={{ color: "hsl(var(--brand-warning))" }}>
                        {item.progressLabel}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="t-helper whitespace-nowrap">{item.signedAt ? fmtDate(item.signedAt) : "-"}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); navigate(`/agreements/${item.id}`); }}
                      aria-label="Open agreement"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!sortedItems.length && (
                <TableRow>
                  <TableCell colSpan={hasProvider ? 7 : 6} className="text-center text-sm text-muted-foreground py-6">
                    No agreements match your search or filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {items.map(item => (
        <div key={item.id} className="flex items-center gap-4 py-3" data-testid={`agreement-row-${item.id}`}>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{item.title}</p>
            <p className="t-helper">
              {item.documentType} - {new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {item.signedAt && ` - Signed ${new Date(item.signedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
            </p>
          </div>
          {item.progressLabel && (
            <span className="text-xs font-medium shrink-0" style={{ color: "hsl(var(--brand-warning))" }}>
              {item.progressLabel}
            </span>
          )}
          <div className="shrink-0">{agreementStatusBadge(item.status)}</div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => navigate(`/agreements/${item.id}`)}
            aria-label="Open agreement"
          >
            <ExternalLink className="w-4 h-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
