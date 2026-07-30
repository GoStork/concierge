/**
 * GoStork - Unit guards for recovery paths (UT-xx)
 *
 * The other suites drive the product end to end. This one covers the pure
 * logic that only runs when something has ALREADY gone wrong:
 *
 *   - match-card tag recovery (bare id / malformed JSON / truncated results)
 *   - which session counts as the parent's private Eva chat
 *   - which duplicate photo survives de-duplication (a wrong drop is silent)
 *
 * Both were silent-failure bugs. Recovery code that is only exercised
 * incidentally is exactly the code whose regression looks like "flake" for
 * months, so it gets direct tests with no server and no database.
 *
 * Usage:
 *   npx tsx scripts/test-unit-guards.ts
 *   npx tsx scripts/test-unit-guards.ts --id=UT-03
 */

import { isUsableCardId, parseFirstJsonArray, parseMatchCardTag, topResultId } from "../server/match-card-parse";
import { resolveParentEvaSessionId } from "../server/parent-visibility";
import { AUTO_REPLY_STARTERS, AUTO_REPLY_TOKENS, autoReplyStartersFor, bodyPromisesAttachment, renderAutoReplyBody } from "../shared/auto-reply-starters";
import { detectContactInfo } from "../shared/contact-guard";
import { MUST_BLOCK, MUST_NOT_BLOCK } from "../shared/contact-guard-corpus";
import { planDedupe, thumbCorrelation, worstBlockDeviation, DEDUP_CORRELATION, DEDUP_MAX_BLOCK_DEVIATION, type Fingerprint } from "../server/src/modules/providers/photo-dedup";

const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";
const filterId = process.argv.slice(2).find((a) => a.startsWith("--id="))?.split("=")[1];

let caseFails: string[] = [];
let totalPass = 0;
let totalFail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`      ${ok ? "✓" : "✗"} ${label}${detail ? ` :: ${String(detail).replace(/\n/g, " | ").slice(0, 180)}` : ""}`);
  if (!ok) caseFails.push(`${label}${detail ? ` :: ${String(detail).slice(0, 160)}` : ""}`);
}

async function reportToDashboard(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${BASE}/api/admin/test-runner/event`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
    });
  } catch { /* best-effort */ }
}

const UUID_A = "30a45389-77cd-4188-b7c7-637444576d0e";
const UUID_B = "6e7bc4e1-bbe3-4424-a9e3-34a868a198ca";

/** A realistic MCP tool-result body: prose, then the array, then a trailing note. */
function toolBody(rows: any[], note = true): string {
  return `Found ${rows.length} surrogates:\n${JSON.stringify(rows, null, 2)}\n\n` +
    (note ? `IMPORTANT: Use the "id" field as "providerId" and set type to "Surrogate" in your MATCH_CARDs. If unmatchedCriteria is non-empty, tell the parent [see above] before showing the MATCH_CARD.` : "");
}

// ─── UT-01: the documented bare-id form is accepted ──────────────────────────
async function ut01() {
  const tag = parseMatchCardTag(UUID_A);
  check("a bare uuid is recognised as the bare-id form", tag.kind === "bare", tag.kind);
  check("the id is preserved", tag.kind === "bare" && tag.id === UUID_A, JSON.stringify(tag));
  // The model sometimes quotes it.
  const quoted = parseMatchCardTag(`"${UUID_A}"`);
  check("a quoted bare id is still recognised", quoted.kind === "bare", quoted.kind);
  const spaced = parseMatchCardTag(`  ${UUID_A}  `);
  check("surrounding whitespace does not break it", spaced.kind === "bare", spaced.kind);
}

// ─── UT-02: well-formed JSON still parses as before ──────────────────────────
async function ut02() {
  const raw = JSON.stringify({ name: "Surrogate #19331", type: "Surrogate", location: "Utah", reasons: ["Open to twins"], providerId: UUID_A });
  const tag = parseMatchCardTag(raw);
  check("well-formed JSON is parsed as json", tag.kind === "json", tag.kind);
  check("fields survive intact", tag.kind === "json" && tag.card.providerId === UUID_A && tag.card.type === "Surrogate",
    JSON.stringify(tag.kind === "json" ? tag.card : tag));
}

// ─── UT-03: malformed JSON is salvaged, not discarded ────────────────────────
async function ut03() {
  // Trailing comma + an unescaped inner quote - both throw in JSON.parse.
  const raw = `{"name":"Donor #402 "The runner"","type":"Egg Donor","providerId":"${UUID_B}",}`;
  const tag = parseMatchCardTag(raw);
  check("malformed JSON is salvaged rather than dropped", tag.kind === "salvage", tag.kind);
  check("salvage keeps the type", tag.kind === "salvage" && tag.card.type === "Egg Donor", JSON.stringify(tag));
  check("salvage keeps the providerId", tag.kind === "salvage" && tag.card.providerId === UUID_B, JSON.stringify(tag));
}

// ─── UT-04: unusable payloads are refused, not turned into broken cards ──────
// A card with a display number or a name as its providerId renders "Profile
// unavailable" for the parent - worse than no card, because the prose-based
// fallback can still rebuild a real one.
async function ut04() {
  // Classification and id-validation are separate jobs: well-formed JSON is
  // still "json" even when its providerId is junk, and isUsableCardId is what
  // stops the junk from becoming a "Profile unavailable" card for the parent.
  check("a display number is rejected as an id", !isUsableCardId("23069"));
  check("a name is rejected as an id", !isUsableCardId("Sarah"));
  check("an empty id is rejected", !isUsableCardId(""));
  check("a real uuid is accepted", isUsableCardId(UUID_A));
  check("a non-uuid slug id is still accepted (not every lane uses uuids)", isUsableCardId("cny-fertility-albany"));
  // Payloads with nothing recoverable at all.
  check("a bare non-uuid is not a bare-id card", parseMatchCardTag("Surrogate #19331").kind === "unusable");
  check("truncated JSON with no salvageable type is refused",
    parseMatchCardTag(`{"providerId":"${UUID_A}"`).kind === "unusable");
}

// ─── UT-05: tool bodies parse despite trailing prose and control chars ───────
async function ut05() {
  const rows = [{ id: UUID_A, displayName: "Surrogate #1" }, { id: UUID_B, displayName: "Surrogate #2" }];
  const arr = parseFirstJsonArray(toolBody(rows));
  check("the array is found despite a trailing note containing ']'", Array.isArray(arr) && arr.length === 2,
    `got ${arr ? arr.length : "null"}`);
  // Raw control characters inside a string field (seen in real MCP results).
  const dirty = `Found 1 surrogates:\n[{"id":"${UUID_A}","note":"line1line2"}]\n\nIMPORTANT: [see above]`;
  const arr2 = parseFirstJsonArray(dirty);
  check("control characters inside string fields do not break parsing", Array.isArray(arr2) && arr2.length === 1,
    `got ${arr2 ? arr2.length : "null"}`);
  check("no array at all returns null", parseFirstJsonArray("No surrogates found matching your criteria.") === null);
}

// ─── UT-06: a TRUNCATED result still yields the top id ───────────────────────
// Pre-search bodies are capped at 8000 chars, so the array is cut mid-object
// and never closes. This cost 12 of 13 recoverable cards in one measured run.
async function ut06() {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: i === 0 ? UUID_A : `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    displayName: `Surrogate #${i}`, bio: "x".repeat(300),
  }));
  const full = toolBody(rows);
  const truncated = full.slice(0, 8000) + "\n\n[Results truncated - present the first result above as a [[MATCH_CARD]] only]";
  check("the truncated body genuinely does not parse", parseFirstJsonArray(truncated) === null);
  const { id, rows: n } = topResultId(truncated);
  check("the top id is still salvaged from a truncated body", id === UUID_A, `${id} (rows=${n})`);
  check("rows reports -1 so the caller can tell truncation from empty", n === -1, String(n));
}

