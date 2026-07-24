/**
 * Formatting helpers for booking/meeting date-times that get baked into
 * server-persisted product strings - in-app chat messages (`aiChatMessage`),
 * `uiCardData.providerContent`, and `inAppNotification` payloads.
 *
 * Browser-rendered UI localizes to each viewer's own timezone automatically, so
 * it needs none of this. But these strings are formatted ONCE on the server and
 * read later by the parent and/or the provider, so they MUST carry an explicit
 * timezone and its abbreviation (e.g. "PST") - otherwise they render in the
 * server process zone (UTC in prod) with no label, which is wrong for everyone.
 *
 * Dual-audience rule (see CLAUDE.md): the parent-facing `content` is formatted
 * in the parent's zone and the provider-facing `providerContent` in the
 * provider's zone.
 */

/**
 * Format a date-time in a given timezone, always including the zone abbreviation.
 * `extra` overrides the default field set (weekday/month/day/hour/minute) for
 * sites that want a different shape (e.g. deadlines without a weekday).
 */
export function formatWhen(
  date: Date | string,
  tz?: string | null,
  extra?: Intl.DateTimeFormatOptions,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...extra,
  };
  if (tz) opts.timeZone = tz;
  return d.toLocaleString("en-US", opts);
}

/**
 * The provider's own timezone (their `ScheduleConfig.timezone`), falling back to
 * the booker's zone and finally a US default. `prisma` is any client exposing
 * `scheduleConfig.findUnique` - both the standalone client and the Nest
 * PrismaService wrapper qualify.
 */
export async function resolveProviderTimezone(
  prisma: any,
  providerUserId?: string | null,
  fallbackTz?: string | null,
): Promise<string> {
  if (providerUserId) {
    try {
      const cfg = await prisma.scheduleConfig.findUnique({
        where: { userId: providerUserId },
        select: { timezone: true },
      });
      if (cfg?.timezone) return cfg.timezone;
    } catch {
      /* fall through to fallback */
    }
  }
  return fallbackTz || "America/Los_Angeles";
}
