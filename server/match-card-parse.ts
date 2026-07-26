/**
 * Pure parsing/recovery helpers for match cards.
 *
 * These exist because a parent reading "here's someone I found for you" with
 * no card underneath is one of the worst failures the concierge has. Each
 * function here recovers a card the old code silently dropped (see
 * docs/freetext-request-test-plan.md section 15-16):
 *
 *   - the model emits the documented bare-id form, which JSON.parse rejects
 *   - the model emits slightly malformed JSON
 *   - the tool result is truncated mid-array, so it will not parse at all
 *
 * They live in their own module with NO database or SDK imports so they can be
 * unit-tested directly (scripts/test-card-recovery.ts). Recovery paths only
 * fire when something else has already gone wrong, so without direct tests a
 * regression here is invisible until it shows up as "flake".
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the FIRST JSON array out of an MCP tool-result body.
 *
 * Bodies look like `Found N surrogates:\n<array>\n\nIMPORTANT: ...`, so a
 * naive indexOf("[") / lastIndexOf("]") slice can swallow trailing prose (any
 * "]" in the note moves the end marker) and throw. Results also carry raw
 * control characters inside string fields. Bracket-match the first array and
 * strip control chars instead. Returns null when there is no complete array -
 * including the truncated case, which `topResultId` handles separately.
 */
export function parseFirstJsonArray(body: string): any[] | null {
  if (!body) return null;
  const clean = body.replace(/[\u0000-\u001f]/g, " ");
  const start = clean.indexOf("[");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(clean.substring(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * The top result's id from a tool-result body, and how many rows were found.
 *
 * `rows` is -1 when no complete array could be parsed. Pre-search bodies are
 * capped at MAX_TOOL_RESULT (8000 chars), so a large result set arrives with
 * its array cut mid-object and never closes - but the FIRST id survives
 * truncation, and that is the only thing the owed-card guarantee needs. Losing
 * the card over the tail we never wanted was 12 of 13 dropped cards in one
 * measured run.
 */
export function topResultId(body: string): { id: string; rows: number } {
  const arr = parseFirstJsonArray(body);
  if (arr) {
    const id = arr.length > 0 ? String(arr[0]?.id || "") : "";
    return { id: UUID_RE.test(id) ? id : "", rows: arr.length };
  }
  const salvaged = body.match(
    /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
  )?.[1];
  return { id: salvaged || "", rows: -1 };
}

/**
 * Classify the payload inside a [[MATCH_CARD:...]] tag.
 *
 * "bare" - the documented [[MATCH_CARD:DONOR_ID]] shorthand. Every other tag in
 *   the system takes a bare id ([[WHISPER:PROVIDER_ID]],
 *   [[CONSULTATION_BOOKING:PROVIDER_ID]]) so the model reaches for it here too;
 *   the parser used to only accept JSON and threw the card away.
 * "json"  - a well-formed card object.
 * "salvage" - malformed JSON we can still pull the required fields out of.
 * "unusable" - nothing recoverable; leave it to the prose-based fallback.
 */
/**
 * Is this providerId something we can actually fetch a profile with?
 *
 * The model sometimes puts a display number ("23069") or a person's name
 * ("Sarah") in providerId. The client then fetches that as an id, 404s, and
 * renders "Profile unavailable" - worse than no card, because the prose-based
 * fallback could have rebuilt a real one from the search results. Kept
 * deliberately permissive about FORMAT (ids are not all UUIDs in every lane);
 * it only rejects the two shapes seen in the wild.
 */
export function isUsableCardId(id: unknown): boolean {
  const pid = String(id || "");
  if (!pid) return false;
  if (/^\d+$/.test(pid)) return false;                             // display number
  if (/^[a-zA-Z\s]+$/.test(pid) && pid.length < 30) return false;  // a name
  return true;
}

export type ParsedCardTag =
  | { kind: "bare"; id: string }
  | { kind: "json"; card: any }
  | { kind: "salvage"; card: any }
  | { kind: "unusable" };

export function parseMatchCardTag(raw: string): ParsedCardTag {
  const trimmed = (raw || "").trim().replace(/^["']|["']$/g, "");
  if (UUID_RE.test(trimmed)) return { kind: "bare", id: trimmed };
  try {
    const card = JSON.parse(raw);
    if (card && typeof card === "object") return { kind: "json", card };
  } catch { /* fall through to field salvage */ }

  const grab = (key: string) => {
    const m = raw.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`, "i"));
    return m ? m[1] : "";
  };
  const card = {
    name: grab("name") || grab("displayName"),
    type: grab("type") || grab("entityType"),
    location: grab("location"),
    photo: "",
    reasons: (raw.match(/"reasons"\s*:\s*\[([^\]]*)\]/i)?.[1] || "")
      .split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean).slice(0, 4),
    providerId: grab("providerId") || grab("entityId") || grab("id"),
  };
  if (card.type && UUID_RE.test(card.providerId)) return { kind: "salvage", card };
  return { kind: "unusable" };
}
