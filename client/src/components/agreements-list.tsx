import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { ExternalLink, FileSignature } from "lucide-react";
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
  // only the settings table exposes headers, so only it re-orders.
  const { sortConfig, handleSort, sortData } = useTableSort();
  const sortedItems = sortData(items, (item, key) => {
    switch (key) {
      case "name": return (item.title || "").toLowerCase();
      case "type": return (item.documentType || "").toLowerCase();
      // Sent sorts by the date the cell leads with, not the signed line under it.
      case "sent": return item.createdAt ? new Date(item.createdAt).getTime() : null;
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
    const fmtDate = (d: string) =>
      new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return (
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Name" sortKey="name" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Agreement" sortKey="type" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Sent" sortKey="sent" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
                <SortableTableHead label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
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
                  <TableCell className="t-helper whitespace-nowrap">{item.documentType}</TableCell>
                  <TableCell className="t-helper whitespace-nowrap">
                    {fmtDate(item.createdAt)}
                    {item.signedAt && <span className="block">Signed {fmtDate(item.signedAt)}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {agreementStatusBadge(item.status)}
                    {item.progressLabel && (
                      <span className="text-xs font-medium ml-2" style={{ color: "hsl(var(--brand-warning))" }}>
                        {item.progressLabel}
                      </span>
                    )}
                  </TableCell>
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
            </TableBody>
          </Table>
        </div>
      </Card>
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
