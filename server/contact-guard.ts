/**
 * Server-side plumbing for the contact guard.
 *
 * The rules live in shared/contact-guard.ts so the client runs exactly the same
 * ones. This file is only the Express/Nest wiring: one response shape, one log
 * line, so every blocked send looks identical to both clients regardless of
 * which of the six enforcement sites rejected it.
 *
 * Deliberately NOT middleware and NOT a Prisma extension. There are ~120
 * `aiChatMessage.create` calls and most of them are system cards that
 * legitimately carry the PROVIDER's own email and phone (booking
 * confirmations, invoice contacts, prep docs). Only human-authored text
 * destined for the other party is guarded - see the call sites listed below.
 *
 * Guarded:
 *   chat-router.ts  parent -> provider direct message
 *   chat-router.ts  provider -> parent (covers the direct message, the
 *                   persisted whisper answerText, and the Eva relay in one)
 *   ai-router.ts    parent message on a SHARED thread (never the private Eva
 *                   thread - Eva legitimately collects the parent's own email
 *                   and phone during intake)
 *   ai-router.ts    the outbound whisper questionText
 *   auto-reply.*    the provider's stored auto-reply body
 */

import { HttpException } from "@nestjs/common";
import { detectContactInfo, contactGuardMessage, CONTACT_GUARD_CODE, type ContactScanResult, ContactGuardSurface } from "../shared/contact-guard";

export { CONTACT_GUARD_CODE };
export type { ContactScanResult };

/** 422, so it is distinguishable from the existing "Content is required" 400s. */
export const CONTACT_GUARD_STATUS = 422;

export interface ContactBlockedBody {
  code: typeof CONTACT_GUARD_CODE;
  /** `message` is the key name deliberately: both clients already read err.message. */
  message: string;
  kinds: string[];
  spans: [number, number][];
}

/**
 * The body both clients render. `findings` is deliberately NOT included -
 * echoing the matched text back would hand a determined sender a normalization
 * oracle to tune obfuscations against.
 */
export function contactBlockedBody(
  scan: ContactScanResult,
  surface: ContactGuardSurface = "chat",
): ContactBlockedBody {
  return {
    code: CONTACT_GUARD_CODE,
    message: contactGuardMessage(scan.kinds, surface),
    kinds: scan.kinds,
    spans: scan.spans,
  };
}

/** Structured log line. Records WHAT rule fired and where, never the full message. */
export function logContactBlock(where: string, scan: ContactScanResult, meta: Record<string, unknown> = {}): void {
  console.warn(
    `[contact-guard] blocked at ${where}`,
    JSON.stringify({
      kinds: scan.kinds,
      rules: scan.findings.map((f) => f.rule),
      samples: scan.findings.map((f) => f.sample.slice(0, 40)),
      ...meta,
    }),
  );
}

/**
 * Express guard. Returns true when it has already sent the 422 response, so
 * call sites read:
 *
 *   if (blockContactInfo(res, content, "provider.message", { sessionId })) return;
 */
export function blockContactInfo(
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  text: string | null | undefined,
  where: string,
  meta: Record<string, unknown> = {},
  surface: ContactGuardSurface = "chat",
): boolean {
  const scan = detectContactInfo(text || "");
  if (!scan.blocked) return false;
  logContactBlock(where, scan, meta);
  res.status(CONTACT_GUARD_STATUS).json(contactBlockedBody(scan, surface));
  return true;
}

/**
 * Nest variant. Throws an HttpException carrying the same body shape as the
 * Express guard, so a client cannot tell which framework rejected it.
 *
 * HttpException is imported at the top, NOT lazily. A `require()` here looked
 * like a way to keep Nest out of the Express-only routers, but the server runs
 * as ESM: `require` is not defined, so every Nest-side guard threw a
 * ReferenceError and the caller got a generic 500 instead of the friendly 422.
 * The guard still detected and still refused - it just could not explain itself.
 * A static import costs nothing; @nestjs/common is already in the graph.
 */
export function assertNoContactInfo(
  text: string | null | undefined,
  where: string,
  meta: Record<string, unknown> = {},
): void {
  const scan = detectContactInfo(text || "");
  if (!scan.blocked) return;
  logContactBlock(where, scan, meta);
  throw new HttpException(contactBlockedBody(scan) as any, CONTACT_GUARD_STATUS);
}

/**
 * Non-throwing variant for paths that must not 4xx.
 *
 * Used by the whisper egress (Eva decided to whisper, the parent cannot see or
 * control that, so punishing them for a routing decision is unexplainable) and
 * by the auto-reply sender, whose contract is that it never throws.
 */
export function scanForContactInfo(text: string | null | undefined): ContactScanResult {
  return detectContactInfo(text || "");
}

/**
 * Does this message travel to the other party, or is it the parent talking to
 * Eva alone?
 *
 * THE TRAP (see server/parent-visibility.ts): a whisper stamps `providerId`
 * onto the parent's PRIVATE Eva session, so `providerId != null` does NOT mean
 * the thread is shared. Keying on it would block the parent from giving Eva
 * their own email during intake, which is a normal, required step.
 *
 * `status` and `providerJoinedAt` are the reliable discriminators - the same
 * pair the router already uses to decide whether to notify provider users.
 */
export function isSharedWithProvider(session: {
  status?: string | null;
  providerJoinedAt?: Date | null;
} | null | undefined): boolean {
  if (!session) return false;
  return (
    session.providerJoinedAt != null ||
    session.status === "PROVIDER_CONNECTED" ||
    session.status === "CONSULTATION_BOOKED"
  );
}
