/**
 * Contact guard - keeps the conversation inside GoStork.
 *
 * GoStork 1.0's core failure was leakage: a provider got the parent's email and
 * phone, and the relationship moved to their inbox. GoStork 2.0 has the whole
 * flow in-app (chat, video, documents, invoices, calendar), so nobody needs to
 * leave. This module is the detector that enforces it: a message carrying a
 * phone number, an email address, an off-platform meeting link or a messaging
 * handle is blocked before it is persisted.
 *
 * Shared (not server-local) because the client must run the SAME rules. The
 * composers clear the textarea the instant they hand off (chat-input-bar.tsx
 * handleSubmit, concierge-chat-page.tsx sendMessage), and the parent path even
 * auto-retries twice on failure - so a server-only 422 would fire three blocked
 * requests and destroy what the user typed. Client check for the UX, server
 * check for the enforcement, one rule set so they cannot disagree.
 *
 * THE DESIGN CONSTRAINT IS FALSE POSITIVES, NOT MISSES.
 *
 * This is a fertility platform. Real messages are full of numbers: "$145,000",
 * "our retainer is 25,000", "AMH 1.2", "BMI 24", "donor #1234", "born
 * 03/14/1994", "cycle 2 of 3", "she is in 90210", "the surrogate ID is
 * 1029384756". A blocked cost discussion is a much worse bug than a phone
 * number that slipped through, because the parent has no way to work around it
 * and no idea why. Every rule below is therefore shape-constrained rather than
 * greedy, and every constraint has a matching entry in contact-guard-corpus.ts.
 *
 * Two rules that look like over-engineering and are not:
 *   - Comma is NOT a phone separator. Without that, "$145,000 and 25,000"
 *     becomes one 8-digit run.
 *   - Letter-spacing collapse is bounded to runs of >= 6 single-character
 *     tokens. Collapsing whitespace globally is the false-positive machine.
 */

export type ContactKind = "email" | "phone" | "link" | "handle";

export interface ContactFinding {
  kind: ContactKind;
  /** Which rule fired, for server logs. Never sent to a client. */
  rule: string;
  /** Offsets into the ORIGINAL text. */
  span: [number, number];
  /** The matched slice of the original text. Server logs only. */
  sample: string;
}

export interface ContactScanResult {
  blocked: boolean;
  kinds: ContactKind[];
  /** Offsets into the ORIGINAL text, for client highlighting. Empty when not blocked. */
  spans: [number, number][];
  /** Rule-level detail. Server-side logging only - never serialize to a client. */
  findings: ContactFinding[];
}

export interface ContactGuardOptions {
  /** Let 800/833/844/855/866/877/888 numbers through. Default false: "call our office at 888-..." is exactly the escape hatch we are closing. */
  allowTollFree?: boolean;
}

/** The error `code` both clients switch on. */
export const CONTACT_GUARD_CODE = "CONTACT_INFO_BLOCKED";

/**
 * Addresses that are allowed to appear in chat, lowercased.
 *
 * Deliberately empty. It exists as the single named knob so that a future
 * "support@gostork.com is fine" decision is a one-line change here rather than
 * a regex edit somewhere in the rules.
 */
export const PLATFORM_EMAIL_ALLOWLIST: string[] = [];

const MAX_SCAN_CHARS = 20_000;

// ─── Normalization ──────────────────────────────────────────────────────────
// Every stage carries an index map so `spans` point back into the user's real
// string. NFKC can turn one code point into several, so the map repeats the
// source index rather than assuming a 1:1 transform.

type Mapped = {
  s: string;
  /** map[i] is the index in the ORIGINAL text that produced s[i]. */
  map: number[];
};

/** NFKC per code point. Folds fullwidth ＠ ． ０-９ and ligatures. */
function normalizeInitial(text: string): Mapped {
  let s = "";
  const map: number[] = [];
  let orig = 0;
  for (const ch of text) {
    const folded = ch.normalize("NFKC");
    for (const out of folded) {
      s += out;
      map.push(orig);
    }
    orig += ch.length;
  }
  return { s, map };
}

/** Per-character transform. Returning "" drops the character. */
function mapChars(m: Mapped, fn: (ch: string) => string): Mapped {
  let s = "";
  const map: number[] = [];
  for (let i = 0; i < m.s.length; i++) {
    const out = fn(m.s[i]);
    for (const c of out) {
      s += c;
      map.push(m.map[i]);
    }
  }
  return { s, map };
}

