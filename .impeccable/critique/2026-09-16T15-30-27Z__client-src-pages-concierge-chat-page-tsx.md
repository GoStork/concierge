---
target: the first Eva conversation
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx"
target_fingerprint: "sha256:a9a912b109ad5810774cd8b2f5a559c23b2bbb73b649dac8f18c7f87487364c5"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx
timestamp: 2026-09-16T15-30-27Z
slug: client-src-pages-concierge-chat-page-tsx
---
# Critique: the first Eva conversation - run 3

Method: dual-agent (A: design review sub-agent, B: detector + browser-evidence sub-agent). Overlay injection blocked (mixed content, no live server); CLI scan + DOM measurement at 1280x900, 375x812, 375x667. One live intake was played by A. Findings in ignore.md and the founder-confirmed intro copy/pause were dropped.

## Design Health Score: 26/40 (Needs work; 22 -> 25 -> 26)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Strip asserts "Looking for IVF clinic" after the parent removed clinics; nothing after [[CURATION]] says what happens next |
| 2 | Match System / Real World | 3 | Live: "Next: here's what I have: open to surrogacy in USA." (lead-in bolted onto the summary); strip stutter "Eggs Egg Donor" |
| 3 | User Control and Freedom | 2 | "Not exactly" + deselecting IVF Clinics left needsClinic true and the clinic cycle ran anyway; no re-entry after "Not now" on partner invite |
| 4 | Consistency and Standards | 3 | One header, one chip style now; chips 13px under 21px mobile bubbles (DESIGN.md says 14px ui) |
| 5 | Error Prevention | 2 | The curation question ("Shall I find your matches now?") shipped with zero quick replies; twins asked twice |
| 6 | Recognition Rather Than Recall | 2 | Live: "He's 41, like I said"; twins re-asked after "No preference"; mobile fold shows ~36 of 150 chars |
| 7 | Flexibility and Efficiency | 3 | Chips, free text, voice, multi-select; D1 is a 965-char bubble (352px desktop) before the parent asked anything |
| 8 | Aesthetic and Minimalist Design | 3 | Clean sand/paper split; two 11px timestamps per exchange; seven-fact single line in the strip |
| 9 | Error Recovery | 2 | When Eva loses an answer the only signal is the question returning; strip's `pending` flag never set |
| 10 | Help and Documentation | 3 | Ready screen steps + Talk to GoStork Team are right; on phones that button is a 42x32 icon with the label hidden |

## Design Specificity Verdict
Specific in intent, generic at the peak. Named persona with title in one shared header (48px/17px, measured identical on all three chat routes), the "So far" memory strip, the ready screen's plain-words identity guarantee, and the fixed frames on the twins/termination questions (confirmed live) are GoStork's own. The climactic "Shall I find your matches now?" turn renders as a stock grey bubble with no card and no button.
Detector: 39 hits, 17 false positives (token radii/colour with fallbacks). Real: 21 literal 10-11px sizes (status pills, list-row times), one 4px side-tab on the provider sidebar row. Measured: titles on every route; role=log + aria-live; every header/composer control named; bottom nav named and hidden in-thread; bubble 13.35:1, parent 5.76:1, timestamps 6.64:1, strip labels 4.96:1 (lowest); zero hardcoded Tailwind colours; zero bounce; no horizontal overflow; 44px chips and toggle at mobile widths; intro/ready CTAs need a 41px scroll at 375x667 (scrollable now, no longer clipped).

## Priority Issues
- [P0] The curation turn has no action and has lost the answers it summarizes. Live: "Next: here's what I have: open to surrogacy in USA. Shall I find your perfect surrogate matches now?" rendered with 0 buttons; profile afterwards had surrogateTermination null and isFirstIvf null; twins asked twice; summary omitted family type, ages, twins, termination. Fix: (a) append a quick reply pair to the curation text (intake-questions.ts:821) or render a CTA for [[CURATION]]; (b) persist scripted chip answers on the bypass path (ai-router.ts:~7814), not only when Gemini emits [[SAVE]]; (c) D3 twins must accept "no preference" like A3 does (intake-questions.ts:772 vs 663); (d) persona-voice.ts: never prefix a curation/summary step with a lead-in. (/impeccable harden)
- [P1] Eva overrides the parent's own correction. "Not exactly" + Surrogacy/Egg Donation left needsClinic true; strip and A-cycle followed the stale flag. Fix: PATH B multi-select save writes needsClinic false; strip treats needsX === false as authoritative; one honest Eva line when a clinic is medically implied. (/impeccable harden)
- [P1] Quick replies are 13px under 21px mobile text. Fix: 15px mobile / 14px desktop via a brand var (concierge-chat-page.tsx:5382, 5420). (/impeccable typeset)
- [P2] "So far": folded ~36 chars; expanded 313px eats the log to 355px at 375x812 (sits outside the scroll container, concierge-chat-page.tsx:5027-5040); "Eggs Egg Donor"; stale clinic fact; pending never shown. (/impeccable clarify)
- [P2] Mobile header controls: back 32x32, team 42x32 with label hidden below sm (chat-thread-header.tsx:94, 144-164). Fix: h-11 w-11 below md; short visible "Team" label. (/impeccable adapt)
- [P3] CurationOverlay says "1,000+ providers" (concierge-chat-page.tsx:204), a count the prompt's own hard rule bans. Fix: "Searching our vetted network...". (/impeccable clarify)

## Persona Red Flags
Jordan: D1 leads with $70,850 / $114,900 / $77,480 one turn after "Not sure yet"; "How old are you?" bare on alternate turns; "perfect matches" sets the bar before the first card; curation turn with no button so Jordan types "ok".
Alex: never sees intro/ready, so the strip member line is the only orientation and sits under a 36-char fold; transcript opens "Hi Eran!" with one age; list row carries no shared-account cue.
Two dads / solo: intro previews "Top Clinics" + "Egg Donors" for a surrogacy family because it takes the first two goals in onboarding order (ai-intro-screen.tsx:80-81); partner invite is the second question, before any value; derivedFamily labels a partnered unmarried parent "Couple"; age from birth year can be off by one.

## Minor Observations
"Adam is ready..." trailing ellipsis reads as loading; three framing screens for a two-persona choice; picker copy "navigate providers, compare costs" drifts toward marketplace framing and the check badge is a text glyph; hex-alpha suffixes on brandColor in the team pill and composer will not follow an HSL brand change; attach drawer items and the logo link have no focus style; list-row accessible name concatenates "AAdam10hWhat are..." with no separators; historic threads keep the retired network counts; intro/ready CTAs still need a 41px scroll at 667px.

## Questions
What would it take to show the first match card after four questions instead of ten? Should the strip show a fact the moment Eva hears it, marked pending until saved? Is the persona choice worth its own screen before any value? Should six-figure numbers ever appear before the first card? What is the first thing an invited partner should read, and who writes it?
