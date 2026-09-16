import { Injectable, Inject, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-local";
import { AuthService } from "./auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { recordAuthEventAsync, requestIp, requestUserAgent } from "../../lib/auth-audit";

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {
    // passReqToCallback so a failed login can be audited with its source IP.
    // Without the request there is no way to tell one attacker from a user who
    // mistyped their password (OWASP A09).
    super({ usernameField: "email", passReqToCallback: true });
  }

  async validate(req: any, email: string, password: string) {
    const user = await this.authService.validateUser(email, password);
    if (!user) {
      recordAuthEventAsync(this.prisma, {
        event: "LOGIN_FAILURE",
        email,
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
        detail: "bad_credentials_or_disabled",
      });
      throw new UnauthorizedException("Invalid credentials");
    }
    return user;
  }
}