/** Regex replace that keeps the map. Replacement chars all point at the match start. */
function mapReplace(m: Mapped, pattern: RegExp, replacement: string): Mapped {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let s = "";
  const map: number[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(m.s)) !== null) {
    if (match[0].length === 0) { re.lastIndex++; continue; }
    for (let i = last; i < match.index; i++) { s += m.s[i]; map.push(m.map[i]); }
    for (const c of replacement) { s += c; map.push(m.map[match.index]); }
    last = match.index + match[0].length;
  }
  for (let i = last; i < m.s.length; i++) { s += m.s[i]; map.push(m.map[i]); }
  return { s, map };
}

// Zero-width and bidi controls. This is what defeats er<ZWSP>an@gost<ZWSP>ork.com.
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿­᠎]/;

/**
 * Cyrillic and Greek lookalikes. LETTERS ONLY, deliberately.
 *
 * Folding O -> 0 would manufacture phone numbers out of ordinary words, which
 * is precisely the false positive this module exists to avoid.
 */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i",
  "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l", "ν": "v", "ο": "o", "α": "a",
  "ε": "e", "ρ": "p", "τ": "t", "υ": "u", "κ": "k", "ι": "i", "μ": "m",
};

function foldConfusable(ch: string): string {
  const stripped = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const base = stripped || ch;
  return CONFUSABLES[base] ?? base;
}

/**
 * Collapse spaced-out text, but ONLY inside a run of >= 6 consecutive
 * single-character tokens.
 *
 * This is what catches "e r a n @ g o s t o r k . c o m" and
 * "9 1 7 2 2 4 7 7 6 1". The >= 6 threshold is what keeps "she is 5 4 and 130
 * lbs" and "cycle 2 of 3" intact: a global whitespace strip would fuse
 * "$145,000" and "25,000" into one 8-digit run.
 */
function collapseLetterSpacing(m: Mapped): Mapped {
  const tokens: { text: string; start: number }[] = [];
  const gaps: string[] = [];
  let i = 0;
  // Leading whitespace becomes gaps[0].
  let gap = "";
  while (i < m.s.length && /\s/.test(m.s[i])) { gap += m.s[i]; i++; }
  gaps.push(gap);
  while (i < m.s.length) {
    const start = i;
    let text = "";
    while (i < m.s.length && !/\s/.test(m.s[i])) { text += m.s[i]; i++; }
    tokens.push({ text, start });
    gap = "";
    while (i < m.s.length && /\s/.test(m.s[i])) { gap += m.s[i]; i++; }
    gaps.push(gap);
  }

  // Mark which tokens belong to a collapsible run. A run may not cross a
  // newline: "9 1 7\n2 2 4" is two lines, not a phone number.
  const inRun = new Array(tokens.length).fill(false);
  let runStart = 0;
  for (let t = 0; t <= tokens.length; t++) {
    const single = t < tokens.length && tokens[t].text.length === 1;
    const gapOk = t === runStart || (t < tokens.length && !gaps[t].includes("\n"));
    if (single && gapOk) continue;
    if (t - runStart >= 6) for (let k = runStart; k < t; k++) inRun[k] = true;
    runStart = single ? t : t + 1;
  }

  let s = "";
  const map: number[] = [];
  const push = (text: string, from: number) => {
    for (let k = 0; k < text.length; k++) { s += text[k]; map.push(m.map[from + k]); }
  };
  // gaps[0] is leading whitespace; gaps[t+1] follows tokens[t].
  push(gaps[0], 0);
  for (let t = 0; t < tokens.length; t++) {
    push(tokens[t].text, tokens[t].start);
    const gapStart = tokens[t].start + tokens[t].text.length;
    // Drop the gap when both sides are inside the same collapsible run.
    const drop = inRun[t] && t + 1 < tokens.length && inRun[t + 1];
    if (!drop) push(gaps[t + 1], gapStart);
  }
  return { s, map };
}

