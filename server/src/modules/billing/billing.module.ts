import { Module } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";
import { CostSheetController } from "./cost-sheet.controller";
import { W9Controller } from "./w9.controller";
import { ConnectService } from "./connect.service";
import { ConnectController } from "./connect.controller";
import { LegalIdentityService } from "./legal-identity.service";
import { LegalIdentityController } from "./legal-identity.controller";
import { NotificationModule } from "../notifications/notification.module";

@Module({
  imports: [NotificationModule],
  providers: [BillingService, ConnectService, LegalIdentityService],
  controllers: [
    BillingController,
    CostSheetController,
    W9Controller,
    ConnectController,
    LegalIdentityController,
  ],
  exports: [BillingService, ConnectService, LegalIdentityService],
})
export class BillingModule {}
