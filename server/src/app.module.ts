import { Module } from "@nestjs/common";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { AuthModule } from "./modules/auth/auth.module";
import { UsersModule } from "./modules/users/users.module";
import { ProvidersModule } from "./modules/providers/providers.module";
import { UploadsModule } from "./modules/uploads/uploads.module";
import { CalendarModule } from "./modules/calendar/calendar.module";
import { VideoModule } from "./modules/video/video.module";
import { StorageModule } from "./modules/storage/storage.module";
import { BrandModule } from "./modules/brand/brand.module";
import { CostsModule } from "./modules/costs/costs.module";
import { KnowledgeModule } from "./modules/knowledge/knowledge.module";
import { GeoModule } from "./modules/geo/geo.module";

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthModule,
    UsersModule,
    ProvidersModule,
    UploadsModule,
    CalendarModule,
    VideoModule,
    BrandModule,
    CostsModule,
    KnowledgeModule,
    GeoModule,
  ],
})
export class AppModule {}