/** Lowercased, de-obfuscated, spacing-collapsed. Rules run against this. */
function buildViews(text: string): { base: Mapped; deobf: Mapped } {
  let m = normalizeInitial(text.slice(0, MAX_SCAN_CHARS));
  m = mapChars(m, (ch) => (INVISIBLE.test(ch) ? "" : ch));
  m = mapChars(m, foldConfusable);
  m = mapChars(m, (ch) => ch.toLowerCase());
  const base = collapseLetterSpacing(m);

  // A second view where BRACKETED and SPELLED separators become real ones, so
  // "eran (at) gostork dot com" and "zoom [dot] us" match the literal rules.
  //
  // Bare-word "at" is NOT rewritten here. Doing so turns "the clinic is at
  // gostork.com" into "is@gostork.com" and blocks it. The bare-word form gets
  // its own gated rule below.
  let d = base;
  d = mapReplace(d, /\s*[([{]\s*at\s*[)\]}]\s*/g, "@");
  d = mapReplace(d, /\s*[([{]\s*dot\s*[)\]}]\s*/g, ".");
  d = mapReplace(d, /\s*﹫\s*/g, "@");
  d = mapReplace(d, /\s+dot\s+/g, ".");
  d = mapReplace(d, /\bd0t\b/g, ".");
  return { base, deobf: d };
}

// ─── Shared vocabulary ──────────────────────────────────────────────────────

/**
 * Known TLDs. The spelled-out email forms are gated on this list: without it,
 * "she works at Google" and "dot the i's before signing" both block.
 */
const TLDS = [
  "com", "net", "org", "co", "io", "me", "edu", "gov", "mil", "info", "biz",
  "us", "uk", "ca", "il", "au", "de", "fr", "es", "it", "nl", "se", "no", "dk",
  "ie", "nz", "in", "jp", "cn", "mx", "br", "ar", "cl", "pt", "ch", "at", "be",
  "pl", "cz", "gr", "ru", "ua", "za", "ge", "tr", "app", "dev", "health", "care",
  "clinic", "life", "email", "mail", "live", "online", "site", "xyz",
];
const TLD_ALT = TLDS.join("|");

/**
 * Words that are NOT email local parts.
 *
 * Guards the bare-word "at" form: "the clinic is at gostork.com" and "I read
 * about it at cdc.gov" would otherwise both read as email addresses.
 */
const LOCAL_STOPWORDS = new Set([
  "is", "it", "us", "we", "me", "be", "to", "in", "on", "of", "or", "and", "the",
  "her", "him", "his", "our", "you", "are", "was", "for", "but", "not", "all",
  "can", "has", "had", "out", "now", "new", "one", "two", "so", "if", "do", "go",
  "up", "by", "as", "no", "yes", "ok", "hi", "hey", "look", "here", "there",
  "back", "over", "team", "call", "meet", "meets", "work", "works", "working",
  "based", "located", "available", "clinic", "office", "staff", "start", "starts",
  "end", "ends", "arrive", "live", "lives", "stay", "staying", "join", "joins",
  "room", "time", "day", "days", "event", "appointment", "session", "said",
  "says", "were", "been", "that", "this", "they", "them", "she", "he", "him",
  "her", "everyone", "anyone", "someone", "people", "her", "again", "still",
]);

function looksLikeEmailLocal(local: string): boolean {
  if (PLATFORM_EMAIL_ALLOWLIST.length && PLATFORM_EMAIL_ALLOWLIST.some((a) => a.startsWith(local + "@"))) return false;
  if (/[0-9._%+-]/.test(local)) return true;
  return local.length >= 3 && !LOCAL_STOPWORDS.has(local);
}

/** Nearby words that make an obfuscated address unambiguous. */
const EMAIL_CONTEXT = /\b(e-?mail|mail|inbox|reach|contact|write|send|address|forward|cc)\b/;

// ─── Email rules ────────────────────────────────────────────────────────────

