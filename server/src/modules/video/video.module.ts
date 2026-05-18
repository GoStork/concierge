import { Module } from "@nestjs/common";
import { VideoController } from "./video.controller";
import { VideoService } from "./video.service";
import { PrismaModule } from "../prisma/prisma.module";
import { NotificationModule } from "../notifications/notification.module";
import { CalendarModule } from "../calendar/calendar.module";
import { BillingModule } from "../billing/billing.module";

@Module({
  imports: [PrismaModule, NotificationModule, CalendarModule, BillingModule],
  controllers: [VideoController],
  providers: [VideoService],
  exports: [VideoService],
})
export class VideoModule {}
