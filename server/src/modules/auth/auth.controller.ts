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

function getBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") return `http://localhost:${process.env.PORT || 5001}`;
  return "https://app.gostork.com";
}

@ApiTags("Auth")
@Controller("api/auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(NotificationService) private readonly notificationService: NotificationService,
  ) {}

  @UseGuards(AuthGuard("local"))
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Login with email and password" })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: "Login successful", type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid credentials", type: ErrorResponseDto })
  async login(@Req() req: Request) {
    const user = req.user as any;
    return new Promise<any>((resolve, reject) => {
      req.logIn(user, async (err) => {
        if (err) {
          reject(new InternalServerErrorException("Login session error"));
          return;
        }
        const enriched = await this.authService.getUserWithProvider(user.id);
        const result = enriched || user;
        const { password: _, ...safe } = result;
        const token = this.authService.generateToken(user);
        resolve({ ...safe, token });
      });
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
      const resetLink = `${getBaseUrl()}/reset-password/${result.token}`;
      try {
        await this.notificationService.sendPasswordResetEmail(email, result.userName, resetLink);
      } catch (err: any) {
        this.logger.error(`Failed to send password reset email to ${email}: ${err.message}`);
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
    return { valid: true };
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

  @Post("send-otp")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Send OTP verification code via SMS" })
  async sendOtp(@Body() body: { phone: string }) {
    if (!body.phone?.trim()) {
      throw new BadRequestException("Phone number is required");
    }
    try {
      const result = await this.authService.sendOtp(body.phone);
      return { success: true, sent: result.sent, devCode: result.devCode };
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
    const valid = this.authService.verifyOtp(body.phone, body.code);
    if (!valid) {
      throw new BadRequestException("Invalid or expired verification code");
    }
    return { verified: true };
  }
}
