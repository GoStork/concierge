/**
 * THE payout table.
 *
 * Payout history renders in two places - the standalone /provider/payouts
 * page and the Payouts tab in Settings - and they had grown two copies of
 * the same five columns, the same status derivation and the same sort
 * comparator. A column added to one silently skipped the other.
 *
 * The genuine difference is what a row DOES, and that is a prop:
 *   mode="expand" - the page: a chevron opens parent + invoice detail inline
 *   mode="open"   - Settings: clicking the row opens the invoice document
 */
import { Fragment, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, FileText } from "lucide-react";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { formatDateTime } from "@/lib/format-date";
import { derivePayoutStatus } from "@/lib/payout-status";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { ServiceTag } from "@/components/ui/service-tag";
import { ParentInfoBlock, InvoiceInfoBlock } from "@/components/invoice-details-blocks";
import { TableShell, TableHeadRow, TableBodyRow } from "@/components/ui/list-page";
import { Button } from "@/components/ui/button";

const openDocument = (id: string) =>
  window.open(`/api/provider/invoices/${id}/document`, "_blank", "noopener,noreferrer");

export function PayoutTable({
  payouts,
  mode = "open",
  testIdPrefix = "payout",
}: {
  payouts: any[];
  mode?: "expand" | "open";
  testIdPrefix?: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Header sort layers on top of the caller's newest-first default: with no
  // active key sortData returns the list untouched, so that default survives.
  const { sortConfig, handleSort, sortData } = useTableSort();
  const rows = sortData(payouts, (inv: any, key) => {
    switch (key) {
      case "parent": return (inv.parentUser?.name || inv.parentUser?.email || "").toLowerCase();
      case "service": return (inv.serviceType || "").toLowerCase();
      case "payout": return inv.providerPayoutAmount ?? null;
      case "status": return derivePayoutStatus(inv).label;
      case "date": return new Date(inv.bankPayoutCompletedAt || inv.payoutInitiatedAt || inv.paidAt || inv.createdAt).getTime();
      default: return null;
    }
  });

  const head = (label: string, key: string, align?: "right") => (
    <SortableTableHead
      label={label} sortKey={key} currentSort={sortConfig} onSort={handleSort}
      align={align} className="whitespace-nowrap"
    />
  );

  return (
    <TableShell minWidth={640}>
      <TableHeadRow>
        {head("Parent", "parent")}
        {head("Service", "service")}
        {head("Your payout", "payout", "right")}
        {head("GoStork paid you", "status")}
        {head("Date", "date")}
        {mode === "expand" && <th className="w-10" />}
      </TableHeadRow>
      <tbody>
        {rows.map((inv: any) => {
          const s = derivePayoutStatus(inv);
          const open = expandedId === inv.id;
          return (
            // The Fragment carries the key: it is the mapped root, so a key on
            // the inner <tr> never applied and React warned on every render.
            <Fragment key={inv.id}>
              <TableBodyRow
                onClick={() => (mode === "expand" ? setExpandedId(open ? null : inv.id) : openDocument(inv.id))}
                title={mode === "open" ? "Open invoice document" : undefined}
                testId={`${testIdPrefix}-${inv.id}`}
              >
                <td className="p-4 align-middle whitespace-nowrap font-medium">
                  {inv.parentUser?.name || inv.parentUser?.email || "Parent"}
                </td>
                <td className="p-4 align-middle whitespace-nowrap"><ServiceTag service={inv.serviceType} /></td>
                <td className="p-4 align-middle text-right font-medium whitespace-nowrap tabular-nums">
                  {formatCents(inv.providerPayoutAmount, inv.currency)}
                </td>
                <td className="p-4 align-middle text-xs font-medium whitespace-nowrap" style={{ color: s.color }}>
                  <span title={s.tooltip} className="cursor-help underline decoration-dotted underline-offset-2 inline-flex items-center gap-1">
                    {s.isReceived && <CheckCircle2 className="w-3.5 h-3.5" />}
                    {s.label}
                  </span>
                </td>
                <td className="t-helper p-4 align-middle whitespace-nowrap">
                  {formatDateTime(inv.bankPayoutCompletedAt || inv.payoutInitiatedAt || inv.paidAt || inv.createdAt)}
                </td>
                {mode === "expand" && (
                  <td className="p-4 align-middle text-muted-foreground">
                    {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </td>
                )}
              </TableBodyRow>

              {mode === "expand" && open && (
                <tr className="bg-secondary/40 border-b last:border-0">
                  <td colSpan={6} className="px-6 py-5">
                    <div className="grid md:grid-cols-2 gap-6 text-sm">
                      <div className="space-y-5">
                        <ParentInfoBlock parentUser={inv.parentUser} />
                        <InvoiceInfoBlock inv={inv} />
                      </div>
                      <div className="space-y-3">
                        <h3 className="font-semibold">Actions</h3>
                        <Button size="sm" variant="outline" className="bg-card" onClick={() => openDocument(inv.id)}>
                          <FileText className="w-3.5 h-3.5 mr-1.5" /> Open invoice document
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </TableShell>
  );
}
