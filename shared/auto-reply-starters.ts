/**
 * Starting copy for the provider booking auto-reply.
 *
 * Shared (not client-local) so the test suite can assert on the same strings a
 * provider actually sees. These are real defaults, not placeholder hints: the
 * editor prefills the body with one of them so a provider can open the page,
 * read it, and save without writing anything.
 *
 * Two variants because "do I have a file to send" is the real fork - the
 * attachment wording promises a document, which reads as broken when none is
 * attached.
 *
 * Every variant must use EVERY token in AUTO_REPLY_TOKENS, so the tokens are
 * discovered by reading the default rather than by hunting through chips.
 * UT-10 enforces that.
 */

/**
 * Note there is no {{call_type}} token, deliberately.
 *
 * This message fires only on a parent's FIRST booking with a provider (see the
 * send-once rule), and a first booking is a consultation - match calls and
 * doctor calls happen later in the relationship, by which point the greeting
 * has already gone out and will not fire again. A call-type token would render
 * "consultation" forever: a confusing way to type a word. renderAutoReplyBody
 * still substitutes it if an old template contains one, so nothing breaks.
 */
export const AUTO_REPLY_TOKENS = [
  { token: "{{parent_name}}", hint: "The parent's first name" },
  { token: "{{staff_name}}", hint: "Whoever the call is booked with" },
  { token: "{{provider_name}}", hint: "Your organization's name" },
  { token: "{{call_time}}", hint: "The scheduled time, in the parent's timezone" },
  {
    token: "{{profile_ref}}",
    hint: "The donor or surrogate the call is about, e.g. Egg Donor #4821",
    profileOnly: true,
  },
  {
    token: "{{profile_link}}",
    hint: "A link to that profile - pair it with {{profile_ref}}",
    profileOnly: true,
  },
] as const;

/**
 * Tokens that only resolve when the booking is about a SPECIFIC profile.
 *
 * A parent can book a general consultation with an agency without having
 * picked anyone yet. Rather than print a hole ("about  -  ") the renderer
 * drops the whole paragraph containing an unresolvable profile token. That is
 * why the starter copy keeps the profile reference in its own paragraph:
 * losing it has to leave a message that still reads.
 */
const PROFILE_TOKENS = ["profile_ref", "profile_link"];

export type AutoReplyStarter = {
  key: string;
  label: string;
  hint: string;
  /** True when the copy promises a file, so the editor can warn on a mismatch. */
  expectsAttachment: boolean;
  body: string;
};

const OPENER =
  "Hi {{parent_name}}, thanks for booking your consultation - this is {{staff_name}} from " +
  "{{provider_name}}. I'm looking forward to speaking with you on {{call_time}}.";

const CLOSER = "If anything comes up before then, just reply here and I'll get back to you.";

/**
 * The middle paragraph, per service line. This is where the tailoring lives:
 * a parent who booked about a specific egg donor should hear about THAT donor,
 * not a generic "looking forward to it".
 *
 * The profile sentence is always its own paragraph so it can be dropped whole
 * when the booking is not about a specific profile (a general agency call).
 */
type ServiceCopy = { profile: string | null; general: string };

const SERVICE_COPY: Record<string, ServiceCopy> = {
  "Egg Donor Agency": {
    profile:
      "I can see you're interested in [{{profile_ref}}]({{profile_link}}) - I'll have her full profile, " +
      "her medical and family history and her current availability ready for our call.",
    general:
      "Before we talk it helps to know what you're looking for in a donor - background, physical traits, " +
      "education, openness to contact - so we can narrow things down quickly.",
  },
  "Egg Bank": {
    profile:
      "I can see you're interested in [{{profile_ref}}]({{profile_link}}) - I'll have her full profile, " +
      "her cohort details and current availability ready for our call.",
    general:
      "Before we talk it helps to know what you're looking for in a donor and how many eggs you're " +
      "hoping to secure, so we can point you to the right cohorts.",
  },
  "Surrogacy Agency": {
    profile:
      "I can see you're interested in [{{profile_ref}}]({{profile_link}}) - I'll have her full profile, " +
      "her pregnancy history and where she is in our screening process ready for our call.",
    general:
      "Before we talk it helps to know your timeline, where you are with embryos, and what matters most " +
      "to you in a surrogate match.",
  },
  "Sperm Bank": {
    profile:
      "I can see you're interested in [{{profile_ref}}]({{profile_link}}) - I'll have his full profile, " +
      "his medical and family history and current vial availability ready for our call.",
    general:
      "Before we talk it helps to know what you're looking for in a donor and whether you'll need vials " +
      "shipped to a clinic, so we can check availability ahead of time.",
  },
  "IVF Clinic": {
    profile: null,
    general:
      "Before we talk it helps to know where you are in your journey - any treatment you've already had, " +
      "and any records or test results you have. Bring your top questions; nothing is too small.",
  },
  "Legal Services": {
    profile: null,
    general:
      "Before we talk it helps to know which state you and your match are in and roughly where you are in " +
      "the process, so I can tell you what will actually apply to you.",
  },
};

