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
  }
}
