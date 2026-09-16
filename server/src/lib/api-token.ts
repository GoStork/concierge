/**
 * The one place a Bearer token becomes a user (OWASP A07).
 *
 * This logic used to be copy-pasted into six Express routers plus the Nest JWT
 * strategy. That duplication was not cosmetic: when the 2FA challenge ticket
 * was added, the Nest strategy refused it and the six copies did not, and
 * because passport's isAuthenticated() is just `!!req.user`, the half-finished
 * login authenticated everywhere. One implementation, one place to get right.
 *
 * A token is accepted only when all four hold:
 *   1. the signature verifies,
 *   2. it is not a 2FA challenge ticket (password accepted, factor still owed),
 *   3. the account exists and is not disabled,
 *   4. its token version still matches the account's.
 *
 * (4) is what makes a password reset actually end existing API sessions.
 * Bumping User.tokenVersion invalidates every token ever issued to that
 * account, which is the only revocation a stateless JWT can have.
 */
import { jwtSecret } from "./app-secrets";

export interface TokenUser {
  id: string;
  isDisabled?: boolean;
  tokenVersion?: number | null;
  [key: string]: any;
}

/**
 * Resolves an Authorization header to a user, or null. Never throws: callers
 * are middleware that must continue unauthenticated on a bad token.
 * `db` is PrismaService or the raw client.
 */
export async function userFromBearer(
  authHeader: string | undefined,
  db: any,
): Promise<TokenUser | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const jwt = (await import("jsonwebtoken")).default;
    const payload = jwt.verify(token, jwtSecret()) as any;
    if (payload?.purpose === "2fa_challenge") return null;
    if (!payload?.sub) return null;
    const user = await db.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.isDisabled) return null;
    // A token minted before the last password reset carries the old version.
    const current = user.tokenVersion ?? 0;
    const presented = typeof payload.tv === "number" ? payload.tv : 0;
    if (presented !== current) return null;
    return user as TokenUser;
  } catch {
    return null;
  }
}

/** Middleware helper: attach the bearer user to the request if there is one. */
export async function attachBearerUser(req: any, db: any): Promise<void> {
  if (req.isAuthenticated && req.isAuthenticated()) return;
  const user = await userFromBearer(req.headers?.authorization, db);
  if (user) {
    req.user = user;
    req.isAuthenticated = () => true;
  }
}
