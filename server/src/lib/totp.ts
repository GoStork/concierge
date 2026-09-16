/**
 * TOTP (RFC 6238) for GoStork staff two-factor authentication.
 *
 * Why an authenticator app and not SMS: GoStork 1.0's Stripe account was taken
 * over in 2024 against SMS 2FA. A TOTP secret cannot be SIM-swapped away.
 *
 * The secret is stored AES-256-GCM encrypted (server/src/lib/encrypt.ts), and
 * recovery codes are stored only as scrypt hashes - the plaintext codes are
 * shown once at enrollment and never again.
 */
import { TOTP, Secret } from "otpauth";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Roles that must carry a second factor. These accounts can read every
 *  family's data, change security policy and move money. */
export const TWO_FACTOR_REQUIRED_ROLES = [
  "GOSTORK_ADMIN",
  "GOSTORK_CONCIERGE",
  "GOSTORK_DEVELOPER",
];

export function roleRequiresTwoFactor(roles: string[] | null | undefined): boolean {
  return (roles || []).some((r) => TWO_FACTOR_REQUIRED_ROLES.includes(r));
}

/**
 * Hard enforcement date. Until it passes, a covered account that has not
 * enrolled is prompted but still gets in (the grace period). Set
 * TWO_FACTOR_ENFORCE_AT to an ISO date to start blocking.
 */
export function twoFactorEnforcedNow(): boolean {
  const at = process.env.TWO_FACTOR_ENFORCE_AT;
  if (!at) return false;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return false;
  return Date.now() >= when.getTime();
}

const PERIOD = 30;
const DIGITS = 6;
/** One step either side, so a slightly wrong device clock still works. */
const WINDOW = 1;

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: "GoStork",
    label,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** New enrollment secret plus the otpauth:// URI the QR encodes. */
export function generateSecret(label: string): { secretBase32: string; uri: string } {
  const secret = new Secret({ size: 20 }); // 160-bit, the RFC 4226 recommendation
  const secretBase32 = secret.base32;
  return { secretBase32, uri: totpFor(secretBase32, label).toString() };
}

/**
 * Verifies a code. Returns the accepted 30-second time step so the caller can
 * persist it and refuse a replay of that same code inside its own window.
 * `lastStep` is the previously accepted step, if any.
 */
export function verifyCode(
  secretBase32: string,
  code: string,
  label: string,
  lastStep?: number | null,
): { ok: boolean; step?: number; reason?: string } {
  const cleaned = (code || "").replace(/\s|-/g, "");
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, reason: "malformed" };
  let delta: number | null;
  try {
    delta = totpFor(secretBase32, label).validate({ token: cleaned, window: WINDOW });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (delta === null) return { ok: false, reason: "invalid" };
  const step = Math.floor(Date.now() / 1000 / PERIOD) + delta;
  if (lastStep != null && step <= lastStep) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true, step };
}

// ── Recovery codes ───────────────────────────────────────────────────────────

const RECOVERY_CODE_COUNT = 10;

function hashRecoveryCode(code: string, salt: string): string {
  return `${scryptSync(code.toLowerCase(), salt, 64).toString("hex")}.${salt}`;
}

/** Ten single-use codes. Returns the plaintext (shown once) and the hashes. */
export function generateRecoveryCodes(): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // 10 hex chars, displayed as xxxxx-xxxxx for readability.
    const raw = randomBytes(5).toString("hex");
    const pretty = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    plain.push(pretty);
    hashed.push(hashRecoveryCode(pretty, randomBytes(16).toString("hex")));
  }
  return { plain, hashed };
}

/**
 * Consumes a recovery code. Returns the remaining hashes with the used one
 * removed, so a code can never be replayed.
 */
export function consumeRecoveryCode(
  supplied: string,
  hashes: string[],
): { ok: boolean; remaining: string[] } {
  const cleaned = (supplied || "").trim().toLowerCase();
  if (!cleaned) return { ok: false, remaining: hashes };
  for (const stored of hashes) {
    const [hash, salt] = stored.split(".");
    if (!hash || !salt) continue;
    let candidate: Buffer;
    try {
      candidate = scryptSync(cleaned, salt, 64);
    } catch {
      continue;
    }
    const expected = Buffer.from(hash, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true, remaining: hashes.filter((h) => h !== stored) };
    }
  }
  return { ok: false, remaining: hashes };
}
