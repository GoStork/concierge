import { Module } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";
import { CostSheetController } from "./cost-sheet.controller";
import { W9Controller } from "./w9.controller";
import { ConnectService } from "./connect.service";
import { ConnectController } from "./connect.controller";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [NotificationModule],
  providers: [BillingService, ConnectService],
  controllers: [BillingController, CostSheetController, W9Controller, ConnectController],
  exports: [BillingService, ConnectService],
})
export class BillingModule {}
