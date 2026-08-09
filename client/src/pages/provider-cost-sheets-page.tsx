/**
 * Provider Cost Sheets page
 * Route: /provider/cost-sheets
 *
 * Every cost sheet the provider has shared with parents, across all sessions:
 * status (Current / Superseded / Acknowledged), file download, and a jump
 * into the conversation. Reached from the Home dashboard's Cost Sheets
 * section - the provider counterpart of /my/cost-sheets.
 */

import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip, MessageCircle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { inDateRange } from "@/components/date-range-filter";
import { FilterSearch, FilterDropdown, FilterDateRange } from "@/components/ui/filter-controls";
import { ListPageHeader, StatGrid, StatCard, ListFilterBar, ListLoading, ListEmpty, TableShell, TableHeadRow, TableBodyRow } from "@/components/ui/list-page";
import { SortableTableHead, useTableSort } from "@/components/sortable-table-head";
import { ServiceTag, SERVICE_FILTER_OPTIONS } from "@/components/ui/service-tag";

const COST_SHEET_STATUS_FILTERS = [
  { key: "current", label: "Current" },
  { key: "superseded", label: "Superseded" },
];

export default function ProviderCostSheetsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") || "all";
  const q = searchParams.get("q") || "";
  const svc = searchParams.get("svc") || "all";
  const dateFrom = searchParams.get("from") || "";
  const dateTo = searchParams.get("to") || "";

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  };

  const { data, isLoading } = useQuery<{ quotes: any[] }>({
    queryKey: ["/api/provider/cost-sheets"],
    queryFn: async () => {
      const res = await fetch("/api/provider/cost-sheets", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cost sheets");
      return res.json();
    },
  });
  const costSheets = data?.quotes ?? [];

  const matchesSearch = (haystack: Array<string | null | undefined>) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return haystack.some(h => (h || "").toLowerCase().includes(needle));
  };

  const filtered = costSheets.filter((cs: any) => {
    if (status === "current" && cs.supersededAt) return false;
    if (status === "superseded" && !cs.supersededAt) return false;
    if (svc !== "all" && cs.serviceType !== svc) return false;
    if (!inDateRange(cs.createdAt, dateFrom, dateTo)) return false;
    return matchesSearch([cs.parentName, cs.notes, cs.costSheetFileName]);
  });

  const { sortConfig, handleSort, sortData } = useTableSort();
  const rows = sortData(filtered, (cs: any, key) => {
    switch (key) {
      case "parent": return (cs.parentName || "").toLowerCase();
      case "service": return (cs.serviceType || "").toLowerCase();
      case "total": return cs.totalCostCents ?? null;
      case "status": return cs.supersededAt ? "superseded" : cs.parentAcknowledgedAt ? "acknowledged" : "current";
      case "date": return new Date(cs.createdAt).getTime();
      default: return null;
    }
  });

  const currentCount = costSheets.filter((cs: any) => !cs.supersededAt).length;
  const acknowledgedCount = costSheets.filter((cs: any) => !cs.supersededAt && cs.parentAcknowledgedAt).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <ListPageHeader title="Cost Sheets" subtitle="Every pricing quote you've shared with parents" />

      <StatGrid>
        <StatCard label="Active cost sheets" value={currentCount} testId="stat-active-cost-sheets" />
        <StatCard label="Acknowledged by parents" value={acknowledgedCount} testId="stat-acknowledged" />
      </StatGrid>

      <ListFilterBar
        showClear={!!(q || dateFrom || dateTo || status !== "all" || svc !== "all")}
        onClear={() => setParam({ q: null, from: null, to: null, status: null, svc: null })}
        testId="provider-cost-sheets-clear-filters"
      >
        <FilterSearch
          placeholder="Search by parent or file name..."
          value={q} onChange={(v) => setParam({ q: v })}
          testId="provider-cost-sheets-search"
        />
        <FilterDateRange
          from={dateFrom} to={dateTo}
          onFrom={(v) => setParam({ from: v })} onTo={(v) => setParam({ to: v })}
          testIdPrefix="provider-cost-sheets-date"
        />
        <FilterDropdown
          single label="All statuses"
          options={COST_SHEET_STATUS_FILTERS.map(f => [f.key, f.label] as [string, string])}
          selected={status === "all" ? [] : [status]}
          onChange={(next) => setParam({ status: next[0] || null })}
          testId="provider-cost-sheets-status-filter"
        />
        <FilterDropdown
          single label="All services"
          options={SERVICE_FILTER_OPTIONS}
          selected={svc === "all" ? [] : [svc]}
          onChange={(next) => setParam({ svc: next[0] || null })}
          testId="provider-cost-sheets-service-filter"
          renderOption={(_k, text) => <ServiceTag service={text} />}
        />
      </ListFilterBar>

      {isLoading ? (
        <ListLoading />
      ) : !filtered.length ? (
        <ListEmpty
          icon={<FileText className="w-8 h-8 text-muted-foreground" />}
          message={costSheets.length ? "No cost sheets match your filters" : "No cost sheets shared yet"}
        />
      ) : (
        <TableShell minWidth={760}>
          <TableHeadRow>
            <SortableTableHead label="Parent" sortKey="parent" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <SortableTableHead label="Service" sortKey="service" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <SortableTableHead label="Total" sortKey="total" currentSort={sortConfig} onSort={handleSort} align="right" className="whitespace-nowrap" />
            <SortableTableHead label="Status" sortKey="status" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <SortableTableHead label="Shared" sortKey="date" currentSort={sortConfig} onSort={handleSort} className="whitespace-nowrap" />
            <th className="text-right whitespace-nowrap px-4 t-micro-label font-heading">Actions</th>
          </TableHeadRow>
          <tbody>
            {rows.map((cs: any) => (
              <TableBodyRow
                key={cs.id}
                onClick={() => navigate(`/chat/${cs.sessionId}?msg=quote:${cs.id}`)}
                title="Open conversation"
                className={cs.supersededAt ? "opacity-65" : ""}
                testId={`provider-cost-sheet-${cs.id}`}
              >
                <td className="p-4 align-middle whitespace-nowrap font-medium">{cs.parentName}</td>
                <td className="p-4 align-middle whitespace-nowrap"><ServiceTag service={cs.serviceType} /></td>
                <td className="p-4 align-middle text-right font-medium whitespace-nowrap tabular-nums">{formatCents(cs.totalCostCents)}</td>
                <td className="p-4 align-middle whitespace-nowrap">
                  {cs.supersededAt ? (
                    <span className="t-micro-label">Superseded</span>
                  ) : cs.parentAcknowledgedAt ? (
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-medium" style={{ color: "hsl(var(--brand-success))" }}>
                      <Check className="w-3 h-3" /> Acknowledged
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide font-medium" style={{ color: "hsl(var(--brand-warning))" }}>Current</span>
                  )}
                </td>
                <td className="t-helper p-4 align-middle whitespace-nowrap">{new Date(cs.createdAt).toLocaleDateString()}</td>
                <td className="p-4 align-middle text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex items-center gap-1.5">
                    {cs.hasFile && (
                      <Button variant="outline" size="sm" className="bg-card" asChild>
                        <a
                          href={`/api/sessions/${cs.sessionId}/cost-sheets/${cs.id}/file`}
                          target="_blank" rel="noopener noreferrer"
                          title={cs.costSheetFileName || "Download file"}
                        >
                          <Paperclip className="w-3.5 h-3.5" />
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="outline" size="sm" className="bg-card"
                      onClick={() => navigate(`/chat/${cs.sessionId}?msg=quote:${cs.id}`)}
                      title="Open conversation"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </td>
              </TableBodyRow>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
