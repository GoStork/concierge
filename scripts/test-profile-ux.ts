/**
 * GoStork - Profile experience guards (PX-xx)
 *
 * The profile work shipped to the donor / surrogate / clinic surfaces in July
 * 2026 - twelve changes, plus four cases covering the gaps those twelve left.
 * Nearly all of it is a RENDERING decision, which is exactly the class of
 * change no other suite in this repo can see: the concierge suites assert what
 * the AI says, the journey suite asserts what moves, and neither notices when a
 * profile starts quoting a sentence she never wrote or publishing a $300,000
 * compensation figure.
 *
 * So each case tests the decision, not the pixels: the pure function that
 * decides what a parent reads. Where that logic lived inline in JSX it was
 * extracted first (lib/profile-sections, lib/profile-hero, lib/rate-delta,
 * lib/cost-program-family, buildCompareTable, validateQuote) - which is also
 * why these are testable at all without a browser.
 *
 * Usage:
 *   npx tsx scripts/test-profile-ux.ts
 *   npx tsx scripts/test-profile-ux.ts --id=PX-08
 */

import { readFileSync } from "node:fs";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { formatFieldLabel, looksLikeRawKey, isPlaceholderValue, formatStatusLabel } from "../client/src/lib/format-label";
import { safeCompensation, compensationWarning, isPlausibleCompensation } from "../client/src/lib/compensation-sanity";
import { formatRelativeTime, isStale } from "../client/src/lib/format-relative-time";
import { profileAddedLabel } from "../client/src/lib/profile-freshness";
import { splitSharedItems, groupProgramFamilies, variantLabels } from "../client/src/lib/cost-program-family";
import { sectionRank, orderProfileSections } from "../client/src/lib/profile-sections";
import { resolveHeroSelection } from "../client/src/lib/profile-hero";
import { describeRateDelta, RATE_TONE_CLASS } from "../client/src/lib/rate-delta";
import { preferencesFromFilters, preferencesFromParentProfile } from "../client/src/hooks/use-parent-preferences";
import {
  getMatchedPreferences, mapDatabaseDonorToSwipeProfile, mapDatabaseSurrogateToSwipeProfile,
  mapDatabaseSpermDonorToSwipeProfile, buildTitle,
} from "../client/src/components/marketplace/swipe-mappers";
import { buildCompareTable, COMPARE_MAX, toggleCompareSelection } from "../client/src/components/marketplace/compare-drawer";
import { compareCellsFromProfile, mergeCompareCells } from "../client/src/lib/compare-sections";
import { buildClinicCompare, buildDoctorCompare, clinicRatesAreGeneric } from "../client/src/lib/compare-providers";
import { pickClinicRate } from "../client/src/lib/clinic-rate";
import { collectOwnWords, validateQuote } from "../server/src/modules/providers/highlight-quote";
import { profileDataToText } from "../server/src/modules/providers/profile-sync.service";
import { programDisplayName } from "../server/src/modules/costs/program-name";
import uiReducer, { toggleFavoriteDonor, passDonor } from "../client/src/store/uiSlice";

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

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

// ─── PX-01: cost labels read as English, and raw keys are flagged ────────────
async function px01() {
  check('snake_case becomes a label ("agency_fee")', formatFieldLabel("agency_fee") === "Agency Fee", formatFieldLabel("agency_fee"));
  check('camelCase is split ("donorCompensation")', formatFieldLabel("donorCompensation") === "Donor Compensation", formatFieldLabel("donorCompensation"));
  check('domain initialisms stay upper ("ivf_cycle")', formatFieldLabel("ivf_cycle") === "IVF Cycle", formatFieldLabel("ivf_cycle"));
  check('"gs_miscellaneous" is not left raw on a $200k quote', formatFieldLabel("gs_miscellaneous") === "GS Miscellaneous", formatFieldLabel("gs_miscellaneous"));

  // The regression that made the naive version unusable: most labels are
  // ALREADY human, and splitting them mangles the page everywhere at once.
  check('an already-human label is untouched ("IVF Cycle")', formatFieldLabel("IVF Cycle") === "IVF Cycle", formatFieldLabel("IVF Cycle"));
  check("parenthesised human labels survive",
    formatFieldLabel("Embryo Transfer (One Cycle)") === "Embryo Transfer (One Cycle)", formatFieldLabel("Embryo Transfer (One Cycle)"));
  check("a name keeps its inner capital", formatFieldLabel("McKinney Fee") === "McKinney Fee", formatFieldLabel("McKinney Fee"));
  // Title-casing "of" made a human label look machine-generated.
  check("small words stay lowercase inside a label",
    formatFieldLabel("Number of Pregnancies") === "Number of Pregnancies", formatFieldLabel("Number of Pregnancies"));
  check("but not at the start of one",
    formatFieldLabel("to_intended_parents") === "To Intended Parents", formatFieldLabel("to_intended_parents"));

  check("looksLikeRawKey flags underscores", looksLikeRawKey("agency_fee"));
  check("looksLikeRawKey flags camelCase", looksLikeRawKey("agencyFee"));
  check("looksLikeRawKey does NOT flag a written label", !looksLikeRawKey("Agency Fee"));
  check("empty input is neither flagged nor crashes", !looksLikeRawKey("") && formatFieldLabel("") === "");
}

// ─── PX-02: implausible compensation is suppressed, never rewritten ──────────
async function px02() {
  check("a normal egg-donor figure publishes", safeCompensation(12_000, "egg-donor") === 12_000);
  check("$300,000 for an egg donor is withheld", safeCompensation(300_000, "egg-donor") === null);
  check("$5 for an egg donor is withheld", safeCompensation(5, "egg-donor") === null);
  check("a six-figure surrogate fee is legitimate", safeCompensation(120_000, "surrogate") === 120_000);
  check("the same figure is implausible for a sperm donor", safeCompensation(120_000, "sperm-donor") === null);
  check("a normal sperm-donor figure publishes", safeCompensation(150, "sperm-donor") === 150);

  // The property that matters: suppression, not correction. A clamped
  // $60,000 would look like a real published price for that donor.
  check("an out-of-band figure is NOT clamped to the band edge",
    safeCompensation(300_000, "egg-donor") !== 60_000);
  check("null and zero stay null", safeCompensation(null, "egg-donor") === null && safeCompensation(0, "egg-donor") === null);
  check("a non-finite value is refused", safeCompensation(Number.NaN as any, "egg-donor") === null);

  const warn = compensationWarning(300_000, "egg-donor");
  check("the provider side is told why it was hidden", !!warn && /outside the plausible range/i.test(warn), String(warn));
  check("no warning for a plausible figure", compensationWarning(12_000, "egg-donor") === null);
  check("no warning for a missing figure", compensationWarning(null, "egg-donor") === null);
  check("isPlausibleCompensation agrees with safeCompensation",
    isPlausibleCompensation(12_000, "egg-donor") && !isPlausibleCompensation(300_000, "egg-donor"));
}

