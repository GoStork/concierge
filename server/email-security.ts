/**
 * Email hygiene for signup (Phase 9 §8, part 1).
 *
 * Two abuse vectors this closes, without turning real parents away:
 *
 *  - Disposable inboxes (mailinator, guerrillamail, ...) - a bot spins up a
 *    throwaway address per account. We refuse known disposable domains.
 *  - Alias flooding - `foo+1@gmail.com`, `f.o.o@gmail.com` all deliver to the
 *    same Gmail inbox, so one person can mint hundreds of "unique" accounts.
 *    We collapse each address to a CANONICAL form and dedup on it.
 *
 * The escape hatch: an editable allowlist (SecurityEmailAllow, seeded with the
 * staff test inbox, managed on /admin/security). An allowlisted canonical may
 * create unlimited aliases - so testing with `natan123+N@gmail.com` keeps
 * working while everyone else is deduped. The EXACT address is still unique
 * for everyone (you never get the same alias twice), only the alias-flood cap
 * is lifted.
 */
import type { PrismaService } from "./src/modules/prisma/prisma.service";

// Providers whose "+tag" suffix is an alias of the same mailbox. Gmail also
// ignores dots in the local part.
const PLUS_ALIAS_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "fastmail.com", "protonmail.com", "proton.me",
]);
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// Known disposable / throwaway email domains. Not exhaustive - the highest-
// volume offenders. Kept in code; can be promoted to an editable list later.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com",
  "10minutemail.com", "temp-mail.org", "tempmail.com", "trashmail.com",
  "yopmail.com", "getnada.com", "dispostable.com", "maildrop.cc", "mailnesia.com",
  "throwawaymail.com", "fakeinbox.com", "tempinbox.com", "mohmal.com",
  "emailondeck.com", "mintemail.com", "spamgourmet.com", "mytemp.email",
  "moakt.com", "tmpmail.org", "tmpmail.net", "burnermail.io", "mailcatch.com",
  "inboxkitten.com", "1secmail.com", "1secmail.org", "1secmail.net", "grr.la",
]);

/** Lowercase, trim, and reduce to the canonical mailbox for dedup. */
export function normalizeEmail(raw: string): { canonical: string; domain: string } {
  const email = String(raw || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0) return { canonical: email, domain: "" };
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (PLUS_ALIAS_DOMAINS.has(domain)) {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
  }
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
  }
  // Fold the two gmail domains together so gmail.com and googlemail.com match.
  const canonicalDomain = GMAIL_DOMAINS.has(domain) ? "gmail.com" : domain;
  return { canonical: `${local}@${canonicalDomain}`, domain };
}

export function isDisposableDomain(email: string): boolean {
  const at = String(email || "").lastIndexOf("@");
  if (at < 0) return false;
  return DISPOSABLE_DOMAINS.has(email.slice(at + 1).trim().toLowerCase());
}

export interface EmailCheckResult {
  ok: boolean;
  reason?: "disposable_email" | "email_alias_exists";
  canonical: string;
}

/**
 * Decide whether this email may register. Returns the canonical to STORE on the
 * new user (so future dedup is a single indexed lookup). Never throws.
 */
export async function checkEmailForSignup(prisma: PrismaService, rawEmail: string): Promise<EmailCheckResult> {
  const { canonical } = normalizeEmail(rawEmail);

  if (isDisposableDomain(rawEmail)) {
    return { ok: false, reason: "disposable_email", canonical };
  }

  // Allowlisted canonical: skip the alias-flood dedup entirely.
  const allowed = await prisma.securityEmailAllow.findUnique({ where: { canonicalEmail: canonical } }).catch(() => null);
  if (allowed) return { ok: true, canonical };

  // Anyone else: one account per canonical mailbox. Match either a stored
  // canonical (new rows) or the exact address (legacy rows without canonical).
  const clash = await prisma.user.findFirst({
    where: { OR: [{ emailCanonical: canonical }, { email: canonical }] },
    select: { id: true },
  });
  if (clash) return { ok: false, reason: "email_alias_exists", canonical };

  return { ok: true, canonical };
}
