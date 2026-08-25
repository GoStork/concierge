import { GoogleGenerativeAI } from "@google/generative-ai";
import { trackGemini } from "../../lib/gemini-usage";
import { GEMINI_BATCH_MODEL } from "../../lib/gemini-models";

/**
 * One sentence, in the donor's or surrogate's own words, for the top of their
 * profile.
 *
 * A parent decides how they feel about a person from the way she writes long
 * before they finish her medical history - but her letter sits below the fold,
 * under twenty rows of attributes. Lifting one line up beside the photos gives
 * the profile a voice at the moment the parent is still deciding whether to
 * read on.
 *
 * Two rules make this safe to attribute to a real person:
 *
 *  1. The quote is chosen ONCE and stored. Picking at render time would cost a
 *     model call per page view and, worse, quote a different sentence each
 *     time - a profile that says something different on every visit is not a
 *     person, it is a slot machine.
 *  2. The returned sentence must appear VERBATIM in what she actually wrote.
 *     A model asked for "the best line" will happily improve it. We check, and
 *     store nothing rather than put words in her mouth.
 */

/** Sections that hold prose the person wrote herself. */
const PROSE_SECTION = /(letter|in\s*her\s*own\s*words|own\s*words|personal\s*statement|about\s*me|things\s*about\s*me|my\s*story|why\s*i|message\s*to|note\s*to)/i;

/** Sections written ABOUT her by staff - never quotable as her voice. */
const STAFF_SECTION = /(agency\s*comment|staff|coordinator|our\s*thoughts|why\s*we)/i;

const MIN_SOURCE_CHARS = 220;
// 180 was too tight for real writing. Letters are written in long sentences,
// and the model was told to return null when nothing revealing fit - so it
// returned null for 397 of 400 profiles that had plenty of their own prose.
const MAX_QUOTE_CHARS = 240;

/** Keys that never hold her writing, whatever they contain. */
const NON_PROSE_KEY = /^(photos?|all\s*photos|images?|videos?|_tables|_sections|url|links?)$/i;

/**
 * Does this string look like something a person wrote?
 *
 * The check that was missing: a photo URL is over 80 characters and contains a
 * dot, so it passed a naive length-plus-punctuation test. Profiles with a dozen
 * photos filled the entire 6000-character budget with storage URLs, the model
 * was handed a wall of links, and it correctly answered that there was no
 * writing to quote - for 397 of 400 profiles.
 */
