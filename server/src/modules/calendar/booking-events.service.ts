import { Injectable, Inject, Logger } from "@nestjs/common";
import { Subject, Observable, merge, from } from "rxjs";
import { filter, map, mergeMap } from "rxjs/operators";
import { PrismaService } from "../prisma/prisma.service";
import { trackConnect, trackDisconnect, isUserOnline } from "../../../online-tracker";

export interface BookingEvent {
  type: "booking_created" | "booking_confirmed" | "booking_declined" | "booking_cancelled" | "booking_rescheduled" | "booking_new_time" | "video_participant_joined";
  booking: {
    id: string;
    subject: string | null;
    status: string;
    scheduledAt: string;
    duration: number;
    attendeeName: string | null;
    providerUserId: string;
    parentUserId: string | null;
  };
  targetUserIds: string[];
  actorUserId?: string;
  joinerName?: string;
}

@Injectable()
export class BookingEventsService {
  private readonly logger = new Logger(BookingEventsService.name);
  private subject = new Subject<BookingEvent>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async emit(event: BookingEvent) {
    this.subject.next(event);

    if (event.type === "video_participant_joined") return;

    for (const userId of event.targetUserIds) {
      if (userId === event.actorUserId) continue;
      if (isUserOnline(userId)) continue;

      try {
        await this.prisma.inAppNotification.create({
          data: {
            userId,
            eventType: event.type,
            payload: {
              booking: event.booking,
              isOwnAction: false,
              ...(event.joinerName ? { joinerName: event.joinerName } : {}),
            },
          },
        });
      } catch (err: any) {
        this.logger.warn(`Failed to persist booking notification for ${userId}: ${err.message}`);
      }
    }
  }

  subscribe(userId: string): Observable<MessageEvent> {
    trackConnect(userId);

    const pending$ = from(this.drainPending(userId)).pipe(
      mergeMap((items) => from(items)),
    );

    const live$ = this.subject.asObservable().pipe(
      filter((event) => event.targetUserIds.includes(userId)),
      map(
        (event) =>
          ({
            data: JSON.stringify({
              type: event.type,
              booking: event.booking,
              isOwnAction: event.actorUserId === userId,
              ...(event.joinerName ? { joinerName: event.joinerName } : {}),
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
      const bookingEventTypes = [
        "booking_created",
        "booking_confirmed",
        "booking_declined",
        "booking_cancelled",
        "booking_rescheduled",
        "booking_new_time",
      ];

      const unseen = await this.prisma.inAppNotification.findMany({
        where: {
          userId,
          seen: false,
          eventType: { in: bookingEventTypes },
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
      this.logger.warn(`Failed to drain pending booking notifications for ${userId}: ${err.message}`);
      return [];
    }
  }
}
