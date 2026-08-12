import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";

/**
 * Watches the shared Twilio account for a resumed bot wave, so nobody has to
 * keep a console tab open.
 *
 * The Aug 2026 signup attack fired 8-10 verification SMS per minute through
 * the OLD platform. The Cloudflare challenge stopped it upstream, but the
 * attacker adapted once already (rotating to allowed-country numbers the same
 * afternoon), so the assumption is they will probe again. Both platforms send
 * through this one Twilio account, which makes the Messages log the earliest
 * reliable signal: a bot that gets past the edge challenge produces a send
 * attempt here BEFORE it becomes a verified account or a HubSpot contact.
 *
 * Every 15 minutes this pulls the recent message list straight from the
 * Twilio REST API (read only) and alarms when the window looks like an
 * attack, not like customers:
 *
 *   - 25+ outbound messages in 15 minutes (legit volume is a fraction of
 *     that), or
 *   - 10+ to numbers outside +1 (US/CA carry the real traffic; a burst of
 *     foreign destinations is the fraud signature even when each individual
 *     country is allowed)
 *
 * Alerts email every GoStork admin, at most once per hour - claimed through
 * Notification.dedupeKey exactly like the booking reminders, because both
 * Macs run this same cron and a read-then-send gate would double-send.
 */

let scheduledTask: cron.ScheduledTask | null = null;

const WINDOW_MINUTES = 15;
const TOTAL_THRESHOLD = 25;
const NON_US_CA_THRESHOLD = 10;

interface TwilioMessage {
  direction: string;
  to: string | null;
  status: string;
  date_created: string;
}

async function twilioGet(path: string): Promise<any | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
  });
  if (!res.ok) throw new Error(`Twilio API ${res.status} on ${path}`);
  return res.json();
}

export async function runTwilioAbuseCheck(
  prisma: PrismaService,
  notifications: NotificationService,
): Promise<void> {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return; // nothing to watch without credentials (e.g. test runs)
  }

  // The list endpoint only filters DateSent by whole days, so pull the most
  // recent page (newest first) and cut the window client-side.
  const page = await twilioGet(`/Messages.json?PageSize=200`);
  const windowStart = Date.now() - WINDOW_MINUTES * 60_000;
  const recent: TwilioMessage[] = ((page?.messages || []) as TwilioMessage[]).filter(
    (m) => m.direction?.startsWith("outbound") && new Date(m.date_created).getTime() >= windowStart,
  );

  const total = recent.length;
  const nonUsCa = recent.filter((m) => m.to && !m.to.startsWith("+1")).length;
  const failed = recent.filter((m) => m.status === "failed" || m.status === "undelivered").length;

  if (total < TOTAL_THRESHOLD && nonUsCa < NON_US_CA_THRESHOLD) {
    return; // quiet window - no log spam either
  }

  // Prefix histogram so the alert says WHERE the burst is aimed without
  // reproducing any full phone number.
  const prefixCounts = new Map<string, number>();
  for (const m of recent) {
    const prefix = (m.to || "").slice(0, 4);
    if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
  }
  const topDestinations = [...prefixCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([p, n]) => `${p}* x${n}`);

  // At most one alert per hour, claimed atomically across both machines. The
  // claim row needs an owner; any active GoStork admin will do.
  const admin = await prisma.user.findFirst({
    where: { roles: { has: "GOSTORK_ADMIN" }, isDisabled: false },
    select: { id: true, email: true },
  });
  if (!admin) {
    console.warn("[twilio-watchdog] Burst detected but no active GOSTORK_ADMIN to notify");
    return;
  }
  const hourKey = new Date().toISOString().slice(0, 13); // 2026-08-12T17
  try {
    await prisma.notification.create({
      data: {
        userId: admin.id,
        type: "security_abuse_alert",
        channel: "email",
        recipient: admin.email || "",
        status: "sent",
        sentAt: new Date(),
        dedupeKey: `twilio-abuse:${hourKey}`,
      },
    });
  } catch (e: any) {
    if (e?.code === "P2002") return; // this hour's alert already claimed (possibly by the other Mac)
    throw e;
  }

  let balance: string | null = null;
  try {
    const b = await twilioGet(`/Balance.json`);
    if (b?.balance) balance = `$${Number(b.balance).toFixed(2)} ${b.currency || "USD"}`;
  } catch {
    // balance is garnish - never block the alert on it
  }

  console.warn(
    `[twilio-watchdog] ALERT: ${total} sends in ${WINDOW_MINUTES}min (${nonUsCa} outside +1, ${failed} failed) - emailing admins`,
  );
  await notifications.sendSecurityAbuseAlert({
    windowMinutes: WINDOW_MINUTES,
    total,
    nonUsCa,
    failed,
    topDestinations,
    balance,
  });
}

export function startTwilioAbuseWatchdog(prisma: PrismaService, notifications: NotificationService) {
  if (scheduledTask) {
    console.log("[twilio-watchdog] Scheduler already running");
    return;
  }

  // Check once on boot so a restart mid-attack still alarms promptly.
  runTwilioAbuseCheck(prisma, notifications).catch((err) => {
    console.error("[twilio-watchdog] Startup check error:", err.message);
  });

  scheduledTask = cron.schedule("*/15 * * * *", async () => {
    try {
      await runTwilioAbuseCheck(prisma, notifications);
    } catch (err: any) {
      console.error("[twilio-watchdog] Cron job error:", err.message);
    }
  });

  console.log("[twilio-watchdog] Scheduler started - checks the Twilio message log every 15 minutes");
}

export function stopTwilioAbuseWatchdog() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[twilio-watchdog] Scheduler stopped");
  }
}
