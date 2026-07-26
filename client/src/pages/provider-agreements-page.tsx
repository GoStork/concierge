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
import { Loader2, Search, FileSignature } from "lucide-react";
import { AgreementRows } from "@/components/agreements-list";
import { DateRangeFilter, inDateRange } from "@/components/date-range-filter";
import { ClearFiltersButton } from "@/components/clear-filters-button";

const AGREEMENT_STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
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
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold">Agreements</h1>
        <p className="t-helper mt-1">Every contract you've sent to parents, across all services</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border p-4 space-y-1">
          <p className="t-micro-label">Awaiting Signature</p>
          <p className="text-xl font-heading font-bold">{sentCount}</p>
        </div>
        <div className="rounded-xl border p-4 space-y-1">
          <p className="t-micro-label">Fully Signed</p>
          <p className="text-xl font-heading font-bold">{signedCount}</p>
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
            placeholder="Search by parent or agreement type..."
            className="w-full h-9 pl-9 pr-3 rounded-[var(--radius)] border bg-background text-sm outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]"
            data-testid="provider-agreements-search"
          />
        </div>
        <DateRangeFilter from={dateFrom} to={dateTo} onFrom={v => setParam({ from: v })} onTo={v => setParam({ to: v })} testIdPrefix="provider-agreements-date" />
        <select
          value={status}
          onChange={e => setParam({ status: e.target.value })}
          className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
          data-testid="provider-agreements-status-filter"
        >
          {AGREEMENT_STATUS_FILTERS.map(f => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        {docTypes.length > 1 && (
          <select
            value={docType}
            onChange={e => setParam({ type: e.target.value })}
            className="h-9 px-3 rounded-[var(--radius)] border bg-background text-sm"
            data-testid="provider-agreements-type-filter"
          >
            <option value="all">All types</option>
            {docTypes.map(dt => (
              <option key={dt} value={dt}>{dt}</option>
            ))}
          </select>
        )}
        <ClearFiltersButton
          show={!!(q || dateFrom || dateTo || status !== "all" || docType !== "all")}
          onClick={() => setParam({ q: null, from: null, to: null, status: null, type: null })}
          testId="provider-agreements-clear-filters"
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
            {agreements.length ? "No agreements match your filters" : "No agreements sent yet. Agreements appear here once drafted or sent for signature."}
          </p>
        </div>
      ) : (
        <AgreementRows
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
