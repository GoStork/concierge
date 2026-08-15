import * as cron from "node-cron";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";

let scheduledTask: cron.ScheduledTask | null = null;

export async function runCalendarHealthCheck(prisma: PrismaService, notifications: NotificationService) {
  console.log("[calendar-health] Scanning for expired calendar connections...");

  // Find all users with at least one invalid connection
  const invalidConns = await prisma.calendarConnection.findMany({
    where: { tokenValid: false, connected: true },
    select: {
      id: true,
      userId: true,
      provider: true,
      label: true,
      email: true,
      disconnectReason: true,
      reconnectAlertAt: true,
    },
    distinct: ["userId", "provider"],
  });

  if (invalidConns.length === 0) {
    console.log("[calendar-health] No expired connections found.");
    return;
  }

  console.log(`[calendar-health] Found ${invalidConns.length} expired connection(s). Checking for unsent alerts...`);

  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  for (const conn of invalidConns) {
    try {
      // Once a day per connection. This used to be "findFirst a Notification
      // from the last 24h, then send" - a read-then-write that both servers
      // pass on the same hourly tick (Aug 14: two emails at 00:00:00.436 and
      // 00:00:00.501). The Notification.dedupeKey net could not catch it
      // either: the key hashes the email body, and the body embeds the
      // per-machine APP_URL, so the two servers hash differently. So the
      // claim lives on the connection row: compare-and-swap on the value we
      // just read - only the UPDATE that still finds it unchanged owns the
      // send. The other server's UPDATE matches 0 rows and moves on.
      if (conn.reconnectAlertAt && conn.reconnectAlertAt > cutoff) continue;
      const claim = await prisma.calendarConnection.updateMany({
        where: { id: conn.id, reconnectAlertAt: conn.reconnectAlertAt ?? null },
        data: { reconnectAlertAt: now },
      });
      if (claim.count === 0) continue;

      const user = await prisma.user.findUnique({
        where: { id: conn.userId },
        select: { id: true, email: true, name: true, mobileNumber: true, provider: { select: { name: true } } },
      });
      if (!user || !user.email) continue;

      await notifications.sendCalendarReconnectionAlert({
        id: user.id,
        email: user.email,
        name: user.name,
        mobileNumber: user.mobileNumber,
        providerName: (user as any).provider?.name || null,
        calendarLabel: conn.label || null,
        calendarEmail: conn.email || null,
        calendarProvider: conn.provider,
        disconnectReason: (conn as any).disconnectReason || null,
      });

      console.log(`[calendar-health] Sent reconnection alert to ${user.email} (${conn.provider})`);
    } catch (err: any) {
      console.error(`[calendar-health] Failed to send alert for user ${conn.userId}:`, err.message);
    }
  }
}

export function startCalendarHealthScheduler(prisma: PrismaService, notifications: NotificationService) {
  if (scheduledTask) {
    console.log("[calendar-health] Scheduler already running");
    return;
  }

  // Run once immediately on startup to catch any existing expired connections
  runCalendarHealthCheck(prisma, notifications).catch((err) => {
    console.error("[calendar-health] Startup check error:", err.message);
  });

  // Then run every hour
  scheduledTask = cron.schedule("0 * * * *", async () => {
    console.log("[calendar-health] Hourly check triggered at", new Date().toISOString());
    try {
      await runCalendarHealthCheck(prisma, notifications);
    } catch (err: any) {
      console.error("[calendar-health] Cron job error:", err.message);
    }
  });

  console.log("[calendar-health] Scheduler started - runs every hour, immediate startup check enabled");
}

export function stopCalendarHealthScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[calendar-health] Scheduler stopped");
  }
}