// ─── UT-07: zero results are reported as zero, not as an error ───────────────
// "No card" is CORRECT when the search found nothing; it must be
// distinguishable from a parse failure or the diagnosis goes wrong.
async function ut07() {
  const { id, rows } = topResultId(toolBody([]));
  check("an empty result set reports rows=0", rows === 0, String(rows));
  check("and yields no id", id === "", id);
  const good = topResultId(toolBody([{ id: UUID_B, displayName: "Surrogate #7" }]));
  check("a normal result yields the top id", good.id === UUID_B && good.rows === 1, JSON.stringify(good));
}

// ─── UT-08: the parent's private Eva session is resolved correctly ───────────
// The bug: review_prompt / ip_form_prompt required matchmakerId and dropped the
// post entirely when it was null. The privacy property: a thread the provider
// has joined must NEVER be selected, or a parent-only card lands in front of
// the provider.
async function ut08() {
  const queries: any[] = [];
  const fakeClient = (results: (string | null)[]) => ({
    aiChatSession: {
      findFirst: async (q: any) => {
        queries.push(q.where);
        const id = results[queries.length - 1];
        return id ? { id } : null;
      },
    },
  });

  queries.length = 0;
  const preferred = await resolveParentEvaSessionId(["u1"], fakeClient(["eva-with-matchmaker"]));
  check("the canonical matchmaker session is preferred", preferred === "eva-with-matchmaker", String(preferred));
  check("only one query is needed when it exists", queries.length === 1, String(queries.length));
  check("the preferred query requires a matchmaker", queries[0]?.matchmakerId?.not === null, JSON.stringify(queries[0]));

  queries.length = 0;
  const fellBack = await resolveParentEvaSessionId(["u1"], fakeClient([null, "eva-without-matchmaker"]));
  check("a session with a NULL matchmakerId is still found (the dropped-prompt bug)",
    fellBack === "eva-without-matchmaker", String(fellBack));
  check("the fallback query drops the matchmaker requirement",
    queries[1] && queries[1].matchmakerId === undefined, JSON.stringify(queries[1]));

  // Privacy: neither query may ever match a thread the provider has joined.
  for (const [i, q] of queries.entries()) {
    check(`query ${i + 1} excludes provider-joined threads`, q.providerJoinedAt === null, JSON.stringify(q));
    check(`query ${i + 1} is limited to ACTIVE parent sessions`,
      q.status === "ACTIVE" && q.sessionType === "PARENT", JSON.stringify(q));
  }

  queries.length = 0;
  const none = await resolveParentEvaSessionId([], fakeClient([]));
  check("no account members resolves to null without querying", none === null && queries.length === 0);
}

