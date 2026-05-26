import { Module } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";
import { CostSheetController } from "./cost-sheet.controller";
import { W9Controller } from "./w9.controller";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [NotificationModule],
  providers: [BillingService],
  controllers: [BillingController, CostSheetController, W9Controller],
  exports: [BillingService],
})
export class BillingModule {}
