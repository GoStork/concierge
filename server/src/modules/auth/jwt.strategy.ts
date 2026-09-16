import { Injectable, Inject } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, ExtractJwt } from "passport-jwt";
import { AuthService } from "./auth.service";
import { jwtSecret } from "../../lib/app-secrets";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret(),
    });
  }

  async validate(payload: { sub: string; email: string; purpose?: string; tv?: number }) {
    // A half-finished login (password accepted, second factor still owed) is
    // handed a short ticket signed with the same key. It must never work as an
    // API credential, or 2FA would be bypassable by presenting the ticket.
    // Deny by default: a real session token has no `purpose` claim. Anything
    // that does is a single-purpose ticket (2fa_challenge, 2fa_enrollment, ...)
    // and must never authenticate an API request. Same rule as
    // src/lib/api-token.ts.
    if (payload?.purpose) return null;
    const user = await this.authService.getUserById(payload.sub);
    // A disabled account must not authenticate even with a still-valid token.
    if (!user || user.isDisabled) return null;
    // A token minted before the last password reset is dead. Same rule as
    // src/lib/api-token.ts, which the Express routers use.
    const presented = typeof payload.tv === "number" ? payload.tv : 0;
    if (presented !== ((user as any).tokenVersion ?? 0)) return null;
    return user;
  }
}
