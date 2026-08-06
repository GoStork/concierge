import { Prisma } from "@prisma/client";

/**
 * Prisma's InputJsonValue rejects nested nulls, though a JSON column stores
 * them perfectly well - so a card payload with `providerName: string | null`
 * fails to typecheck against uiCardData. This narrows at the boundary instead
 * of forcing every card shape to use undefined.
 */
export function asJson<T>(value: T): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Rewrite a literal `null` on the named Json columns to `Prisma.DbNull`.
 *
 * A `Json?` column has two distinct nulls: the JSON value `null` and a NULL
 * cell. Prisma refuses a bare `null` rather than guess, so a zod-validated
 * form payload (where "cleared" is `null`) cannot be handed to create/update
 * as-is. Clearing a field means clearing the cell, so DbNull is the intent.
 */
export function normalizeJsonNulls<T extends Record<string, any>, K extends string>(
  payload: T,
  jsonFields: readonly K[],
): Omit<T, K> & { [P in K]?: Prisma.InputJsonValue | typeof Prisma.DbNull } {
  const out: Record<string, any> = { ...payload };
  for (const f of jsonFields) {
    if (f in out && out[f] === null) out[f] = Prisma.DbNull;
  }
  return out as Omit<T, K> & { [P in K]?: Prisma.InputJsonValue | typeof Prisma.DbNull };
}
