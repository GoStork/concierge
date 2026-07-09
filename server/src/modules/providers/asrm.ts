// ASRM minimum-requirements gate for surrogate profiles.
//
// The platform-wide minimums live on the GoStork house provider's
// "Surrogate Matching Requirements" settings (ivfSurrogate* columns), so the
// GoStork team edits them from the normal Company settings UI. Every
// surrogate that enters or changes in the system (website sync, bulk PDF
// upload, manual edit) is evaluated against them; failing profiles get the
// system-owned asrmHidden flag, which parent-facing queries exclude
// regardless of the provider-controlled hiddenFromSearch toggle.

import { Prisma } from "@prisma/client";
import {
  evaluateSurrogateAsrm,
  surrogateAsrmRequirementsFromProvider,
  surrogateAsrmFactsFromRow,
  type SurrogateAsrmRequirements,
} from "../../../../shared/surrogate-requirements";

const ASRM_SELECT = {
  id: true,
  ivfSurrogateMinAge: true,
  ivfSurrogateMaxAge: true,
  ivfSurrogateMinBmi: true,
  ivfSurrogateMaxBmi: true,
  ivfSurrogateMinDeliveries: true,
  ivfSurrogateMaxDeliveries: true,
  ivfSurrogateMaxCSections: true,
  ivfSurrogateMaxMiscarriages: true,
  ivfSurrogateMaxAbortions: true,
  ivfSurrogateMaxYearsFromLastPregnancy: true,
  ivfSurrogateMonthsPostVaginal: true,
  ivfSurrogateCovidVaccination: true,
} as const;

let cachedReqs: { value: SurrogateAsrmRequirements | null; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

/** Clear the requirements cache (call after the house provider's settings change). */
export function invalidateAsrmRequirementsCache() {
  cachedReqs = null;
}

/** Resolve the GoStork house provider whose Surrogate Matching Requirements
 *  act as the platform-wide ASRM minimums. Explicit env override first, then
 *  the provider literally named "GoStork". Returns null (gate disabled) when
 *  neither exists - a missing house provider must not block profile syncs. */
export async function getAsrmRequirements(prisma: any): Promise<SurrogateAsrmRequirements | null> {
  if (cachedReqs && Date.now() - cachedReqs.at < CACHE_TTL_MS) return cachedReqs.value;

  let row: any = null;
  const envId = process.env.GOSTORK_PROVIDER_ID;
  if (envId) {
    row = await prisma.provider.findUnique({ where: { id: envId }, select: ASRM_SELECT });
  }
  if (!row) {
    row = await prisma.provider.findFirst({
      where: { name: { equals: "GoStork", mode: "insensitive" } },
      select: ASRM_SELECT,
    });
  }
  const value = row ? surrogateAsrmRequirementsFromProvider(row) : null;
  cachedReqs = { value, at: Date.now() };
  return value;
}

/** Evaluate one surrogate row against the platform minimums and persist the
 *  asrmHidden flag + failure reasons if they changed. The row must include
 *  id, age, bmi, liveBirths, cSections, miscarriages, abortions,
 *  lastDeliveryYear, covidVaccinated, asrmHidden, asrmFailReasons. */
export async function applyAsrmGate(prisma: any, surrogateRow: any): Promise<{ hidden: boolean; failures: string[]; missing: string[] }> {
  const reqs = await getAsrmRequirements(prisma);
  const { pass, failures, missing } = evaluateSurrogateAsrm(reqs, surrogateAsrmFactsFromRow(surrogateRow));
  const hidden = !pass;

  const prevReasons = JSON.stringify(surrogateRow.asrmFailReasons ?? null);
  const nextReasons = hidden ? { failures, missing } : null;
  if (surrogateRow.asrmHidden !== hidden || prevReasons !== JSON.stringify(nextReasons)) {
    await prisma.surrogate.update({
      where: { id: surrogateRow.id },
      data: { asrmHidden: hidden, asrmFailReasons: nextReasons === null ? Prisma.DbNull : nextReasons },
    });
  }
  return { hidden, failures, missing };
}

/** Re-evaluate every surrogate in the system. Used for the backfill and
 *  whenever the GoStork house provider's requirements change. */
export async function reevaluateAllSurrogatesAsrm(prisma: any): Promise<{ total: number; hidden: number; changed: number }> {
  invalidateAsrmRequirementsCache();
  const reqs = await getAsrmRequirements(prisma);
  const rows = await prisma.surrogate.findMany({
    select: {
      id: true, age: true, bmi: true, liveBirths: true, cSections: true,
      miscarriages: true, abortions: true, lastDeliveryYear: true,
      covidVaccinated: true, asrmHidden: true, asrmFailReasons: true,
    },
  });
  let hidden = 0;
  let changed = 0;
  for (const row of rows) {
    const { pass, failures, missing } = evaluateSurrogateAsrm(reqs, surrogateAsrmFactsFromRow(row));
    const nextHidden = !pass;
    if (nextHidden) hidden++;
    const prevReasons = JSON.stringify(row.asrmFailReasons ?? null);
    const nextReasons = nextHidden ? { failures, missing } : null;
    if (row.asrmHidden !== nextHidden || prevReasons !== JSON.stringify(nextReasons)) {
      changed++;
      await prisma.surrogate.update({
        where: { id: row.id },
        data: { asrmHidden: nextHidden, asrmFailReasons: nextReasons === null ? Prisma.DbNull : nextReasons },
      });
    }
  }
  console.log(`[ASRM] Re-evaluated ${rows.length} surrogates: ${hidden} below minimums, ${changed} rows updated`);
  return { total: rows.length, hidden, changed };
}
