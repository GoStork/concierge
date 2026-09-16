import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { LocalStrategy } from "./local.strategy";
import { JwtStrategy } from "./jwt.strategy";
import { SessionSerializer } from "./session.serializer";
import { OtpGuardService } from "./otp-guard.service";
import { TwoFactorService } from "./two-factor.service";
import { NotificationModule } from "../notifications/notification.module";
import { jwtSecret } from "../../lib/app-secrets";

@Module({
  imports: [
    PassportModule.register({ session: true }),
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: "7d" },
    }),
    NotificationModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy, SessionSerializer, OtpGuardService, TwoFactorService],
  exports: [AuthService, TwoFactorService],
})
export class AuthModule {}