function scanEmail(base: Mapped, deobf: Mapped, push: (f: Omit<ContactFinding, "sample">, view: Mapped) => void) {
  // A literal @ between two identifier runs is unambiguous. No gate needed.
  const literal = new RegExp(`[a-z0-9._%+-]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLD_ALT})\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = literal.exec(deobf.s)) !== null) {
    if (PLATFORM_EMAIL_ALLOWLIST.includes(m[0])) continue;
    push({ kind: "email", rule: "email.literal", span: [m.index, m.index + m[0].length] }, deobf);
  }

  // Spelled or bracketed separators, on the RAW view so we can still see that
  // the writer spelled them out. Bracketed forms are already folded in `deobf`
  // and caught above; this catches the bare-word spellings.
  const spelled = new RegExp(
    `([a-z0-9._%+-]{2,})\\s*(?:@|\\bat\\b)\\s*([a-z0-9-]{2,})\\s*(?:\\bdot\\b|\\.)\\s*(${TLD_ALT})\\b`,
    "g",
  );
  while ((m = spelled.exec(base.s)) !== null) {
    const [whole, local] = m;
    if (!looksLikeEmailLocal(local)) continue;
    const usedSpelledSeparator = /\bat\b|\bdot\b/.test(whole);
    if (!usedSpelledSeparator) continue; // the pure-literal case is handled above
    // A bare "at" with a literal dot is the ambiguous shape ("meet us at
    // gostork.com"). Require email context nearby before blocking it.
    const bareAtOnly = /\bat\b/.test(whole) && !/\bdot\b/.test(whole);
    if (bareAtOnly) {
      const before = base.s.slice(Math.max(0, m.index - 40), m.index);
      if (!EMAIL_CONTEXT.test(before)) continue;
    }
    push({ kind: "email", rule: bareAtOnly ? "email.bare-at" : "email.spelled", span: [m.index, m.index + whole.length] }, base);
  }

  // Free-mail providers get a shortcut form: "eran at gmail dot com" reads as an
  // address in any context, so it does not need the EMAIL_CONTEXT gate.
  const freemail = /([a-z0-9._%+-]{2,})\s*(?:@|\bat\b)\s*(gmail|yahoo|hotmail|outlook|icloud|protonmail|proton|aol|gmx|yandex)\s*(?:\bdot\b|\.)\s*(com|co\.uk|net|org)\b/g;
  while ((m = freemail.exec(base.s)) !== null) {
    if (!looksLikeEmailLocal(m[1])) continue;
    push({ kind: "email", rule: "email.freemail", span: [m.index, m.index + m[0].length] }, base);
  }
}

// ─── Phone rules ────────────────────────────────────────────────────────────

/**
 * Separators inside a phone number. Note what is ABSENT:
 *   - comma, so "$145,000 and 25,000" is never one candidate
 *   - colon, so "9:30 AM" is two candidates
 *   - newline, so a spaced number cannot span two lines
 */
const PHONE_SEP = " \\t().\\-/\\u2013\\u2014";
const PHONE_CANDIDATE = new RegExp(`\\+?\\d(?:[${PHONE_SEP}]*\\d)*`, "g");

/** Currency and quantity context: this is money, not a number to call. */
const MONEY_BEFORE = /(?:\$|€|£|₪|\b(?:total|totals|cost|costs|price|priced|fee|fees|retainer|deposit|budget|quote|quoted|usd|dollars|paid|pay|payment|refund|invoice|compensation|escrow|balance|charge|charged|worth|around|about|roughly|approx|estimated)\b)[^a-z0-9]{0,15}$/;
const MONEY_AFTER = /^[^a-z0-9]{0,4}(?:usd|dollars?|k\b|\$)/;

/** Identifier and clinical context: this is a measurement or a record number. */
const IDENTIFIER_BEFORE = /\b(?:amh|bmi|fsh|afc|lh|tsh|e2|hcg|npi|day|days|cycle|cycles|week|weeks|wk|embryo|embryos|blast|blasts|pgt|grade|donor|surrogate|id|ids|ref|reference|order|case|policy|claim|account|member|chart|mrn|record|suite|ste|apt|unit|room|floor|zip|invoice|no|num|number|#)[^a-z0-9]{0,25}$/;

const DATE_SHAPE = /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$|^\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}$|^(?:19|20)\d{2}$/;
const THOUSANDS_SHAPE = /^\d{1,3}(?:[.–—]\d{3})+$/;

/** Words that make a 7-digit local number a phone number rather than a record id. */
const PHONE_CONTEXT = /\b(?:call|calling|text|texting|txt|phone|cell|mobile|reach me|reach us|ring|dial|my number|my line|direct|extension|ext|whatsapp|sms|imessage|hotline|voicemail)\b/;

const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

function digitGroups(raw: string): string[] {
  return raw.split(new RegExp(`[${PHONE_SEP}+]+`)).filter((g) => /^\d+$/.test(g));
}

function isNanpArea(area: string): boolean {
  return /^[2-9]/.test(area);
}

function scanPhone(base: Mapped, opts: ContactGuardOptions, push: (f: Omit<ContactFinding, "sample">, view: Mapped) => void) {
  const re = new RegExp(PHONE_CANDIDATE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(base.s)) !== null) {
    let raw = m[0];
    // Trim trailing separators the greedy class may have grabbed.
    const trimmed = raw.replace(new RegExp(`[${PHONE_SEP}]+$`), "");
    if (!trimmed) continue;
    const start = m.index;
    const end = start + trimmed.length;
    raw = trimmed;

    const groups = digitGroups(raw);
    const digits = groups.join("");
    if (digits.length < 7 || digits.length > 15) continue;

    const before = base.s.slice(Math.max(0, start - 30), start);
    const after = base.s.slice(end, end + 12);

    // Exclusions, cheapest first.
    if (MONEY_BEFORE.test(before) || MONEY_AFTER.test(after)) continue;
    if (THOUSANDS_SHAPE.test(raw)) continue;
    if (DATE_SHAPE.test(raw)) continue;
    if (IDENTIFIER_BEFORE.test(before)) continue;

    const hasPlus = base.s[start] === "+" || raw.startsWith("+");
    const shape = groups.map((g) => g.length).join(",");
    let rule: string | null = null;

    if (hasPlus && digits.length >= 8) {
      rule = "phone.e164";
    } else if (digits.length === 10 && ["10", "3,3,4", "3,7", "3,4,3"].includes(shape)) {
      if (isNanpArea(digits.slice(0, 3)) && /^[2-9]/.test(digits.slice(3, 4))) rule = "phone.us10";
    } else if (digits.length === 11 && digits.startsWith("1") && ["11", "1,3,3,4", "1,10", "1,3,7", "1,3,3,4"].includes(shape)) {
      if (isNanpArea(digits.slice(1, 4))) rule = "phone.us11";
    } else if (digits.length === 7 && ["7", "3,4"].includes(shape)) {
      if (PHONE_CONTEXT.test(before)) rule = "phone.local7";
    }

    if (!rule) continue;
    if (opts.allowTollFree && rule !== "phone.e164") {
      const area = digits.length === 11 ? digits.slice(1, 4) : digits.slice(0, 3);
      if (TOLL_FREE.has(area)) continue;
    }
    push({ kind: "phone", rule, span: [start, end] }, base);
  }
}

// ─── Off-platform link rules ────────────────────────────────────────────────

/**
 * Host list, not a blanket URL block. Parents legitimately paste clinic
 * websites, CDC pages and GoStork links; blocking every URL would be useless.
 */
const OFF_PLATFORM_HOSTS = [
  "zoom.us", "meet.google.com", "teams.microsoft.com", "teams.live.com",
  "calendly.com", "cal.com", "whereby.com", "meet.jit.si", "webex.com",
  "gotomeeting.com", "join.skype.com", "wa.me", "api.whatsapp.com",
  "chat.whatsapp.com", "t.me", "telegram.me", "signal.me", "m.me",
  "discord.gg", "ig.me", "paypal.me", "venmo.com", "cash.app",
];

function scanLink(deobf: Mapped, push: (f: Omit<ContactFinding, "sample">, view: Mapped) => void) {
  const hosts = OFF_PLATFORM_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|");
  // Optional subdomain prefix gives us *.zoom.us (us02web.zoom.us) for free.
  const re = new RegExp(`(?:^|[^a-z0-9.@-])((?:[a-z0-9-]+\\.)*(?:${hosts}))(?![a-z0-9-])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(deobf.s)) !== null) {
    const at = m.index + m[0].length - m[1].length;
    push({ kind: "link", rule: "link.host", span: [at, at + m[1].length] }, deobf);
    re.lastIndex = at + m[1].length;
  }
  // A Zoom room id survives even when the host is mangled beyond our reach.
  const roomId = /\/j\/\d{9,11}\b/g;
  while ((m = roomId.exec(deobf.s)) !== null) {
    push({ kind: "link", rule: "link.zoom-room", span: [m.index, m.index + m[0].length] }, deobf);
  }
}

