/**
 * Gate A: the identity gate must be fed RAW chat-session statuses.
 *
 * The parents table derives a journey ladder (HANDED_OFF, AGREEMENT_SIGNED,
 * DEPOSIT_PAID, MATCHED, MATCH_CALL) on top of AiChatSession.status. Feeding
 * that derived value into resolveParentGates closes Gate A on the most
 * advanced parents in the table, because none of those promoted strings are in
 * IDENTITY_STATUSES - and the parents table then DROPS the row entirely.
 *
 * Most rungs are rescued by accident (an invoice or agreement implies a release
 * row; a MATCH_CALL implies a booking). MATCHED is not: an agency sets
 * Surrogate.status itself. This pins the difference so the fix cannot silently
 * regress. No fixtures needed - the resolver is pure apart from one lookup, and
 * a provider id of null forces the "no release" branch.
 *
 * Run: npx tsx scripts/test-parent-gate-a.ts
 */
import "dotenv/config";
import { resolveParentGatesBatch } from "../server/parent-privacy";

const fails: string[] = [];
const ck = (n: string, ok: boolean) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}`);
  if (!ok) fails.push(n);
};

(async () => {
  const KEY = "gate-a-probe-account";
  const PROVIDER = "gate-a-probe-provider"; // no release rows exist for this id

  // What the buggy code did: hand the resolver the DERIVED ladder value.
  const derived = await resolveParentGatesBatch(PROVIDER, [
    { accountKey: KEY, sessionStatus: "MATCHED", hasBooking: false },
  ]);
  // What the fix does: hand it the RAW session statuses as siblings.
  const raw = await resolveParentGatesBatch(PROVIDER, [
    { accountKey: KEY, sessionStatus: null, siblingStatuses: ["PROVIDER_CONNECTED"], hasBooking: false },
  ]);

  console.log("GATE A INPUTS");
  ck("derived 'MATCHED' does NOT open Gate A (this was the bug)",
    derived.get(KEY)?.showIdentity === false);
  ck("raw 'PROVIDER_CONNECTED' DOES open Gate A (this is the fix)",
    raw.get(KEY)?.showIdentity === true);
  ck("neither opens Gate B without a release row",
    derived.get(KEY)?.showContact === false && raw.get(KEY)?.showContact === false);

  // The accidental rescues, so nobody 'simplifies' the fix away later.
  const booked = await resolveParentGatesBatch(PROVIDER, [
    { accountKey: KEY, sessionStatus: null, siblingStatuses: ["ACTIVE"], hasBooking: true },
  ]);
  ck("a booking alone opens Gate A (the MATCH_CALL rescue)",
    booked.get(KEY)?.showIdentity === true);

  const activeOnly = await resolveParentGatesBatch(PROVIDER, [
    { accountKey: KEY, sessionStatus: null, siblingStatuses: ["ACTIVE"], hasBooking: false },
  ]);
  ck("an ACTIVE-only anonymous thread stays closed",
    activeOnly.get(KEY)?.showIdentity === false);

  // Gate A is PAIR-scoped: one booked thread must unmask the whole account.
  const mixed = await resolveParentGatesBatch(PROVIDER, [
    { accountKey: KEY, sessionStatus: null, siblingStatuses: ["ACTIVE", "CONSULTATION_BOOKED"], hasBooking: false },
  ]);
  ck("one booked sibling opens the account, not just that thread",
    mixed.get(KEY)?.showIdentity === true);

  console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("THREW:", e); process.exit(1); });
