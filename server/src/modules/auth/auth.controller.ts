import {
  Controller,
  Post,
  Body,
  Param,
  Get,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiTags, ApiOperation, ApiBody, ApiResponse } from "@nestjs/swagger";
import { Request } from "express";
import { AuthService } from "./auth.service";
import { NotificationService } from "../notifications/notification.service";
import { LoginDto, LoginResponseDto, LogoutResponseDto, ErrorResponseDto } from "../../dto/auth.dto";
import { getBaseUrl } from "../../lib/get-base-url";
import { verifyTurnstile, turnstileSiteKey } from "../../../turnstile";
import { TwoFactorService } from "./two-factor.service";
import { recordAuthEvent, requestIp, requestUserAgent } from "../../lib/auth-audit";
import { roleRequiresTwoFactor, twoFactorEnforcedNow } from "../../lib/totp";
import { PrismaService } from "../prisma/prisma.service";
import { SessionOrJwtGuard } from "./guards/auth.guard";
import { prisma as dbPrisma } from "../../../db";

@ApiTags("Auth")
@Controller("api/auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(NotificationService) private readonly notificationService: NotificationService,
    @Inject(TwoFactorService) private readonly twoFactor: TwoFactorService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Shared tail of a successful authentication: regenerate the session id
   * (fixation), log the user in, stamp lastLoginAt, write the audit row and
   * hand back the sanitised user plus a JWT. Used by both the password-only
   * path and the second-factor path so the two can never drift.
   */
  private finishLogin(req: Request, user: any, detail?: string) {
    return new Promise<any>((resolve, reject) => {
      const proceed = () =>
        req.logIn(user, async (err) => {
          if (err) {
            reject(new InternalServerErrorException("Login session error"));
            return;
          }
          const enriched = await this.authService.getUserWithProvider(user.id);
          (dbPrisma as any).user
            .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
            .catch(() => {});
          await recordAuthEvent(this.prisma, {
            event: "LOGIN_SUCCESS",
            userId: user.id,
            email: user.email,
            ip: requestIp(req),
            userAgent: requestUserAgent(req),
            detail: detail ?? null,
          });
          const result = enriched || user;
          const { password: _, totpSecret: __, totpRecoveryCodes: ___, totpLastStep: ____, ...safe } = result as any;
          const token = this.authService.generateToken(user);
          resolve({ ...safe, token });
        });

      const session = (req as any).session;
      if (session?.regenerate) {
        session.regenerate((regenErr: any) => {
          if (regenErr) {
            reject(new InternalServerErrorException("Login session error"));
            return;
          }
          proceed();
        });
      } else {
        proceed();
      }
    });
  }

  @UseGuards(AuthGuard("local"))
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Login with email and password" })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: "Login successful", type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid credentials", type: ErrorResponseDto })
  async login(@Req() req: Request) {
    const user = req.user as any;

    // Password was correct. Now the second factor, if this account has one.
    // OWASP A07: staff accounts can read every family's record and move money,
    // and GoStork 1.0 lost its Stripe account to exactly this gap.
    if (user.totpEnabledAt) {
      await recordAuthEvent(this.prisma, {
        event: "LOGIN_SUCCESS",
        userId: user.id,
        email: user.email,
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
        detail: "password_ok_awaiting_2fa",
      });
      return {
        requiresTwoFactor: true,
        challengeToken: this.authService.createTwoFactorChallenge(user.id),
      };
    }

    // Covered role that never enrolled. During the grace period they are let
    // in and nagged; once TWO_FACTOR_ENFORCE_AT passes they must enrol first.
    //
    // Refusing outright (what this did originally) is a lockout: enrolment
    // happens inside the app, so an account that cannot log in can never set
    // up the factor it is being refused for. The next person added to the team
    // would have needed a database edit to get in. Instead, hand out a
    // 15-minute ticket that opens the enrolment endpoints and nothing else.
    const mustEnrol = roleRequiresTwoFactor(user.roles);
    if (mustEnrol && twoFactorEnforcedNow()) {
      await recordAuthEvent(this.prisma, {
        event: "LOGIN_SUCCESS",
        userId: user.id,
        email: user.email,
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
        detail: "password_ok_must_enrol_2fa",
      });
      return {
        requiresTwoFactorEnrollment: true,
        enrollmentToken: this.authService.createTwoFactorEnrollmentTicket(user.id),
      };
    }

    const result = await this.finishLogin(req, user);
    // Lets the UI show the enrolment prompt during the grace period.
    return { ...result, twoFactorRequired: mustEnrol, twoFactorEnabled: false };
  }

  @Post("2fa/verify-login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Complete a login by supplying the TOTP or recovery code" })
  async verifyTwoFactorLogin(
    @Body() body: { challengeToken: string; code: string },
    @Req() req: Request,
  ) {
    if (!body?.challengeToken || !body?.code) {
      throw new BadRequestException("Challenge token and code are required");
    }
    const userId = this.authService.verifyTwoFactorChallenge(body.challengeToken);
    if (!userId) {
      throw new BadRequestException("That sign-in attempt expired. Please start again.");
    }
    const meta = { ip: requestIp(req), userAgent: requestUserAgent(req) };
    const ok = await this.twoFactor.verifyForLogin(userId, body.code, meta);
    if (!ok) {
      throw new BadRequestException("That code is not right.");
    }
    const user = await this.authService.getUserById(userId);
    if (!user || user.isDisabled) throw new BadRequestException("Account unavailable");
    const result = await this.finishLogin(req, user, "2fa");
    return { ...result, twoFactorRequired: true, twoFactorEnabled: true };
  }

  @Post("2fa/enroll/setup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "First-login enrollment: QR code, using the ticket from /login" })
  async twoFactorEnrollSetup(@Body() body: { enrollmentToken: string }) {
    const userId = await this.resolveEnrollmentTicket(body?.enrollmentToken);
    return this.twoFactor.beginEnrollment(userId);
  }

  @Post("2fa/enroll/complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "First-login enrollment: confirm the code, then sign in" })
  async twoFactorEnrollComplete(
    @Body() body: { enrollmentToken: string; code: string },
    @Req() req: Request,
  ) {
    if (!body?.code) throw new BadRequestException("Code is required");
    const userId = await this.resolveEnrollmentTicket(body?.enrollmentToken);
    const meta = { ip: requestIp(req), userAgent: requestUserAgent(req) };
    const result = await this.twoFactor.completeEnrollment(userId, body.code, meta);

    const user = await this.authService.getUserById(userId);
    if (!user || user.isDisabled) throw new BadRequestException("Account unavailable");
    // They proved the factor in the same request, so this IS the second
    // factor: sign them in rather than making them type a second code.
    const session = await this.finishLogin(req, user, "2fa_enrollment");
    return {
      ...session,
      twoFactorRequired: true,
      twoFactorEnabled: true,
      recoveryCodes: result.recoveryCodes,
    };
  }

  /**
   * Validates an enrolment ticket. Refuses one for an account that already has
   * an authenticator: otherwise a stolen password could be used to enrol a new
   * device and bypass the existing factor entirely.
   */
  private async resolveEnrollmentTicket(token: string | undefined): Promise<string> {
    if (!token) throw new BadRequestException("Enrollment token is required");
    const userId = this.authService.verifyTwoFactorEnrollmentTicket(token);
    if (!userId) {
      throw new BadRequestException("That sign-in attempt expired. Please start again.");
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, totpEnabledAt: true, isDisabled: true },
    });
    if (!user || user.isDisabled) throw new BadRequestException("Account unavailable");
    if (user.totpEnabledAt) {
      throw new BadRequestException("This account already has two-factor authentication.");
    }
    return userId;
  }

  @Get("2fa/status")
  @UseGuards(SessionOrJwtGuard)
  @ApiOperation({ summary: "Whether this account has, or needs, a second factor" })
  async twoFactorStatus(@Req() req: Request) {
    return this.twoFactor.status((req.user as any).id);
  }

  @Post("2fa/setup")
  @UseGuards(SessionOrJwtGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Start enrollment: returns the QR code to scan" })
  async twoFactorSetup(@Req() req: Request) {
    return this.twoFactor.beginEnrollment((req.user as any).id);
  }

  @Post("2fa/enable")
  @UseGuards(SessionOrJwtGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirm enrollment with a code; returns recovery codes once" })
  async twoFactorEnable(@Body() body: { code: string }, @Req() req: Request) {
    if (!body?.code) throw new BadRequestException("Code is required");
    return this.twoFactor.completeEnrollment((req.user as any).id, body.code, {
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
  }

  @Post("2fa/disable")
  @UseGuards(SessionOrJwtGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Turn off two-factor authentication (needs a live code)" })
  async twoFactorDisable(@Body() body: { code: string }, @Req() req: Request) {
    if (!body?.code) throw new BadRequestException("Code is required");
    return this.twoFactor.disable((req.user as any).id, body.code, {
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Logout and destroy session" })
  @ApiResponse({ status: 200, description: "Logged out", type: LogoutResponseDto })
  logout(@Req() req: Request, @Res() res: any) {
    req.logout((err) => {
      if (err) {
        res.status(500).json({ message: "Logout failed" });
        return;
      }
      (req as any).session?.destroy?.((destroyErr: any) => {
        if (destroyErr) console.error("Session destroy error:", destroyErr);
        res.clearCookie("connect.sid", { path: "/" });
        res.json({ message: "Logged out" });
      });
    });
  }

  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() body: { email: string }) {
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException("Email is required");
    }

    const result = await this.authService.createPasswordResetToken(email);

    if (result) {
      // An invited family member who never set a password is asking for a
      // fresh INVITATION, not a reset: same 7-day link, invite wording, the
      // page's ?invite=1 variant. Before this, the expired-invite page sent
      // them into the reset flow while the email said to ask the inviter.
      const account = await this.prisma.user.findUnique({ where: { email }, select: { id: true, name: true, mobileNumber: true, password: true, parentAccountId: true } });
      if (account && !account.password && account.parentAccountId) {
        const inviter = await this.prisma.user.findFirst({ where: { parentAccountId: account.parentAccountId, parentAccountRole: "INTENDED_PARENT_1" }, select: { name: true } });
        const inviteLink = `${getBaseUrl()}/reset-password/${result.token}?invite=1`;
        try {
          await this.notificationService.sendMemberInvitation(inviter?.name || "Your partner", { id: account.id, email, name: account.name, mobileNumber: account.mobileNumber }, inviteLink);
        } catch (err: any) {
          this.logger.error(`Failed to re-send member invitation to ${email}: ${err.message}`);
        }
      } else {
        const resetLink = `${getBaseUrl()}/reset-password/${result.token}`;
        try {
          await this.notificationService.sendPasswordResetEmail(email, result.userName, resetLink);
        } catch (err: any) {
          this.logger.error(`Failed to send password reset email to ${email}: ${err.message}`);
        }
      }
    }

    return { message: "If an account with that email exists, a password reset link has been sent." };
  }

  @Get("validate-reset-token/:token")
  async validateResetToken(@Param("token") token: string) {
    const valid = await this.authService.validatePasswordResetToken(token);
    if (!valid) {
      throw new BadRequestException("Invalid or expired reset token");
    }
    // The email lets the set-password page pre-fill sign-in afterwards; the
    // invite flag lets it choose first-password wording. Neither is secret to
    // the holder of a valid token.
    const owner = await this.prisma.user.findUnique({ where: { id: valid.userId }, select: { email: true, password: true } });
    return { valid: true, email: owner?.email ?? null, invite: !!owner && !owner.password };
  }

  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() body: { token: string; password: string }) {
    if (!body.token || !body.password) {
      throw new BadRequestException("Token and password are required");
    }

    if (body.password.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters");
    }

    const success = await this.authService.resetPassword(body.token, body.password);
    if (!success) {
      throw new BadRequestException("Invalid or expired reset token");
    }

    return { message: "Password has been reset successfully" };
  }

  // Public, unauthenticated: the signup form fetches this before rendering the
  // phone step. Returns the Turnstile site key (safe to expose) or null, so the
  // client renders the bot-check widget only when it is configured.
  @Get("turnstile-config")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Public Turnstile site key for the signup widget" })
  turnstileConfig() {
    return { siteKey: turnstileSiteKey() };
  }

  @Post("send-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Send OTP verification code via SMS or WhatsApp" })
  async sendOtp(@Body() body: { phone: string; turnstileToken?: string }, @Req() req: Request) {
    if (!body.phone?.trim()) {
      throw new BadRequestException("Phone number is required");
    }
    // Behind Cloudflare the first x-forwarded-for hop is a Cloudflare edge
    // address, which would bucket every visitor behind one edge node together
    // and defeat the per-IP OTP limit that exists to stop SMS toll fraud.
    const ip = requestIp(req);

    // Turnstile gate. A real signup carries a token minted by the widget in the
    // form; a bot POSTing straight to this endpoint has none. Inert until the
    // secret is set (verifyTurnstile returns ok), so dev/tests are unaffected.
    const turnstile = await verifyTurnstile(body.turnstileToken, ip);
    if (!turnstile.ok) {
      this.logger.warn(`[turnstile] send-otp rejected: ${(turnstile.errorCodes || []).join(",") || "invalid token"}`);
      throw new BadRequestException("turnstile_failed");
    }

    try {
      const result = await this.authService.sendOtp(body.phone, {
        ip,
        userAgent: (req.headers["user-agent"] as string) ?? null,
      });
      return { success: true, sent: result.sent, channel: result.channel, devCode: result.devCode };
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  @Post("verify-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify OTP code" })
  async verifyOtp(@Body() body: { phone: string; code: string }) {
    if (!body.phone?.trim() || !body.code?.trim()) {
      throw new BadRequestException("Phone and code are required");
    }
    const valid = await this.authService.verifyOtp(body.phone, body.code);
    if (!valid) {
      throw new BadRequestException("Invalid or expired verification code");
    }
    return { verified: true };
  }
}
