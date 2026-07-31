/**
 * The one parents table.
 *
 * There were two: an admin one over /api/users + /api/admin/parents-overview,
 * and a provider one over /api/providers/:id/parent-contacts. They shared ten
 * of their columns and every cell component, but each kept its own copy of the
 * scaffolding - so a column added to one silently skipped the other, which is
 * how the two surfaces drifted apart in the first place.
 *
 * Each view now normalises its payload into ParentTableRow and renders this.
 * The genuine differences are props, not forks:
 *
 *   selectable   - admin gets checkboxes and bulk delete
 *   rowActions   - admin gets a per-row block/delete cell
 *   contactReleased - a provider sees the hidden-contact chip until Gate B
 *                  opens; an admin always sees through it
 *   members      - a couple renders one line per login, which only the
 *                  provider payload carries today but the admin one may later
 */
import { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { SortableTableHead, type SortConfig } from "@/components/sortable-table-head";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import {
  ContactHiddenChip,
  HouseholdBadge,
  MatchStatusBadge,
  NextStepCell,
  OwnerCell,
  ParentAgreementsCell,
  ParentCostSheetsCell,
  ParentInvoicesCell,
  ServiceChips,
  TagsCell,
  dedupeHouseholdPhones,
} from "./parent-cells";
import type { ParentTableRow } from "./parent-record-types";

export interface ParentsTableProps {
  rows: ParentTableRow[];
  sortConfig: SortConfig;
  onSort: (key: string) => void;
  onRowClick: (row: ParentTableRow) => void;
  isAdmin: boolean;
  emptyMessage: ReactNode;
  /** Admin only: checkbox column + bulk selection. */
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: () => void;
  allVisibleSelected?: boolean;
  someSelected?: boolean;
  /** Admin only: trailing per-row controls. */
  rowActions?: (row: ParentTableRow) => ReactNode;
}

export function ParentsTable({
  rows, sortConfig, onSort, onRowClick, isAdmin, emptyMessage,
  selectable = false, selectedIds, onToggleSelect, onToggleSelectAll,
  allVisibleSelected = false, someSelected = false, rowActions,
}: ParentsTableProps) {
  // checkbox + 12 shared + optional actions
  const colSpan = 12 + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <Card className="overflow-x-auto">
      <Table className="[&_th]:px-2 [&_td]:px-2 [&_th]:text-xs">
        <TableHeader>
          <TableRow>
            {selectable && (
              <TableHead className="w-10 pl-4">
                <Checkbox
                  checked={allVisibleSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={onToggleSelectAll}
                  aria-label="Select all"
                  data-testid="checkbox-select-all"
                />
              </TableHead>
            )}
            <SortableTableHead label="Name" sortKey="name" currentSort={sortConfig} onSort={onSort} data-testid="sort-name" />
            <SortableTableHead label="Email" sortKey="email" currentSort={sortConfig} onSort={onSort} className="hidden sm:table-cell" data-testid="sort-email" />
            <SortableTableHead label="Mobile" sortKey="mobile" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden md:table-cell" data-testid="sort-mobile" />
            <SortableTableHead label="Services" sortKey="services" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-services" />
            <SortableTableHead label="Match Status" sortKey="status" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-status" />
            <TableHead className="hidden lg:table-cell whitespace-nowrap">Cost Sheets</TableHead>
            <TableHead className="hidden lg:table-cell whitespace-nowrap">Invoices</TableHead>
            <TableHead className="hidden lg:table-cell whitespace-nowrap">Agreements</TableHead>
            <SortableTableHead label="Created" sortKey="created" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-created" />
            <SortableTableHead label="Updated" sortKey="updated" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-updated" />
            <SortableTableHead label="Owner" sortKey="owner" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-owner" />
            <SortableTableHead label="Next step" sortKey="nextDue" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-next-step" />
            <TableHead className="whitespace-nowrap hidden xl:table-cell">Tags</TableHead>
            {rowActions && <TableHead className="text-right whitespace-nowrap">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length > 0 ? rows.map((row) => {
            const photo = getPhotoSrc(row.photoUrl);
            // A couple renders one line per login; a solo parent falls back to
            // the row's own fields, so both payload shapes work unchanged.
            const contactLines = (row.members?.length || 0) > 1
              ? row.members
              : [{ id: row.id, name: row.name, email: row.email, mobileNumber: row.mobileNumber, photoUrl: null }];
            const phones = dedupeHouseholdPhones(contactLines as any, contactLines[0] as any);
            return (
              <TableRow
                key={row.key}
                data-testid={`row-staff-${row.id}`}
                className={`cursor-pointer ${row.isDisabled ? "opacity-60" : ""}`}
                // Couple rows are pulled adjacent by the caller and share an
                // accent tint + left bar so the pair reads as one block.
                style={row.householdNames?.length
                  ? { background: "hsl(var(--accent) / 0.06)", boxShadow: "inset 3px 0 0 hsl(var(--accent) / 0.6)" }
                  : undefined}
                onClick={() => onRowClick(row)}
              >
                {selectable && (
                  <TableCell className="pl-4 w-10" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds?.has(row.id) || false}
                      onCheckedChange={() => onToggleSelect?.(row.id)}
                      aria-label={`Select ${row.name || row.email || row.id}`}
                      data-testid={`checkbox-select-${row.id}`}
                    />
                  </TableCell>
                )}

                <TableCell className="font-ui whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    {photo ? (
                      <img src={photo} alt="" className="w-8 h-8 rounded-[var(--radius)] object-cover" />
                    ) : (
                      <DoctorMonogram name={row.name || "?"} size={32} rounded="var(--radius)" />
                    )}
                    <button
                      type="button"
                      className="text-left hover:text-primary hover:underline transition-colors cursor-pointer truncate max-w-[150px]"
                      title={row.name || undefined}
                      onClick={(e) => { e.stopPropagation(); onRowClick(row); }}
                      data-testid={`link-user-name-${row.id}`}
                    >
                      {row.name || "-"}
                    </button>
                    {row.name && <CopyButton value={row.name} testId={`btn-copy-name-${row.id}`} />}
                    {row.isDisabled && (
                      <span
                        className="shrink-0 inline-flex items-center text-[10px] font-ui px-2 py-0.5 rounded-full whitespace-nowrap bg-destructive text-destructive-foreground"
                        data-testid={`badge-disabled-${row.id}`}
                      >
                        Disabled
                      </span>
                    )}
                  </div>
                  {/* Second line so the chip never bleeds into the email column */}
                  {(row.householdNames?.length || 0) > 1 && (
                    <div className="mt-1 pl-6">
                      <HouseholdBadge memberNames={row.householdNames!} selfName={row.name} testId={`badge-couple-${row.id}`} />
                    </div>
                  )}
                </TableCell>

                <TableCell className="hidden sm:table-cell whitespace-nowrap" data-testid={`text-parent-email-${row.id}`} onClick={(e) => e.stopPropagation()}>
                  {!row.contactReleased ? (
                    <ContactHiddenChip testId={`chip-email-hidden-${row.key}`} />
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {contactLines.filter((m) => m.email).map((m) => (
                        <div key={m.id} className="flex items-center gap-1.5">
                          <span className="truncate max-w-[150px] inline-block align-middle" title={m.email || undefined}>{m.email}</span>
                          <CopyButton value={m.email as string} testId={`btn-copy-email-${row.key}-${m.id}`} />
                        </div>
                      ))}
                      {contactLines.every((m) => !m.email) && <span className="t-helper">-</span>}
                    </div>
                  )}
                </TableCell>

                <TableCell className="hidden md:table-cell whitespace-nowrap" data-testid={`text-parent-mobile-${row.id}`} onClick={(e) => e.stopPropagation()}>
                  {!row.contactReleased ? (
                    <ContactHiddenChip testId={`chip-mobile-hidden-${row.key}`} />
                  ) : phones.length === 0 ? (
                    <span className="t-helper">-</span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {phones.map((m: any) => (
                        <div key={m.id} className="flex items-center gap-1 text-sm">
                          <span className="whitespace-nowrap">{formatPhoneDisplay(m.mobileNumber)}</span>
                          <CopyButton value={m.mobileNumber} testId={`btn-copy-mobile-${row.key}-${m.id}`} />
                        </div>
                      ))}
                    </div>
                  )}
                </TableCell>

                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <ServiceChips services={row.services} testId={`chips-services-${row.id}`} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  <MatchStatusBadge status={row.matchStatus} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentCostSheetsCell
                    costSheets={row.costSheets || []}
                    sessionId={row.sessionId}
                    isAdmin={isAdmin}
                    parentUserId={row.id}
                  />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentInvoicesCell invoices={row.invoices || []} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentAgreementsCell agreements={row.agreements || []} />
                </TableCell>
                <TableCell className="hidden lg:table-cell" data-testid={`text-created-${row.id}`}>
                  <span className="t-helper">{row.createdAt ? new Date(row.createdAt).toLocaleDateString() : "-"}</span>
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap">
                  <span className="t-helper">{row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : "-"}</span>
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap">
                  <OwnerCell owner={row.owner} testId={`cell-owner-${row.id}`} />
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap">
                  <NextStepCell nextStep={row.nextStep} testId={`cell-next-step-${row.id}`} />
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap">
                  <TagsCell tags={row.tags} testId={`cell-tags-${row.id}`} />
                </TableCell>

                {rowActions && (
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {rowActions(row)}
                  </TableCell>
                )}
              </TableRow>
            );
          }) : (
            <TableRow>
              <TableCell colSpan={colSpan} className="text-center text-muted-foreground py-8">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
