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

export const AUTO_REPLY_TOKENS = [
  { token: "{{parent_name}}", hint: "The parent's first name" },
  { token: "{{staff_name}}", hint: "Whoever the call is booked with" },
  { token: "{{provider_name}}", hint: "Your organization's name" },
  { token: "{{call_type}}", hint: "consultation / match call / doctor call" },
  { token: "{{call_time}}", hint: "The scheduled time, in the parent's timezone" },
] as const;

export type AutoReplyStarter = {
  key: string;
  label: string;
  hint: string;
  /** True when the copy promises a file, so the editor can warn on a mismatch. */
  expectsAttachment: boolean;
  body: string;
};

const OPENER =
  "Hi {{parent_name}}, thanks for booking - this is {{staff_name}} from {{provider_name}}. " +
  "I'm looking forward to our {{call_type}} on {{call_time}}.";

const CLOSER = "If anything comes up before then, just reply here and I'll get back to you.";

export const AUTO_REPLY_STARTERS: AutoReplyStarter[] = [
  {
    key: "message_only",
    label: "Message only",
    hint: "No file to send",
    expectsAttachment: false,
    body:
      `${OPENER}\n\n` +
      "Before we talk it helps to know where you are in your journey and what matters most to you, " +
      "so bring any questions you have - nothing is too small.\n\n" +
      CLOSER,
  },
  {
    key: "with_attachment",
    label: "With an attachment",
    hint: "Send a PDF or intro packet",
    expectsAttachment: true,
    body:
      `${OPENER}\n\n` +
      "I've attached a short intro to how we work so you can skim it beforehand - it covers our " +
      "process, timelines and what the costs typically look like.\n\n" +
      CLOSER,
  },
];

/** Does this body promise a file? Used to warn when nothing is attached. */
export function bodyPromisesAttachment(body: string): boolean {
  return /\battach(ed|ment|ments|ing)?\b/i.test(body || "");
}

export type AutoReplyVars = {
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
  const map: Record<string, string> = {
    parent_name: vars.parentName || "there",
    provider_name: vars.providerName || "our team",
    staff_name: vars.staffName || vars.providerName || "our team",
    call_type: vars.callType || "call",
    call_time: vars.callTime || "the scheduled time",
  };
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => {
    const v = map[String(key).toLowerCase()];
    return v === undefined ? whole : v;
  });
}
