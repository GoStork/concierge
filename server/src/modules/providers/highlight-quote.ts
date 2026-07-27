import { GoogleGenerativeAI } from "@google/generative-ai";

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
const MAX_QUOTE_CHARS = 180;

/** Collect the prose this person wrote, in reading order. */
export function collectOwnWords(profileData: any): string {
  if (!profileData || typeof profileData !== "object") return "";
  const chunks: string[] = [];

  const walk = (obj: any, sectionName: string) => {
    if (!obj) return;
    if (typeof obj === "string") {
      // Prose, not an attribute value: a real sentence with sentence-ending
      // punctuation and enough length to be worth quoting from.
      if (obj.trim().length >= 80 && /[.!?]/.test(obj)) chunks.push(obj.trim());
      return;
    }
    if (Array.isArray(obj)) {
      for (const v of obj) walk(v, sectionName);
      return;
    }
    if (typeof obj !== "object") return;
    for (const [key, value] of Object.entries(obj)) {
      if (STAFF_SECTION.test(key)) continue;
      const name = PROSE_SECTION.test(key) ? key : sectionName;
      if (name) walk(value, name);
      else if (value && typeof value === "object") walk(value, "");
    }
  };

  walk(profileData, "");
  return chunks.join("\n\n").slice(0, 6000);
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
    model: "gemini-3.5-flash",
    generationConfig: {
      temperature: 0,
      // Without this, 3.5-flash spends the whole output budget thinking and
      // the response arrives truncated mid-preamble ("Here is the JSON requ").
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 512,
      responseMimeType: "application/json",
    } as any,
  });

  const prompt = `Below is what an egg donor or surrogate wrote about herself on her profile.

Choose the ONE sentence that tells an intended parent the most about who she is - her warmth, her motivation, her humour, what she cares about. Prefer a sentence that could only have been written by her over a generic one ("I love to help people").

Rules:
- Copy the sentence EXACTLY as written. Do not fix grammar, shorten, join two sentences, or rephrase. An exact copy is the only acceptable output.
- It must be at most ${MAX_QUOTE_CHARS} characters. If no single sentence that revealing fits, return null.
- Do not choose a sentence that is purely factual (age, job title, number of children).
- Return null if nothing stands out.

Return JSON: {"quote": "<the exact sentence>"} or {"quote": null}

Her words:
"""
${source}
"""`;

  let raw = "";
  try {
    const res = await model.generateContent(prompt);
    raw = res.response.text() || "";
  } catch (err: any) {
    console.error(`[highlight-quote] model call failed: ${err?.message || err}`);
    return null;
  }

  // JSON mode usually holds, but the model still occasionally wraps the object
  // in a fence or a sentence, so take the outermost object if a strict parse fails.
  let quote: unknown = null;
  const parseCandidate = (text: string): unknown => {
    try { return JSON.parse(text)?.quote ?? null; } catch { return undefined; }
  };
  quote = parseCandidate(raw.trim());
  if (quote === undefined) {
    const match = raw.match(/\{[\s\S]*\}/);
    quote = match ? parseCandidate(match[0]) : undefined;
  }
  if (quote === undefined) {
    console.error(`[highlight-quote] unparseable response: ${raw.slice(0, 200)}`);
    return null;
  }

  if (typeof quote !== "string") return null;
  const cleaned = quote.trim().replace(/^["'“]|["'”]$/g, "").trim();
  if (!cleaned || cleaned.length > MAX_QUOTE_CHARS) return null;

  // A whole sentence, not a slice of one. Asked for "at most 180 characters"
  // the model will happily hand back a long sentence chopped at 180 - verbatim,
  // but ending mid-thought ("...I remember how excited I was I want"), which
  // reads on the page as if she trailed off.
  if (!/[.!?…]["'”’)]?$/.test(cleaned)) {
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
