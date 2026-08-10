/**
 * Making tasks push instead of sit there.
 *
 * Two sweeps, deliberately different in kind:
 *
 *   runTaskReminderSweep - the per-task reminder. Fires once, at whatever
 *     offset the person chose, for the specific thing they asked to be
 *     reminded about.
 *   runTaskDigestSweep - one message a day, at 8am IN THAT PERSON'S OWN
 *     TIMEZONE, listing what is due today and what is already late.
 *
 * TIMEZONE. Every due date is stored as an absolute instant, so the UI already
 * shows each person their own clock without converting anything. The only
 * place a zone is genuinely needed is here, deciding when "8am" and "today"
 * are for a given assignee - an owner in New York and a coordinator in
 * California must each get their digest at their own breakfast, not at one
 * shared server hour. That comes from ScheduleConfig.timezone, the same
 * per-user zone their calendar already uses.
 */

type Db = any;

/** The calendar's default, so a user with no schedule config behaves like it. */
const FALLBACK_TZ = "America/Los_Angeles";

/** What hour, in the person's own zone, the digest lands. */
const DIGEST_HOUR = 8;

/**
 * The wall-clock hour and calendar date it is right now for this person.
 *
 * Intl does the zone maths - no offset arithmetic, so it stays correct across
 * daylight-saving changes rather than drifting by an hour twice a year.
 */
export function localNow(tz: string, at = new Date()): { hour: number; date: string } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    return { hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
  } catch {
    return { hour: at.getUTCHours(), date: at.toISOString().slice(0, 10) };
  }
}

/** Per-user timezone, from the calendar config they already keep. */
async function timezonesFor(db: Db, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = await db.scheduleConfig.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, timezone: true },
  });
  return new Map(rows.map((r: any) => [r.userId, r.timezone || FALLBACK_TZ]));
}

/**
 * Per-task reminders.
 *
 * The claim is an atomic updateMany on reminderSentAt IS NULL, the same shape
 * every other sweep here uses: both machines see the same due task on the same
 * tick, and only the one whose UPDATE lands sends anything.
 */
export async function runTaskReminderSweep(db: Db, notifications: any): Promise<void> {
  try {
    const now = new Date();
    // Widest offset is a week, so nothing outside that window can be due.
    const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const candidates = await db.parentTask.findMany({
      where: {
        status: "OPEN",
        reminderSentAt: null,
        reminderMinutesBefore: { not: null },
        assigneeUserId: { not: null },
        dueAt: { lte: horizon },
      },
      select: {
        id: true, title: true, dueAt: true, reminderMinutesBefore: true,
        assigneeUserId: true, parentAccountId: true, type: true, priority: true,
      },
      take: 500,
    });
    const due = candidates.filter((t: any) =>
      new Date(t.dueAt).getTime() - (t.reminderMinutesBefore || 0) * 60_000 <= now.getTime());
    if (!due.length) return;

    const users = await db.user.findMany({
      where: { id: { in: Array.from(new Set(due.map((t: any) => t.assigneeUserId))) } },
      select: { id: true, name: true, email: true },
    });
    const userById = new Map<string, any>(users.map((u: any) => [u.id, u]));

    for (const task of due) {
      const claim = await db.parentTask.updateMany({
        where: { id: task.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claim.count === 0) continue;

      const user = userById.get(task.assigneeUserId);
      if (!user?.email) continue;

      await db.inAppNotification.create({
        data: {
          userId: user.id,
          eventType: "task_due",
          payload: { taskId: task.id, title: task.title, dueAt: task.dueAt, parentAccountId: task.parentAccountId },
        },
      }).catch(() => {});

      await notifications?.sendTaskReminder?.({
        recipient: { userId: user.id, email: user.email, name: user.name },
        task: { id: task.id, title: task.title, dueAt: task.dueAt, type: task.type, priority: task.priority },
        parentAccountId: task.parentAccountId,
      }).catch((e: any) => console.error(`[tasks] reminder email failed: ${e?.message}`));
    }
    console.log(`[tasks] Sent ${due.length} task reminder(s)`);
  } catch (e: any) {
    console.error(`[tasks] reminder sweep failed: ${e?.message}`);
  }
}

/**
 * The morning digest: one message per person, at 8am their time.
 *
 * Runs on the same 10-minute cron as everything else and simply asks, for each
 * person with open work, "is it 8 o'clock where you are?". That is what makes
 * one shared cron deliver at the right local hour for everyone.
 */
export async function runTaskDigestSweep(db: Db, notifications: any): Promise<void> {
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const open = await db.parentTask.findMany({
      where: { status: "OPEN", assigneeUserId: { not: null }, dueAt: { lte: soon } },
      select: { id: true, title: true, dueAt: true, assigneeUserId: true, type: true, priority: true, parentAccountId: true },
      orderBy: { dueAt: "asc" },
      take: 2000,
    });
    if (!open.length) return;

    const userIds = Array.from(new Set(open.map((t: any) => t.assigneeUserId))) as string[];
    const [users, tzById] = await Promise.all([
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
      timezonesFor(db, userIds),
    ]);

    for (const user of users as any[]) {
      if (!user.email) continue;
      const tz = tzById.get(user.id) || FALLBACK_TZ;
      const { hour, date } = localNow(tz, now);
      // Only in the 8am hour for THIS person. The cron ticks every 10 minutes,
      // so the once-a-day guard below is what stops six sends inside that hour.
      if (hour !== DIGEST_HOUR) continue;

      // Already sent today? Read-then-write is safe here only because the
      // dispatch layer ALSO dedupes identical sends inside a 10-minute window,
      // which is where the two machines actually collide.
      const since = new Date(now.getTime() - 20 * 60 * 60 * 1000);
      const already = await db.notification.findFirst({
        where: { userId: user.id, channel: "task_digest", sentAt: { gte: since } },
        select: { id: true },
      });
      if (already) continue;

      const mine = open.filter((t: any) => t.assigneeUserId === user.id);
      const overdue = mine.filter((t: any) => new Date(t.dueAt).getTime() < now.getTime());
      const today = mine.filter((t: any) => {
        const d = localNow(tz, new Date(t.dueAt)).date;
        return d === date && new Date(t.dueAt).getTime() >= now.getTime();
      });
      // Nothing due and nothing late is not worth an email.
      if (!overdue.length && !today.length) continue;

      await db.inAppNotification.create({
        data: {
          userId: user.id,
          eventType: "task_digest",
          payload: { overdue: overdue.length, dueToday: today.length },
        },
      }).catch(() => {});

      await notifications?.sendTaskDigest?.({
        recipient: { userId: user.id, email: user.email, name: user.name },
        timezone: tz,
        overdue: overdue.map((t: any) => ({ id: t.id, title: t.title, dueAt: t.dueAt })),
        today: today.map((t: any) => ({ id: t.id, title: t.title, dueAt: t.dueAt })),
      }).catch((e: any) => console.error(`[tasks] digest email failed: ${e?.message}`));

      console.log(`[tasks] Digest to ${user.email} (${tz}): ${overdue.length} overdue, ${today.length} today`);
    }
  } catch (e: any) {
    console.error(`[tasks] digest sweep failed: ${e?.message}`);
  }
}
