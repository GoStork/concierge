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

  async validate(payload: { sub: string; email: string; purpose?: string }) {
    // A half-finished login (password accepted, second factor still owed) is
    // handed a short ticket signed with the same key. It must never work as an
    // API credential, or 2FA would be bypassable by presenting the ticket.
    if (payload?.purpose === "2fa_challenge") return null;
    const user = await this.authService.getUserById(payload.sub);
    // A disabled account must not authenticate even with a still-valid token.
    if (!user || user.isDisabled) return null;
    return user;
  }
}
