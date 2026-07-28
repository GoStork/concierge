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
