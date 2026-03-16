import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeService } from "./knowledge.service";
import { PrismaModule } from "../prisma/prisma.module";
import { MulterModule } from "@nestjs/platform-express";

@Module({
  imports: [
    PrismaModule,
    PassportModule.register({ session: true }),
    MulterModule.register({
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  ],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
