/**
 * Acceptance corpus for the contact guard (UT-11 / UT-12).
 *
 * MUST_NOT_BLOCK is the important half. A phone number that slips through is a
 * miss; a blocked cost discussion is a bug the parent cannot work around and
 * cannot understand. Every entry carries the specific rule or exclusion it
 * exercises, so a failure names the defense that regressed rather than just
 * "the detector changed".
 *
 * Lives in shared/ so the unit script and any future client test import the
 * same strings, mirroring how AUTO_REPLY_STARTERS is used by UT-10.
 */

import type { ContactKind } from "./contact-guard";

const ZWSP = "​";

export type BlockCase = { text: string; kind: ContactKind; why: string };
export type PassCase = { text: string; why: string };

export const MUST_BLOCK: BlockCase[] = [
  // ── email: literal and obfuscated ────────────────────────────────────────
  { text: "you can write me at eran@gostork.com", kind: "email", why: "email.literal" },
  { text: "email me: e r a n @ g o s t o r k . c o m", kind: "email", why: "letter-spacing collapse then email.literal" },
  { text: "reach me at eran (at) gostork dot com", kind: "email", why: "bracketed at plus spelled dot" },
  { text: "eran[at]gostork[dot]com", kind: "email", why: "square-bracket separators" },
  { text: "eran{at}gostork{dot}com", kind: "email", why: "brace separators" },
  { text: "my address is eran＠gostork.com", kind: "email", why: "fullwidth @ folded by NFKC" },
  { text: `contact er${ZWSP}an@gost${ZWSP}ork.com`, kind: "email", why: "zero-width injection stripped" },
  { text: "Email me: Eran (AT) GoStork (DOT) com", kind: "email", why: "uppercase separators" },
  { text: "my personal is eranamir99@gmail.com if that is easier", kind: "email", why: "email.literal, free-mail" },
  { text: "reach me: e.amir+ivf@protonmail.com", kind: "email", why: "dots and plus in the local part" },
  { text: "eran at gmail dot com works better", kind: "email", why: "email.freemail needs no context gate" },
  { text: "you can mail dana.k at brightfutures dot com", kind: "email", why: "spelled dot, dotted local part" },

  // ── phone ────────────────────────────────────────────────────────────────
  { text: "here is my cell 917-224-7761", kind: "phone", why: "phone.us10, 3-3-4 grouping" },
  { text: "+1 (917) 224 7761", kind: "phone", why: "phone.e164 leading plus" },
  { text: "9 1 7 2 2 4 7 7 6 1", kind: "phone", why: "letter-spacing collapse then phone.us10" },
  { text: "call 917.224.7761 any time", kind: "phone", why: "dot separators" },
  { text: "my number is +972 54 123 4567", kind: "phone", why: "international e164" },
  { text: "1-917-224-7761 is the best line", kind: "phone", why: "phone.us11 with country code" },
  { text: "(917)224-7761", kind: "phone", why: "parenthesized area code" },
  { text: "9172247761", kind: "phone", why: "bare 10 digits, valid NANP area code" },
  { text: "reach me on +44 7911 123456", kind: "phone", why: "UK e164" },
  { text: "here is my cell 917 224 7761", kind: "phone", why: "space-separated 3-3-4" },
  { text: "call me at 224-7761 tonight", kind: "phone", why: "phone.local7 with a call keyword" },
  { text: "my direct is 224.7761, ask for Dana", kind: "phone", why: "phone.local7 with a direct keyword" },

  // ── off-platform links ───────────────────────────────────────────────────
  { text: "join us https://us02web.zoom.us/j/98765432101", kind: "link", why: "wildcard subdomain on zoom.us" },
  { text: "zoom.us/j/9876543210 at 4", kind: "link", why: "bare zoom host" },
  { text: "https://meet.google.com/abc-defg-hij", kind: "link", why: "google meet host" },
  { text: "teams.microsoft.com/l/meetup-join/19%3ameeting", kind: "link", why: "teams host" },
  { text: "grab a slot at calendly.com/eran-gostork/30min", kind: "link", why: "calendly host" },
  { text: "we use whereby.com/gostork for calls", kind: "link", why: "whereby host" },
  { text: "our room is gostork.zoom.us", kind: "link", why: "branded zoom subdomain" },
  { text: "zoom [dot] us / j / 9876543210", kind: "link", why: "bracketed dot deobfuscated to a host" },
  { text: "wa.me/19172247761", kind: "link", why: "whatsapp click-to-chat host" },
  { text: "t.me/eranamir", kind: "link", why: "telegram host" },

  // ── messaging handles ────────────────────────────────────────────────────
  { text: "text me on whatsapp at 917 224 7761", kind: "phone", why: "phone fires first on the number" },
  { text: "my telegram is @eranamir", kind: "handle", why: "platform plus @identifier" },
  { text: "add me on signal, username eran.99", kind: "handle", why: "platform plus a solicitation phrase" },
  { text: "skype: live:eran_amir_1", kind: "handle", why: "platform plus a live: id" },
  { text: "dm me on instagram @gostork.eran", kind: "handle", why: "platform plus dm me" },
  { text: "let us move this over to WhatsApp", kind: "handle", why: "explicit move-off-platform verb" },
  { text: "switch to telegram, my handle is @dana", kind: "handle", why: "switch-to verb plus a handle" },
  { text: "follow me on instagram @dana_ivf", kind: "handle", why: "follow me plus @identifier" },
  { text: "ok just email me eran.amir@gostork.co.uk", kind: "email", why: "multi-label domain" },
  { text: "my cell: 4155551234", kind: "phone", why: "bare 10 digits, different area code" },
  { text: "+13105551234", kind: "phone", why: "e164 with no separators at all" },
  { text: "let's just hop on zoom.us instead", kind: "link", why: "host with no path" },
];

