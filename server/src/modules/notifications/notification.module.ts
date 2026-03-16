import { Module } from "@nestjs/common";
import { NotificationService } from "./notification.service";
import { AppEventsService } from "./app-events.service";

@Module({
  providers: [NotificationService, AppEventsService],
  exports: [NotificationService, AppEventsService],
})
export class NotificationModule {}
