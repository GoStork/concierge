import { Module } from "@nestjs/common";
import { CalendarController } from "./calendar.controller";
import { NotificationModule } from "../notifications/notification.module";
import { GoogleCalendarService } from "./google-calendar.service";
import { MicrosoftCalendarService } from "./microsoft-calendar.service";
import { CaldavCalendarService } from "./caldav-calendar.service";
import { BookingEventsService } from "./booking-events.service";

@Module({
  imports: [NotificationModule],
  controllers: [CalendarController],
  providers: [GoogleCalendarService, MicrosoftCalendarService, CaldavCalendarService, BookingEventsService, CalendarController],
  exports: [BookingEventsService, CalendarController],
})
export class CalendarModule {}
