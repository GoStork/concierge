import { Module } from "@nestjs/common";
import { UploadsController } from "./uploads.controller";
import { StorageModule } from "../storage/storage.module";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
  imports: [StorageModule, PrismaModule],
  controllers: [UploadsController],
})
export class UploadsModule {}