// ─── Messaging handle rules ─────────────────────────────────────────────────

const HANDLE_PLATFORM = /\b(whats\s?app|telegram|signal|skype|instagram|insta|snapchat|viber|wechat|imessage|facetime|messenger)\b/g;
/** An identifier or an explicit move-off-platform verb within reach of the platform name. */
const HANDLE_IDENTIFIER = /@[a-z0-9._]{3,30}\b|\blive:[a-z0-9._-]{3,}|\b(?:my handle|username|user name|my id|add me|dm me|find me|follow me|message me|text me|reach me|ping me|hit me up|move (?:this|it|us|our chat)(?: over)? to|switch to|continue (?:this|our)?\s?(?:conversation|chat)?\s?(?:on|over|via)|talk (?:on|over)|chat (?:on|over))\b/;

function scanHandle(base: Mapped, push: (f: Omit<ContactFinding, "sample">, view: Mapped) => void) {
  const re = new RegExp(HANDLE_PLATFORM.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(base.s)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // A bare @name never blocks on its own - people @-mention each other. The
    // platform name has to be there too, within reach.
    const window = base.s.slice(Math.max(0, start - 30), Math.min(base.s.length, end + 30));
    if (!HANDLE_IDENTIFIER.test(window)) continue;
    push({ kind: "handle", rule: "handle.platform", span: [start, end] }, base);
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

function toOriginalSpan(view: Mapped, span: [number, number], originalLength: number): [number, number] | null {
  const [s, e] = span;
  if (s >= view.map.length || e <= s) return null;
  const from = view.map[s];
  const lastIdx = Math.min(e, view.map.length) - 1;
  const to = Math.min(view.map[lastIdx] + 1, originalLength);
  if (!(to > from)) return null;
  return [from, to];
}

/**
 * Scan a message for contact details and off-platform routing.
 *
 * Returns `spans` in ORIGINAL-text coordinates so a client can highlight what
 * it found. `findings` carries the matched text and is for server logs only -
 * echoing it back would hand an attacker a normalization oracle.
 */
export function detectContactInfo(text: string, opts: ContactGuardOptions = {}): ContactScanResult {
  const empty: ContactScanResult = { blocked: false, kinds: [], spans: [], findings: [] };
  if (!text || typeof text !== "string" || !text.trim()) return empty;

  const { base, deobf } = buildViews(text);
  const findings: ContactFinding[] = [];
  const push = (f: Omit<ContactFinding, "sample">, view: Mapped) => {
    const span = toOriginalSpan(view, f.span, text.length);
    if (!span) return;
    findings.push({ ...f, span, sample: text.slice(span[0], span[1]) });
  };

  scanEmail(base, deobf, push);
  scanPhone(base, opts, push);
  scanLink(deobf, push);
  scanHandle(base, push);

  if (findings.length === 0) return empty;

  // De-duplicate overlapping findings of the same kind (a spelled address can
  // match both the literal and the spelled rule).
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = `${f.kind}:${f.span[0]}:${f.span[1]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const order: ContactKind[] = ["phone", "email", "link", "handle"];
  const kinds = order.filter((k) => unique.some((f) => f.kind === k));
  return {
    blocked: true,
    kinds,
    spans: unique.map((f) => f.span),
    findings: unique,
  };
}

// ─── User-facing copy ───────────────────────────────────────────────────────

const KIND_NOUN: Record<ContactKind, string> = {
  phone: "phone numbers",
  email: "email addresses",
  link: "outside meeting links",
  handle: "outside messaging apps",
};

/**
 * The message both composers show. Explains the why, not just the no - a bare
 * "not allowed" reads as a bug, and the parent has no way to know that calls
 * and files on GoStork are already free.
 */
/**
 * Where the blocked text was being written. The guard protects two very
 * different surfaces and the same wording cannot serve both:
 *
 *   "chat"  - a parent or provider typing into a conversation. They are the
 *             one being protected, so the message reassures them the platform
 *             is free and asks them to resend.
 *   "note"  - GoStork or provider STAFF writing an internal CRM note about a
 *             parent. Telling them their messages are free is nonsense; what
 *             they need to know is that this particular org has not earned the
 *             parent's contact details yet.
 */
export type ContactGuardSurface = "chat" | "note";

export function contactGuardMessage(kinds: ContactKind[], surface: ContactGuardSurface = "chat"): string {
  const list = (kinds.length ? kinds : (["email"] as ContactKind[])).map((k) => KIND_NOUN[k]);
  const nouns = list.length === 1
    ? list[0]
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  if (surface === "note") {
    return (
      `This note is shared with a provider who has not been given this family's contact ` +
      `details yet, so ${nouns} cannot go in it. Remove that part, or share the contact ` +
      `details first if the provider genuinely needs them.`
    );
  }
  return (
    `To keep your journey protected, GoStork keeps conversations on-platform, so ${nouns} ` +
    `cannot be shared here. Please remove that part and send again. Your messages, calls and ` +
    `files on GoStork are always free.`
  );
}
