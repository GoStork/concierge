import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {}

@Injectable()
export class SessionOrJwtGuard extends AuthGuard("jwt") {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    if (request.isAuthenticated && request.isAuthenticated()) {
      return true;
    }

    const authHeader = request.headers?.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const result = await super.canActivate(context);
        return !!result;
      } catch {
        throw new UnauthorizedException("Invalid or expired token");
      }
    }

    throw new UnauthorizedException("Not authenticated");
  }
}
