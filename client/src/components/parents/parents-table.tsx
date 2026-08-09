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
import { ServiceTag } from "@/components/ui/service-tag";
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

/**
 * One entry per service line for the paired Services / Match Status stacks:
 * lines with journey artifacts first (each paired with its own stage), then
 * interest-only services (the family said they want it, nothing has happened
 * yet) with no status - so the admin view never drops a service the profile
 * declares just because it has no session yet.
 */
function buildServiceLines(row: ParentTableRow): { serviceKey: string | null; status: string | null }[] {
  const lines: { serviceKey: string | null; status: string | null }[] =
    (row.serviceStatuses || []).map((ss) => ({ serviceKey: ss.serviceKey, status: ss.status }));
  const seen = new Set(lines.map((l) => l.serviceKey).filter(Boolean));
  for (const svc of row.services || []) {
    if (!seen.has(svc)) { seen.add(svc); lines.push({ serviceKey: svc, status: null }); }
  }
  return lines;
}

/** Current cost sheets only; when every sheet was superseded, keep the newest. */
function liveCostSheets(costSheets: any[]): any[] {
  const live = costSheets.filter((cs) => !cs.supersededAt);
  if (live.length) return live;
  return costSheets.length ? [costSheets[0]] : [];
}

/**
 * Order a row's invoices (or agreements - both carry serviceType) to mirror
 * the stacked Services column: rows for the first listed service line first,
 * then the second, unknown types last. Stable within a group (server already
 * sends newest-first).
 */
function sortInvoicesByServiceOrder(
  invoices: any[],
  serviceStatuses?: { serviceKey: string | null }[] | null,
): any[] {
  const order = (serviceStatuses || []).map((ss) => ss.serviceKey).filter(Boolean) as string[];
  if (order.length < 2 || invoices.length < 2) return invoices;
  const rank = (inv: any) => {
    const i = order.indexOf(inv.serviceType);
    return i === -1 ? order.length : i;
  };
  return [...invoices].sort((a, b) => rank(a) - rank(b));
}

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

  // Every data column shows from xl up (user request: providers see the same
  // table admins do, Actions aside). Below xl the narrow set survives; the
  // horizontal scroller + pinned right edge below carry the overflow on a
  // laptop instead of hiding whole columns.
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
            <SortableTableHead label="Mobile" sortKey="mobile" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-mobile" />
            <SortableTableHead label="Services" sortKey="services" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-services" />
            <SortableTableHead label="Match Status" sortKey="status" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-status" />
            <SortableTableHead label="Cost Sheets" sortKey="costSheets" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-cost-sheets" />
            <SortableTableHead label="Invoices" sortKey="invoices" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden lg:table-cell" data-testid="sort-invoices" />
            <SortableTableHead label="Agreements" sortKey="agreements" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-agreements" />
            <SortableTableHead label="Created" sortKey="created" currentSort={sortConfig} onSort={onSort} className="whitespace-nowrap hidden xl:table-cell" data-testid="sort-created" />
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
            const svcLines = buildServiceLines(row);
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

                <TableCell className="hidden xl:table-cell whitespace-nowrap" data-testid={`text-parent-mobile-${row.id}`} onClick={(e) => e.stopPropagation()}>
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

                {/* Services and Match Status are PAIRED stacks: when a family
                    runs several lines, line N of this column names the
                    service whose status is line N of the next column - both
                    stacks render from serviceStatuses in the same order, each
                    line pinned to the same fixed height so the pairs stay on
                    a shared baseline. No "+N" collapse: every line shows. */}
                <TableCell className="hidden lg:table-cell whitespace-nowrap align-middle">
                  {svcLines.length > 1 ? (
                    <div className="flex flex-col gap-1 items-start" data-testid={`chips-services-${row.id}`}>
                      {svcLines.map((ss) => (
                        <span key={ss.serviceKey || "untyped"} className="flex items-center h-[22px]">
                          {ss.serviceKey
                            ? <ServiceTag service={SERVICE_LABELS[ss.serviceKey] || ss.serviceKey} />
                            : <span className="t-helper">-</span>}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <ServiceChips services={row.services} limit={0} testId={`chips-services-${row.id}`} />
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap align-middle">
                  {svcLines.length > 1 ? (
                    // One true status PER LINE - a single most-advanced badge
                    // was how a brand-new surrogacy thread read "Handed Off"
                    // off the egg-donation journey. The service name lives in
                    // the previous column, same line - not repeated here; an
                    // interest-only line has no journey yet, so a "-".
                    <div className="flex flex-col gap-1 items-start" data-testid={`match-statuses-${row.id}`}>
                      {svcLines.map((ss) => (
                        <span key={ss.serviceKey || "untyped"} className="flex items-center h-[22px]">
                          {ss.status ? <MatchStatusBadge status={ss.status} /> : <span className="t-helper">-</span>}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <MatchStatusBadge status={row.matchStatus} />
                  )}
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  {/* Superseded sheets are history, not state - the record's
                      Documents panel keeps the full trail; the table shows
                      only what is live, stacked. If every sheet was
                      superseded (edge case), the newest one still shows so
                      the column never lies about a quote having been sent. */}
                  <ParentCostSheetsCell
                    costSheets={liveCostSheets(row.costSheets || [])}
                    sessionId={row.sessionId}
                    isAdmin={isAdmin}
                    parentUserId={row.id}
                    limit={0}
                    stack
                  />
                </TableCell>
                <TableCell className="hidden lg:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  {/* All invoices, stacked, sorted into the same service
                      order as the Services column so an invoice sits beside
                      the line it was sent for. */}
                  <ParentInvoicesCell
                    invoices={sortInvoicesByServiceOrder(row.invoices || [], row.serviceStatuses)}
                    limit={0}
                    stack
                  />
                </TableCell>
                <TableCell className="hidden xl:table-cell whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <ParentAgreementsCell
                    agreements={sortInvoicesByServiceOrder(row.agreements || [], row.serviceStatuses)}
                    limit={0}
                    stack
                  />
                </TableCell>
                <TableCell className="hidden xl:table-cell" data-testid={`text-created-${row.id}`}>
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