// ─── PX-03: placeholders never reach a parent as content ─────────────────────
async function px03() {
  for (const v of ["--", "-", "—", "N/A", "n/a", "null", "undefined", "Not specified", "Not provided", "", "   "]) {
    check(`"${v}" is treated as blank`, isPlaceholderValue(v));
  }
  check("null is blank", isPlaceholderValue(null));
  check("an empty array is blank", isPlaceholderValue([]));

  // The line this feature must not cross: "None" is a real answer. A surrogate
  // profile saying "Health Conditions: None" is telling the parent something.
  check('"None" is a real answer, not a placeholder', !isPlaceholderValue("None"));
  check('"none" lowercase is also a real answer', !isPlaceholderValue("none"));
  check('"0" is a real answer', !isPlaceholderValue("0"));
  check('"Never" is a real answer', !isPlaceholderValue("Never"));
  check("a normal value passes through", !isPlaceholderValue("Blue"));
}

// ─── PX-04: freshness says "updated", and only what it can prove ─────────────
async function px04() {
  check("a few hours ago reads as today", formatRelativeTime(new Date(Date.now() - 3 * 3600_000)) === "today", String(formatRelativeTime(new Date(Date.now() - 3 * 3600_000))));
  check("one day ago reads as yesterday", formatRelativeTime(daysAgo(1)) === "yesterday", String(formatRelativeTime(daysAgo(1))));
  check("five days ago counts days", formatRelativeTime(daysAgo(5)) === "5 days ago", String(formatRelativeTime(daysAgo(5))));
  check("two months ago counts months", formatRelativeTime(daysAgo(62)) === "2 months ago", String(formatRelativeTime(daysAgo(62))));
  check("a very old record is not dressed up", /year/.test(String(formatRelativeTime(daysAgo(500)))), String(formatRelativeTime(daysAgo(500))));

  check("a missing timestamp says nothing", formatRelativeTime(null) === null && formatRelativeTime(undefined) === null);
  check("an unparseable timestamp says nothing", formatRelativeTime("not a date") === null);
  // Clock skew must not produce "in 3 days" on a live profile.
  check("a future timestamp says nothing rather than guessing",
    formatRelativeTime(new Date(Date.now() + 86_400_000)) === null, String(formatRelativeTime(new Date(Date.now() + 86_400_000))));

  check("a week-old record is not stale", !isStale(daysAgo(7)));
  check("a 60-day-old record is stale", isStale(daysAgo(60)));
  check("the threshold is configurable", isStale(daysAgo(10), 7) && !isStale(daysAgo(10), 30));
  check("a missing timestamp is not called stale", !isStale(null));

  // WHO sees a date, which matters more than how it is worded. Parents see
  // none: a synced profile is re-checked nightly, so a "last checked" value
  // reads the same across the catalogue - decoration beside the status badge
  // that carries the real claim. The marketplace card already fixed both the
  // wording and the audience ("parents never see upload dates"), so the profile
  // page matches it instead of inventing a second phrasing.
  check("the label matches the card's wording exactly",
    profileAddedLabel({ createdAt: "2026-03-23T18:53:56Z" }) === "Added Mar 23, 2026",
    String(profileAddedLabel({ createdAt: "2026-03-23T18:53:56Z" })));
  check("a missing or unparseable date yields nothing",
    profileAddedLabel(null) === null && profileAddedLabel({} as any) === null && profileAddedLabel({ createdAt: "nope" }) === null);

  const page = readFileSync("client/src/pages/profile-detail-page.tsx", "utf8");
  check("surrogates show the date to everyone, donors only to staff",
    /type === "surrogate" \|\| isStaffViewer/.test(page));
  const drawerSrc = readFileSync("client/src/components/marketplace/compare-drawer.tsx", "utf8");
  check("the parent-facing comparison carries no date row at all",
    !/Uploaded|Last updated/.test(drawerSrc));
}

// ─── PX-05: the cost ladder collapses only what is genuinely identical ───────
function line(key: string, min: number, max = min, isIncluded = true) {
  return { category: "IVF", key, minValue: min, maxValue: max, isIncluded } as any;
}
function program(id: string, name: string, items: any[], over: any = {}) {
  return {
    programId: id, programName: name, subTypeLabel: "IVF", subType: "ivf", tab: "ivf",
    country: "USA", isFixedCost: false, minTotal: 20_000, maxTotal: 20_000, lineItems: items, ...over,
  } as any;
}
async function px05() {
  const shared = [line("Monitoring", 2_000), line("Anesthesia", 800), line("Storage", 0, 0, false)];
  const one = program("p1", "IVF Program - One Cycle", [...shared, line("Cycles", 15_000)]);
  const two = program("p2", "IVF Program - Two Cycles", [...shared, line("Cycles", 28_000)], { minTotal: 28_000, maxTotal: 28_000 });
  const three = program("p3", "IVF Program - Three Cycles", [...shared, line("Cycles", 39_000)], { minTotal: 39_000, maxTotal: 39_000 });

  const split = splitSharedItems([one, two, three]);
  check("rows identical in every variant move to the shared block",
    split.sharedIncluded.map((i: any) => i.key).sort().join(",") === "Anesthesia,Monitoring",
    JSON.stringify(split.sharedIncluded.map((i: any) => i.key)));
  check("a shared NOT-included row is kept separate from included ones",
    split.sharedExtra.length === 1 && split.sharedExtra[0].key === "Storage", JSON.stringify(split.sharedExtra));
  check("the row that differs stays with its own variant",
    split.perVariant.every((rows: any[]) => rows.length === 1 && rows[0].key === "Cycles"),
    JSON.stringify(split.perVariant.map((r: any[]) => r.map((x) => x.key))));

  // The safety property: a row present in only SOME variants must never be
  // presented as shared, or the parent reads a price they are not being quoted.
  const withExtra = program("p4", "IVF Program - Unlimited", [...shared, line("Cycles", 50_000), line("Genetic Testing", 4_000)]);
  const split2 = splitSharedItems([one, withExtra]);
  check("a row only one variant has is never called shared",
    !split2.sharedIncluded.some((i: any) => i.key === "Genetic Testing"), JSON.stringify(split2.sharedIncluded.map((i: any) => i.key)));
  check("that row still renders against the variant that has it",
    split2.perVariant[1].some((i: any) => i.key === "Genetic Testing"), JSON.stringify(split2.perVariant[1].map((i: any) => i.key)));

  // Same key, different PRICE, is a difference - not a shared row.
  const cheaper = program("p5", "IVF Program - One Cycle", [line("Monitoring", 1_000), line("Cycles", 15_000)]);
  const split3 = splitSharedItems([one, cheaper]);
  check("the same row at a different price is not merged",
    !split3.sharedIncluded.some((i: any) => i.key === "Monitoring"), JSON.stringify(split3.sharedIncluded.map((i: any) => i.key)));

  // Grouping: only variants of the same product merge.
  const families = groupProgramFamilies([one, two, three, program("p6", "Fixed Cost Egg Donation", [], { subType: "egg-donation", isFixedCost: true })]);
  check("three variants of one product form one family", families.some((f: any[]) => f.length === 3), JSON.stringify(families.map((f: any[]) => f.length)));
  check("a genuinely different product stays its own card", families.some((f: any[]) => f.length === 1), JSON.stringify(families.map((f: any[]) => f.length)));

  // Found on a live donor profile: "Fixed Egg Donation Program" and "Regular
  // Egg Donation Program" shared a tab, subtype and country, so they rendered
  // as two rungs of one ladder - which reads as "same product, pick a size"
  // when they carry different terms. Variants share a leading stem; different
  // products diverge at the first word.
  const fixedVsRegular = groupProgramFamilies([
    program("f1", "Fixed Egg Donation Program", [line("Agency Fee", 10_000)], { subType: "egg-donation", tab: "egg-donation" }),
    program("r1", "Regular Egg Donation Program", [line("Agency Fee", 12_000)], { subType: "egg-donation", tab: "egg-donation" }),
  ]);
  check("Fixed and Regular Egg Donation are never merged into one ladder",
    fixedVsRegular.length === 2, JSON.stringify(fixedVsRegular.map((f: any[]) => f.map((p: any) => p.programName))));

  check("the ladder is labelled by what differs",
    JSON.stringify(variantLabels(["IVF Program - One Cycle", "IVF Program - Two Cycles"])) === JSON.stringify(["One Cycle", "Two Cycles"]),
    JSON.stringify(variantLabels(["IVF Program - One Cycle", "IVF Program - Two Cycles"])));
  // A tiered program becomes one card per tier, named "<program> - <tier>". When
  // the tier key IS the program name, that rendered as "Fixed Egg Donation
  // Program - Fixed Egg Donation Program" on a live donor profile.
  check("a tier suffix that repeats the program name is dropped",
    programDisplayName("Fixed Egg Donation Program", "Fixed Egg Donation Program", 1) === "Fixed Egg Donation Program",
    programDisplayName("Fixed Egg Donation Program", "Fixed Egg Donation Program", 1));
  check("a single tier needs no suffix at all",
    programDisplayName("Regular Egg Donation Program", "Standard", 1) === "Regular Egg Donation Program",
    programDisplayName("Regular Egg Donation Program", "Standard", 1));
  check("real tiers still distinguish their cards",
    programDisplayName("IUI", "Premium", 2) === "IUI \u00b7 Premium" && programDisplayName("IUI", "Platinum", 2) === "IUI \u00b7 Platinum",
    `${programDisplayName("IUI", "Premium", 2)} / ${programDisplayName("IUI", "Platinum", 2)}`);
  check("siblings are named consistently - one keeps its tier, so both do",
    programDisplayName("IUI Premium", "Premium", 2).includes("\u00b7") === programDisplayName("IUI Premium", "Platinum", 2).includes("\u00b7"),
    `${programDisplayName("IUI Premium", "Premium", 2)} / ${programDisplayName("IUI Premium", "Platinum", 2)}`);

  check("unrelated names are kept whole rather than trimmed to nothing",
    JSON.stringify(variantLabels(["Shared Risk", "Shared Risk"])) === JSON.stringify(["Shared Risk", "Shared Risk"]),
    JSON.stringify(variantLabels(["Shared Risk", "Shared Risk"])));
}