const DEFAULT_COPY: ServiceCopy = {
  profile: null,
  general:
    "Before we talk it helps to know where you are in your journey and what matters most to you, " +
    "so bring any questions you have - nothing is too small.",
};

const ATTACHMENT_LINE =
  "I've attached a short intro to how we work so you can skim it beforehand - it covers our " +
  "process, timelines and what the costs typically look like.";

/**
 * Build the two starters for a service line. `serviceName` is a
 * ProviderType.name ("Egg Donor Agency", "IVF Clinic", ...); anything unknown
 * falls back to neutral copy.
 */
export function autoReplyStartersFor(serviceName?: string | null): AutoReplyStarter[] {
  const copy = (serviceName && SERVICE_COPY[serviceName]) || DEFAULT_COPY;
  // Profile paragraph first when there is one: it is the most specific, most
  // "you were actually listened to" line in the message.
  const middle = [copy.profile, copy.general].filter(Boolean).join("\n\n");

  return [
    {
      key: "message_only",
      label: "Message only",
      hint: "No file to send",
      expectsAttachment: false,
      body: `${OPENER}\n\n${middle}\n\n${CLOSER}`,
    },
    {
      key: "with_attachment",
      label: "With an attachment",
      hint: "Send a PDF or intro packet",
      expectsAttachment: true,
      body: `${OPENER}\n\n${middle}\n\n${ATTACHMENT_LINE}\n\n${CLOSER}`,
    },
  ];
}

/** Neutral starters, used before a service line is chosen. */
export const AUTO_REPLY_STARTERS: AutoReplyStarter[] = autoReplyStartersFor(null);

/** Service lines that get profile-aware copy, for the editor's hint text. */
export const PROFILE_AWARE_SERVICES = Object.entries(SERVICE_COPY)
  .filter(([, c]) => !!c.profile)
  .map(([name]) => name);

/** Does this body promise a file? Used to warn when nothing is attached. */
export function bodyPromisesAttachment(body: string): boolean {
  return /\battach(ed|ment|ments|ing)?\b/i.test(body || "");
}

export type AutoReplyVars = {
  /** e.g. "Egg Donor #4821" - null when the call is not about one profile. */
  profileRef?: string | null;
  /** Absolute URL to that profile. */
  profileLink?: string | null;
  parentName?: string | null;
  providerName?: string | null;
  staffName?: string | null;
  callType?: string | null;
  callTime?: string | null;
};

/**
 * Fill the personalization tokens.
 *
 * Pure string work, and deliberately shared rather than living on the server
 * service: it sits next to the token list it substitutes, so the two cannot
 * drift, and it stays testable without a database.
 *
 * Unknown tokens are left untouched rather than blanked, so a typo is visible
 * to the provider instead of silently producing a hole in the sentence.
 */
export function renderAutoReplyBody(body: string, vars: AutoReplyVars): string {
  const map: Record<string, string | null> = {
    parent_name: vars.parentName || "there",
    provider_name: vars.providerName || "our team",
    staff_name: vars.staffName || vars.providerName || "our team",
    call_type: vars.callType || "call",
    call_time: vars.callTime || "the scheduled time",
    // Null (not "") when the booking is not about a specific profile - null is
    // what triggers the paragraph drop below.
    profile_ref: vars.profileRef || null,
    profile_link: vars.profileLink || null,
  };

  // Drop any paragraph that leans on a profile token we cannot fill. A general
  // agency call has no donor to name, and half a sentence about nobody is worse
  // than no sentence at all. Only PROFILE tokens do this: an unknown token is a
  // typo and stays visible so the provider can see and fix it.
  const paragraphs = body.split(/\n\s*\n/);
  const kept = paragraphs.filter((p) => {
    const used = [...p.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1].toLowerCase());
    return !used.some((k) => PROFILE_TOKENS.includes(k) && !map[k]);
  });

  return kept
    .join("\n\n")
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
      const v = map[String(key).toLowerCase()];
      return v === undefined || v === null ? whole : v;
    })
    .trim();
}