export const MUST_NOT_BLOCK: PassCase[] = [
  // ── money: the single biggest false-positive risk on this platform ───────
  { text: "the total is $145,000", why: "comma is not a phone separator" },
  { text: "our retainer is 25,000", why: "5 digits, plus a money keyword" },
  { text: "the agency fee is 32,500 plus a 5,000 deposit", why: "commas split both candidates" },
  { text: "we paid $18,500 and then 6,000", why: "currency prefix exclusion" },
  { text: "estimated total 145000 USD", why: "6 digits and a trailing USD" },
  { text: "the surrogate compensation is 55000 for a first journey", why: "5 digits after a money keyword" },
  { text: "escrow needs 12500 by Friday", why: "money keyword exclusion" },

  // ── clinical numbers ─────────────────────────────────────────────────────
  { text: "AMH 1.2", why: "2 digits" },
  { text: "she has 3 prior pregnancies", why: "single digits" },
  { text: "BMI 24", why: "2 digits" },
  { text: "her FSH was 6.8 and AFC was 14", why: "short clinical values" },
  { text: "AMH 0.42, FSH 11.3, AFC 9", why: "commas split, all runs short" },
  { text: "45 embryos, PGT-A tested", why: "2 digits" },
  { text: "PGT-A came back 46 XX", why: "2 digits" },
  { text: "she delivered at 38 weeks 4 days", why: "letters break the candidate" },
  { text: "we transferred 2 embryos on 11/02/2023", why: "date shape exclusion" },

  // ── identifiers and records ──────────────────────────────────────────────
  { text: "donor #1234", why: "4 digits after an identifier marker" },
  { text: "the surrogate ID is 1029384756", why: "10 digits but area code 102 fails the NANP rule" },
  { text: "policy number 987654321", why: "9 digits matches no rule" },
  { text: "the invoice number is 2024001", why: "7 digits with no phone keyword" },
  { text: "case 4419283 is still open", why: "identifier keyword exclusion" },
  { text: "her NPI is 1234567890", why: "10 digits, area code 123 fails the NANP rule" },

  // ── dates, times, addresses ──────────────────────────────────────────────
  { text: "born 03/14/1994", why: "date shape exclusion" },
  { text: "DOB 1994-03-14", why: "date shape exclusion" },
  { text: "my due date is 2025 06 14", why: "8 digits matches no rule" },
  { text: "let's do Friday 9:30 AM", why: "colon is not a separator" },
  { text: "cycle 2 of 3", why: "single digits" },
  { text: "she is in 90210", why: "5 digits" },
  { text: "our office is at Suite 200, 1234 Wilshire Blvd", why: "suite exclusion plus comma split" },
  { text: "1-800 numbers are on their website", why: "4 digits" },
  { text: "I have 2 kids, ages 5 and 8", why: "single digits" },
  { text: "we are looking at a 12 to 18 month timeline", why: "letters break the candidate" },
  { text: "she is 5 4 and 130 lbs", why: "only 2 single-char tokens, under the collapse threshold" },

  // ── words that look like separators ──────────────────────────────────────
  { text: "she works at Google", why: "no TLD after the bare at" },
  { text: "dot the i's before signing", why: "no domain before the spelled dot" },
  { text: "the clinic is at gostork.com/providers/ccrm", why: "stopword local part blocks the bare-at rule" },
  { text: "I read about it at https://www.cdc.gov/art/reports", why: "stopword local part, and a resource link is not a meeting link" },
  { text: "Sarah said @ the last call that she was ready", why: "a lone @ with spaces is not an address" },
  { text: "she is based at Shady Grove in Rockville", why: "no TLD after the bare at" },

  // ── platform names used innocently ───────────────────────────────────────
  { text: "Zoom is fine but let's use the GoStork video room", why: "host list, not a bare keyword" },
  { text: "that is a good signal that she is ready", why: "signal without an identifier or solicitation" },
  { text: "you can see her full profile at gostork.com", why: "our own domain is not an off-platform host" },
  { text: "book at gostork.com/book/dana", why: "our own booking link" },
  { text: "our GoStork video room worked great", why: "no host, no identifier" },

  // ── the near misses: right digit count, wrong meaning ────────────────────
  { text: "our clinic did 1,842 cycles in 2024", why: "comma split plus a cycle keyword" },
  { text: "the CDC reported 91,771 transfers", why: "comma split" },
  { text: "her chart number is 8827361", why: "7 digits, chart keyword, no phone keyword" },
  { text: "call me when you can, I am free after 3", why: "phone keyword present but no number to attach it to" },
  { text: "I paid 4500 for the initial workup", why: "4 digits after a money keyword" },
  { text: "we saw a 62% success rate for under 35", why: "short runs" },
  { text: "AMH was 2 1 last year and 1 8 now", why: "single-char tokens well under the collapse threshold" },
  { text: "I will send the W-9 and the 1099 later", why: "form numbers" },
  { text: "day 5 blast, grade 4AA", why: "clinical shorthand" },
  { text: "the address is 1234 Main St, Suite 500", why: "street number plus suite exclusion" },
];
