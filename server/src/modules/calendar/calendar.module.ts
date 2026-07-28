import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { NotificationModule } from "../notifications/notification.module";
import { BillingModule } from "../billing/billing.module";
import { GoogleCalendarService } from "./google-calendar.service";
import { MicrosoftCalendarService } from "./microsoft-calendar.service";
import { CaldavCalendarService } from "./caldav-calendar.service";
import { BookingEventsService } from "./booking-events.service";
import { AutoReplyService } from "../providers/auto-reply.service";
import { ParentBriefingService } from "../providers/parent-briefing.service";

@Module({
  imports: [NotificationModule, BillingModule],
  controllers: [CalendarController],
  providers: [GoogleCalendarService, MicrosoftCalendarService, CaldavCalendarService, BookingEventsService, AutoReplyService, ParentBriefingService, CalendarController],
  exports: [BookingEventsService, CalendarController],
})
export class CalendarModule {}
