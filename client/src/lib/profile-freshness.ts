/**
 * When the content on this profile last actually changed.
 *
 * NOT `updatedAt`. That is a Prisma `@updatedAt` column: it moves whenever any
 * column on the row is written, including by background work a parent has no
 * stake in - embedding refreshes, the ASRM gate, photo migration, a backfill.
 * A surrogate whose PDF was uploaded in March and never touched since read
 * "Updated today" because a script wrote one derived field to her row that
 * morning. The label is a trust claim about how current the profile is, so
 * sourcing it from a column that moves for unrelated reasons makes it a lie
 * that is invisible to us and legible to a parent who knows the agency.
 *
 * The honest sources, newest wins:
 *   lastEditedAt   - a human edited this profile
 *   lastFullSyncAt - we refreshed it from the agency
 *   createdAt      - it has not changed since it arrived (PDF uploads)
 */
export function profileContentUpdatedAt(profile: {
  lastEditedAt?: string | Date | null;
  lastFullSyncAt?: string | Date | null;
  createdAt?: string | Date | null;
} | null | undefined): Date | null {
  if (!profile) return null;
  const times = [profile.lastEditedAt, profile.lastFullSyncAt, profile.createdAt]
    .map((v) => (v ? new Date(v).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.max(...times)) : null;
}
