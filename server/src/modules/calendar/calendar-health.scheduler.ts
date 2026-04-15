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
      userId: true,
      provider: true,
      label: true,
      email: true,
    },
    distinct: ["userId", "provider"],
  });

  if (invalidConns.length === 0) {
    console.log("[calendar-health] No expired connections found.");
    return;
  }

  console.log(`[calendar-health] Found ${invalidConns.length} expired connection(s). Checking for unsent alerts...`);

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const conn of invalidConns) {
    try {
      // Skip if a reconnection alert was already sent in the last 24 hours
      const recentAlert = await prisma.notification.findFirst({
        where: {
          userId: conn.userId,
          channel: "calendar_reconnection",
          createdAt: { gte: cutoff },
        },
      });
      if (recentAlert) continue;

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