function looksLikeProse(text: string): boolean {
  const t = text.trim();
  if (t.length < 80) return false;
  if (/https?:\/\/|www\.|\/\//.test(t)) return false;
  // A sentence ends and then breathes: punctuation followed by a space or the end.
  if (!/[.!?][\s"'\u201d\u2019)]|[.!?]$/.test(t)) return false;
  // Real prose, not a delimited data blob.
  const words = t.split(/\s+/);
  if (words.length < 12) return false;
  if (words.some((w) => w.length > 40)) return false;
  return true;
}

/** Collect the prose this person wrote, in reading order. */
export function collectOwnWords(profileData: any): string {
  if (!profileData || typeof profileData !== "object") return "";
  const chunks: string[] = [];

  const walk = (obj: any, sectionName: string) => {
    if (!obj) return;
    if (typeof obj === "string") {
      if (looksLikeProse(obj)) chunks.push(obj.trim());
      return;
    }
    if (Array.isArray(obj)) {
      for (const v of obj) walk(v, sectionName);
      return;
    }
    if (typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      if (STAFF_SECTION.test(key) || NON_PROSE_KEY.test(key)) continue;
      const name = PROSE_SECTION.test(key) ? key : sectionName;
      if (name) walk(value, name);
      else if (value && typeof value === "object") walk(value, "");
    }
  };

  walk(profileData, "");
  return chunks.join("\n\n").slice(0, 6000);
}

/** The first `{...}` whose braces balance, ignoring braces inside strings. */
export function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Whitespace and smart-quote insensitive containment check. */
function containsVerbatim(haystack: string, needle: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  return norm(haystack).includes(norm(needle));
}

/**
 * Ask the model which single sentence says the most about who this person is.
 * Returns null whenever we cannot prove the sentence is hers.
 */
export async function selectHighlightQuote(profileData: any): Promise<string | null> {
  if (!process.env.GEMINI_API_KEY) return null;

  const source = collectOwnWords(profileData);
  // Below this there is nothing to choose FROM - a two-line answer quoted back
  // as a pull-quote just repeats itself further down the page.
  if (source.length < MIN_SOURCE_CHARS) return null;

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: GEMINI_BATCH_MODEL,
    generationConfig: {
      temperature: 0,
      // Without this, 3.5-flash spends the whole output budget thinking and
      // the response arrives truncated mid-preamble ("Here is the JSON requ").
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    } as any,
  });

  const prompt = `Below is what an egg donor or surrogate wrote about herself on her profile.

Pick the ONE sentence that tells an intended parent the most about who she is - her warmth, her motivation, her humour, what she cares about. Prefer a sentence that could only have been written by her over a generic one ("I love to help people").

Rules:
- Copy the sentence EXACTLY as written, character for character. Do not fix grammar or spelling, do not shorten, do not join two sentences, do not rephrase. An exact copy is the only acceptable output.
- It must be a complete sentence and at most ${MAX_QUOTE_CHARS} characters. If her most revealing sentence is longer than that, pick the best one that fits rather than giving up.
- Skip purely factual sentences (age, job title, number of children) and skip anything written about her by staff.
- These are real people writing about something that matters to them. If there is any first-person writing here at all, one sentence of it is worth quoting - only return null when the text contains no such writing.

Return JSON: {"quote": "<the exact sentence>"} or {"quote": null}

Her words:
"""
${source}
"""`;

  let raw = "";
  try {
    const res = await model.generateContent(prompt);
    trackGemini("highlight-quote", GEMINI_BATCH_MODEL, res);
    raw = res.response.text() || "";
  } catch (err: any) {
    console.error(`[highlight-quote] model call failed: ${err?.message || err}`);
    return null;
  }

  // JSON mode usually holds, but the model sometimes emits a valid object and
  // then trails extra closing braces after it. A greedy /\{[\s\S]*\}/ swallows
  // that junk and fails to parse, throwing away a perfectly good quote - so
  // take the FIRST BALANCED object instead of the longest span.
  let quote: unknown = null;
  const parseCandidate = (text: string): unknown => {
    try { return JSON.parse(text)?.quote ?? null; } catch { return undefined; }
  };
  quote = parseCandidate(raw.trim());
  if (quote === undefined) quote = parseCandidate(firstBalancedObject(raw) ?? "");
  if (quote === undefined) {
    // A truncated response still carries the sentence: {"quote": "..." <cut>.
    // Safe to lift because validateQuote still has to find it verbatim in her
    // own writing - a recovered string cannot become a fabricated quote.
    const field = /"quote"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (field) { try { quote = JSON.parse(`"${field[1]}"`); } catch { quote = undefined; } }
  }
  if (quote === undefined) {
    console.error(`[highlight-quote] unparseable response: ${raw.slice(0, 200)}`);
    return null;
  }

  if (typeof quote !== "string") return null;
  return validateQuote(source, quote);
}

/**
 * The gate between "a model said this" and "we print it as her words".
 *
 * Separate and exported because these two rules are the whole safety story of
 * the feature, and they are the part a future change is most likely to relax
 * by accident.
 */
export function validateQuote(source: string, candidate: string): string | null {
  // Models like to wrap their answer in quote marks. Strip only a MATCHED
  // pair: stripping one end of `I told myself "this is the year."` would print
  // an unbalanced quotation mark on her profile.
  const trimmedCandidate = (candidate || "").trim();
  const wrapped = /^(["'\u201c\u2018])([\s\S]*)(["'\u201d\u2019])$/.exec(trimmedCandidate);
  const cleaned = (wrapped ? wrapped[2] : trimmedCandidate).trim();
  if (!cleaned || cleaned.length > MAX_QUOTE_CHARS) return null;

  // A whole sentence, not a slice of one. Asked for "at most 180 characters"
  // the model will happily hand back a long sentence chopped at 180 - verbatim,
  // but ending mid-thought ("...I remember how excited I was I want"), which
  // reads on the page as if she trailed off.
  if (!/[.!?\u2026]["'\u201d\u2019)]?$/.test(cleaned)) {
    console.warn(`[highlight-quote] rejected mid-sentence fragment: ${cleaned.slice(-60)}`);
    return null;
  }

  // The guard that matters: we are about to attribute this to a real person.
  if (!containsVerbatim(source, cleaned)) {
    console.warn(`[highlight-quote] rejected non-verbatim quote: ${cleaned.slice(0, 80)}`);
    return null;
  }
  return cleaned;
}

type QuotableModel = "eggDonor" | "surrogate" | "spermDonor";

/**
 * Fill in the stored quote after a sync. Fire-and-forget: a profile without a
 * quote renders fine, so this must never fail a sync.
 */
export async function refreshHighlightQuote(
  prisma: any,
  model: QuotableModel,
  id: string,
  profileData: any,
): Promise<void> {
  try {
    const quote = await selectHighlightQuote(profileData);
    if (!quote) return;
    await prisma[model].update({ where: { id }, data: { highlightQuote: quote } });
  } catch (err: any) {
    console.error(`[highlight-quote] ${model} ${id}: ${err?.message || err}`);
  }
}
