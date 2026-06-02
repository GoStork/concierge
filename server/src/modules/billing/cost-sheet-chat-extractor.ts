// Phase 2 chat extractor. Pure regex/parser, no Prisma, no Nest. Reads
// the last N AiChatMessage.content strings of a session and pulls out
// compensation amounts + mentioned surrogate/donor IDs so the cost-sheet
// auto-draft can pre-fill line items with the actual numbers that the
// parent and provider already discussed.
//
// Sources in order of trust:
//   1. [[SAVE:{...}]] JSON blobs - Eva persists intake answers here.
//      surrogateBudget / eggDonorCompensationRange / etc. are the
//      canonical source.
//   2. [[MATCH_CARD:{...}]] JSON blobs - tells us which specific
//      surrogate/donor profile is in context.
//   3. Dollar-amount regex - fallback when SAVE blobs are missing.

// Inlined here since the legacy matcher was removed; the auto-draft and
// chat extractor are the only remaining consumers.
export interface ChatExtractions {
  surrogateCompCents: number | null;
  donorCompCents: number | null;
  mentionedSurrogateId: string | null;
  mentionedEggDonorId: string | null;
  mentionedSpermDonorId: string | null;
}

const SAVE_RE = /\[\[SAVE:(\{[\s\S]*?\})\]\]/g;
const MATCH_CARD_RE = /\[\[MATCH_CARD:(\{[\s\S]*?\})\]\]/g;
// Loose dollar grabber: "$50,000", "$50K", "50,000 base comp", "50k compensation".
const DOLLAR_RE = /\$?\s?([\d,]{2,8})\s?(k\b|thousand)?(?:\s*(?:base\s*comp(?:ensation)?|compensation))?/gi;

function safeJsonParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function dollarsToCents(amount: number, isK: boolean): number {
  return Math.round((isK ? amount * 1000 : amount) * 100);
}

// Pull the first dollar amount mentioned in context of "comp"/"compensation".
// Returns cents or null. Skips obviously-wrong values (under $1k, over $500k).
function extractCompFromText(text: string): number | null {
  const lower = text.toLowerCase();
  if (!/\bcomp(ensation)?\b/.test(lower)) return null;
  DOLLAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOLLAR_RE.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, "");
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) continue;
    const isK = !!m[2];
    const cents = dollarsToCents(num, isK);
    if (cents < 1_000_00) continue; // skip values under $1,000
    if (cents > 500_000_00) continue; // skip values over $500,000 (likely a parse error)
    return cents;
  }
  return null;
}

// Parse a "$50,000-$60,000" range string and return the LOW end in cents.
// Used for surrogateBudget / eggDonorCompensationRange SAVE values.
function parseRangeLowEnd(rangeStr: string): number | null {
  if (typeof rangeStr !== "string") return null;
  const match = rangeStr.match(/\$?\s?([\d,]{2,8})/);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(num) || num <= 0) return null;
  const cents = Math.round(num * 100);
  if (cents < 1_000_00) return null;
  return cents;
}

export function extractFromChatMessages(messages: Array<{ content: string }>): ChatExtractions {
  const out: ChatExtractions = {
    surrogateCompCents: null,
    donorCompCents: null,
    mentionedSurrogateId: null,
    mentionedEggDonorId: null,
    mentionedSpermDonorId: null,
  };

  // Walk newest-first so the most-recent mention wins.
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content || "";
    if (!content) continue;

    // 1. SAVE blobs (most trusted)
    SAVE_RE.lastIndex = 0;
    let sm: RegExpExecArray | null;
    while ((sm = SAVE_RE.exec(content)) !== null) {
      const parsed = safeJsonParse(sm[1]) as Record<string, unknown> | null;
      if (!parsed) continue;
      if (out.surrogateCompCents == null && typeof parsed.surrogateBudget === "string") {
        out.surrogateCompCents = parseRangeLowEnd(parsed.surrogateBudget);
      }
      if (out.donorCompCents == null && typeof parsed.eggDonorCompensationRange === "string") {
        out.donorCompCents = parseRangeLowEnd(parsed.eggDonorCompensationRange);
      }
    }

    // 2. MATCH_CARD blobs
    MATCH_CARD_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = MATCH_CARD_RE.exec(content)) !== null) {
      const parsed = safeJsonParse(mm[1]) as Record<string, unknown> | null;
      if (!parsed) continue;
      const type = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";
      const id = typeof parsed.id === "string" ? parsed.id : null;
      if (!id) continue;
      if (type.includes("surrogate") && out.mentionedSurrogateId == null) {
        out.mentionedSurrogateId = id;
      } else if (type.includes("egg") && out.mentionedEggDonorId == null) {
        out.mentionedEggDonorId = id;
      } else if (type.includes("sperm") && out.mentionedSpermDonorId == null) {
        out.mentionedSpermDonorId = id;
      }
    }

    // 3. Fallback regex if SAVE didn't catch it
    if (out.surrogateCompCents == null && /surrogate/i.test(content)) {
      out.surrogateCompCents = extractCompFromText(content);
    }
    if (out.donorCompCents == null && /donor/i.test(content)) {
      out.donorCompCents = extractCompFromText(content);
    }
  }

  return out;
}
