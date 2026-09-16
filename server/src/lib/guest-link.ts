/**
 * Lifetime rules for login-free signing links (OWASP A07 / A01).
 *
 * The provider-agreement and W-9 links let someone with no GoStork account
 * open an executed contract or a tax form carrying an EIN or SSN. They were
 * minted once and then valid forever, with no way to switch one off: the only
 * check was "is the token at least 20 characters". A link forwarded to the
 * wrong mailbox, or sitting in an ex-employee's inbox, stayed live
 * indefinitely.
 *
 * The IP-form guest tokens already did this correctly (expiry + revocation);
 * this brings the other two in line, with the same 30-day window.
 */

/** Same window the IP-form guest links use. */
export const GUEST_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function guestLinkExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + GUEST_LINK_TTL_MS);
}

export interface GuestLinkRow {
  guestTokenExpiresAt?: Date | null;
  guestTokenRevokedAt?: Date | null;
}

export type GuestLinkProblem = "revoked" | "expired" | null;

/**
 * Why a link should be refused, or null when it is fine.
 *
 * A row with no expiry set is treated as usable: rows created before this
 * existed have null, and silently killing every outstanding signing link on
 * deploy would strand real providers mid-signature. They get an expiry the
 * next time the link is sent or reminded.
 */
export function guestLinkProblem(row: GuestLinkRow | null | undefined): GuestLinkProblem {
  if (!row) return null;
  if (row.guestTokenRevokedAt) return "revoked";
  if (row.guestTokenExpiresAt && row.guestTokenExpiresAt.getTime() < Date.now()) return "expired";
  return null;
}

/**
 * What the signer is told. Deliberately the same wording for both cases and
 * for a token that does not exist at all: someone probing links should not
 * learn whether a given token was ever real.
 */
export const GUEST_LINK_DEAD_MESSAGE =
  "This signing link is no longer valid. Ask your GoStork contact to send a new one.";
