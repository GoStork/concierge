import { Injectable, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

@Injectable()
export class MicrosoftCalendarService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  isConfigured(): boolean {
    return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
  }

  generateAuthUrl(redirectUri: string, state: string, loginHint?: string): string {
    const params = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid offline_access User.Read Calendars.Read Calendars.ReadWrite",
      state,
      prompt: "consent",
      response_mode: "query",
    });
    if (loginHint) {
      params.set("login_hint", loginHint);
    }
    return `${MICROSOFT_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiry: Date; email: string }> {
    const body = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "openid offline_access User.Read Calendars.Read Calendars.ReadWrite",
    });

    const tokenRes = await fetch(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const errData = await tokenRes.text();
      console.error("Microsoft token exchange error:", errData);
      throw new Error("Failed to exchange Microsoft authorization code for tokens");
    }

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      throw new Error("Failed to get access token from Microsoft");
    }

    const userRes = await fetch(`${GRAPH_BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    let email = "";
    if (userRes.ok) {
      const userData = await userRes.json();
      email = userData.mail || userData.userPrincipalName || "";
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || "",
      expiry: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : new Date(Date.now() + 3600000),
      email,
    };
  }

  private async refreshAccessToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }> {
    const body = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "openid offline_access User.Read Calendars.Read Calendars.ReadWrite",
    });

    const res = await fetch(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("Microsoft token refresh error:", errText);
      throw new Error("Failed to refresh Microsoft access token");
    }

    return await res.json();
  }

  private async getAuthenticatedToken(userId: string, opts?: { email?: string; calendarId?: string }): Promise<{ token: string; connection: any }> {
    let connection: any = null;

    if (opts?.calendarId) {
      connection = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: "microsoft", connected: true, calendarId: opts.calendarId },
      });
    }

    if (!connection && opts?.email) {
      connection = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: "microsoft", connected: true, email: opts.email },
        orderBy: { createdAt: "asc" },
      });
    }

    if (!connection) {
      connection = await this.prisma.calendarConnection.findFirst({
        where: { userId, provider: "microsoft", connected: true },
        orderBy: { createdAt: "asc" },
      });
    }

    if (!connection || !connection.accessToken) {
      throw new Error("No Microsoft Calendar connection found");
    }

    if (connection.tokenExpiry && connection.tokenExpiry.getTime() < Date.now() + 60000) {
      const emailScope = connection.email;
      if (!connection.refreshToken) {
        await this.markUnhealthy(userId, emailScope || undefined);
        throw new Error("No refresh token available for Microsoft Calendar. Please reconnect.");
      }
      try {
        const refreshed = await this.refreshAccessToken(connection.refreshToken);
        const newExpiry = refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : new Date(Date.now() + 3600000);

        const updateWhere: any = { userId, provider: "microsoft", connected: true };
        if (emailScope) {
          updateWhere.email = emailScope;
        }
        await this.prisma.calendarConnection.updateMany({
          where: updateWhere,
          data: {
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token || connection.refreshToken,
            tokenExpiry: newExpiry,
            tokenValid: true,
          },
        });

        return { token: refreshed.access_token, connection: { ...connection, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || connection.refreshToken, tokenExpiry: newExpiry, tokenValid: true } };
      } catch (err: any) {
        console.error("Failed to refresh Microsoft token:", err.message);
        const updateWhere: any = { userId, provider: "microsoft", connected: true };
        if (emailScope) {
          updateWhere.email = emailScope;
        }
        await this.prisma.calendarConnection.updateMany({
          where: updateWhere,
          data: { tokenValid: false },
        }).catch(() => {});
        throw new Error("Microsoft Calendar token expired and refresh failed. Please reconnect your Microsoft Calendar.");
      }
    }

    return { token: connection.accessToken, connection };
  }

  private async graphRequest(token: string, url: string, options?: { method?: string; body?: any; preferUtc?: boolean }): Promise<any> {
    const method = options?.method || "GET";
    const headers: any = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (options?.preferUtc) {
      headers["Prefer"] = 'outlook.timezone="UTC"';
    }

    const fetchOpts: any = { method, headers };
    if (options?.body) {
      fetchOpts.body = JSON.stringify(options.body);
    }

    const res = await fetch(url, fetchOpts);

    if (method === "DELETE" && (res.status === 204 || res.status === 200)) {
      return null;
    }

    if (!res.ok) {
      const errText = await res.text();
      const err: any = new Error(`Microsoft Graph API error: ${res.status} ${errText}`);
      err.code = res.status;
      err.response = { status: res.status };
      throw err;
    }

    if (res.status === 204) return null;
    return await res.json();
  }

  async hasConnection(userId: string): Promise<boolean> {
    const count = await this.prisma.calendarConnection.count({
      where: { userId, provider: "microsoft", connected: true },
    });
    return count > 0;
  }

  private isAuthError(err: any): boolean {
    const code = err?.code || err?.response?.status;
    return code === 401 || code === 403 || err.message?.includes("InvalidAuthenticationToken") || err.message?.includes("token expired");
  }

  private async markUnhealthy(userId: string, email?: string) {
    const where: any = { userId, provider: "microsoft", connected: true };
    if (email) where.email = email;
    await this.prisma.calendarConnection.updateMany({
      where,
      data: { tokenValid: false },
    }).catch(() => {});
  }

  async getCalendarList(userId: string, email?: string) {
    try {
      const { token } = await this.getAuthenticatedToken(userId, { email });
      const data = await this.graphRequest(token, `${GRAPH_BASE_URL}/me/calendars`);
      return (data.value || []).map((cal: any) => ({
        id: cal.id,
        summary: cal.name,
        primary: cal.isDefaultCalendar || false,
        backgroundColor: cal.hexColor || null,
        accessRole: cal.canEdit ? "writer" : "reader",
      }));
    } catch (err: any) {
      if (this.isAuthError(err)) await this.markUnhealthy(userId, email);
      throw err;
    }
  }

  async getEvents(userId: string, calendarId: string, timeMin: string, timeMax: string) {
    try {
      const { token } = await this.getAuthenticatedToken(userId, { calendarId });
      const params = new URLSearchParams({
        $filter: `start/dateTime ge '${timeMin}' and end/dateTime le '${timeMax}'`,
        $orderby: "start/dateTime",
        $top: "250",
      });
      const data = await this.graphRequest(
        token,
        `${GRAPH_BASE_URL}/me/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        { preferUtc: true },
      );

      return (data.value || []).map((event: any) => {
        let startIso: string | null = null;
        let endIso: string | null = null;
        if (event.start?.dateTime) {
          const dt = event.start.dateTime;
          startIso = dt.endsWith("Z") ? new Date(dt).toISOString() : new Date(dt + "Z").toISOString();
        }
        if (event.end?.dateTime) {
          const dt = event.end.dateTime;
          endIso = dt.endsWith("Z") ? new Date(dt).toISOString() : new Date(dt + "Z").toISOString();
        }
        return {
          id: event.id,
          summary: event.subject || "Busy",
          start: startIso,
          end: endIso,
          status: event.isCancelled ? "cancelled" : "confirmed",
          htmlLink: event.webLink || null,
        };
      });
    } catch (err: any) {
      if (this.isAuthError(err)) await this.markUnhealthy(userId);
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
      const { token } = await this.getAuthenticatedToken(userId, { calendarId });
      const tz = eventData.timezone || "UTC";

      const event: any = {
        subject: eventData.summary,
        body: {
          contentType: "text",
          content: eventData.description || "",
        },
        start: {
          dateTime: eventData.startTime.toISOString().replace("Z", ""),
          timeZone: tz,
        },
        end: {
          dateTime: eventData.endTime.toISOString().replace("Z", ""),
          timeZone: tz,
        },
      };

      if (eventData.attendees && eventData.attendees.length > 0) {
        event.attendees = eventData.attendees.map((a) => ({
          emailAddress: { address: a.email, name: a.displayName || a.email },
          type: "required",
        }));
      }

      if (eventData.meetingLink) {
        event.location = { displayName: eventData.meetingLink };
        const linkText = "\n\nMeeting Link: " + eventData.meetingLink;
        event.body.content = (event.body.content || "") + linkText;
      }

      const data = await this.graphRequest(
        token,
        `${GRAPH_BASE_URL}/me/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: "POST", body: event },
      );

      return data?.id || null;
    } catch (err: any) {
      console.error("Failed to create Microsoft Calendar event:", err.message);
      return null;
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
      const { token } = await this.getAuthenticatedToken(userId, { calendarId });
      const tz = eventData.timezone || "UTC";

      const patch: any = {};
      if (eventData.summary) patch.subject = eventData.summary;
      if (eventData.description !== undefined) {
        patch.body = { contentType: "text", content: eventData.description };
      }
      if (eventData.startTime) {
        patch.start = { dateTime: eventData.startTime.toISOString().replace("Z", ""), timeZone: tz };
      }
      if (eventData.endTime) {
        patch.end = { dateTime: eventData.endTime.toISOString().replace("Z", ""), timeZone: tz };
      }

      await this.graphRequest(
        token,
        `${GRAPH_BASE_URL}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "PATCH", body: patch },
      );

      return true;
    } catch (err: any) {
      console.error("Failed to update Microsoft Calendar event:", err.message);
      return false;
    }
  }

  async deleteEvent(userId: string, calendarId: string, eventId: string): Promise<boolean> {
    try {
      const { token } = await this.getAuthenticatedToken(userId, { calendarId });

      await this.graphRequest(
        token,
        `${GRAPH_BASE_URL}/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: "DELETE" },
      );

      return true;
    } catch (err: any) {
      console.error("Failed to delete Microsoft Calendar event:", err.message);
      return false;
    }
  }

  async getFreeBusy(userId: string, calendarIds: string[], timeMin: string, timeMax: string) {
    const connections = await this.prisma.calendarConnection.findMany({
      where: { userId, provider: "microsoft", connected: true, calendarId: { in: calendarIds } },
    });

    const emailGroups: Record<string, string[]> = {};
    for (const conn of connections) {
      const email = conn.email || "__default__";
      if (!emailGroups[email]) emailGroups[email] = [];
      emailGroups[email].push(conn.calendarId!);
    }

    let mergedCalendars: Record<string, any> = {};
    for (const [email, groupCalIds] of Object.entries(emailGroups)) {
      try {
        const { token } = await this.getAuthenticatedToken(userId, email !== "__default__" ? { email } : { calendarId: groupCalIds[0] });

        for (const calId of groupCalIds) {
          try {
            const params = new URLSearchParams({
              $filter: `start/dateTime ge '${timeMin}' and end/dateTime le '${timeMax}'`,
              $select: "id,start,end,showAs",
              $top: "250",
            });
            const data = await this.graphRequest(
              token,
              `${GRAPH_BASE_URL}/me/calendars/${encodeURIComponent(calId)}/events?${params.toString()}`,
              { preferUtc: true },
            );
            const busySlots = (data.value || [])
              .filter((e: any) => e.showAs !== "free")
              .map((e: any) => {
                const startDt = e.start?.dateTime || "";
                const endDt = e.end?.dateTime || "";
                return {
                  start: startDt ? new Date(startDt.endsWith("Z") ? startDt : startDt + "Z").toISOString() : null,
                  end: endDt ? new Date(endDt.endsWith("Z") ? endDt : endDt + "Z").toISOString() : null,
                  eventId: e.id || undefined,
                };
              });
            mergedCalendars[calId] = { busy: busySlots };
          } catch (err: any) {
            console.warn(`[microsoft-calendar] Events fetch failed for cal=${calId}: ${err.message}`);
          }
        }
      } catch (err: any) {
        console.warn(`[microsoft-calendar] Auth failed for account ${email}: ${err.message}`);
      }
    }
    return Object.keys(mergedCalendars).length > 0 ? mergedCalendars : null;
  }

  async checkConnectionHealth(userId: string): Promise<{ healthy: boolean; error?: string }> {
    const connections = await this.prisma.calendarConnection.findMany({
      where: { userId, provider: "microsoft", connected: true, NOT: { calendarId: "__pending__" } },
      distinct: ["email"],
    });

    if (connections.length === 0) {
      return { healthy: false, error: "No Microsoft Calendar connection found" };
    }

    let allHealthy = true;
    let lastError = "";

    for (const connection of connections) {
      if (!connection.accessToken) continue;
      try {
        const { token } = await this.getAuthenticatedToken(userId, { email: connection.email || undefined });
        await this.graphRequest(token, `${GRAPH_BASE_URL}/me/calendars?$top=1`);

        if (!connection.tokenValid) {
          const updateWhere: any = { userId, provider: "microsoft", connected: true };
          if (connection.email) updateWhere.email = connection.email;
          await this.prisma.calendarConnection.updateMany({
            where: updateWhere,
            data: { tokenValid: true },
          });
        }
      } catch (err: any) {
        allHealthy = false;
        lastError = err.message || "Token invalid or revoked";
        const updateWhere: any = { userId, provider: "microsoft", connected: true };
        if (connection.email) updateWhere.email = connection.email;
        await this.prisma.calendarConnection.updateMany({
          where: updateWhere,
          data: { tokenValid: false },
        }).catch(() => {});
      }
    }

    return allHealthy ? { healthy: true } : { healthy: false, error: lastError };
  }
}
