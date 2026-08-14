/**
 * Partner providers picker - ONE shared card for both directions and both
 * surfaces (admin provider edit page Profile tab, provider-side Company tab):
 *
 *  - A surrogacy AGENCY links its partner IVF clinics: the AI bundles the two
 *    (combined matching requirements + combined program costs, sequential
 *    two-call booking) for ANY agency with partners, domestic or international.
 *  - An IVF CLINIC links the surrogacy agencies it works with: an EXCLUSIVITY
 *    list - the AI only ever offers these agencies to that clinic's parents.
 *
 * The chips + inline search results deliberately avoid dropdown portals so the
 * card works inside overflow-hidden ancestors on both surfaces.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Check, X } from "lucide-react";

interface PartnerProvidersCardProps {
  /** What kind of provider is being edited - decides the partner direction. */
  editingType: "surrogacy-agency" | "ivf-clinic";
  /** The provider being edited (never offered as its own partner). */
  selfId: string;
  value: string[];
  onChange: (ids: string[]) => void;
  readOnly?: boolean;
}

export function PartnerProvidersCard({ editingType, selfId, value, onChange, readOnly }: PartnerProvidersCardProps) {
  const [search, setSearch] = useState("");
  const forAgency = editingType === "surrogacy-agency";
  const optionsPath = forAgency ? "/api/providers/by-type/ivf-clinic" : "/api/providers/by-type/surrogacy-agency";
  const heading = forAgency ? "Partner IVF Clinics" : "Partner Surrogacy Agencies";
  const description = forAgency
    ? "Link the IVF clinic(s) this agency works with. The AI combines both providers' matching requirements and costs when evaluating parents, and books consultations with both - the agency first, then the clinic. Works for domestic and international agencies alike."
    : "Link the surrogacy agencies this clinic works with. If any are set, the AI treats the list as EXCLUSIVE: parents working with this clinic will only ever be offered these agencies, with a clear explanation that the clinic partners with specific agencies.";
  const noun = forAgency ? "IVF clinics" : "surrogacy agencies";

  const { data: options } = useQuery<any[]>({
    queryKey: [optionsPath],
    queryFn: async () => {
      const res = await fetch(optionsPath, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  return (
    <Card className="p-6 space-y-4" data-testid="card-partner-providers">
      <h3 className="text-lg font-heading flex items-center gap-2">
        <Check className="w-5 h-5 text-primary" /> {heading}
      </h3>
      <p className="t-helper">{description}</p>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((pid) => {
            const partner = (options || []).find((c: any) => c.id === pid);
            return (
              <Badge key={pid} variant="outline" className="flex items-center gap-1" data-testid={`chip-partner-clinic-${pid}`}>
                {partner?.name || pid}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((x) => x !== pid))}
                    className="ml-1 text-muted-foreground hover:text-destructive"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </Badge>
            );
          })}
        </div>
      )}

      {!readOnly && (
        <div className="max-w-md">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${noun} to add...`}
            data-testid="input-partner-clinic-search"
          />
          {search.trim() && (
            <ul className="mt-1 w-full max-h-64 overflow-y-auto rounded-[var(--container-radius)] border border-border bg-card shadow-md">
              {(() => {
                const q = search.trim().toLowerCase();
                const matches = (options || [])
                  .filter((c: any) => c.id !== selfId && !value.includes(c.id) && c.name.toLowerCase().includes(q))
                  .slice(0, 10);
                if (matches.length === 0) {
                  return <li className="t-helper px-3 py-2 italic">No matching {noun}</li>;
                }
                return matches.map((partner: any) => (
                  <li
                    key={partner.id}
                    className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted"
                    onClick={() => {
                      onChange([...value, partner.id]);
                      setSearch("");
                    }}
                    data-testid={`option-partner-clinic-${partner.id}`}
                  >
                    <span>{partner.name}</span>
                    {partner.locations?.length > 0 && (
                      <span className="t-helper">({partner.locations.map((l: any) => l.state || l.city).filter(Boolean).slice(0, 2).join(", ")})</span>
                    )}
                  </li>
                ));
              })()}
            </ul>
          )}
        </div>
      )}
      {!options && <p className="t-helper italic">Loading {noun}...</p>}
    </Card>
  );
}
