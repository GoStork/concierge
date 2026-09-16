/**
 * Single source of truth for the two signing secrets (OWASP A02/A04).
 *
 * These used to be read as `process.env.X || "<literal>"` in eleven separate
 * files. Two problems with that: the literal is in a git repo, so anyone who
 * reads it can forge a session cookie or an admin JWT; and because the fallback
 * is silent, one unset env var in one environment downgrades the whole platform
 * to a publicly-known key with nothing in the logs. (SESSION_SECRET was in fact
 * empty on a dev box, so the hardcoded value was live.)
 *
 * Now: no literals, and a missing secret is fatal at boot instead of quietly
 * insecure at runtime.
 */
function required(name: "SESSION_SECRET" | "JWT_SECRET"): string {
  const value = process.env[name];
  if (value && value.length >= 32) return value;
  const problem = !value ? "is not set" : `is only ${value.length} chars (need >= 32)`;
  throw new Error(
    `FATAL: ${name} ${problem}. Generate one with:\n` +
      `  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\n` +
      `and add it to this machine's .env (it is per-machine and gitignored). ` +
      `Refusing to start with a guessable signing key.`,
  );
}

let cachedSession: string | null = null;
let cachedJwt: string | null = null;

export function sessionSecret(): string {
  if (!cachedSession) cachedSession = required("SESSION_SECRET");
  return cachedSession;
}

export function jwtSecret(): string {
  if (!cachedJwt) cachedJwt = required("JWT_SECRET");
  return cachedJwt;
}
