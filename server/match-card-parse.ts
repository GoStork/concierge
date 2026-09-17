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
 * Cap a tool-result body WITHOUT cutting the JSON array mid-object.
 *
 * The old hard slice at MAX_TOOL_RESULT left `Found 10 surrogates:\n[{...},{..`
 * with the array never closing. Two things broke at once: the model read a
 * malformed list and reached for whatever id it could see (an agency's
 * ownerProviderId, once, which the card guard then had to drop), and the
 * prose-based card repair could not parse the array at all, so the turn went
 * out card-less. Measured Sep 16 2026: 49 of 74 surrogate searches in one
 * suite run hit the cap. Keep the prefix and suffix prose, drop whole trailing
 * items until the body fits, and say how many were trimmed. Falls back to the
 * hard slice only when no array can be found or parsed.
 */
export function truncateToolResultAtItemBoundary(body: string, cap: number, note: string): string {
  if (!body || body.length <= cap) return body;
  const clean = body.replace(/[\u0000-\u001f]/g, " ");
  const start = clean.indexOf("[");
  let end = -1;
  if (start !== -1) {
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
      else if (ch === "]") { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  let items: any[] | null = null;
  if (start !== -1 && end !== -1) {
    try { const parsed = JSON.parse(clean.substring(start, end + 1)); items = Array.isArray(parsed) ? parsed : null; } catch { items = null; }
  }
  if (!items || items.length === 0) {
    return body.slice(0, cap) + "\n\n" + note;
  }
  const prefix = clean.substring(0, start);
  const suffix = clean.substring(end + 1);
  const total = items.length;
  let kept = items.slice();
  const build = () => `${prefix}${JSON.stringify(kept)}${suffix}\n\n[Showing the first ${kept.length} of ${total} results - the rest were trimmed for length. ${note}]`;
  let out = build();
  while (out.length > cap && kept.length > 1) {
    kept = kept.slice(0, -1);
    out = build();
  }
  return out;
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

/**
 * Repair structured card tags the model closed with a single "]".
 *
 * The documented form is `[[MATCH_CARD:{...}]]`. Gemini intermittently emits
 * `[[MATCH_CARD:{...}]` - one closing bracket - and every consumer downstream
 * keys off the `]]` terminator, so a single-bracket tag both fails to parse
 * into a card AND survives the strip pass, which is how the raw
 * `[[MATCH_CARD:{"entityId":"...","entityType":"Clinic"}]` text ended up
 * rendered as prose in a parent's chat.
 *
 * This is a terminator repair on OUR side of a known model defect, not a
 * fabricated card: the payload has to be a balanced JSON object for the tag to
 * be rewritten, and what it resolves to is still decided by the normal parse +
 * DB lookup path. A tag already closed with "]]" is left untouched.
 */
export function repairCardTagTerminators(content: string): string {
  if (!content || content.indexOf("[[") === -1) return content;
  const TAG_RE = /\[\[([A-Z_]+):\s*\{/g;
  let out = content;
  let guard = 0;
  // Re-scan from the start after each repair: an insertion shifts every later
  // offset, and there are at most a handful of tags in a turn.
  for (;;) {
    if (guard++ > 50) break;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let repaired = false;
    while ((m = TAG_RE.exec(out)) !== null) {
      const braceStart = m.index + m[0].length - 1;
      let depth = 0, inStr = false, esc = false, braceEnd = -1;
      for (let i = braceStart; i < out.length; i++) {
        const ch = out[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { braceEnd = i; break; }
        }
      }
      if (braceEnd === -1) continue; // unbalanced - leave it to the unusable path
      const after = out.slice(braceEnd + 1);
      const closing = /^\s*\]\]/.test(after);
      if (closing) continue; // already well formed
      if (!/^\s*\]/.test(after)) continue; // not a single-bracket close either
      const insertAt = braceEnd + 1 + after.indexOf("]") + 1;
      out = `${out.slice(0, insertAt)}]${out.slice(insertAt)}`;
      repaired = true;
      break;
    }
    if (!repaired) break;
  }
  return out;
}
