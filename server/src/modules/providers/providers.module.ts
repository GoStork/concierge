import { Module } from "@nestjs/common";
import { ProvidersController } from "./providers.controller";
import { ProviderTypesController } from "./provider-types.controller";
import { ProviderServicesController } from "./provider-services.controller";
import { ProviderLocationsController } from "./provider-locations.controller";
import { MembersController } from "./members.controller";
import { ProfileSyncController } from "./profile-sync.controller";
import { ScrapersController } from "./scrapers.controller";
import { DocumentsController } from "./documents.controller";
import { AutoReplyController } from "./auto-reply.controller";
import { AutoReplyService } from "./auto-reply.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  providers: [AutoReplyService],
  exports: [AutoReplyService],
  controllers: [
    ProvidersController,
    ProviderTypesController,
    ProviderServicesController,
    ProviderLocationsController,
    MembersController,
    ProfileSyncController,
    ScrapersController,
    DocumentsController,
    AutoReplyController,
  ],
})
export class ProvidersModule {}
