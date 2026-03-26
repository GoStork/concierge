import { Injectable, Inject, Logger } from "@nestjs/common";
import { Subject, Observable, merge, from } from "rxjs";
import { filter, map, mergeMap, delay } from "rxjs/operators";
import { PrismaService } from "../prisma/prisma.service";
import { trackConnect, trackDisconnect, getConnectedCount } from "../../../online-tracker";

export interface AppEvent {
  type: "cost_sheet_submitted" | "cost_sheet_approved" | "cost_sheet_rejected" | "cost_sheet_deleted" | "human_escalation";
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

      await this.prisma.inAppNotification.updateMany({
        where: { id: { in: unseen.map((n) => n.id) } },
        data: { seen: true },
      });

      return unseen.map(
        (n) =>
          ({
            data: JSON.stringify({
              type: n.eventType,
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
