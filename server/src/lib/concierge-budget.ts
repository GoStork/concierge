/**
 * Daily ceiling on AI concierge turns (OWASP A06 - business logic abuse).
 *
 * Every /chat turn fans out to Gemini, sometimes a Tier-2 model, plus tool
 * calls - real money per request. `gemini-usage.ts` METERS that spend, it does
 * not GATE it: one authenticated account could loop the endpoint and run up an
 * unbounded bill. This project has already had a $845 Gemini crash-loop, so
 * the failure mode is not hypothetical.
 *
 * Counted per FAMILY ACCOUNT, not per user: both parents on one account share
 * a conversation, so charging them one budget is the honest unit. Falls back
 * to the user id for accounts that have no parentAccountId yet.
 */
import { timingSafeEqual } from "node:crypto";

/** Generous for a real family, ruinous for a script. */
export const DEFAULT_DAILY_TURN_LIMIT = 200;

export function dailyTurnLimit(): number {
  const raw = parseInt(process.env.CONCIERGE_DAILY_TURN_LIMIT || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_DAILY_TURN_LIMIT;
}

/** Staff and provider accounts are exempt: they use the concierge to answer
 *  families and to test, and they are not the abuse vector this guards. */
const EXEMPT_ROLES = [
  "GOSTORK_ADMIN",
  "GOSTORK_CONCIERGE",
  "GOSTORK_DEVELOPER",
  "PROVIDER_ADMIN",
];

function isTestRunner(req: any): boolean {
  const token = process.env.TEST_RUNNER_TOKEN;
  if (!token) return false;
  const provided = req?.headers?.["x-test-runner-token"];
  if (typeof provided !== "string" || provided.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
  } catch {
    return false;
  }
}

function today(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface TurnBudgetResult {
  ok: boolean;
  used: number;
  limit: number;
  message?: string;
}

/**
 * Records one turn and says whether it may proceed. Counts first and compares
 * after, in a single atomic upsert, so two concurrent turns cannot both read
 * "199" and both pass.
 *
 * Fails OPEN on a database error: a counter outage must not take the product
 * down. The spend meter still records what was actually used, so an outage is
 * visible after the fact rather than silently uncapped forever.
 */
export async function consumeConciergeTurn(
  db: any,
  input: { userId: string; parentAccountId?: string | null; roles?: string[] | null; req?: any },
): Promise<TurnBudgetResult> {
  const limit = dailyTurnLimit();
  if (input.req && isTestRunner(input.req)) return { ok: true, used: 0, limit };
  if ((input.roles || []).some((r) => EXEMPT_ROLES.includes(r))) {
    return { ok: true, used: 0, limit };
  }

  const subjectKey = input.parentAccountId || input.userId;
  const day = today();
  try {
    const row = await db.conciergeTurnBudget.upsert({
      where: { subjectKey_day: { subjectKey, day } },
      create: { subjectKey, day, turns: 1 },
      update: { turns: { increment: 1 } },
      select: { turns: true },
    });
    const used = row.turns;
    if (used > limit) {
      // One line per crossing, not per blocked turn after it, so a looping
      // client cannot flood the log with its own rejections.
      if (used === limit + 1) {
        console.warn(`[concierge-budget] ${subjectKey} hit the daily limit of ${limit} turns`);
      }
      return {
        ok: false,
        used,
        limit,
        message:
          "You have reached today's limit for messages with your concierge. It resets tomorrow, " +
          "and your GoStork team can pick up anything urgent in the meantime.",
      };
    }
    return { ok: true, used, limit };
  } catch (e: any) {
    console.error(`[concierge-budget] counter unavailable, allowing turn: ${e?.message}`);
    return { ok: true, used: 0, limit };
  }
}
