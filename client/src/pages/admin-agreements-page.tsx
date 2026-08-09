/**
 * GoStork Admin Agreements page
 * Route: /admin/agreements
 *
 * Every agreement across ALL providers - the platform-wide counterpart of
 * /provider/agreements, with the same search + date + status + type filters
 * plus the provider name on each row. Reached from the admin Home's
 * Out-for-signature section; rows open the read-only agreement view.
 */

import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, FileSignature } from "lucide-react";
import { AgreementRows } from "@/components/agreements-list";
import { inDateRange } from "@/components/date-range-filter";
import { ClearFiltersButton } from "@/components/clear-filters-button";
import { PageHeader } from "@/components/ui/page-header";
import { FilterRow, FilterSearch, FilterDropdown, FilterDateRange } from "@/components/ui/filter-controls";

// "all" is the absence of a selection, not an option - the shared dropdown
// clears by re-picking, so listing it would be a second way to say the same
// thing.
const AGREEMENT_STATUS_FILTERS: [string, string][] = [
  ["sent", "Sent - awaiting signature"],
  ["signed", "Signed"],
  ["other", "Rejected / expired / error"],
];

export default function AdminAgreementsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") || "all";
  const q = searchParams.get("q") || "";
  const docType = searchParams.get("type") || "all";
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

  const { data: agreements = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/admin/agreements"],
    queryFn: async () => {
      const res = await fetch("/api/admin/agreements", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreements");
      return res.json();
    },
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const matchesSearch = (a: any) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [a.parentName, a.providerName, a.documentType]
      .some(h => (h || "").toLowerCase().includes(needle));
  };

  const docTypes = Array.from(new Set(agreements.map((a: any) => a.documentType).filter(Boolean))) as string[];

  const filtered = agreements.filter((a: any) => {
    if (status === "sent" && a.status !== "SENT") return false;
    if (status === "signed" && a.status !== "SIGNED") return false;
    if (status === "other" && !["REJECTED", "EXPIRED", "ERROR", "CREATED", "DRAFT"].includes(a.status)) return false;
    if (docType !== "all" && a.documentType !== docType) return false;
    if (!inDateRange(a.createdAt, dateFrom, dateTo)) return false;
    return matchesSearch(a);
  });

  const sentCount = agreements.filter((a: any) => a.status === "SENT").length;
  const signedCount = agreements.filter((a: any) => a.status === "SIGNED").length;

  return (
    <div className="space-y-8">
      <PageHeader title="Agreements" subtitle="Every contract across all providers and parents" />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 max-w-xl">
        <div className="rounded-[var(--radius)] border border-border/50 bg-card p-4 space-y-1">
          <p className="t-micro-label">Awaiting Signature</p>
          <p className="text-xl font-heading font-bold">{sentCount}</p>
        </div>
        <div className="rounded-[var(--radius)] border border-border/50 bg-card p-4 space-y-1">
          <p className="t-micro-label">Fully Signed</p>
          <p className="text-xl font-heading font-bold">{signedCount}</p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3">
        <FilterRow className="flex-1 min-w-0">
          <FilterSearch
            value={q}
            onChange={(v) => setParam({ q: v })}
            placeholder="Search by parent, provider, or agreement type..."
            testId="admin-agreements-search"
          />
          <FilterDateRange
            from={dateFrom}
            to={dateTo}
            onFrom={(v) => setParam({ from: v })}
            onTo={(v) => setParam({ to: v })}
            testIdPrefix="admin-agreements-date"
          />
          <FilterDropdown
            single
            label="All statuses"
            options={AGREEMENT_STATUS_FILTERS}
            selected={status === "all" ? [] : [status]}
            onChange={(next) => setParam({ status: next[0] || null })}
            testId="admin-agreements-status-filter"
          />
          {docTypes.length > 1 && (
            <FilterDropdown
              single
              label="All types"
              options={docTypes.map((dt) => [dt, dt] as [string, string])}
              selected={docType === "all" ? [] : [docType]}
              onChange={(next) => setParam({ type: next[0] || null })}
              testId="admin-agreements-type-filter"
            />
          )}
        </FilterRow>
        <ClearFiltersButton
          pill
          show={!!(q || dateFrom || dateTo || status !== "all" || docType !== "all")}
          onClick={() => setParam({ q: null, from: null, to: null, status: null, type: null })}
          testId="admin-agreements-clear-filters"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !filtered.length ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <FileSignature className="w-8 h-8 text-muted-foreground" />
          <p className="t-helper">
            {agreements.length ? "No agreements match your filters" : "No agreements on the platform yet."}
          </p>
        </div>
      ) : (
        <AgreementRows
          variant="table"
          items={filtered.map((a: any) => ({
            id: a.id,
            status: a.status,
            documentType: a.documentType,
            createdAt: a.createdAt,
            signedAt: a.signedAt,
            // Admin spans providers, so the provider gets its own sortable
            // column instead of being glued onto the parent's name.
            title: a.parentName,
            providerName: a.providerName,
            progressLabel: a.status === "SENT" && a.signerCount > 0 ? `${a.signedCount}/${a.signerCount} signed` : null,
          }))}
        />
      )}
    </div>
  );
}
