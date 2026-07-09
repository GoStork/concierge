/**
 * Parent Cost Sheets page
 * Route: /my/cost-sheets
 *
 * Dedicated view of every cost sheet quote across ALL providers, with status
 * (Current / Superseded / Acknowledged), file download, and a jump into the
 * conversation it was shared in. Reached from the Home dashboard's Cost
 * Sheets section. Split out of the old 3-tab Billing page.
 */

import { Link, useSearchParams } from "react-router-dom";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { useQuery } from "@tanstack/react-query";
import { Loader2, FileText, Search, Paperclip, MessageCircle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

const COST_SHEET_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "current", label: "Current" },
  { key: "superseded", label: "Superseded" },
];

export default function MyCostSheetsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") || "all";
  const q = searchParams.get("q") || "";

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || v === "all") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  };

  const { data: costSheetData, isLoading } = useQuery<{ quotes: any[] }>({
    queryKey: ["/api/my/cost-sheets"],
    queryFn: async () => {
      const res = await fetch("/api/my/cost-sheets", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cost sheets");
      return res.json();
    },
  });
  const costSheets = costSheetData?.quotes ?? [];

  const matchesSearch = (haystack: Array<string | null | undefined>) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return haystack.some(h => (h || "").toLowerCase().includes(needle));
  };

  const filteredCostSheets = costSheets.filter((cs: any) => {
    if (status === "current" && cs.supersededAt) return false;
    if (status === "superseded" && !cs.supersededAt) return false;
    return matchesSearch([cs.providerName, cs.notes, cs.costSheetFileName]);
  });

  const currentCostSheetCount = costSheets.filter((cs: any) => !cs.supersededAt).length;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Cost Sheets</h1>
        <p className="text-sm text-muted-foreground mt-1">Every pricing quote your providers have shared with you</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Active Cost Sheets</p>
          <p className="text-xl font-heading font-bold">{currentCostSheetCount}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Received</p>
          <p className="text-xl font-heading font-bold">{costSheets.length}</p>
        </div>
      </div>

      {/* Search + status filter */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={q}
            onChange={e => setParam({ q: e.target.value })}
            placeholder="Search by provider or file name..."
            className="w-full h-9 pl-9 pr-3 rounded-[var(--radius)] border bg-background text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
            data-testid="cost-sheets-search"
          />
        </div>
        <select
          value={status}
          onChange={e => setParam({ status: e.target.value })}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
          data-testid="cost-sheets-status-filter"
        >
          {COST_SHEET_STATUS_FILTERS.map(f => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        <ClearFiltersButton
          show={!!(q || status !== "all")}
          onClick={() => setParam({ q: null, status: null })}
          testId="my-cost-sheets-clear-filters"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !filteredCostSheets.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <FileText className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{costSheets.length ? "No cost sheets match your filters" : "No cost sheets yet"}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredCostSheets.map((cs: any) => (
            <div
              key={cs.id}
              className="rounded-xl border px-5 py-4 flex items-center justify-between gap-3"
              style={{ opacity: cs.supersededAt ? 0.65 : 1 }}
              data-testid={`billing-cost-sheet-${cs.id}`}
            >
              <div className="space-y-0.5 min-w-0">
                <p className="font-semibold truncate">{cs.providerName || "Provider"}</p>
                <p className="text-sm text-muted-foreground">
                  {new Date(cs.createdAt).toLocaleDateString()}
                  {cs.parentAcknowledgedAt && (
                    <span className="inline-flex items-center gap-1 ml-2" style={{ color: "hsl(var(--brand-success))" }}>
                      <Check className="w-3 h-3" /> Acknowledged
                    </span>
                  )}
                </p>
                {cs.notes && <p className="text-xs text-muted-foreground italic truncate">{cs.notes}</p>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {cs.supersededAt ? (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">Superseded</span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wide font-medium" style={{ color: "hsl(var(--brand-success))" }}>Current</span>
                )}
                <p className="font-heading font-bold">{formatCents(cs.totalCostCents)}</p>
                <div className="flex items-center gap-1.5">
                  {cs.hasFile && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/api/sessions/${cs.sessionId}/cost-sheets/${cs.id}/file`} target="_blank" rel="noopener noreferrer" title={cs.costSheetFileName || "Download file"}>
                        <Paperclip className="w-3.5 h-3.5" />
                      </a>
                    </Button>
                  )}
                  <Button variant="outline" size="sm" asChild>
                    <Link to={`/chat/${cs.sessionId}?msg=quote:${cs.id}`} title="Open conversation">
                      <MessageCircle className="w-3.5 h-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
