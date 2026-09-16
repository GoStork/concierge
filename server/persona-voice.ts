/**
 * Persona voice for the SCRIPTED intake turns.
 *
 * The intake state machine (intake-questions.ts) serves fixed question text so
 * the 73-test concierge suite stays deterministic. Before this, Adam and Ariel
 * asked every one of those questions in identical words, so the persona the
 * parent had just chosen was cosmetic until the first free-text turn.
 *
 * This layer prefixes a SHORT lead-in in the persona's register and leaves the
 * question sentence and every [[QUICK_REPLY]] / [[MULTI_SELECT]] tag untouched,
 * so `contains` / quick-reply assertions in the suite keep passing. It never
 * touches long education blocks or curation summaries, and it alternates
 * turns so the lead-ins do not become a tic.
 */

export type PersonaLike = { name?: string | null; title?: string | null; personalityPrompt?: string | null } | null | undefined;

type Style = "warm" | "direct" | "holistic" | "expert" | "coach" | null;

function styleOf(p: PersonaLike): Style {
  const src = `${p?.title || ""} ${p?.personalityPrompt || ""}`.toLowerCase();
  if (/warm|empath|nurtur|gentle|kind/.test(src)) return "warm";
  if (/straight|direct|honest|no sugarcoat|blunt/.test(src)) return "direct";
  if (/holistic|wellness|mind|spirit/.test(src)) return "holistic";
  if (/coach|encourag|motivat|positive|cheer/.test(src)) return "coach";
  if (/expert|experience|industry|knowledge/.test(src)) return "expert";
  return null;
}

// Lead-ins are grouped by what the question is doing, so the words fit the
// moment: a medical baseline question earns reassurance, a preference question
// earns encouragement, a money question earns a plain frame.
const LEAD_INS: Record<Exclude<Style, null>, Record<"baseline" | "preference" | "clinic" | "generic", string[]>> = {
  warm: {
    baseline: ["Thank you for sharing that.", "I appreciate you telling me.", "You're doing great."],
    preference: ["There's no wrong answer here.", "Whatever feels right for you."],
    clinic: ["This helps me find the right fit for you.", "Almost there."],
    generic: ["Thank you.", "Got it."],
  },
  direct: {
    baseline: ["Quick one:", "Next:"],
    preference: ["Your call:", "Straight question:"],
    clinic: ["Two more and I can start matching.", "Next:"],
    generic: ["Next:"],
  },
  holistic: {
    baseline: ["Take your time with this one.", "Thank you for trusting me with that."],
    preference: ["Go with what feels right for your family.", "No pressure on this one."],
    clinic: ["This shapes the care you'll receive.", "Nearly there."],
    generic: ["Thank you."],
  },
  coach: {
    baseline: ["Great progress.", "You've got this."],
    preference: ["Good, keep going.", "Nice - a couple more."],
    clinic: ["We're close now.", "Strong start."],
    generic: ["Great."],
  },
  expert: {
    baseline: ["This matters for matching.", "Noted - this shapes the shortlist."],
    preference: ["Providers ask this early, so it helps to know now.", "This narrows the field well."],
    clinic: ["Clinics weigh this heavily.", "This is the key input for clinic fit."],
    generic: ["Noted."],
  },
};

function groupOf(step: string): "baseline" | "preference" | "clinic" | "generic" {
  if (/^step(0|1|2|3|4)/.test(step)) return "baseline";
  if (/^a[1-5]/.test(step)) return "clinic";
  if (/^d[23]|^b|^c/.test(step)) return "preference";
  return "generic";
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Returns the text with a persona lead-in when one fits, else unchanged.
 * `turn` is any monotonically varying number (e.g. chat length) used to
 * alternate turns; pass 0 to always apply.
 */
// The two questions a first-timer is least equipped to answer used to arrive
// as the shortest bubbles in the intake, and on alternate turns with no
// lead-in at all. These frames are fixed (never alternated, every persona):
// one sentence on WHY it is asked, then the question verbatim so the suite's
// contains-assertions and the aiAsked() detectors still match.
const FIXED_FRAMES: Record<string, string> = {
  d2_termination: "Agencies ask this early so you are never matched with someone whose values differ from yours.",
  a3_twins: "Most clinics now transfer one embryo at a time, so this is about your preference, not a plan.",
  d3_twins: "Most clinics now transfer one embryo at a time, so this is about your preference, not a plan.",
};

export function applyPersonaVoice(text: string, step: string, persona: PersonaLike, turn: number): string {
  const frame = FIXED_FRAMES[step];
  if (frame) return `${frame} ${text}`;
  // Curation summaries are statements, not questions: "Next: here's what I
  // have" read as a typo on the most important turn of the intake.
  if (/curation|summary/i.test(step)) return text;
  const style = styleOf(persona);
  if (!style) return text;
  // Only short, single-question turns. Education blocks, curation summaries
  // and anything already carrying a lead-in stay as written.
  const plain = text.replace(/\[\[[^\]]*\]\]/g, "").trim();
  if (plain.length > 160 || plain.includes("\n") || (plain.match(/\?/g) || []).length !== 1) return text;
  if (/^(got it|thank|great|perfect|sorry|next|quick one)/i.test(plain)) return text;
  // Alternate: roughly every other scripted turn carries a lead-in.
  if (turn > 0 && (turn + hash(step)) % 2 === 1) return text;
  const pool = LEAD_INS[style][groupOf(step)];
  const lead = pool[hash(step) % pool.length];
  // Direct lead-ins end with a colon: the question continues in lower case.
  if (lead.endsWith(":")) {
    return `${lead} ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  }
  return `${lead} ${text}`;
}

/** The ages (18-70) mentioned in a reply, in order. Ignores four-digit years. */
export function agesIn(text: string): number[] {
  const out: number[] = [];
  for (const m of (text || "").matchAll(/(?<!\d)(1[89]|[2-6]\d|70)(?!\d)/g)) out.push(parseInt(m[1], 10));
  return out;
}

/**
 * One-line acknowledgment that must open the next scripted question when the
 * parent just repeated or corrected themselves, or answered two things at
 * once (both ages). Returns null when nothing needs acknowledging.
 */
export function buildIntakeAck(userMessage: string, lastAiContent: string): string | null {
  const msg = (userMessage || "").trim();
  if (/\b(like i (said|told you|mentioned)|as i (said|mentioned|told you)|i (already )?(said|told you)|i just (said|told you))\b/i.test(msg)) {
    return "Sorry about that - got it.";
  }
  if (/how old are you/i.test(lastAiContent || "")) {
    const ages = agesIn(msg);
    if (ages.length >= 2) return `Got it - ${ages[0]} and ${ages[1]}.`;
  }
  return null;
}