// ─── UT-09: photo de-dup keeps the larger copy and never guesses ─────────────
// Dropping a photo is destructive and invisible (nobody notices a picture that
// was never rendered), so the planner's safety properties are pinned here: a
// photo with no thumbnail is always kept, and when two files ARE the same
// picture the survivor is the biggest one, in the earliest slot.
//
// The thumbnails below are synthetic but the thresholds are not: on real
// profiles a re-encoded copy correlates at 0.995+ and different photos of the
// same person in the same session peak at 0.812.
async function ut09() {
  // A 32x32 greyscale thumbnail as the planner sees it, from a pixel function.
  const thumb = (f: (x: number, y: number) => number): string => {
    const b = Buffer.alloc(32 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) b[y * 32 + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
    return b.toString("base64");
  };
  const gradient = thumb((x, y) => x * 6 + y * 2);
  // Same picture, re-compressed: same structure, small per-pixel noise and a
  // brightness shift (which the normalisation is supposed to absorb).
  const reencoded = thumb((x, y) => x * 6 + y * 2 + 12 + ((x * 7 + y * 13) % 5));
  const different = thumb((x, y) => (x < 16 ? 40 : 200) + ((y * 11) % 7));
  // Two frames of one moment: identical except for one corner (a raised hand).
  // Overall correlation stays high, so only the per-block test can refuse it.
  const movedSubject = thumb((x, y) => (x >= 24 && y >= 24 ? 250 : x * 6 + y * 2));

  const fp = (url: string, t: string | null, w: number, h: number): [string, Fingerprint] =>
    [url, { url, phash: null, thumb: t, width: w, height: h, bytes: w * h, failed: !t }];
  const map = new Map<string, Fingerprint>([
    fp("small.jpg", reencoded, 768, 512),
    fp("large.jpg", gradient, 1500, 1000),
    fp("different.jpg", different, 900, 900),
    fp("unreadable.jpg", null, 0, 0),
    fp("moved.jpg", movedSubject, 1500, 1000),
  ]);

  check("a re-encoded copy scores above the threshold", thumbCorrelation(gradient, reencoded) >= DEDUP_CORRELATION,
    thumbCorrelation(gradient, reencoded).toFixed(3));
  check("a different picture scores below it", thumbCorrelation(gradient, different) < DEDUP_CORRELATION,
    thumbCorrelation(gradient, different).toFixed(3));

  check("a moved subject still correlates highly overall", thumbCorrelation(gradient, movedSubject) >= DEDUP_CORRELATION,
    thumbCorrelation(gradient, movedSubject).toFixed(3));
  check("but its worst block gives it away", worstBlockDeviation(gradient, movedSubject) > DEDUP_MAX_BLOCK_DEVIATION,
    worstBlockDeviation(gradient, movedSubject).toFixed(3));
  check("a true copy passes the block test", worstBlockDeviation(gradient, reencoded) <= DEDUP_MAX_BLOCK_DEVIATION,
    worstBlockDeviation(gradient, reencoded).toFixed(3));
  check("two frames of one moment are NOT merged",
    planDedupe(["large.jpg", "moved.jpg"], map).keep.length === 2);

  const plan = planDedupe(["small.jpg", "large.jpg", "different.jpg"], map);
  check("the same picture at two sizes collapses to one", plan.keep.length === 2, plan.keep.join(","));
  check("the survivor is the larger file", plan.keep.includes("large.jpg") && !plan.keep.includes("small.jpg"),
    plan.keep.join(","));
  check("it takes the earlier slot, so the gallery order is unchanged", plan.keep[0] === "large.jpg", plan.keep.join(","));
  check("a genuinely different photo is untouched", plan.keep.includes("different.jpg"));
  check("the dropped copy points at the one we kept", plan.replacements.get("small.jpg") === "large.jpg",
    JSON.stringify(Array.from(plan.replacements.entries())));

  // A photo we could not fingerprint must never be dropped - we cannot prove it
  // is a copy, and a wrong drop deletes a real photo from someone's profile.
  const withUnknown = planDedupe(["large.jpg", "unreadable.jpg", "small.jpg"], map);
  check("a photo we could not fingerprint is kept", withUnknown.keep.includes("unreadable.jpg"), withUnknown.keep.join(","));
  check("the unknown photo does not stop the real duplicate being dropped", withUnknown.keep.length === 2,
    withUnknown.keep.join(","));

  // Exact repeats of one URL collapse without needing any fingerprint at all.
  const repeated = planDedupe(["a.jpg", "a.jpg", "b.jpg"], new Map());
  check("a repeated URL is counted once", repeated.keep.length === 2 && repeated.exactRepeats === 1,
    `${repeated.keep.join(",")} repeats=${repeated.exactRepeats}`);
}

// ─── UT-10: the auto-reply starter copy stays in sync with its tokens ───────
// The starters are REAL default text a provider can save unedited, and they
// double as the documentation for which tokens exist. Two silent failures to
// guard: copy that drops a token (the provider never discovers it), and a
// profile paragraph that survives a booking with no specific donor - which
// would ship "I can see you're interested in {{profile_ref}}" to a parent.
async function ut10() {
  const CORE = AUTO_REPLY_TOKENS.filter((t) => !(t as any).profileOnly).map((t) => t.token);
  const FULL_VARS = {
    parentName: "Alex", providerName: "Bright Futures", staffName: "Dana",
    profileRef: "Egg Donor #4821", profileLink: "https://example.test/eggdonor/p/d",
    callTime: "Friday, August 1 at 9:30 AM EDT",
  };

  // Every service line a provider can pick, plus the neutral default.
  const SERVICES = [null, "Egg Donor Agency", "Egg Bank", "Surrogacy Agency", "Sperm Bank", "IVF Clinic", "Legal Services"];

  for (const svc of SERVICES) {
    const label = svc || "(neutral)";
    for (const starter of autoReplyStartersFor(svc)) {
      const missing = CORE.filter((tok) => !starter.body.includes(tok));
      check(`${label} / ${starter.key}: uses every core token`, missing.length === 0, missing.join(", "));

      const rendered = renderAutoReplyBody(starter.body, FULL_VARS);
      check(`${label} / ${starter.key}: renders with nothing unsubstituted`, !/\{\{|\}\}/.test(rendered), rendered.slice(0, 100));

      check(`${label} / ${starter.key}: declares its attachment intent correctly`,
        bodyPromisesAttachment(starter.body) === starter.expectsAttachment);

      // THE guard: with no specific profile, the reference paragraph must be
      // gone entirely - not blank, not half a sentence, not a raw token.
      const noProfile = renderAutoReplyBody(starter.body, { ...FULL_VARS, profileRef: null, profileLink: null });
      check(`${label} / ${starter.key}: no-profile render drops the reference cleanly`,
        !/\{\{|interested in\s*$|interested in\s*\n|review (her|him) here/i.test(noProfile) && noProfile.length > 0,
        noProfile.slice(0, 120));
      check(`${label} / ${starter.key}: still greets the parent without a profile`,
        noProfile.includes("Alex") && noProfile.includes("Bright Futures"));
      check(`${label} / ${starter.key}: no blank paragraph is left behind`,
        !/\n\s*\n\s*\n/.test(noProfile), JSON.stringify(noProfile.slice(0, 80)));
    }
  }

  // Donor/surrogate services must actually reference the profile - that is the
  // whole point of tailoring them.
  for (const svc of ["Egg Donor Agency", "Surrogacy Agency", "Sperm Bank", "Egg Bank"]) {
    const body = autoReplyStartersFor(svc)[0].body;
    check(`${svc}: references the specific profile`, body.includes("{{profile_ref}}") && body.includes("{{profile_link}}"));
  }
  // ...and services with no profile concept must NOT pretend to have one.
  for (const svc of ["IVF Clinic", "Legal Services", null]) {
    const body = autoReplyStartersFor(svc)[0].body;
    check(`${svc || "(neutral)"}: does not reference a profile it never has`,
      !body.includes("{{profile_ref}}"));
  }

  check("the default starter promises no file it cannot deliver", !AUTO_REPLY_STARTERS[0].expectsAttachment);
}

// ─── UT-11: the contact guard blocks contact details and nothing else ───────
// The false-positive half is the acceptance bar. This is a fertility platform:
// "$145,000", "AMH 1.2", "donor #1234" and "born 03/14/1994" are ordinary
// sentences, and a blocked cost discussion is worse than a missed phone number
// because the parent cannot work around it and cannot tell why.
async function ut11() {
  for (const c of MUST_BLOCK) {
    const r = detectContactInfo(c.text);
    check(`blocks (${c.why}): ${c.text.slice(0, 52)}`, r.blocked && r.kinds.includes(c.kind),
      r.blocked ? `got kinds=${r.kinds.join(",")} want ${c.kind}` : "not blocked");
  }

  for (const c of MUST_NOT_BLOCK) {
    const r = detectContactInfo(c.text);
    check(`allows (${c.why}): ${c.text.slice(0, 52)}`, !r.blocked,
      r.blocked ? r.findings.map((f) => `${f.rule}="${f.sample}"`).join(" ") : undefined);
  }

  // Spans must point back into the ORIGINAL string. The normalizer rewrites
  // length as it folds, strips and collapses, so an index-map regression is
  // silent everywhere except here - and it would make the client highlight the
  // wrong half of the message.
  for (const c of MUST_BLOCK) {
    const r = detectContactInfo(c.text);
    if (!r.blocked) continue;
    const bad = r.spans.filter(([s, e]) => !(s >= 0 && e > s && e <= c.text.length && c.text.slice(s, e).trim().length > 0));
    check(`span maps back to the original text: ${c.text.slice(0, 40)}`, bad.length === 0, JSON.stringify(bad));
  }

  check("empty input is not blocked", !detectContactInfo("").blocked);
  check("whitespace-only input is not blocked", !detectContactInfo("   \n  ").blocked);
  check("a normal booked-call message is not blocked",
    !detectContactInfo("Thanks so much, Friday at 9:30 works. We have 3 embryos and our budget is around 145,000.").blocked);
}

// ─── UT-12: every obfuscation of one address and one number still blocks ────
// Each transform below defeats a different normalizer stage. Testing them
// against a single canonical value is what proves the pipeline composes rather
// than each rule happening to catch its own favorite spelling.
async function ut12() {
  const EMAILS = [
    "eran@gostork.com",
    "e r a n @ g o s t o r k . c o m",
    "eran (at) gostork dot com",
    "eran[at]gostork[dot]com",
    "eran{at}gostork{dot}com",
    "eran＠gostork.com",
    `er${"​"}an@gost${"​"}ork.com`,
    "ERAN (AT) GOSTORK (DOT) COM",
  ];
  for (const e of EMAILS) {
    const r = detectContactInfo(`you can reach me at ${e} any time`);
    check(`email obfuscation blocks: ${JSON.stringify(e)}`, r.blocked && r.kinds.includes("email"), r.kinds.join(","));
  }

  const PHONES = [
    "917-224-7761", "917.224.7761", "(917) 224-7761", "+1 917 224 7761",
    "9172247761", "9 1 7 2 2 4 7 7 6 1", "1-917-224-7761", "+1(917)224.7761",
  ];
  for (const p of PHONES) {
    const r = detectContactInfo(`here is my cell ${p}`);
    check(`phone obfuscation blocks: ${JSON.stringify(p)}`, r.blocked && r.kinds.includes("phone"), r.kinds.join(","));
  }
}

// ─── Consultation focus lock fixtures ───────────────────────────────────────
// The lock is DERIVED on every read, so a fake Prisma client is enough to pin
// every rule with no server and no database. Getting these wrong is silent in
// the worst direction: a wrong lock is a dead end the parent cannot see.
const DAY = 24 * 60 * 60 * 1000;

function lockClient(opts: {
  members?: string[];
  bookings?: any[];
  sessions?: any[];
  events?: any[];
  matchCalls?: any[];
  services?: Record<string, string[]>;
  partners?: Record<string, string[]>;
}) {
  const members = opts.members ?? ["u1"];
  const bookingCalls: any[] = [];
  return {
    bookingCalls,
    client: {
      user: {
        findUnique: async () => ({ parentAccountId: "acct1" }),
        findMany: async () => members.map((id) => ({ id })),
      },
      booking: {
        findMany: async (q: any) => {
          bookingCalls.push(q.where);
          return q.where?.meetingSubtype === "MATCH_CALL" ? (opts.matchCalls ?? []) : (opts.bookings ?? []);
        },
        findFirst: async () => null,
      },
      aiChatSession: { findMany: async () => opts.sessions ?? [] },
      journeyEvent: { findMany: async () => opts.events ?? [] },
      providerService: {
        findMany: async (q: any) =>
          (opts.services?.[q.where.providerId] ?? []).map((name) => ({ providerType: { name } })),
      },
      provider: {
        findMany: async (q: any) =>
          (q.where.id.in as string[]).map((id) => ({ id, partnerProviderIds: opts.partners?.[id] ?? [] })),
        findUnique: async () => null,
      },
    },
  };
}

/** One live consultation booking, `daysAgo` in the past (negative = future). */
function consult(over: Partial<any> = {}) {
  return {
    id: "b1",
    sessionId: "s1",
    scheduledAt: new Date(Date.now() + 2 * DAY),
    status: "PENDING",
    createdAt: new Date(Date.now() - DAY),
    outcome: null,
    providerUser: { provider: { id: "pAgency", name: "Agency A", services: [{ providerType: { name: "Surrogacy Agency" } }] } },
    ...over,
  };
}

// ─── UT-13: the focus lock's release rules and account scoping ───────────────
async function ut13() {
  const { evaluateConsultationLock, listOpenConsultations } = await import("../server/consultation-gates");

  const base = {
    bookings: [consult()],
    sessions: [{ id: "s1", subjectType: "Surrogate", title: "Surrogate #1", handoffCompletedAt: null }],
    services: { pAgency: ["Surrogacy Agency"], pOther: ["Surrogacy Agency"], pDonor: ["Egg Donor Agency"] },
  };

  const blocked = await evaluateConsultationLock({
    parentUserId: "u1", targetProviderId: "pOther", subjectType: "Surrogate",
    client: lockClient(base).client,
  });
  check("a second agency of the SAME type is blocked", !blocked.allowed && blocked.code === "CONSULTATION_ALREADY_OPEN", JSON.stringify(blocked.code));
  check("the blocker names the provider they already have", blocked.blocker?.providerId === "pAgency", String(blocked.blocker?.providerId));

  const otherType = await evaluateConsultationLock({
    parentUserId: "u1", targetProviderId: "pDonor", subjectType: "Egg Donor",
    client: lockClient(base).client,
  });
  check("a DIFFERENT provider type is untouched (types are independent)", otherType.allowed, JSON.stringify(otherType.code));

  const self = await evaluateConsultationLock({
    parentUserId: "u1", targetProviderId: "pAgency", subjectType: "Surrogate",
    client: lockClient(base).client,
  });
  check("a provider never blocks itself", self.allowed, JSON.stringify(self.code));

  // Account expansion: the booking belongs to the PARTNER, not the caller.
  const partnerHeld = lockClient({ ...base, members: ["u1", "u2"], bookings: [consult({ id: "b2" })] });
  const cross = await evaluateConsultationLock({
    parentUserId: "u1", targetProviderId: "pOther", subjectType: "Surrogate", client: partnerHeld.client,
  });
  check("a call booked by the partner still locks (parentAccountId expansion)", !cross.allowed, JSON.stringify(cross.code));
  const bookingWhere = partnerHeld.bookingCalls[0];
  check("the booking query spans every account member",
    Array.isArray(bookingWhere?.parentUserId?.in) && bookingWhere.parentUserId.in.length === 2,
    JSON.stringify(bookingWhere?.parentUserId));

  // THE PRISMA NULL TRAP: `outcome: { notIn: [...] }` silently drops NULL rows,
  // and an un-swept booking has outcome: null - exactly the one that must lock.
  check("the outcome filter spells out NULL rather than relying on notIn",
    Array.isArray(bookingWhere?.OR) && bookingWhere.OR.some((o: any) => o.outcome === null),
    JSON.stringify(bookingWhere?.OR));

  // Each release condition, one at a time.
  const releases: Array<[string, any, string]> = [
    ["a no-show releases it", { bookings: [] }, "TERMINAL_OUTCOME"],
    ["provider not-a-fit releases it", { events: [{ providerId: "pAgency", eventType: "CONSULTATION_NOT_A_FIT", createdAt: new Date(), metadata: {} }] }, "NOT_A_FIT"],
    ["parent moving on releases it", { events: [{ providerId: "pAgency", eventType: "CONSULTATION_LOCK_RELEASED", createdAt: new Date(), metadata: { reason: "PARENT_MOVED_ON" } }] }, "PARENT_MOVED_ON"],
    ["an admin override releases it", { events: [{ providerId: "pAgency", eventType: "CONSULTATION_LOCK_RELEASED", createdAt: new Date(), metadata: { reason: "ADMIN" } }] }, "ADMIN_OVERRIDE"],
    ["7 days with no match call releases it", { bookings: [consult({ scheduledAt: new Date(Date.now() - 8 * DAY) })] }, "STALE_WINDOW"],
  ];
  for (const [label, over, _expected] of releases) {
    const r = await evaluateConsultationLock({
      parentUserId: "u1", targetProviderId: "pOther", subjectType: "Surrogate",
      client: lockClient({ ...base, ...over }).client,
    });
    check(label, r.allowed, JSON.stringify(r.code));
  }

  // ...but a stale call WITH a live match call still locks - that track is alive.
  const staleButMatched = await evaluateConsultationLock({
    parentUserId: "u1", targetProviderId: "pOther", subjectType: "Surrogate",
    client: lockClient({
      ...base,
      bookings: [consult({ scheduledAt: new Date(Date.now() - 8 * DAY) })],
      matchCalls: [{ providerUser: { providerId: "pAgency" } }],
    }).client,
  });
  check("a stale call with a scheduled match call still locks", !staleButMatched.allowed, JSON.stringify(staleButMatched.code));

  // A release event OLDER than the booking must not release it - otherwise
  // last month's "not a fit" would unlock a call booked today.
  const oldEvent = await evaluateConsultationLock({
    parentUserId: "u1", targetProviderId: "pOther", subjectType: "Surrogate",
    client: lockClient({
      ...base,
      events: [{ providerId: "pAgency", eventType: "CONSULTATION_NOT_A_FIT", createdAt: new Date(Date.now() - 10 * DAY), metadata: {} }],
    }).client,
  });
  check("a release event older than the booking does NOT release it", !oldEvent.allowed, JSON.stringify(oldEvent.code));

  // A handed-off journey is finished business and never locks.
  const handedOff = await listOpenConsultations(["u1"], lockClient({
    ...base,
    sessions: [{ id: "s1", subjectType: "Surrogate", title: "Surrogate #1", handoffCompletedAt: new Date() }],
  }).client);
  check("a handed-off journey never locks", handedOff.length === 0, String(handedOff.length));

  // International programs: two legs of one decision never block each other.
  const partner = await evaluateConsultationLock({
    parentUserId: "u1", targetProviderId: "pOther", subjectType: "Surrogate",
    client: lockClient({ ...base, partners: { pAgency: ["pOther"] } }).client,
  });
  check("a partner clinic in the same program is not blocked", partner.allowed, JSON.stringify(partner.code));
}

// ─── UT-14: which service line a provider is locked on ───────────────────────
// A wrong answer here locks a lane the family never entered, so the ambiguous
// case MUST fail open rather than guess.
async function ut14() {
  const { resolveLockProviderType, providerTypeFromSubject } = await import("../server/provider-type-resolve");
  const svc = (names: string[]) => ({
    providerService: { findMany: async () => names.map((name) => ({ providerType: { name } })) },
  });

  const multi = ["IVF Clinic", "Surrogacy Agency", "Egg Donor Agency"];
  check("subjectType wins over the org's other service lines",
    (await resolveLockProviderType("p", "Surrogate", svc(multi))) === "Surrogacy Agency");
  check("an egg-donor subject resolves to the donor line",
    (await resolveLockProviderType("p", "Egg Donor", svc(multi))) === "Egg Donor Agency");
  check("a single approved service resolves with no subject at all",
    (await resolveLockProviderType("p", null, svc(["Surrogacy Agency"]))) === "Surrogacy Agency");
  check("AMBIGUOUS multi-service org returns null so the caller ALLOWS",
    (await resolveLockProviderType("p", null, svc(multi))) === null);
  check("an org with no approved services returns null",
    (await resolveLockProviderType("p", "Surrogate", svc([]))) === null);

  check("egg bank beats the generic egg/donor rule", providerTypeFromSubject("Egg Bank donor") === "Egg Bank");
  check("sperm is matched before egg/donor", providerTypeFromSubject("Sperm Donor") === "Sperm Bank");
  check("legal maps to Legal Services", providerTypeFromSubject("legal") === "Legal Services");
  check("an unrecognised subject is null, never a guess", providerTypeFromSubject("something else") === null);
}

// ─── UT-15: the match-call gates fire in a fixed order ───────────────────────
async function ut15() {
  const { evaluateMatchCallGates, resolveDepositSnapshot } = await import("../server/consultation-gates");

  const gateClient = (o: {
    ipStatus?: string; couple?: boolean; acks?: string[];
    quoteSchedule?: any; sheets?: any[];
  }) => ({
    user: {
      findUnique: async () => ({
        parentAccountId: "acct1",
        relationshipStatus: o.couple ? "Married" : "Single",
        partnerFirstName: o.couple ? "Sam" : null,
      }),
      findMany: async () => [{ id: "u1" }],
    },
    ipFormResponse: { findUnique: async () => ({ status: o.ipStatus ?? "SUBMITTED", hasSecondParent: false, hasSecondParentManual: false }) },
    intendedParentProfile: { findUnique: async () => ({ sameSexCouple: false }) },
    journeyEvent: {
      findMany: async (q: any) =>
        (o.acks ?? []).includes(q.where.eventType) ? [{ createdAt: new Date(), metadata: {} }] : [],
    },
    booking: { findFirst: async () => null, findMany: async () => [] },
    provider: { findUnique: async () => ({ depositMilestone: null }) },
    providerQuote: { findFirst: async () => (o.quoteSchedule ? { paymentSchedule: o.quoteSchedule } : null) },
    providerCostSheet: { findMany: async () => o.sheets ?? [] },
  });

  const noForm = await evaluateMatchCallGates({ parentUserId: "u1", providerId: "p", client: gateClient({ ipStatus: "DRAFT", couple: true }) as any });
  check("the IP form is refused first", noForm.code === "IP_FORM_REQUIRED", String(noForm.code));

  const noAttendance = await evaluateMatchCallGates({ parentUserId: "u1", providerId: "p", client: gateClient({ couple: true }) as any });
  check("both-parents comes second", noAttendance.code === "BOTH_PARENTS_ACK_REQUIRED", String(noAttendance.code));

  const noDecision = await evaluateMatchCallGates({
    parentUserId: "u1", providerId: "p",
    client: gateClient({ couple: true, acks: ["MATCH_CALL_ATTENDANCE_ACKNOWLEDGED"] }) as any,
  });
  check("the decision window comes third", noDecision.code === "MATCH_DECISION_ACK_REQUIRED", String(noDecision.code));

  const solo = await evaluateMatchCallGates({
    parentUserId: "u1", providerId: "p",
    client: gateClient({ couple: false, acks: ["MATCH_CALL_DECISION_ACKNOWLEDGED"] }) as any,
  });
  check("a genuinely single parent is not asked to promise a partner", solo.allowed, String(solo.code));
  check("...and both-parents is not listed as missing", !solo.missing.includes("BOTH_PARENTS"), solo.missing.join(","));

  // An ai_proposed schedule is provider-only. Showing it to a parent as a real
  // figure would be worse than showing no figure at all.
  const tranche = { triggerType: "AT_MATCH", name: "First Deposit", minValueCents: 800000, maxValueCents: 800000, payToLabel: "Escrow" };
  const unconfirmed = await resolveDepositSnapshot("p", ["u1"], gateClient({
    sheets: [{ scheduleSource: "ai_proposed", tranches: [tranche] }],
  }) as any);
  check("an ai_proposed schedule is REFUSED and falls back to no figure", unconfirmed.source === "NONE", unconfirmed.source);

  const confirmed = await resolveDepositSnapshot("p", ["u1"], gateClient({
    sheets: [{ scheduleSource: "provider_confirmed", tranches: [tranche] }],
  }) as any);
  check("a provider-confirmed schedule yields the real figure", confirmed.source === "COST_SHEET" && confirmed.minCents === 800000, JSON.stringify(confirmed));

  const quoted = await resolveDepositSnapshot("p", ["u1"], gateClient({
    quoteSchedule: { tranches: [{ ...tranche, minValueCents: 750000, maxValueCents: 750000 }] },
    sheets: [{ scheduleSource: "provider_confirmed", tranches: [tranche] }],
  }) as any);
  check("the family's OWN quote beats the provider's generic sheet", quoted.source === "QUOTE" && quoted.minCents === 750000, JSON.stringify(quoted));
}

// ─── UT-16: card registration stays in lockstep ──────────────────────────────
// A card the parent cannot see but the unread count still counts is a badge
// they can never clear - the exact failure parent-visibility.ts exists to stop.
async function ut16() {
  const { PARENT_VISIBLE_SYSTEM_CARDS, PARENT_PRIVATE_SYSTEM_CARDS } = await import("../server/parent-visibility");
  const { GATE_CARD_TYPE } = await import("../server/consultation-gates");

  for (const [gate, cardType] of Object.entries(GATE_CARD_TYPE)) {
    check(`${gate} card (${cardType}) is parent-visible`, PARENT_VISIBLE_SYSTEM_CARDS.includes(cardType), cardType);
  }
  check("the preliminary ack is parent-PRIVATE (it renders while the agency is masked)",
    PARENT_PRIVATE_SYSTEM_CARDS.includes("consult_preliminary_ack"));
  // The two match-call gates must NOT be private: the provider is the one
  // refused at propose-call-times and needs to see the blocker.
  check("the both-parents card stays visible to the provider",
    !PARENT_PRIVATE_SYSTEM_CARDS.includes("match_call_attendance_ack"));
  check("the decision-window card stays visible to the provider",
    !PARENT_PRIVATE_SYSTEM_CARDS.includes("match_call_decision_ack"));
}

// ─── UT-17: the whisper trap ─────────────────────────────────────────────────
// A whisper stamps providerId onto the parent's PRIVATE Eva session, so a bare
// providerId lookup reports "already connected" for every agency they ever
// whispered to - and would silently skip a consultation they actually need.
async function ut17() {
  const { findConnectedProviderSession, findSharedProviderSession } = await import("../server/parent-visibility");
  const queries: any[] = [];
  const client = (results: (any | null)[]) => ({
    aiChatSession: {
      findFirst: async (q: any) => {
        queries.push(q.where);
        return results[queries.length - 1] ?? null;
      },
    },
  });

  queries.length = 0;
  const whisperOnly = await findConnectedProviderSession(["u1"], "p", { client: client([null]) });
  check("a whisper-stamped Eva session is NOT treated as connected", whisperOnly === null, JSON.stringify(whisperOnly));
  check("the strict lookup runs exactly one query (no loose fallback)", queries.length === 1, String(queries.length));
  check("the strict query requires a joined provider or a shared status",
    Array.isArray(queries[0]?.OR) && queries[0].OR.length === 2, JSON.stringify(queries[0]?.OR));

  queries.length = 0;
  const real = await findConnectedProviderSession(["u1"], "p", { client: client([{ id: "shared", status: "PROVIDER_CONNECTED", providerJoinedAt: new Date(), subjectProfileId: "d1", subjectType: "Surrogate", title: "Surrogate #1" }]) });
  check("a real shared thread IS returned", real?.id === "shared", String(real?.id));

  queries.length = 0;
  await findConnectedProviderSession(["u1"], "p", { client: client([null]), excludeSessionId: "eva1" });
  check("the caller's own session is excluded from the strict query", queries[0]?.id?.not === "eva1", JSON.stringify(queries[0]?.id));

  // findSharedProviderSession keeps the loose fallback (it answers "where do I
  // post this?", not "are they connected?") but must try strict FIRST.
  queries.length = 0;
  const posted = await findSharedProviderSession(["u1"], "p", { client: client([null, { id: "loose" }]), excludeSessionId: "eva1" });
  check("the posting lookup falls back to a loose match", posted?.id === "loose", String(posted?.id));
  check("...only after trying the strict one first", queries.length === 2 && Array.isArray(queries[0]?.OR), String(queries.length));
  check("...and still excludes the caller's own session", queries[1]?.id?.not === "eva1", JSON.stringify(queries[1]?.id));
}

// ─── UT-18: every tag the prompt promises to strip is actually stripped ──────
// The failure mode is loud and embarrassing rather than subtle: a raw
// [[CONSULT_RELEASE:8f3b...]] rendered in a parent's chat. It happens whenever
// someone adds a tag to the prompt and forgets the matching `.replace()` in
// the router, which no other test would catch. Read both files and compare.
async function ut18() {
  const fs = await import("fs");
  const path = await import("path");
  const root = process.cwd();
  const prompts = fs.readFileSync(path.join(root, "server/ai-prompt-defaults.ts"), "utf8");
  const router = fs.readFileSync(path.join(root, "server/ai-router.ts"), "utf8");

  // The protocols section ends with an explicit "these are stripped" list.
  const claim = prompts.match(/All \[\[SAVE:\.\.\.\]\][^\n]*tags are stripped[^\n]*/)?.[0];
  check("the prompt still declares which tags are stripped", !!claim, String(claim).slice(0, 80));
  if (!claim) return;

  const claimed = Array.from(claim.matchAll(/\[\[([A-Z_]+)[:\]]/g)).map((m) => m[1]);
  check("the strip list parses into tag names", claimed.length >= 10, claimed.join(","));
  check("CONSULT_RELEASE is declared as stripped", claimed.includes("CONSULT_RELEASE"), claimed.join(","));

  for (const tag of claimed) {
    // Either a targeted replace for that tag, or the tag consumed by a shared
    // strip pass. Both end with it gone from the user-visible content.
    const stripped = new RegExp(`replace\\(\\s*/\\\\\\[\\\\\\[${tag}\\b`).test(router)
      || new RegExp(`\\\\\\[\\\\\\[${tag}[^\\n]*\\]\\]\\/g?[a-z]*,\\s*""`).test(router);
    check(`[[${tag}]] is stripped in ai-router before the reply is saved`, stripped);
  }

  // And the tag must be emitted only after a confirmation - the prompt is the
  // only thing enforcing that, so pin the wording that carries it.
  const releaseRule = prompts.match(/RELEASING A LOCK[\s\S]{0,900}/)?.[0] || "";
  check("the release rule requires confirming ONCE before emitting",
    /confirm ONCE/i.test(releaseRule) && /ONLY after they confirm/i.test(releaseRule));
  check("the release rule forbids firing on a first mention",
    /Never emit it on a first mention/i.test(releaseRule));
  check("the release rule forbids pairing it with a booking tag",
    /never emit it in the same message as a \[\[CONSULTATION_BOOKING\]\]/i.test(releaseRule));
}

const CASES: { id: string; name: string; run: () => Promise<void> }[] = [
  { id: "UT-01", name: "Bare-id [[MATCH_CARD:<uuid>]] form is accepted", run: ut01 },
  { id: "UT-02", name: "Well-formed card JSON parses unchanged", run: ut02 },
  { id: "UT-03", name: "Malformed card JSON is salvaged, not dropped", run: ut03 },
  { id: "UT-04", name: "Unusable card payloads are refused, not rendered broken", run: ut04 },
  { id: "UT-05", name: "Tool bodies parse despite trailing prose and control chars", run: ut05 },
  { id: "UT-06", name: "A truncated tool result still yields the top id", run: ut06 },
  { id: "UT-07", name: "Zero results are distinguishable from a parse failure", run: ut07 },
  { id: "UT-08", name: "The parent's private Eva session resolves (and never a joined thread)", run: ut08 },
  { id: "UT-09", name: "Photo de-dup keeps the larger copy and never drops an unknown", run: ut09 },
  { id: "UT-10", name: "Auto-reply starter copy stays in sync with its tokens", run: ut10 },
  { id: "UT-11", name: "Contact guard blocks contact details and leaves ordinary text alone", run: ut11 },
  { id: "UT-12", name: "Every obfuscation of one address and one number still blocks", run: ut12 },
  { id: "UT-13", name: "Consultation focus lock: types are independent and every release works", run: ut13 },
  { id: "UT-14", name: "Provider service line resolves, or fails OPEN when ambiguous", run: ut14 },
  { id: "UT-15", name: "Match-call gates fire in order and never quote an unconfirmed deposit", run: ut15 },
  { id: "UT-16", name: "Consent card registration stays in lockstep with visibility", run: ut16 },
  { id: "UT-17", name: "A whisper-stamped Eva session never counts as a provider connection", run: ut17 },
  { id: "UT-18", name: "Every tag the prompt promises to strip is stripped before the parent sees it", run: ut18 },
];

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🧪 Unit Guards (recovery paths)`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases\n`);

  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: "unit" });
  for (const c of toRun) {
    caseFails = [];
    console.log(`  ▶ Starting: ${c.id}`);
    console.log(`    ${c.name}`);
    await reportToDashboard({ type: "test_start", id: c.id });
    const t0 = Date.now();
    // No retry: these are deterministic. A retry here would only hide a real bug.
    try { await c.run(); } catch (e: any) { caseFails.push(`scenario crashed: ${(e?.message || String(e)).slice(0, 220)}`); }
    const durationMs = Date.now() - t0;
    if (caseFails.length === 0) {
      totalPass++; console.log(`  ✅ ${c.id} PASS (${(durationMs / 1000).toFixed(1)}s)`);
      await reportToDashboard({ type: "test_pass", id: c.id, durationMs });
    } else {
      totalFail++;
      for (const x of caseFails) console.log(`     [${c.id}] ${x}`);
      console.log(`  ❌ ${c.id} FAIL (${(durationMs / 1000).toFixed(1)}s)`);
      await reportToDashboard({ type: "test_fail", id: c.id, durationMs, errors: caseFails });
    }
  }
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${totalPass} passed, ${totalFail} failed (${Math.round((Date.now() - suiteStart) / 1000)}s total)`);
  await reportToDashboard({ type: "run_done", passCount: totalPass, failCount: totalFail, durationMs: Date.now() - suiteStart });
  process.exit(totalFail ? 1 : 0);
})();
