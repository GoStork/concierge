import { Module } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";
import { CostSheetController } from "./cost-sheet.controller";
import { W9Controller } from "./w9.controller";
import { ProviderAgreementController } from "./provider-agreement.controller";
import { ConnectService } from "./connect.service";
import { ConnectController } from "./connect.controller";
import { LegalIdentityService } from "./legal-identity.service";
import { LegalIdentityController } from "./legal-identity.controller";
import { CostSheetAutoDraftService } from "./cost-sheet-auto-draft.service";
import { CostSheetAutoDraftController } from "./cost-sheet-auto-draft.controller";
import { NotificationModule } from "../notifications/notification.module";
import { SponsorshipModule } from "../sponsorship/sponsorship.module";

@Module({
  imports: [NotificationModule, SponsorshipModule],
  providers: [BillingService, ConnectService, LegalIdentityService, CostSheetAutoDraftService],
  controllers: [
    BillingController,
    CostSheetController,
    W9Controller,
    ProviderAgreementController,
    ConnectController,
    LegalIdentityController,
    CostSheetAutoDraftController,
  ],
  exports: [BillingService, ConnectService, LegalIdentityService, CostSheetAutoDraftService],
})
export class BillingModule {}
