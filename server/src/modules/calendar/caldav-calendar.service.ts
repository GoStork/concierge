import { Injectable, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationService } from "../notifications/notification.service";
import { encryptPassword, decryptPassword } from "./caldav-crypto";
import { createDAVClient, DAVCalendar, DAVObject } from "tsdav";
import ICAL from "ical.js";

const CALDAV_SERVERS: Record<string, string> = {
  apple: "https://caldav.icloud.com",
};

interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  url: string;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  url?: string;
}

@Injectable()
export class CaldavCalendarService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  private getServerUrl(provider: string): string {
    const url = CALDAV_SERVERS[provider];
    if (!url) {
      throw new Error(`Unsupported CalDAV provider: ${provider}`);
    }
    return url;
  }

  private async createClient(provider: string, email: string, password: string) {
    const serverUrl = this.getServerUrl(provider);
    const client = await createDAVClient({
      serverUrl,
      credentials: { username: email, password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    return client;
  }

  private async getCredentials(connectionId: string): Promise<{ provider: string; email: string; password: string; userId: string }> {
    const conn = await this.prisma.calendarConnection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new Error("Calendar connection not found");
    if (!conn.encryptedPassword || !conn.passwordIv || !conn.email) {
      throw new Error("CalDAV credentials not found for this connection");
    }
    const password = decryptPassword(conn.encryptedPassword, conn.passwordIv);
    return { provider: conn.provider, email: conn.email, password, userId: conn.userId };
  }

  private async getCredentialsForCalendar(userId: string, calendarUrl: string): Promise<{ provider: string; email: string; password: string; connId: string } | null> {
    const conn = await this.prisma.calendarConnection.findFirst({
      where: { userId, calendarId: calendarUrl, connected: true },
    });
    if (!conn || !conn.email) return null;

    const credConn = await this.prisma.calendarConnection.findFirst({
      where: { userId, provider: conn.provider, email: conn.email, connected: true, encryptedPassword: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    if (!credConn?.encryptedPassword || !credConn?.passwordIv || !credConn?.email) return null;

    const password = decryptPassword(credConn.encryptedPassword, credConn.passwordIv);
    return { provider: conn.provider, email: credConn.email, password, connId: credConn.id };
  }

  async validateCredentials(provider: string, email: string, appPassword: string): Promise<boolean> {
    try {
      const client = await this.createClient(provider, email, appPassword);
      const calendars = await client.fetchCalendars();
      return Array.isArray(calendars) && calendars.length >= 0;
    } catch (err: any) {
      console.warn(`[caldav] Credential validation failed for ${provider}/${email}: ${err.message}`);
      return false;
    }
  }

  async discoverCalendars(provider: string, email: string, appPassword: string): Promise<CalendarInfo[]> {
    const client = await this.createClient(provider, email, appPassword);
    const calendars = await client.fetchCalendars();
    return calendars.map((cal: DAVCalendar) => ({
      id: cal.url,
      name: cal.displayName || "Calendar",
      color: (cal as any).calendarColor || "#6b7280",
      url: cal.url,
    }));
  }

  async discoverCalendarsForConnection(connectionId: string): Promise<CalendarInfo[]> {
    const { provider, email, password } = await this.getCredentials(connectionId);
    return this.discoverCalendars(provider, email, password);
  }

  async getEvents(userId: string, calendarUrl: string, from: string, to: string): Promise<CalendarEvent[]> {
    const creds = await this.getCredentialsForCalendar(userId, calendarUrl);
    if (!creds) return [];

    return this.fetchEventsWithCredentials(creds.provider, creds.email, creds.password, calendarUrl, from, to, userId);
  }

  private async fetchEventsWithCredentials(
    provider: string, email: string, password: string,
    calendarUrl: string, from: string, to: string, userId?: string,
  ): Promise<CalendarEvent[]> {
    try {
      const client = await this.createClient(provider, email, password);
      const calendarObjects = await client.fetchCalendarObjects({
        calendar: { url: calendarUrl } as DAVCalendar,
        timeRange: { start: from, end: to },
      });

      return this.parseCalendarObjects(calendarObjects, from, to);
    } catch (err: any) {
      console.warn(`[caldav] Failed to fetch events: ${err.message}`);
      if (userId && (err.message?.includes("401") || err.message?.includes("403") || err.message?.includes("Unauthorized"))) {
        await this.markConnectionsUnhealthy(userId, provider, email);
      }
      return [];
    }
  }

  private async markConnectionsUnhealthy(userId: string, provider: string, email: string): Promise<void> {
    try {
      const conn = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider, email, connected: true },
      });
      await this.prisma.calendarConnection.updateMany({
        where: { userId, provider, email, connected: true },
        data: { tokenValid: false },
      });
      console.warn(`[caldav] Marked ${provider}/${email} connections as unhealthy for user ${userId}`);

      // Send reconnection alert (dedup: skip if already sent in last 24h)
      const recentAlert = await this.prisma.notification.findFirst({
        where: {
          userId,
          channel: "calendar_reconnection",
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });
      if (!recentAlert) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, name: true, mobileNumber: true, provider: { select: { name: true } } },
        });
        if (user) {
          this.notifications.sendCalendarReconnectionAlert({
            id: user.id,
            email: user.email,
            name: user.name,
            mobileNumber: user.mobileNumber,
            providerName: (user as any).provider?.name || null,
            calendarLabel: conn?.label || null,
            calendarEmail: conn?.email || null,
            calendarProvider: provider,
          }).catch((e) => {
            console.error("[caldav] Failed to send calendar reconnection alert:", e.message);
          });
        }
      }
    } catch (e: any) {
      console.warn(`[caldav] Failed to mark connections unhealthy: ${e.message}`);
    }
  }

  private parseCalendarObjects(objects: DAVObject[], from: string, to: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    const rangeStart = new Date(from);
    const rangeEnd = new Date(to);

    for (const obj of objects) {
      if (!obj.data) continue;
      try {
        const parsed = this.parseICalData(obj.data, obj.url, rangeStart, rangeEnd);
        events.push(...parsed);
      } catch (err: any) {
        console.warn(`[caldav] Failed to parse event: ${err.message}`);
      }
    }

    return events;
  }

  private parseICalData(icalData: string, url: string, rangeStart: Date, rangeEnd: Date): CalendarEvent[] {
    const jcalData = ICAL.parse(icalData);
    const comp = new ICAL.Component(jcalData);
    const vevents = comp.getAllSubcomponents("vevent");
    const events: CalendarEvent[] = [];

    for (const vevent of vevents) {
      const event = new ICAL.Event(vevent);
      const uid = event.uid || url;
      const summary = event.summary || "(No title)";
      const location = event.location || undefined;
      const description = event.description || undefined;

      if (event.isRecurring()) {
        const iterator = event.iterator();
        let next: ICAL.Time | null;
        let count = 0;
        const maxOccurrences = 200;
        while ((next = iterator.next()) && count < maxOccurrences) {
          const occStart = next.toJSDate();
          if (occStart > rangeEnd) break;

          const duration = event.duration;
          const occEnd = new Date(occStart.getTime() + (duration ? duration.toSeconds() * 1000 : 3600000));

          if (occEnd < rangeStart) { count++; continue; }

          const allDay = next.isDate;
          events.push({
            id: `${uid}_${occStart.toISOString()}`,
            title: summary,
            start: allDay ? occStart.toISOString().split("T")[0] : occStart.toISOString(),
            end: allDay ? occEnd.toISOString().split("T")[0] : occEnd.toISOString(),
            allDay,
            location,
            description,
            url,
          });
          count++;
        }
      } else {
        const dtstart = event.startDate;
        const dtend = event.endDate;
        if (!dtstart) continue;

        const startDate = dtstart.toJSDate();
        const endDate = dtend ? dtend.toJSDate() : new Date(startDate.getTime() + 3600000);
        const allDay = dtstart.isDate;

        events.push({
          id: uid,
          title: summary,
          start: allDay ? startDate.toISOString().split("T")[0] : startDate.toISOString(),
          end: allDay ? endDate.toISOString().split("T")[0] : endDate.toISOString(),
          allDay,
          location,
          description,
          url,
        });
      }
    }

    return events;
  }

  async getFreeBusy(
    userId: string, calendarUrls: string[], from: string, to: string,
  ): Promise<Record<string, { busy: { start: string; end: string; eventId?: string }[] }>> {
    const result: Record<string, { busy: { start: string; end: string; eventId?: string }[] }> = {};

    for (const calUrl of calendarUrls) {
      try {
        const events = await this.getEvents(userId, calUrl, from, to);
        result[calUrl] = {
          busy: events
            .filter((e) => !e.allDay)
            .map((e) => ({ start: e.start, end: e.end, eventId: e.id })),
        };
      } catch (err: any) {
        console.warn(`[caldav] FreeBusy failed for ${calUrl}: ${err.message}`);
        result[calUrl] = { busy: [] };
      }
    }

    return result;
  }

  async createEvent(
    userId: string, calendarUrl: string,
    event: { title: string; start: string; end: string; description?: string; location?: string; attendees?: string[] },
  ): Promise<string | null> {
    const creds = await this.getCredentialsForCalendar(userId, calendarUrl);
    if (!creds) return null;

    try {
      const client = await this.createClient(creds.provider, creds.email, creds.password);
      const uid = this.generateUID();
      const icalData = this.buildICalEvent(uid, event);

      await client.createCalendarObject({
        calendar: { url: calendarUrl } as DAVCalendar,
        filename: `${uid}.ics`,
        iCalString: icalData,
      });

      return uid;
    } catch (err: any) {
      console.warn(`[caldav] Failed to create event: ${err.message}`);
      return null;
    }
  }

  async updateEvent(
    userId: string, calendarUrl: string, eventUrl: string,
    event: { title: string; start: string; end: string; description?: string; location?: string },
  ): Promise<boolean> {
    const creds = await this.getCredentialsForCalendar(userId, calendarUrl);
    if (!creds) return false;

    try {
      const client = await this.createClient(creds.provider, creds.email, creds.password);
      const uid = eventUrl.split("/").pop()?.replace(".ics", "") || this.generateUID();
      const icalData = this.buildICalEvent(uid, event);

      await client.updateCalendarObject({
        calendarObject: {
          url: eventUrl,
          data: icalData,
        } as DAVObject,
      });

      return true;
    } catch (err: any) {
      console.warn(`[caldav] Failed to update event: ${err.message}`);
      return false;
    }
  }

  async deleteEvent(userId: string, calendarUrl: string, eventUrl: string): Promise<boolean> {
    const creds = await this.getCredentialsForCalendar(userId, calendarUrl);
    if (!creds) return false;

    try {
      const client = await this.createClient(creds.provider, creds.email, creds.password);
      await client.deleteCalendarObject({ calendarObject: { url: eventUrl } as DAVObject });
      return true;
    } catch (err: any) {
      console.warn(`[caldav] Failed to delete event: ${err.message}`);
      return false;
    }
  }

  async checkConnectionHealth(connectionId: string): Promise<{ healthy: boolean; error?: string }> {
    try {
      const { provider, email, password, userId } = await this.getCredentials(connectionId);
      const valid = await this.validateCredentials(provider, email, password);
      if (!valid) {
        await this.markConnectionsUnhealthy(userId, provider, email);
      } else {
        await this.prisma.calendarConnection.updateMany({
          where: { userId, provider, email, connected: true },
          data: { tokenValid: true },
        });
      }
      return { healthy: valid, error: valid ? undefined : "Credentials may be invalid or expired" };
    } catch (err: any) {
      return { healthy: false, error: err.message };
    }
  }

  private generateUID(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let uid = "";
    for (let i = 0; i < 32; i++) uid += chars[Math.floor(Math.random() * chars.length)];
    return `${uid}@gostork`;
  }

  private buildICalEvent(
    uid: string,
    event: { title: string; start: string; end: string; description?: string; location?: string; attendees?: string[] },
  ): string {
    const now = new Date();
    const stamp = this.toICalDate(now.toISOString());
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//GoStork//CalDAV//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${this.toICalDate(event.start)}`,
      `DTEND:${this.toICalDate(event.end)}`,
      `SUMMARY:${event.title}`,
    ];
    if (event.description) lines.push(`DESCRIPTION:${event.description}`);
    if (event.location) lines.push(`LOCATION:${event.location}`);
    if (event.attendees) {
      for (const attendee of event.attendees) {
        lines.push(`ATTENDEE;CN=${attendee}:mailto:${attendee}`);
      }
    }
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
  }

  private toICalDate(iso: string): string {
    return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "").replace(/Z$/, "Z");
  }
}
