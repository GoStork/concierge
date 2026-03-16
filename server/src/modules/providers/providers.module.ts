import { Module } from "@nestjs/common";
import { ProvidersController } from "./providers.controller";
import { ProviderTypesController } from "./provider-types.controller";
import { ProviderServicesController } from "./provider-services.controller";
import { ProviderLocationsController } from "./provider-locations.controller";
import { MembersController } from "./members.controller";
import { ProfileSyncController } from "./profile-sync.controller";
import { ScrapersController } from "./scrapers.controller";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [
    ProvidersController,
    ProviderTypesController,
    ProviderServicesController,
    ProviderLocationsController,
    MembersController,
    ProfileSyncController,
    ScrapersController,
  ],
})
export class ProvidersModule {}
