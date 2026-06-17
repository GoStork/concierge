import { Module } from "@nestjs/common";
import { SponsorshipService } from "./sponsorship.service";
import { SponsorshipController } from "./sponsorship.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [PrismaModule, NotificationModule],
  providers: [SponsorshipService],
  controllers: [SponsorshipController],
  exports: [SponsorshipService],
})
export class SponsorshipModule {}
