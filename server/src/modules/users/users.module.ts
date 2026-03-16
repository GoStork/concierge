import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { AuthModule } from "../auth/auth.module";
import { VideoModule } from "../video/video.module";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [AuthModule, VideoModule, NotificationModule],
  controllers: [UsersController],
})
export class UsersModule {}
