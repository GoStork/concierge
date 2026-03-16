import { Injectable, Inject } from "@nestjs/common";
import { PassportSerializer } from "@nestjs/passport";
import { AuthService } from "./auth.service";

@Injectable()
export class SessionSerializer extends PassportSerializer {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {
    super();
  }

  serializeUser(user: any, done: (err: Error | null, id?: string) => void) {
    done(null, user.id);
  }

  async deserializeUser(id: string, done: (err: Error | null, user?: any) => void) {
    try {
      const user = await this.authService.getUserById(id);
      if (user?.isDisabled) {
        done(null, undefined);
        return;
      }
      done(null, user);
    } catch (err) {
      done(err as Error);
    }
  }
}
