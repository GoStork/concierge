// Parent-matched cost programs for marketplace cards, fetched for a whole deck
// at once instead of once per card.
//
// Every clinic / doctor / agency card used to fire its own raw fetch to
// /api/costs/provider/:id/parent-programs. A clinic deck renders ~175 cards, so
// switching to that tab opened 175 uncached requests at once: they saturated the
// browser's connection pool, the tail took 13-30s, and the parent's NEXT search
// queued behind all of them - a 200ms search felt like 15 seconds.
//
// Now the deck wraps its cards in <ParentProgramsProvider providerIds={...}> and
// each card reads from the shared map. Cards rendered outside a deck (the AI
// concierge match cards, provider profile pages) still work: the hook falls back
// to a single-provider React Query, which at least dedupes and caches - unlike
// the raw fetch it replaces.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { formatMoneyDollars } from "@/lib/format-money";

export interface ParentCostItem {
  label: string;
  country: string | null;
  programName: string;
  subLabel: string | null;
  total: string;
}

/**
 * Shape a provider's matched programs into the card's Costs rows, cheapest
 * first. This was copy-pasted identically into the clinic, doctor and agency
 * cards; it lives here now so a pricing-display change lands in one place.
 */
export function mapProgramsToCostItems(programs: any[] | undefined): ParentCostItem[] {
  const items = (programs || [])
    .map((p: any) => {
      const min = Number(p.minTotal);
      const max = Number(p.maxTotal);
      if (!Number.isFinite(min) || min <= 0) return null;
      const cost = Number.isFinite(max) && max > min
        ? `${formatMoneyDollars(min)} - ${formatMoneyDollars(max)}`
        : formatMoneyDollars(min);
      const name = p.programName || p.country || "Program";
      // Structured fields drive the cost_cards layout; label is the fallback.
      return { label: `${name}: ${cost}`, country: p.country || null, programName: name, subLabel: p.subTypeLabel || null, total: cost, _min: min };
    })
    .filter(Boolean) as (ParentCostItem & { _min: number })[];
  items.sort((a, b) => a._min - b._min);
  return items.map(({ _min, ...rest }) => rest);
}

type ProgramsMap = Record<string, { programs: any[] }>;

const ParentProgramsContext = createContext<{ map: ProgramsMap } | null>(null);

// Pricing a provider costs the server ~200ms, so asking for a 450-clinic deck in
// one shot takes 5-9s. The parent only ever looks at the first handful of cards,
// so the first chunk is small and goes out immediately; the rest follow once it
// lands and fill in off-screen cards without ever competing with a search.
const FIRST_CHUNK = 30;
const REST_CHUNK = 150;

function chunkIds(ids: string[]): string[][] {
  if (ids.length === 0) return [];
  const out: string[][] = [ids.slice(0, FIRST_CHUNK)];
  for (let i = FIRST_CHUNK; i < ids.length; i += REST_CHUNK) {
    out.push(ids.slice(i, i + REST_CHUNK));
  }
  return out;
}

async function fetchPrograms(providerIds: string[], parentAccountId: string): Promise<ProgramsMap> {
  const res = await fetch("/api/costs/providers/parent-programs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ providerIds, parentAccountId }),
  });
  if (!res.ok) return {};
  return res.json();
}

/**
 * Wrap a deck to batch its cards' cost lookups. `providerIds` must be in the
 * order the deck renders them, so the first chunk covers what the parent sees.
 */
export function ParentProgramsProvider({ providerIds, children }: {
  providerIds: (string | null | undefined)[];
  children: ReactNode;
}) {
  const { user } = useAuth();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;

  // Dedupe but KEEP deck order - the first chunk has to be the cards on screen.
  const ids = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of providerIds) {
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }, [providerIds]);

  const chunks = useMemo(() => chunkIds(ids), [ids]);
  const firstChunk = chunks[0] ?? [];
  const restChunks = useMemo(() => chunks.slice(1), [chunks]);

  // Chunk 0 covers the cards on screen and goes out immediately.
  const first = useQuery<ProgramsMap>({
    queryKey: ["parent-programs-batch", parentAccountId, firstChunk.join(",")],
    queryFn: () => fetchPrograms(firstChunk, parentAccountId!),
    enabled: !!parentAccountId && firstChunk.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  // The rest fill in off-screen cards only AFTER the visible ones have their
  // prices, so the server is never pricing 450 providers while the parent waits
  // on the nine they can actually see.
  const rest = useQueries({
    queries: restChunks.map((chunk) => ({
      queryKey: ["parent-programs-batch", parentAccountId, chunk.join(",")],
      queryFn: () => fetchPrograms(chunk, parentAccountId!),
      enabled: !!parentAccountId && chunk.length > 0 && !first.isPending,
      staleTime: 5 * 60_000,
      gcTime: 10 * 60_000,
    })),
  });

  const restStamp = rest.map((r) => r.dataUpdatedAt).join(",");
  const map = useMemo(() => {
    const merged: ProgramsMap = {};
    Object.assign(merged, first.data || {});
    for (const r of rest) Object.assign(merged, (r.data as ProgramsMap) || {});
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.data, restStamp]);

  const value = useMemo(() => ({ map }), [map]);

  return (
    <ParentProgramsContext.Provider value={value}>
      {children}
    </ParentProgramsContext.Provider>
  );
}

/**
 * A card's parent-matched cost rows. Inside a deck this is a free map lookup
 * against the batched result; standalone (chat match cards, profile pages) it
 * falls back to a cached single-provider query.
 */
export function useParentCostItems(providerId: string | null | undefined): ParentCostItem[] {
  const ctx = useContext(ParentProgramsContext);
  const { user } = useAuth();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;

  // Only used when the card is rendered outside a deck. Hooks must run
  // unconditionally, so the query is always declared and simply disabled when
  // the batched map already covers this provider.
  const standalone = !ctx;
  const { data } = useQuery<ProgramsMap>({
    queryKey: ["parent-programs-batch", parentAccountId, providerId || ""],
    queryFn: () => fetchPrograms([providerId!], parentAccountId!),
    enabled: standalone && !!parentAccountId && !!providerId,
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    if (!providerId) return [];
    const source = ctx ? ctx.map : data;
    return mapProgramsToCostItems(source?.[providerId]?.programs);
  }, [ctx, data, providerId]);
}
