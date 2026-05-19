import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Req,
  Res,
  Inject,
  HttpException,
  HttpStatus,
  UseGuards,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { TestRunnerService } from "./test-runner.service";

@Controller()
export class TestRunnerController {
  private readonly logger = new Logger(TestRunnerController.name);

  constructor(
    @Inject(TestRunnerService) private readonly testRunnerService: TestRunnerService,
  ) {}

  private assertAdmin(req: Request): void {
    const user = req.user as any;
    this.logger.log(`assertAdmin check: userId=${user?.id}, roles=${JSON.stringify(user?.roles)}, role=${user?.role}`);
    // Support both 'roles' array and legacy 'role' string
    const isAdmin = user?.roles?.includes("GOSTORK_ADMIN") || user?.role === "GOSTORK_ADMIN";
    if (!isAdmin) {
      throw new HttpException("Forbidden - Admin only", HttpStatus.FORBIDDEN);
    }
  }

  // ─── GET /api/admin/test-runner/state ─────────────────────────────────────

  @Get("api/admin/test-runner/state")
  @UseGuards(SessionOrJwtGuard)
  getState(@Req() req: Request) {
    this.assertAdmin(req);
    return this.testRunnerService.getState();
  }

  // ─── GET /api/admin/test-runner/stream (SSE) ──────────────────────────────

  @Get("api/admin/test-runner/stream")
  @UseGuards(SessionOrJwtGuard)
  stream(@Req() req: Request, @Res() res: Response) {
    this.assertAdmin(req);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendData = (json: string) => {
      res.write(`data: ${json}\n\n`);
    };

    const unsubscribe = this.testRunnerService.subscribe(sendData);

    // Keepalive every 20s
    const keepalive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 20_000);

    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  }

  // ─── POST /api/admin/test-runner/run ──────────────────────────────────────

  @Post("api/admin/test-runner/run")
  @UseGuards(SessionOrJwtGuard)
  async startRun(@Req() req: Request, @Body() body: { filter?: string }) {
    this.assertAdmin(req);
    try {
      await this.testRunnerService.startRun(body?.filter);
      return { ok: true, message: "Run started" };
    } catch (e: any) {
      throw new HttpException(e.message, HttpStatus.CONFLICT);
    }
  }

  // ─── POST /api/admin/test-runner/stop ─────────────────────────────────────

  @Post("api/admin/test-runner/stop")
  @UseGuards(SessionOrJwtGuard)
  stopRun(@Req() req: Request) {
    this.assertAdmin(req);
    this.testRunnerService.stopRun();
    return { ok: true };
  }

  // ─── DELETE /api/admin/test-runner/results ────────────────────────────────

  @Delete("api/admin/test-runner/results")
  @UseGuards(SessionOrJwtGuard)
  clearResults(@Req() req: Request) {
    this.assertAdmin(req);
    this.testRunnerService.clearResults();
    return { ok: true };
  }
}
