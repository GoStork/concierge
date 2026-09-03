import { Injectable, Inject, Logger } from "@nestjs/common";
import { Subject, Observable, merge, from } from "rxjs";
import { filter, map, mergeMap, delay } from "rxjs/operators";
import { PrismaService } from "../prisma/prisma.service";
import { trackConnect, trackDisconnect, getConnectedCount } from "../../../online-tracker";

export interface AppEvent {
  type: "cost_sheet_submitted" | "cost_sheet_approved" | "cost_sheet_rejected" | "cost_sheet_deleted" | "human_escalation" | "human_concluded" | "user_profile_updated" | "parent_ready_to_proceed" | "provider_service_requested";
  payload: Record<string, any>;
  targetUserIds: string[];
  actorUserId?: string;
}

@Injectable()
export class AppEventsService {
  private readonly logger = new Logger(AppEventsService.name);
  private subject = new Subject<AppEvent>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async emit(event: AppEvent) {
    this.subject.next(event);

    for (const userId of event.targetUserIds) {
      if (userId === event.actorUserId) continue;
      if (getConnectedCount(userId) > 0) continue;

      try {
        await this.prisma.inAppNotification.create({
          data: {
            userId,
            eventType: event.type,
            payload: {
              ...event.payload,
              isOwnAction: false,
            },
          },
        });
      } catch (err: any) {
        this.logger.warn(`Failed to persist in-app notification for ${userId}: ${err.message}`);
      }
    }
  }

  subscribe(userId: string): Observable<MessageEvent> {
    trackConnect(userId);

    const pending$ = from(this.drainPending(userId)).pipe(
      delay(1500),
      mergeMap((items) => from(items)),
    );

    const live$ = this.subject.asObservable().pipe(
      filter((event) => event.targetUserIds.includes(userId)),
      map(
        (event) =>
          ({
            data: JSON.stringify({
              type: event.type,
              ...event.payload,
              isOwnAction: event.actorUserId === userId,
            }),
          }) as MessageEvent,
      ),
    );

    return merge(pending$, live$);
  }

  disconnect(userId: string) {
    trackDisconnect(userId);
  }

  private async drainPending(userId: string): Promise<MessageEvent[]> {
    try {
      const costEventTypes = [
        "cost_sheet_submitted",
        "cost_sheet_approved",
        "cost_sheet_rejected",
        "cost_sheet_deleted",
        "human_escalation",
        "HUMAN_ESCALATION",
        "parent_ready_to_proceed",
        "PARENT_READY_TO_PROCEED",
        "IP_FORM_PARTNER_SIGNED",
        "IP_FORM_SUBMITTED",
        "IP_FORM_SENT_TO_PARENT",
        "IP_FORM_PHOTOCOPY_REQUEST",
        // #7 @mentions: a colleague tagged you in a note or task. Written
        // directly by the CRM router; surfaced here as a toast on next connect,
        // exactly like the IP-form events above (lowercased to "crm_mention").
        "CRM_MENTION",
        // A provider asked GoStork to approve a new service line - admins get
        // the toast on next connect if they were offline when it was requested.
        "provider_service_requested",
      ];

      const unseen = await this.prisma.inAppNotification.findMany({
        where: {
          userId,
          seen: false,
          eventType: { in: costEventTypes },
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      });

      if (unseen.length === 0) return [];

      // A mention is toasted here but NOT marked seen: `seen` is the "cleared
      // from the home widget" flag, and clearing is the user's to do (open it
      // or dismiss it). Everything else is a fire-once toast, marked seen so it
      // never re-pops. The client de-dupes mention re-toasts within a session.
      const toMarkSeen = unseen.filter((n) => n.eventType !== "CRM_MENTION").map((n) => n.id);
      if (toMarkSeen.length) {
        await this.prisma.inAppNotification.updateMany({
          where: { id: { in: toMarkSeen } },
          data: { seen: true },
        });
      }

      return unseen.map(
        (n) =>
          ({
            data: JSON.stringify({
              // Normalize to lowercase so client handlers match (e.g. "HUMAN_ESCALATION" -> "human_escalation")
              type: n.eventType.toLowerCase(),
              // The row id lets the client de-dupe re-toasts and clear the
              // mention when it is opened.
              notificationId: n.id,
              ...(n.payload as Record<string, any>),
            }),
          }) as MessageEvent,
      );
    } catch (err: any) {
      this.logger.warn(`Failed to drain pending notifications for ${userId}: ${err.message}`);
      return [];
    }
  }
}
