/**
 * Provider Agreements page
 * Route: /provider/agreements
 *
 * Every agreement across all the provider's parents - unlike the parent side
 * (1-2 agreements, shown inline on Home), an agency accumulates many, so this
 * is a dedicated page with search + status filter. Reached from the Home
 * dashboard's Agreements and Out-for-signature sections.
 */

import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileSignature } from "lucide-react";
import { AgreementRows } from "@/components/agreements-list";
import { inDateRange } from "@/components/date-range-filter";
import { FilterSearch, FilterDropdown, FilterDateRange } from "@/components/ui/filter-controls";
import { ListPageHeader, StatGrid, StatCard, ListFilterBar, ListLoading, ListEmpty } from "@/components/ui/list-page";

const AGREEMENT_STATUS_FILTERS = [
  { key: "sent", label: "Sent - awaiting signature" },
  { key: "signed", label: "Signed" },
  { key: "other", label: "Rejected / expired / error" },
];

export default function ProviderAgreementsPage() {
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
    queryKey: ["/api/agreements"],
    queryFn: async () => {
      const res = await fetch("/api/agreements", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreements");
      return res.json();
    },
  });

  const matchesSearch = (a: any) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [a.parentName, a.parentEmail, a.documentType]
      .some(h => (h || "").toLowerCase().includes(needle));
  };

  // Type options come from the data itself (Surrogacy Agreement, Egg
  // Donation Agreement, ...) so multi-service agencies see exactly theirs.
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
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <ListPageHeader title="Agreements" subtitle="Every contract you've sent to parents, across all services" />

      <StatGrid>
        <StatCard label="Awaiting signature" value={sentCount} testId="stat-awaiting-signature" />
        <StatCard label="Fully signed" value={signedCount} testId="stat-fully-signed" />
      </StatGrid>

      <ListFilterBar
        showClear={!!(q || dateFrom || dateTo || status !== "all" || docType !== "all")}
        onClear={() => setParam({ q: null, from: null, to: null, status: null, type: null })}
        testId="provider-agreements-clear-filters"
      >
        <FilterSearch
          placeholder="Search by parent or agreement type..."
          value={q} onChange={(v) => setParam({ q: v })}
          testId="provider-agreements-search"
        />
        <FilterDateRange
          from={dateFrom} to={dateTo}
          onFrom={(v) => setParam({ from: v })} onTo={(v) => setParam({ to: v })}
          testIdPrefix="provider-agreements-date"
        />
        <FilterDropdown
          single label="All statuses"
          options={AGREEMENT_STATUS_FILTERS.map(f => [f.key, f.label] as [string, string])}
          selected={status === "all" ? [] : [status]}
          onChange={(next) => setParam({ status: next[0] || null })}
          testId="provider-agreements-status-filter"
        />
        {docTypes.length > 1 && (
          <FilterDropdown
            single label="All types"
            options={docTypes.map(dt => [dt, dt] as [string, string])}
            selected={docType === "all" ? [] : [docType]}
            onChange={(next) => setParam({ type: next[0] || null })}
            testId="provider-agreements-type-filter"
          />
        )}
      </ListFilterBar>

      {isLoading ? (
        <ListLoading />
      ) : !filtered.length ? (
        <ListEmpty
          icon={<FileSignature className="w-8 h-8 text-muted-foreground" />}
          message={agreements.length
            ? "No agreements match your filters"
            : "No agreements sent yet. Agreements appear here once drafted or sent for signature."}
        />
      ) : (
        // variant="table" is the same shared renderer the record's Documents
        // panel uses - no second agreements table to keep in step.
        <AgreementRows
          variant="table"
          items={filtered.map((a: any) => ({
            id: a.id,
            status: a.status,
            documentType: a.documentType,
            createdAt: a.createdAt,
            signedAt: a.signedAt,
            title: a.parentName,
          }))}
        />
      )}
    </div>
  );
}
