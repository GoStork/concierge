import { Module, OnModuleInit, Inject, Logger } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { NotificationModule } from "../notifications/notification.module";
import { CostsController } from "./costs.controller";
import { CostsService } from "./costs.service";
import { CostsAiService } from "./costs-ai.service";

@Module({
  imports: [PrismaModule, NotificationModule],
  controllers: [CostsController],
  providers: [CostsService, CostsAiService],
  exports: [CostsService],
})
export class CostsModule implements OnModuleInit {
  private readonly logger = new Logger(CostsModule.name);

  constructor(@Inject(CostsService) private readonly costsService: CostsService) {}

  async onModuleInit() {
    try {
      await this.costsService.ensureFrozenEggTemplates();
    } catch (err: any) {
      this.logger.warn(`Failed to ensure frozen egg templates: ${err.message}`);
    }
    try {
      // Resume (re-run) any cost-sheet parses that were in-flight when the
      // server died. Sheets whose file is recoverable from GCS get their
      // background parse restarted automatically; sheets with a missing
      // file get marked DRAFT so they don't stay stuck in PARSING forever.
      // The client's polling on parseProgress picks up the resumed progress
      // without any UI change.
      await this.costsService.resumeOrphanedParsingSheets();
    } catch (err: any) {
      this.logger.warn(`Failed to resume orphaned parsing sheets: ${err.message}`);
    }
  }
}
