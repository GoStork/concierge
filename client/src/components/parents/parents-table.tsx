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
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  SERVICE_LABELS,
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

  // Cost Sheets and Agreements now appear only at 2xl. They were the two
  // columns most often empty, and dropping them below 1536px is what lets the
  // rest fit a laptop without sideways scrolling - the thing that made the
  // email look permanently truncated. Invoices stays: it is the money column
  // people actually scan.
  //
  // The scroll container is the Table's OWN wrapper, not the Card: the wrapper
  // clips first, so overflow-x on any ancestor is dead weight and the columns
  // past the edge were simply cut off with no scrollbar to reach them.
  //
  // Only the RIGHT edge is pinned. Name used to be pinned too, and the cost was
  // the email: the moment the table scrolled a few pixels the email slid under
  // the name column and read as a truncated address ("MAIL", "est-cardview-1").
  // Keeping a row identifiable while scrolling is not worth a column that looks
  // permanently broken - Name is the first column, so it stays in view for the
  // small scroll this table actually needs.
  const scroller = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdge({ left: false, right: el.scrollLeft < max - 1 });
  }, []);
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, rows.length]);

  // A hairline, not a drop shadow. A blurred edge on a pinned column reads as
  // a narrow empty column of its own, which is worse than the ambiguity it was
  // meant to resolve; a single rule looks like the table dividers already here
  // and still says "this column is pinned, the rest slides under it".
  const pinR = edge.right ? { borderLeft: "1px solid hsl(var(--border))" } : undefined;

  return (
    <Card>
      <Table
        className="[&_th]:px-2 [&_td]:px-2 [&_th]:text-xs"
        wrapperClassName="overflow-x-auto"
        wrapperRef={scroller}
        onWrapperScroll={measure}
      >
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
            {/* Every header stays on one line so all thirteen read the same
                way. The width that bought is the caps on Name and Email below,
                not wrapping - measured under the admin column budget, the table
                fits with the headers unwrapped. */}
            <SortableTableHead label="Name" sortKey="name" currentSort={sortConfig} onSort={onSort} className="min-w-[164px]" data-testid="sort-name" />
            <SortableTableHead label="Email" sortKey="email" currentSort={sortConfig} onSort={onSort} className="hidden sm:table-cell max-w-[170px]" data-testid="sort-email" />
            <SortableTableHead label="Mobile" sortKey="mobile" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden 2xl:table-cell" data-testid="sort-mobile" />
            <SortableTableHead label="Services" sortKey="services" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-services" />
            <SortableTableHead label="Match Status" sortKey="status" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-status" />
            <SortableTableHead label="Cost Sheets" sortKey="costSheets" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden 2xl:table-cell" data-testid="sort-cost-sheets" />
            <SortableTableHead label="Invoices" sortKey="invoices" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-invoices" />
            <SortableTableHead label="Agreements" sortKey="agreements" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden 2xl:table-cell" data-testid="sort-agreements" />
            <SortableTableHead label="Created" sortKey="created" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden 2xl:table-cell" data-testid="sort-created" />
            <SortableTableHead label="Updated" sortKey="updated" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-updated" />
            <SortableTableHead label="Owner" sortKey="owner" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-owner" />
            <SortableTableHead label="Next step" sortKey="nextDue" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-next-step" />
            <SortableTableHead label="Tags" sortKey="tags" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-tags" />
            {rowActions && <TableHead className="text-right whitespace-nowrap sticky right-0 z-20 bg-muted" style={pinR}>Actions</TableHead>}
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
                className={`cursor-pointer bg-card ${row.isDisabled ? "opacity-60" : ""}`}
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

                <TableCell className="font-ui whitespace-nowrap min-w-[164px]">
                  <div className="flex items-center gap-2">
                    {photo ? (
                      <img src={photo} alt="" className="w-8 h-8 rounded-[var(--radius)] object-cover" />
                    ) : (
                      <DoctorMonogram name={row.name || "?"} size={32} rounded="var(--radius)" />
                    )}
                    <button
                      type="button"
                      className="text-left hover:text-primary hover:underline transition-colors cursor-pointer truncate max-w-[168px]"
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
                      {/* selfName only when the row is ONE person. The provider
                          payload's `name` is the combined household name, so
                          passing it would filter nothing out and the badge
                          would list both partners - duplicating the name cell
                          an inch to the left. Then it correctly reads "Couple". */}
                      <HouseholdBadge
                        memberNames={row.householdNames!}
                        selfName={row.householdNames!.includes(row.name || "") ? row.name : undefined}
                        testId={`badge-couple-${row.id}`}
                      />
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
                          <span className="truncate max-w-[118px] inline-block align-middle" title={m.email || undefined}>{m.email}</span>
                          <CopyButton value={m.email as string} testId={`btn-copy-email-${row.key}-${m.id}`} />
                        </div>
                      ))}
                      {contactLines.every((m) => !m.email) && <span className="t-helper">-</span>}
                    </div>
                  )}
                </TableCell>

                <TableCell className="hidden 2xl:table-cell whitespace-nowrap" data-testid={`text-parent-mobile-${row.id}`} onClick={(e) => e.stopPropagation()}>
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
                  <ServiceChips services={row.services} limit={1} testId={`chips-services-${row.id}`} />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap">
                  {row.serviceStatuses && row.serviceStatuses.length > 1 ? (
                    // A family running several service lines with this org
                    // has one true status PER LINE - a single most-advanced
                    // badge was how a brand-new surrogacy thread read
                    // "Handed Off" off the egg-donation journey.
                    <div className="flex flex-col gap-1" data-testid={`match-statuses-${row.id}`}>
                      {row.serviceStatuses.map((ss) => (
                        <div key={ss.serviceKey || "untyped"} className="flex items-center gap-1.5">
                          {ss.serviceKey && (
                            <span className="t-helper text-xs whitespace-nowrap">
                              {SERVICE_LABELS[ss.serviceKey] || ss.serviceKey}
                            </span>
                          )}
                          <MatchStatusBadge status={ss.status} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <MatchStatusBadge status={row.matchStatus} />
                  )}
                </TableCell>
                <TableCell className="hidden 2xl:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentCostSheetsCell
                    costSheets={row.costSheets || []}
                    sessionId={row.sessionId}
                    isAdmin={isAdmin}
                    parentUserId={row.id}
                    limit={1}
                  />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentInvoicesCell invoices={row.invoices || []} limit={1} />
                </TableCell>
                <TableCell className="hidden 2xl:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentAgreementsCell agreements={row.agreements || []} limit={1} />
                </TableCell>
                <TableCell className="hidden 2xl:table-cell" data-testid={`text-created-${row.id}`}>
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
                  <TableCell
                    className="text-right whitespace-nowrap sticky right-0 z-10 bg-inherit" style={pinR}
                    onClick={(e) => e.stopPropagation()}
                  >
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
