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
import { getTestCaseInfo } from "./test-cases";
import { timingSafeEqual } from "node:crypto";

@Controller()
export class TestRunnerController {
  private readonly logger = new Logger(TestRunnerController.name);

  constructor(
    @Inject(TestRunnerService) private readonly testRunnerService: TestRunnerService,
  ) {}

  private assertAdmin(req: Request): void {
    const user = req.user as any;
    // Debug: always visible in logs
    console.log(`[TestRunner] assertAdmin: id=${user?.id}, roles=${JSON.stringify(user?.roles)}, role=${user?.role}, isAuth=${(req as any).isAuthenticated?.()}`);
    // Support both 'roles' array and legacy 'role' string
    const isAdmin = user?.roles?.includes("GOSTORK_ADMIN") || user?.role === "GOSTORK_ADMIN" || user?.roles?.includes("GOSTORK_DEVELOPER");
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

  // ─── GET /api/admin/test-runner/cases ─────────────────────────────────────
  // Returns full metadata (name, desc, interestedServices, messageCount) for
  // all 72 test cases. Used by the admin UI to render expanded cards without
  // duplicating the test definitions.

  @Get("api/admin/test-runner/cases")
  @UseGuards(SessionOrJwtGuard)
  getCases(@Req() req: Request) {
    this.assertAdmin(req);
    return getTestCaseInfo();
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

  // ─── POST /api/admin/test-runner/event ────────────────────────────────────
  // The running CLI reports progress events here and the service broadcasts
  // them to the admin SSE stream.
  //
  // SECURITY (OWASP A01): this was unauthenticated on the theory that it is
  // "localhost-only", but the server binds 0.0.0.0 and is published through
  // ngrok, so anyone could inject arbitrary events into an admin's live test
  // view. The CLI runs with a shared secret in TEST_RUNNER_TOKEN (or, in a
  // developer session, an admin session/JWT like every sibling route).
  @Post("api/admin/test-runner/event")
  receiveCliEvent(@Body() event: Record<string, unknown>, @Req() req: Request) {
    const token = process.env.TEST_RUNNER_TOKEN;
    const provided = req.headers["x-test-runner-token"];
    const tokenOk =
      !!token &&
      typeof provided === "string" &&
      provided.length === token.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(token));
    if (!tokenOk) {
      // Falls back to the same admin check every other test-runner route uses.
      this.assertAdmin(req);
    }
    this.testRunnerService.receiveCliEvent(event);
    return { ok: true };
  }
}
