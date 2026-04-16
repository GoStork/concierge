import { Injectable, Inject } from "@nestjs/common";
import { google } from "googleapis";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class GoogleCalendarService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private getOAuth2Client() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth not configured");
    }
    return new google.auth.OAuth2(clientId, clientSecret);
  }

  isConfigured(): boolean {
    return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }

  generateAuthUrl(redirectUri: string, state: string, loginHint?: string): string {
    const client = this.getOAuth2Client();
    const opts: any = {
      access_type: "offline",
      prompt: "consent select_account",
      redirect_uri: redirectUri,
      state,
      scope: [
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    };
    if (loginHint) {
      opts.login_hint = loginHint;
    }
    return client.generateAuthUrl(opts);
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiry: Date; email: string }> {
    const client = this.getOAuth2Client();
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });

    if (!tokens.access_token) {
      throw new Error("Failed to get access token from Google");
    }

    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const userInfo = await oauth2.userinfo.get();

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || "",
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600000),
      email: userInfo.data.email || "",
    };
  }

  private async getAuthenticatedClient(userId: string, opts?: { email?: string; calendarId?: string }) {
    let connection: any = null;

    if (opts?.calendarId) {
      connection = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: "google", connected: true, calendarId: opts.calendarId },
      });
    }

    if (!connection && opts?.email) {
      connection = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: "google", connected: true, email: opts.email },
        orderBy: { createdAt: "asc" },
      });
    }

    if (!connection) {
      connection = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: "google", connected: true },
        orderBy: { createdAt: "asc" },
      });
    }

    if (!connection || !connection.accessToken) {
      throw new Error("No Google Calendar connection found");
    }

    const client = this.getOAuth2Client();
    client.setCredentials({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken || undefined,
    });

    if (connection.tokenExpiry && connection.tokenExpiry.getTime() < Date.now() + 60000) {
      const emailScope = connection.email;
      try {
        const { credentials } = await client.refreshAccessToken();
        const newExpiry = credentials.expiry_date
          ? new Date(credentials.expiry_date)
          : new Date(Date.now() + 3600000);

        const updateWhere: any = { userId, provider: "google", connected: true };
        if (emailScope) {
          updateWhere.email = emailScope;
        }
        await this.prisma.calendarConnection.updateMany({
          where: updateWhere,
          data: {
            accessToken: credentials.access_token || connection.accessToken,
            refreshToken: credentials.refresh_token || connection.refreshToken,
            tokenExpiry: newExpiry,
            tokenValid: true,
          },
        });

        client.setCredentials(credentials);
      } catch (err: any) {
        console.error("Failed to refresh Google token:", err.message);
        const reason = this.isInvalidGrant(err) ? "invalid_grant" : "refresh_failed";
        const updateWhere: any = { userId, provider: "google", connected: true };
        if (emailScope) {
          updateWhere.email = emailScope;
        }
        await this.prisma.calendarConnection.updateMany({
          where: updateWhere,
          data: { tokenValid: false, disconnectReason: reason },
        }).catch(() => {});
        throw new Error("Google Calendar token expired and refresh failed. Please reconnect your Google Calendar.");
      }
    }

    return client;
  }

  async hasConnection(userId: string): Promise<boolean> {
    const count = await this.prisma.calendarConnection.count({
      where: { userId, provider: "google", connected: true },
    });
    return count > 0;
  }

  private isAuthError(err: any): boolean {
    const code = err?.code || err?.response?.status;
    return code === 401 || code === 403 || err.message?.includes("invalid_grant") || err.message?.includes("Token has been");
  }

  private isInvalidGrant(err: any): boolean {
    return (
      err.message?.includes("invalid_grant") ||
      err.message?.includes("Token has been expired or revoked") ||
      err?.response?.data?.error === "invalid_grant"
    );
  }

  private async markUnhealthy(userId: string, email?: string, reason?: string) {
    const where: any = { userId, provider: "google", connected: true };
    if (email) where.email = email;
    await this.prisma.calendarConnection.updateMany({
      where,
      data: { tokenValid: false, disconnectReason: reason || "auth_error" },
    }).catch(() => {});
  }

  private isUtilityCalendar(calendarId: string): boolean {
    if (!calendarId) return false;
    return (
      calendarId.includes("#holiday@group.v.calendar.google.com") ||
      calendarId.includes("#contacts@group.v.calendar.google.com") ||
      calendarId.includes("#other@group.v.calendar.google.com") ||
      calendarId.includes("addressbook#")
    );
  }

  async getCalendarList(userId: string, email?: string) {
    try {
      const client = await this.getAuthenticatedClient(userId, { email });
      const calendar = google.calendar({ version: "v3", auth: client });
      const res = await calendar.calendarList.list();
      return (res.data.items || [])
        .filter((cal) => !this.isUtilityCalendar(cal.id || ""))
        .map((cal) => ({
          id: cal.id,
          summary: cal.summary,
          primary: cal.primary || false,
          backgroundColor: cal.backgroundColor,
          accessRole: cal.accessRole,
        }));
    } catch (err: any) {
      if (this.isAuthError(err)) await this.markUnhealthy(userId, email, this.isInvalidGrant(err) ? "invalid_grant" : "auth_error");
      throw err;
    }
  }

  async getEvents(userId: string, calendarId: string, timeMin: string, timeMax: string) {
    try {
      const client = await this.getAuthenticatedClient(userId, { calendarId });
      const calendar = google.calendar({ version: "v3", auth: client });
      const res = await calendar.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
      });

      return (res.data.items || []).map((event) => ({
        id: event.id,
        summary: event.summary || "Busy",
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        status: event.status,
        htmlLink: event.htmlLink,
        transparency: event.transparency,
      }));
    } catch (err: any) {
      if (this.isAuthError(err)) await this.markUnhealthy(userId, undefined, this.isInvalidGrant(err) ? "invalid_grant" : "auth_error");
      throw err;
    }
  }

  async createEvent(
    userId: string,
    calendarId: string,
    eventData: {
      summary: string;
      description?: string;
      startTime: Date;
      endTime: Date;
      attendees?: { email: string; displayName?: string }[];
      meetingLink?: string;
      timezone?: string;
    },
  ): Promise<string | null> {
    try {
      const client = await this.getAuthenticatedClient(userId, { calendarId });
      const calendar = google.calendar({ version: "v3", auth: client });
      const tz = eventData.timezone || "UTC";

      const event: any = {
        summary: eventData.summary,
        description: eventData.description || "",
        start: { dateTime: eventData.startTime.toISOString(), timeZone: tz },
        end: { dateTime: eventData.endTime.toISOString(), timeZone: tz },
      };

      if (eventData.attendees && eventData.attendees.length > 0) {
        event.attendees = eventData.attendees;
      }

      if (eventData.meetingLink) {
        event.location = eventData.meetingLink;
        event.description = (event.description ? event.description + "\n\n" : "") +
          "Meeting Link: " + eventData.meetingLink;
      }

      const res = await calendar.events.insert({
        calendarId,
        requestBody: event,
        sendUpdates: "none",
      });

      return res.data.id || null;
    } catch (err: any) {
      console.error("Failed to create Google Calendar event:", err.message);
      return null;
    }
  }

  async getEvent(userId: string, calendarId: string, eventId: string): Promise<{ status: string } | null> {
    try {
      const client = await this.getAuthenticatedClient(userId, { calendarId });
      const calendar = google.calendar({ version: "v3", auth: client });
      const res = await calendar.events.get({ calendarId, eventId });
      return { status: res.data.status || "confirmed" };
    } catch (err: any) {
      if (err?.code === 404 || err?.response?.status === 404) {
        return null;
      }
      if (err?.code === 410 || err?.response?.status === 410) {
        return null;
      }
      if (this.isAuthError(err)) await this.markUnhealthy(userId, undefined, this.isInvalidGrant(err) ? "invalid_grant" : "auth_error");
      throw err;
    }
  }

  async updateEvent(
    userId: string,
    calendarId: string,
    eventId: string,
    eventData: {
      summary?: string;
      description?: string;
      startTime?: Date;
      endTime?: Date;
      timezone?: string;
    },
  ): Promise<boolean> {
    try {
      const client = await this.getAuthenticatedClient(userId, { calendarId });
      const calendar = google.calendar({ version: "v3", auth: client });
      const tz = eventData.timezone || "UTC";

      const patch: any = {};
      if (eventData.summary) patch.summary = eventData.summary;
      if (eventData.description !== undefined) patch.description = eventData.description;
      if (eventData.startTime) {
        patch.start = { dateTime: eventData.startTime.toISOString(), timeZone: tz };
      }
      if (eventData.endTime) {
        patch.end = { dateTime: eventData.endTime.toISOString(), timeZone: tz };
      }

      await calendar.events.patch({
        calendarId,
        eventId,
        requestBody: patch,
        sendUpdates: "none",
      });

      return true;
    } catch (err: any) {
      console.error("Failed to update Google Calendar event:", err.message);
      return false;
    }
  }

  async deleteEvent(userId: string, calendarId: string, eventId: string): Promise<boolean> {
    try {
      const client = await this.getAuthenticatedClient(userId, { calendarId });
      const calendar = google.calendar({ version: "v3", auth: client });

      await calendar.events.delete({
        calendarId,
        eventId,
        sendUpdates: "none",
      });

      return true;
    } catch (err: any) {
      console.error("Failed to delete Google Calendar event:", err.message);
      return false;
    }
  }

  async getFreeBusy(userId: string, calendarIds: string[], timeMin: string, timeMax: string) {
    const connections = await this.prisma.calendarConnection.findMany({
      where: { userId, provider: "google", connected: true, calendarId: { in: calendarIds } },
    });

    const emailGroups: Record<string, string[]> = {};
    for (const conn of connections) {
      const email = conn.email || "__default__";
      if (!emailGroups[email]) emailGroups[email] = [];
      emailGroups[email].push(conn.calendarId);
    }

    let mergedCalendars: Record<string, any> = {};
    for (const [email, groupCalIds] of Object.entries(emailGroups)) {
      try {
        const client = await this.getAuthenticatedClient(userId, email !== "__default__" ? { email } : { calendarId: groupCalIds[0] });
        const calendar = google.calendar({ version: "v3", auth: client });
        const res = await calendar.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            items: groupCalIds.map((id) => ({ id })),
          },
        });
        if (res.data.calendars) {
          for (const [calId, calData] of Object.entries(res.data.calendars)) {
            const errors = (calData as any)?.errors || [];
            if (errors.length > 0) {
              console.warn(`[google-calendar] FreeBusy errors for cal=${calId}: ${JSON.stringify(errors)}`);
            }
          }
          mergedCalendars = { ...mergedCalendars, ...res.data.calendars };
        }
      } catch (err: any) {
        console.warn(`[google-calendar] FreeBusy failed for account ${email}: ${err.message}`);
      }
    }
    return Object.keys(mergedCalendars).length > 0 ? mergedCalendars : null;
  }

  async checkConnectionHealth(userId: string): Promise<{ healthy: boolean; error?: string }> {
    const connections = await this.prisma.calendarConnection.findMany({
      where: { userId, provider: "google", connected: true, NOT: { calendarId: "__pending__" } },
      distinct: ["email"],
    });

    if (connections.length === 0) {
      return { healthy: false, error: "No Google Calendar connection found" };
    }

    let allHealthy = true;
    let lastError = "";

    for (const connection of connections) {
      if (!connection.accessToken) continue;
      try {
        const client = await this.getAuthenticatedClient(userId, { email: connection.email || undefined });
        const calendar = google.calendar({ version: "v3", auth: client });
        await calendar.calendarList.list({ maxResults: 1 });

        if (!connection.tokenValid) {
          const updateWhere: any = { userId, provider: "google", connected: true };
          if (connection.email) updateWhere.email = connection.email;
          await this.prisma.calendarConnection.updateMany({
            where: updateWhere,
            data: { tokenValid: true },
          });
        }
      } catch (err: any) {
        allHealthy = false;
        lastError = err.message || "Token invalid or revoked";
        const reason = this.isInvalidGrant(err) ? "invalid_grant" : "auth_error";
        const updateWhere: any = { userId, provider: "google", connected: true };
        if (connection.email) updateWhere.email = connection.email;
        await this.prisma.calendarConnection.updateMany({
          where: updateWhere,
          data: { tokenValid: false, disconnectReason: reason },
        }).catch(() => {});
      }
    }

    return allHealthy ? { healthy: true } : { healthy: false, error: lastError };
  }
}