// ─── PX-06: the fit line knows what THIS parent asked for ────────────────────
async function px06() {
  const fromFilters = preferencesFromFilters({ eyeColor: ["Blue"], age: ["21", "29"], agreesToTwins: ["true"], education: [] });
  check("a list filter becomes one preference per value",
    fromFilters.some((p) => p.key === "eyeColor" && p.value === "Blue"), JSON.stringify(fromFilters));
  check("a two-value range becomes a range preference",
    fromFilters.some((p) => p.key === "age" && p.rangeMin === 21 && p.rangeMax === 29), JSON.stringify(fromFilters));
  check("an empty filter contributes nothing", !fromFilters.some((p) => p.key === "education"));

  const fromProfile = preferencesFromParentProfile({
    donorEyeColor: "Green", donorHairColor: "Blonde, Brown", donorEducation: "Any", donorEthnicity: null,
  });
  check("a stored answer becomes a preference", fromProfile.some((p) => p.key === "eyeColor" && p.value === "Green"), JSON.stringify(fromProfile));
  check("a comma list becomes two preferences",
    fromProfile.filter((p) => p.key === "hairColor").length === 2, JSON.stringify(fromProfile.filter((p) => p.key === "hairColor")));
  check('"Any" means the parent is open, not a filter', !fromProfile.some((p) => p.key === "education"), JSON.stringify(fromProfile));
  check("a null answer contributes nothing", !fromProfile.some((p) => p.key === "ethnicity"));
  check("no profile at all is survivable", preferencesFromParentProfile(null).length === 0);

  // The fit line itself: matches are found, and a miss is a miss.
  const profile: any = { id: "d1", age: 27, eyeColor: "Blue", hairColor: "Brown", education: "Bachelor's Degree", location: "California" };
  const matched = getMatchedPreferences(profile, [
    { key: "eyeColor", value: "Blue" }, { key: "hairColor", value: "Red" }, { key: "age", value: "range", rangeMin: 21, rangeMax: 29 },
  ] as any);
  const keys = matched.map((m: any) => m.key);
  check("a matching trait is reported", keys.includes("eyeColor"), JSON.stringify(keys));
  check("an in-range age is reported", keys.includes("age"), JSON.stringify(keys));
  check("a trait she does not have is NOT reported as a match", !keys.includes("hairColor"), JSON.stringify(keys));
  // No cap on the chips: the row wraps, and "+1 more" was a dead label - it
  // announced a match and gave no way to see it. Claiming "5 of your 5" and
  // then showing four is worse than not counting.
  const fitSrc = readFileSync("client/src/components/profile-fit-line.tsx", "utf8");
  check("every matched chip is rendered, none hidden behind a counter",
    !/more<\/span>|slice\(0,\s*\d/.test(fitSrc));

  check("every match carries a label the page can print",
    matched.every((m: any) => typeof m.displayLabel === "string" && m.displayLabel.length > 0), JSON.stringify(matched));
  check("no preferences means no claims", getMatchedPreferences(profile, []).length === 0);
}

// ─── PX-07: sections are ordered by what actually decides the choice ─────────
async function px07() {
  // This replaced a three-band model that sorted by the KIND of content and so
  // pushed "medical" to the bottom as due diligence. For a surrogate, pregnancy
  // history IS the decision - the tidy version buried it.
  const surrogateSections = [
    "Letter to Intended Parents", "General Interests", "Physical Characteristics",
    "Medical History", "Pregnancy History", "Support System", "Education",
  ];
  const s = orderProfileSections(surrogateSections, "surrogate");
  check("surrogate: pregnancy history leads", s[0] === "Pregnancy History", JSON.stringify(s));
  check("surrogate: medical history second", s[1] === "Medical History", JSON.stringify(s));
  check("surrogate: support system third", s[2] === "Support System", JSON.stringify(s));
  check("surrogate: her letter fourth", s[3] === "Letter to Intended Parents", JSON.stringify(s));
  check("surrogate: everything else follows", s.slice(4).length === 3, JSON.stringify(s.slice(4)));

  const donorSections = [
    "Education", "Letter to Intended Parents", "Physical Characteristics",
    "Family Medical History", "Medical History", "Donation History", "Hobbies",
  ];
  const d = orderProfileSections(donorSections, "egg-donor");
  check("donor: donation history leads", d[0] === "Donation History", JSON.stringify(d));
  check("donor: medical history second", d[1] === "Medical History", JSON.stringify(d));
  check("donor: family history third", d[2] === "Family Medical History", JSON.stringify(d));
  check("donor: her letter fourth", d[3] === "Letter to Intended Parents", JSON.stringify(d));
  check("donor: education fifth", d[4] === "Education", JSON.stringify(d));

  // The tail keeps the agency's own order - re-sorting it would scramble
  // question/answer pairs that read as a sequence.
  const tail = d.slice(5);
  check("unranked sections keep their source order",
    tail.indexOf("Physical Characteristics") < tail.indexOf("Hobbies"), JSON.stringify(tail));

  // Loose matching on purpose: scrapers emit several names for one thing.
  check("scraper variants still rank", sectionRank("Previous Pregnancies", "surrogate") === 0
    && sectionRank("Birth History", "surrogate") === 0
    && sectionRank("Health Screening", "surrogate") === 1, "variants");
  check("a marker name is normalised before matching",
    sectionRank("__LETTER__", "surrogate") === 3, String(sectionRank("__LETTER__", "surrogate")));
  check("an unknown section falls to the tail rather than vanishing",
    sectionRank("Something Novel", "surrogate") === 4, String(sectionRank("Something Novel", "surrogate")));
  check("nothing is dropped by the reordering", s.length === surrogateSections.length && d.length === donorSections.length);
  check("no sections in means nothing out", orderProfileSections([], "surrogate").length === 0);

  // Band headings are gone; the section names already say what they are.
  const page = readFileSync("client/src/pages/profile-detail-page.tsx", "utf8");
  check("no band headings remain on the page", !/__BAND_|BAND_LABEL/.test(page));
}

// ─── PX-08: the pull-quote is hers, whole, and not staff copy ────────────────
async function px08() {
  const source = "I grew up on a farm with four brothers. My kids call me the pancake queen and I will take it. I want to help another family feel that.";

  check("a verbatim sentence is accepted",
    validateQuote(source, "My kids call me the pancake queen and I will take it.") === "My kids call me the pancake queen and I will take it.",
    String(validateQuote(source, "My kids call me the pancake queen and I will take it.")));

  // The guard that protects a real person: a model asked for "the best line"
  // will improve it, and an improved line is words she never wrote.
  check("a paraphrase is refused", validateQuote(source, "Her children call her the pancake queen.") === null);
  check("a rewrite that fixes grammar is refused", validateQuote(source, "My kids call me the Pancake Queen, and I will take it!") === null);

  // The bug this caught in production: asked for "at most 180 characters" the
  // model returns a real sentence chopped at 180 - verbatim, but trailing off.
  check("a mid-sentence fragment is refused", validateQuote(source, "My kids call me the pancake queen and I") === null);
  check("a fragment ending on a comma is refused", validateQuote(source, "I grew up on a farm with four brothers,") === null);
  check("a sentence ending in ! is accepted",
    validateQuote("I love it here!", "I love it here!") === "I love it here!", String(validateQuote("I love it here!", "I love it here!")));
  // Models wrap their answer in quote marks; that wrapper is stripped, but only
  // as a matched pair - stripping one end would print an unbalanced quote.
  check("a model-added wrapper quote is stripped",
    validateQuote('She said "you should do this."', '"you should do this."') === "you should do this.",
    String(validateQuote('She said "you should do this."', '"you should do this."')));
  const inner = 'I told myself "this is the year."';
  check("a quotation inside her own sentence survives intact",
    validateQuote(inner, inner) === inner, String(validateQuote(inner, inner)));

  check("an over-long quote is refused", validateQuote(source + " " + "x".repeat(400), "x".repeat(200) + ".") === null);
  check("an empty candidate is refused", validateQuote(source, "") === null && validateQuote(source, "   ") === null);

  // Sourcing: only her own writing is quotable.
  const profileData = {
    "Letter to Intended Parents": "I have always loved being a mother. It is the part of my life that matters most to me.",
    "Agency Comments": "This donor is highly recommended by our staff and has completed two successful cycles with us.",
    "Eye Color": "Blue",
  };
  const own = collectOwnWords(profileData);
  check("her letter is collected", /always loved being a mother/.test(own), own.slice(0, 90));
  check("agency copy about her is NOT collected", !/highly recommended/.test(own), own.slice(0, 120));
  check("short attribute values are not mistaken for prose", !/Blue/.test(own), own.slice(0, 120));
  check("an empty profile yields nothing to quote", collectOwnWords(null) === "" && collectOwnWords({}) === "");
}

// ─── PX-09: saving from the action rail keeps her on the grid ────────────────
async function px09() {
  // The rail's Save and Hide must stay different actions. They were briefly the
  // same behaviour: saving a donor removed her from the deck, so the parent
  // lost the profile they had just chosen to keep.
  let state: any = uiReducer(undefined, { type: "@@INIT" });
  state = uiReducer(state, toggleFavoriteDonor("d1"));
  check("saving records the donor as favorited", state.favoritedDonorIds.includes("d1"), JSON.stringify(state.favoritedDonorIds));
  check("saving does NOT hide her from the grid", !state.passedDonorIds.includes("d1"), JSON.stringify(state.passedDonorIds));

  state = uiReducer(state, toggleFavoriteDonor("d1"));
  check("saving again unsaves (the heart toggles)", !state.favoritedDonorIds.includes("d1"), JSON.stringify(state.favoritedDonorIds));

  state = uiReducer(state, passDonor("d2"));
  check("hiding records the donor as passed", state.passedDonorIds.includes("d2"), JSON.stringify(state.passedDonorIds));
  check("hiding does not save her", !state.favoritedDonorIds.includes("d2"), JSON.stringify(state.favoritedDonorIds));

  state = uiReducer(state, passDonor("d2"));
  check("hiding twice does not duplicate the entry",
    state.passedDonorIds.filter((id: string) => id === "d2").length === 1, JSON.stringify(state.passedDonorIds));

  state = uiReducer(state, toggleFavoriteDonor("d3"));
  state = uiReducer(state, toggleFavoriteDonor("d4"));
  check("saves accumulate independently",
    state.favoritedDonorIds.includes("d3") && state.favoritedDonorIds.includes("d4"), JSON.stringify(state.favoritedDonorIds));
}

// ─── PX-10: the comparison drops dead rows and keeps real gaps ───────────────
async function px10() {
  const a: any = { id: "a", displayName: "Donor 1", age: 27, height: "5'6\"", eyeColor: "Blue", education: "BA", totalCost: 42_000, donorCompensation: 10_000, location: "California" };
  const b: any = { id: "b", displayName: "Donor 2", age: 29, height: "5'4\"", eyeColor: "Brown", totalCost: 38_000, donorCompensation: 9_000, location: "Texas" };

  const table = buildCompareTable("egg-donor", [a, b]);
  const groups = table.map((g) => g.group);
  // The Summary block leads: the comparison shows every fact the profile shows,
  // rather than the hand-picked subset it shipped with (which omitted twins,
  // selective reduction, prior c-sections and vaccination - the answers people
  // actually choose on).
  check("the Summary leads the table", groups[0] === "Summary", JSON.stringify(groups));

  const rows = table.flatMap((g) => g.rows.map((r) => r.label));
  check("total cost is compared", rows.includes("Total Cost"), JSON.stringify(rows));
  check("age is compared", rows.includes("Age"), JSON.stringify(rows));

  // A row ONE profile answers is a real difference and must be kept.
  check("a row only one profile fills is kept", rows.includes("Education Level"), JSON.stringify(rows));
  const edu = table.flatMap((g) => g.rows).find((r) => r.label === "Education Level");
  check("the profile that left it blank shows blank, not a fabricated value",
    !!edu && edu.values[0] === "BA" && edu.values[1] === null, JSON.stringify(edu));

  // A row NOBODY answers is a line of dashes - it reads as broken, so it goes.
  check("a row no profile fills is dropped", !rows.includes("Blood Type"), JSON.stringify(rows));
  check("an empty group disappears entirely",
    !table.some((g) => g.rows.length === 0), JSON.stringify(table.map((g) => [g.group, g.rows.length])));
  check("every row has one value per profile",
    table.every((g) => g.rows.every((r) => r.values.length === 2)), JSON.stringify(rows));

  const surrogateTable = buildCompareTable("surrogate", [
    { id: "s1", liveBirths: 2, cSections: 0, baseCompensation: 55_000, agreesToTwins: true, agreesToSelectiveReduction: false, covidVaccinated: true },
    { id: "s2", liveBirths: 3, cSections: 1, baseCompensation: 60_000, agreesToTwins: false, agreesToSelectiveReduction: true, covidVaccinated: true },
  ]);
  const sRows = surrogateTable.flatMap((g) => g.rows.map((r) => r.label));
  check("surrogates are compared on deliveries, not eggs retrieved",
    sRows.includes("Live Births") && !sRows.includes("Eggs retrieved"), JSON.stringify(sRows));
  check("surrogate cost uses base compensation", sRows.includes("Base Compensation"), JSON.stringify(sRows));
  // The whole point of pulling in the Summary: these decide real choices and
  // the hand-picked subset left every one of them out.
  for (const label of ["Twins", "Selective Reduction", "C-Sections", "COVID Vaccinated"]) {
    check(`the Summary's "${label}" is now compared`, sRows.includes(label), JSON.stringify(sRows));
  }

  // The comparison used to read only scalar columns - cost, age, height - which
  // is everything already on the card. What decides between two surrogates is in
  // her sections, and they were absent entirely.
  const carriedTwice = {
    id: "s1", liveBirths: 2,
    profileData: {
      "Pregnancy History": { "Number of Pregnancies": "2", "Complications": "None" },
      "Medical History": { "Health Conditions": "None", "Medications": "Prenatal vitamins" },
      "Support System": { "Who supports you": "Husband and my mother" },
      "Physical Characteristics": { "Shoe Size": "8" },
    },
  };
  const carriedOnce = {
    id: "s2", liveBirths: 1,
    profileData: {
      "Pregnancy History": { "Number of Pregnancies": "1" },
      "Medical History": { "Health Conditions": "Hypothyroidism" },
    },
  };
  const withSections = buildCompareTable("surrogate", [carriedTwice, carriedOnce]);
  const groupNames = withSections.map((g) => g.group);
  check("the Summary still leads", groupNames[0] === "Summary", JSON.stringify(groupNames));
  check("pregnancy history is compared, and comes before medical",
    groupNames.indexOf("Pregnancy History") > 0 && groupNames.indexOf("Pregnancy History") < groupNames.indexOf("Medical History"),
    JSON.stringify(groupNames));
  check("support system is compared", groupNames.includes("Support System"), JSON.stringify(groupNames));
  check("an unranked section is not dragged in", !groupNames.includes("Physical Characteristics"), JSON.stringify(groupNames));

  const preg = withSections.find((g) => g.group === "Pregnancy History")!;
  check("a row one profile leaves blank is kept, showing the gap",
    preg.rows.some((r) => r.label === "Complications" && r.values[0] === "None" && r.values[1] === null),
    JSON.stringify(preg.rows));
  check("answers land under the right profile",
    preg.rows.find((r) => r.label === "Number of Pregnancies")?.values.join("|") === "2|1",
    JSON.stringify(preg.rows.find((r) => r.label === "Number of Pregnancies")));

  // A letter is read, not scanned across four columns.
  const longform = compareCellsFromProfile({ "Letter to Intended Parents": { Letter: "x".repeat(400) } }, "surrogate");
  check("a full letter is not forced into a table cell", longform.length === 0, JSON.stringify(longform));
  check("placeholders never become a compared value",
    compareCellsFromProfile({ "Medical History": { Allergies: "--" } }, "surrogate").length === 0);
  check("no profileData at all is survivable", compareCellsFromProfile(null, "surrogate").length === 0);
  check("merging with nothing to merge yields nothing", mergeCompareCells([[], []]).length === 0);

  check("the shortlist is capped at four", COMPARE_MAX === 4, String(COMPARE_MAX));
  check("a single profile still builds a table", buildCompareTable("egg-donor", [a]).length > 0);
  check("no profiles builds nothing", buildCompareTable("egg-donor", []).length === 0);
}

// ─── PX-11: a rate below national is stated, not condemned ───────────────────
async function px11() {
  const above = describeRateDelta(58, 47);
  check("above national is a positive signal", above.tone === "positive", above.tone);
  check("above national is signed with a +", above.label.startsWith("+11%"), above.label);
  check("above national needs no caveat", above.context === null, String(above.context));

  const below = describeRateDelta(41, 47);
  check("below national is NEVER styled as a failure", below.tone === "neutral", below.tone);
  check("the number itself is unchanged", below.label.startsWith("-6%"), below.label);
  check("below national explains why CDC rates differ",
    !!below.context && /not adjusted|aren't adjusted/i.test(below.context), String(below.context));

  // The specific harm: a red minus punishes a clinic for accepting hard cases.
  check("no tone maps to a destructive colour",
    Object.values(RATE_TONE_CLASS).every((c) => !/destructive|red-|rose-/.test(c)), JSON.stringify(RATE_TONE_CLASS));
  check("both tones come from brand tokens",
    Object.values(RATE_TONE_CLASS).every((c) => /var\(--|text-foreground/.test(c)), JSON.stringify(RATE_TONE_CLASS));

  const equal = describeRateDelta(47, 47);
  check("exactly national is not a shortfall", equal.tone === "positive" && equal.context === null, JSON.stringify(equal));
  check("the delta is rounded for display", describeRateDelta(47.4, 47).diff === 0, String(describeRateDelta(47.4, 47).diff));
}

// ─── PX-12: the desktop hero never renders blank ─────────────────────────────
async function px12() {
  check("a normal photo selection is preserved",
    JSON.stringify(resolveHeroSelection({ video: false, idx: 2 }, 5, null)) === JSON.stringify({ isVideo: false, photoIdx: 2 }),
    JSON.stringify(resolveHeroSelection({ video: false, idx: 2 }, 5, null)));

  // A photo that 404s is dropped from the array after selection.
  check("an index past the end is clamped to the last photo",
    resolveHeroSelection({ video: false, idx: 7 }, 3, null).photoIdx === 2,
    JSON.stringify(resolveHeroSelection({ video: false, idx: 7 }, 3, null)));
  check("a negative index is clamped to the first photo",
    resolveHeroSelection({ video: false, idx: -1 }, 3, null).photoIdx === 0,
    JSON.stringify(resolveHeroSelection({ video: false, idx: -1 }, 3, null)));
  check("no photos at all does not produce a negative index",
    resolveHeroSelection({ video: false, idx: 3 }, 0, null).photoIdx === 0,
    JSON.stringify(resolveHeroSelection({ video: false, idx: 3 }, 0, null)));

  check("a video hero with a URL plays the video",
    resolveHeroSelection({ video: true, idx: 0 }, 3, "https://x/v.mp4").isVideo === true);
  // The failure this prevents: a video flag outliving its URL renders an empty
  // hero on a profile that has photos, which reads as "she has no pictures".
  check("a video hero WITHOUT a URL falls back to photos",
    resolveHeroSelection({ video: true, idx: 1 }, 3, null).isVideo === false,
    JSON.stringify(resolveHeroSelection({ video: true, idx: 1 }, 3, null)));
  check("the photo index survives that fallback",
    resolveHeroSelection({ video: true, idx: 1 }, 3, "").photoIdx === 1,
    JSON.stringify(resolveHeroSelection({ video: true, idx: 1 }, 3, "")));
  check("a NaN index does not propagate",
    resolveHeroSelection({ video: false, idx: Number.NaN }, 3, null).photoIdx === 0,
    JSON.stringify(resolveHeroSelection({ video: false, idx: Number.NaN }, 3, null)));

  // The framing contract, which shipped wrong twice - once on the hero and once
  // in the comparison. A portrait photo inside a full-width box with a fixed
  // short height is scaled by object-cover to cover ~1900px of width, so a
  // 460px-tall band showed nothing but the top of her hair. The fix is the same
  // in both places: bound the width, and let an aspect ratio set the height.
  const page = readFileSync("client/src/pages/profile-detail-page.tsx", "utf8");
  const heroBtn = /data-testid="gallery-hero"/.test(page)
    ? page.slice(Math.max(0, page.indexOf('data-testid="gallery-hero"') - 400), page.indexOf('data-testid="gallery-hero"') + 900)
    : "";
  check("the hero exists in the page", heroBtn.length > 0);
  check("the hero frame is width-bounded, not full-bleed", /max-w-\[\d+px\]/.test(heroBtn), heroBtn.slice(0, 0));
  check("the hero height comes from an aspect ratio", /aspect-\[\d+\/\d+\]/.test(heroBtn));
  check("the hero is not a fixed-height band over a full-width box",
    !/w-full h-\[min\(/.test(heroBtn));

  const drawer = readFileSync("client/src/components/marketplace/compare-drawer.tsx", "utf8");
  check("the comparison columns follow the same framing rule",
    /max-w-\[\d+px\] aspect-\[\d+\/\d+\]/.test(drawer));

  // The profile's photo rail crops NOTHING. A fixed portrait frame cut the two
  // children out of the sides of a surrogate's family photo, and on these
  // profiles the family is the photo - a ragged right edge is a far smaller
  // price than deciding which half of someone's family a parent gets to see.
  const railStart = page.indexOf('data-testid="profile-photo-rail"');
  check("the photo rail exists", railStart > 0);
  const itemStart = page.indexOf('data-testid={`photo-rail-item-${idx}`}', railStart);
  const item = page.slice(itemStart, itemStart + 1400);
  check("the rail renders its photos", itemStart > 0 && /<img/.test(item));
  check("no rail photo is cropped to a fixed frame", !/object-cover/.test(item), item.slice(0, 0));
  check("rail photos keep their own height", /h-auto/.test(item), item.slice(0, 0));
}


// ─── PX-13: every quote we already published really is hers ──────────────────
// The other quote case tests the gate with fixtures. This one tests the ~490
// sentences that gate has ALREADY let through and that parents are reading
// right now - a rule is only as good as the data it produced.
async function px13() {
  // Prisma 7 needs the pg adapter in a standalone script.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const models: Array<["eggDonor" | "surrogate" | "spermDonor", string]> = [
      ["eggDonor", "egg donor"], ["surrogate", "surrogate"], ["spermDonor", "sperm donor"],
    ];
    let checked = 0;
    const notVerbatim: string[] = [];
    const fragments: string[] = [];
    const tooLong: string[] = [];

    for (const [model, label] of models) {
      const rows: any[] = await (prisma as any)[model].findMany({
        where: { highlightQuote: { not: null } },
        select: { id: true, highlightQuote: true, profileData: true },
      });
      for (const row of rows) {
        checked++;
        const quote = String(row.highlightQuote);
        const source = collectOwnWords(row.profileData);
        if (validateQuote(source, quote) !== quote) {
          // Distinguish the two failure modes - they have different causes.
          if (!/[.!?\u2026]["'\u201d\u2019)]?$/.test(quote.trim())) fragments.push(`${label} ${row.id}: ...${quote.slice(-45)}`);
          else if (quote.length > 180) tooLong.push(`${label} ${row.id}: ${quote.length} chars`);
          else notVerbatim.push(`${label} ${row.id}: ${quote.slice(0, 60)}`);
        }
      }
    }

    check(`there are published quotes to check (${checked})`, checked > 0, String(checked));
    check("every published quote appears verbatim in her own writing",
      notVerbatim.length === 0, notVerbatim.slice(0, 3).join(" ~ "));
    check("no published quote trails off mid-sentence",
      fragments.length === 0, fragments.slice(0, 3).join(" ~ "));
    check("no published quote exceeds the length limit",
      tooLong.length === 0, tooLong.slice(0, 3).join(" ~ "));
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// ─── PX-14: the guards are applied where profiles are actually built ─────────
// PX-02/PX-03 prove the helpers are correct. They would still pass if a mapper
// stopped calling them - which is the likelier regression, since the helper is
// stable and the mappers are edited constantly.
async function px14() {
  const donor = mapDatabaseDonorToSwipeProfile({
    id: "d1", externalId: "EG-2429", providerId: "p1", age: 27,
    donorCompensation: 300000, profileData: {},
  } as any);
  check("an absurd donor compensation does not reach the card",
    !donor.donorCompensation, String(donor.donorCompensation));

  const sane = mapDatabaseDonorToSwipeProfile({
    id: "d2", externalId: "EG-2430", providerId: "p1", age: 27, donorCompensation: 12000, profileData: {},
  } as any);
  check("a plausible one does", Number(sane.donorCompensation) === 12000, String(sane.donorCompensation));

  const surrogate = mapDatabaseSurrogateToSwipeProfile({
    id: "s1", externalId: "SU-25996", providerId: "p1", age: 32,
    baseCompensation: 75000, profileData: {},
  } as any);
  check("a legitimate six-figure surrogate fee survives the same path",
    Number(surrogate.baseCompensation) === 75000, String(surrogate.baseCompensation));

  const sperm = mapDatabaseSpermDonorToSwipeProfile({
    id: "sp1", externalId: "SP-77", providerId: "p1", compensation: 120000, profileData: {},
  } as any);
  check("a surrogate-sized figure on a sperm donor is refused",
    !sperm.donorCompensation, String(sperm.donorCompensation));

  // Titles: the compare columns, the saved cards and the deck must agree, and
  // they only do if they all go through buildTitle. They did not, briefly - the
  // compare header had its own fallback and rendered every column as "#".
  check("a surrogate with no name still gets a readable title",
    buildTitle(surrogate) === "Surrogate #25996", buildTitle(surrogate));
  check("a donor gets the donor wording", buildTitle(donor) === "Donor #2429", buildTitle(donor));
  check("a profile with no externalId falls back to its id, never a bare #",
    /#[0-9a-z]/i.test(buildTitle({ id: "abc12345-0000", providerType: "surrogate" } as any)),
    buildTitle({ id: "abc12345-0000", providerType: "surrogate" } as any));

  // Status prose, used by the comparison's Availability row.
  check('"AVAILABLE" reads as prose', formatStatusLabel("AVAILABLE") === "Available", String(formatStatusLabel("AVAILABLE")));
  check("an underscored status is split", formatStatusLabel("SOLD_OUT") === "Sold Out", String(formatStatusLabel("SOLD_OUT")));
  check("a missing status says nothing", formatStatusLabel(null) === null && formatStatusLabel("") === null);

  // The quote's source collector must not swallow a profile the embedding
  // pipeline can read - if profileDataToText finds prose, so should we.
  const profileData = { "Letter to Intended Parents": "I have wanted to do this since my sister struggled for years. It changed how I see family." };
  check("the quote collector sees what the rest of the pipeline sees",
    collectOwnWords(profileData).length > 0 && profileDataToText(profileData).length > 0);
}

// ─── PX-15: the compare shortlist behaves at its edges ───────────────────────
async function px15() {
  let sel: string[] = [];
  sel = toggleCompareSelection(sel, "a");
  sel = toggleCompareSelection(sel, "b");
  check("picks accumulate in the order chosen", JSON.stringify(sel) === '["a","b"]', JSON.stringify(sel));

  sel = toggleCompareSelection(sel, "a");
  check("picking again removes it", JSON.stringify(sel) === '["b"]', JSON.stringify(sel));

  sel = ["a", "b", "c", "d"];
  const full = toggleCompareSelection(sel, "e");
  check("a fifth pick is refused at the cap", JSON.stringify(full) === JSON.stringify(sel), JSON.stringify(full));
  // The important half: refusing must not silently evict someone's first pick.
  check("the refusal does not evict an earlier pick", full.includes("a") && full.length === 4, JSON.stringify(full));
  check("removing one at the cap still works",
    JSON.stringify(toggleCompareSelection(sel, "b")) === '["a","c","d"]', JSON.stringify(toggleCompareSelection(sel, "b")));
  check("the cap is the shared constant", COMPARE_MAX === 4, String(COMPARE_MAX));

  // A shortlist belongs to its tab. Donor ids left over from Eggs counted
  // against the cap on Clinics, so two clinics filled it and the rest went
  // disabled - "Compare 4" with two pills lit.
  const page2 = readFileSync("client/src/pages/marketplace-page.tsx", "utf8");
  check("switching profile type clears the shortlist",
    /useEffect\(\(\) => \{ setCompareIds\(\[\]\);[\s\S]{0,60}\}, \[compareKind\]\)/.test(page2));

  // The drawer must never render a table it cannot fill.
  check("a table is only built for the profiles actually passed",
    buildCompareTable("egg-donor", [{ id: "a", age: 27 }]).flatMap((g) => g.rows).every((r) => r.values.length === 1));
}

// ─── PX-16: the new surfaces are brand-managed, not hardcoded ────────────────
// A standing rule in CLAUDE.md, and one that is invisible until someone
// restyles the brand and half a page ignores it.
const NEW_SURFACES = [
  "client/src/components/marketplace/compare-drawer.tsx",
  "client/src/components/profile-quote.tsx",
  "client/src/components/profile-fit-line.tsx",
  "client/src/components/cost-program-family-card.tsx",
  "client/src/lib/rate-delta.ts",
];
async function px16() {
  // Tailwind's palette utilities and raw hex both bypass the brand entirely.
  const PALETTE = /\b(?:bg|text|border|ring|from|to|via)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
  const HEX = /#[0-9a-fA-F]{3,8}\b/g;
  const FONT = /font-family\s*:/g;

  for (const file of NEW_SURFACES) {
    const src = readFileSync(file, "utf8");
    const palette = src.match(PALETTE) || [];
    const hex = src.match(HEX) || [];
    const font = src.match(FONT) || [];
    const short = file.split("/").pop();
    check(`${short}: no Tailwind palette colours`, palette.length === 0, palette.slice(0, 4).join(", "));
    check(`${short}: no hardcoded hex`, hex.length === 0, hex.slice(0, 4).join(", "));
    check(`${short}: no hardcoded font-family`, font.length === 0, String(font.length));
  }

  // And the positive half: they DO reach for the brand variables.
  const drawer = readFileSync("client/src/components/marketplace/compare-drawer.tsx", "utf8");
  check("the comparison uses the brand radius", /var\(--radius\)/.test(drawer));
  check("the comparison uses the shared type scale", /t-(?:field|micro)-/.test(drawer));

  // A label that changes must not change its button's width - "Save" growing
  // into "Saved" nudged everything beside it and made the click feel like a
  // glitch. Both labels are stacked in one grid cell so it sizes to the wider.
  const toggle = readFileSync("client/src/components/ui/toggle-label.tsx", "utf8");
  check("both labels occupy the same grid cell, so the width is the wider one",
    (toggle.match(/col-start-1 row-start-1/g) || []).length === 3, String((toggle.match(/col-start-1 row-start-1/g) || []).length));
  check("the sizing copies are hidden from assistive tech",
    (toggle.match(/aria-hidden/g) || []).length === 2, String((toggle.match(/aria-hidden/g) || []).length));
  const railSrc = readFileSync("client/src/pages/profile-detail-page.tsx", "utf8");
  check("the Save button uses it rather than a bare ternary",
    /<ToggleLabel active=\{isSaved\}/.test(railSrc) && !/\{isSaved \? "Saved" : "Save"\}/.test(railSrc));

  const quote = readFileSync("client/src/components/profile-quote.tsx", "utf8");
  check("the pull-quote sits on a brand surface, not a grey one",
    /bg-secondary|bg-accent/.test(quote) && !/bg-muted|bg-gray/.test(quote));
}


// ─── PX-17: clinics and doctors compare on what decides THOSE choices ────────
async function px17() {
  const rate = (over: any) => ({ profileType: "own_eggs", ageGroup: "35_37", isNewPatient: true,
    metricCode: "pct_new_patients_live_birth_after_1_retrieval", successRate: 0.52, nationalAverage: 0.47, cycleCount: 210, ...over });

  const clinicA = { id: "c1", name: "A", location: "Boston, MA", yearFounded: 2001,
    ivfSuccessRates: [rate({})], acceptedInsurance: ["Aetna|PPO"], ivfAcceptingPatients: ["Self-pay"],
    cdcServices: { donorEgg: true, gestationalCarrier: false }, cdcCycleStats: { totalCycles: 900 } };
  const clinicB = { id: "c2", name: "B", location: "Austin, TX",
    ivfSuccessRates: [rate({ successRate: 0.41 })], cdcServices: { donorEgg: true, gestationalCarrier: true } };

  const ctx = { eggSource: "own_eggs", ageGroup: "35_37", isNewPatient: true };
  const clinic = buildClinicCompare([clinicA, clinicB], ctx);
  const groups = clinic.map((g) => g.group);
  check("outcomes lead a clinic comparison - it is the question", groups[0] === "Outcomes", JSON.stringify(groups));
  check("access is compared", groups.includes("Access"), JSON.stringify(groups));

  const outcomes = clinic[0].rows;
  check("her rate is used, not the headline",
    outcomes.find((r) => r.label === "Live birth rate")?.values.join("|") === "52%|41%",
    JSON.stringify(outcomes.find((r) => r.label === "Live birth rate")));
  // CDC rates are not risk-adjusted, so below national is stated, never condemned.
  const delta = outcomes.find((r) => r.label === "vs. national average");
  check("below national is stated plainly, not as a failure",
    delta?.values[1] === "-6% vs. national average", JSON.stringify(delta));
  check("a row only one clinic fills is kept",
    clinic.flatMap((g) => g.rows).some((r) => r.label === "Insurance accepted"), JSON.stringify(groups));
  check("a row no clinic fills is dropped",
    !clinic.flatMap((g) => g.rows).some((r) => r.label === "Years in practice"));

  // The rate must come from the same lookup the clinic card uses.
  check("the comparison and the card pick the same rate",
    pickClinicRate(clinicA.ivfSuccessRates, ctx).rate?.successRate === 0.52);
  check("a parent with no profile gets the generic row, flagged as generic",
    clinicRatesAreGeneric([{ ivfSuccessRates: [rate({ ageGroup: "under_35" })] }], { ageGroup: "over_40" }),
    "fallback must be reported so the UI can label it");
  check("a matched profile is NOT flagged generic", !clinicRatesAreGeneric([clinicA], ctx));

  // Doctors: outcomes are their CLINIC's - CDC reports at clinic level, and
  // implying a physician-level statistic would invent a number we do not have.
  const docs = [
    { id: "d1", clinicName: "A Fertility", location: "Boston, MA", acceptingNewPatients: true,
      specialties: ["Endometriosis", "PCOS"], languages: ["English", "Spanish"],
      provider: { ivfSuccessRates: [rate({ ageGroup: "under_35" })] } },
    { id: "d2", clinicName: "B Fertility", location: "Austin, TX", acceptingNewPatients: false, specialties: ["Male factor"] },
  ];
  const doctor = buildDoctorCompare(docs, ["PCOS"]);
  const dGroups = doctor.map((g) => g.group);
  check("a doctor comparison leads with their clinic", dGroups[0] === "Clinic & outcomes", JSON.stringify(dGroups));
  const clinicRow = doctor[0].rows.find((r) => r.label === "Their clinic's live birth rate");
  check("the rate is labelled as the clinic's, not the doctor's", !!clinicRow, JSON.stringify(doctor[0].rows.map((r) => r.label)));

  const match = doctor.flatMap((g) => g.rows).find((r) => r.label === "Matches your diagnoses");
  check("specialties are matched against her own diagnoses",
    match?.values[0] === "PCOS" && match?.values[1] === "None listed", JSON.stringify(match));
  check("with no diagnoses on file that row is absent rather than empty",
    !buildDoctorCompare(docs, []).flatMap((g) => g.rows).some((r) => r.label === "Matches your diagnoses"));
  check("languages are compared", doctor.flatMap((g) => g.rows).some((r) => r.label === "Languages"));
  // The notice is the difference between an honest generic rate and a
  // misleading one - the flag alone is not the feature.
  const drawerSrc = readFileSync("client/src/components/marketplace/compare-drawer.tsx", "utf8");
  check("a generic rate is labelled in the UI, not just flagged in code",
    /clinicRatesAreGeneric\(/.test(drawerSrc) && /compare-generic-rate-notice/.test(drawerSrc));
  check("and the notice offers the fix, not just the caveat",
    /compare-personalise/.test(drawerSrc) && /onPersonalise/.test(drawerSrc));

  // A clinic is not a donor: it has a name and a logo, and buildTitle would
  // mint "Donor #f9f6ab90" for it - which is what shipped.
  const drawer2 = readFileSync("client/src/components/marketplace/compare-drawer.tsx", "utf8");
  check("columns use the provider's real name, not a donor number",
    /compareTitle\(p\)/.test(drawer2) && !/\{buildTitle\(p\)\}/.test(drawer2));
  check("a clinic logo is found where clinics keep it", /logoUrl/.test(drawer2));

  // Yes/No are scanned, not read - a shape answers faster than a word down a
  // four-column table. The word stays for anyone who cannot see the shape.
  check("Yes and No render as marks, in brand tokens",
    /brand-success/.test(drawer2) && /text-destructive/.test(drawer2) && /value === "Yes"/.test(drawer2));
  check("and the word survives for screen readers", /sr-only/.test(drawer2));

  check("no clinics or doctors yields no table",
    buildClinicCompare([], ctx).length === 0 && buildDoctorCompare([], []).length === 0);
}

const CASES: { id: string; name: string; run: () => Promise<void> }[] = [
  { id: "PX-01", name: "Cost labels read as English, and raw keys are flagged", run: px01 },
  { id: "PX-02", name: "Implausible compensation is suppressed, never rewritten", run: px02 },
  { id: "PX-03", name: "Placeholders never reach a parent as content", run: px03 },
  { id: "PX-04", name: "Freshness claims only what it can prove", run: px04 },
  { id: "PX-05", name: "The cost ladder collapses only what is genuinely identical", run: px05 },
  { id: "PX-06", name: "The fit line knows what THIS parent asked for", run: px06 },
  { id: "PX-07", name: "Sections are ordered by what actually decides the choice", run: px07 },
  { id: "PX-08", name: "The pull-quote is hers, whole, and not staff copy", run: px08 },
  { id: "PX-09", name: "Saving from the action rail keeps her on the grid", run: px09 },
  { id: "PX-10", name: "The comparison drops dead rows and keeps real gaps", run: px10 },
  { id: "PX-11", name: "A rate below national is stated, not condemned", run: px11 },
  { id: "PX-12", name: "The desktop hero never renders blank", run: px12 },
  { id: "PX-13", name: "Every quote already published really is hers", run: px13 },
  { id: "PX-14", name: "The guards are applied where profiles are actually built", run: px14 },
  { id: "PX-15", name: "The compare shortlist behaves at its edges", run: px15 },
  { id: "PX-16", name: "The new surfaces are brand-managed, not hardcoded", run: px16 },
  { id: "PX-17", name: "Clinics and doctors compare on what decides those choices", run: px17 },
];

(async () => {
  const wanted = filterId ? filterId.split(",").map((s) => s.trim().toUpperCase()) : null;
  const toRun = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
  console.log(`🧪 Profile Experience Guards`);
  console.log(`   Running: ${toRun.length} of ${CASES.length} cases\n`);

  const suiteStart = Date.now();
  await reportToDashboard({ type: "run_start", testIds: toRun.map((c) => c.id), filter: "profile-ux" });
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
