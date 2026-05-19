import { Module } from "@nestjs/common";
import { TestRunnerService } from "./test-runner.service";
import { TestRunnerController } from "./test-runner.controller";

@Module({
  providers: [TestRunnerService],
  controllers: [TestRunnerController],
  exports: [TestRunnerService],
})
export class TestRunnerModule {}
