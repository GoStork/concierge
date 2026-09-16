---
target: the first match
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx"
target_fingerprint: "sha256:93ec1e54a7d1de703bbe9305d219dc2e8fd6d7f6bc6b55bc0f10f8524be8b94a"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx
timestamp: 2026-09-16T18-15-34Z
slug: omponents-marketplace-swipe-deck-card-tsx-f9cd6b03
---
# Critique: the first match (card in chat -> chips -> consultation -> calendar) - run 1

Method: dual-agent (A: design review sub-agent, read-only live at tab cap; B: detector + browser-evidence sub-agent, full live). Signed in, 1280x900 / 375x812 / 375x667. Consultation card, ack card and calendar assessed from source (A could not send turns). The live match message predates the blurb cap and decline-phrase change.

## Design Health Score: 21/40 (Needs work)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Whisper in flight leaves no visible open item |
| 2 | Match System / Real World | 1 | "Surrogate #23062" headline; tabs are DB labels; en dash in cost range |
| 3 | User Control and Freedom | 2 | Card X sends instantly, no undo in chat |
| 4 | Consistency and Standards | 2 | X ("show me someone else") vs chip (refinement flow): two behaviours, one intent |
| 5 | Error Prevention | 3 | Ack gate before calendar; identity reveal itself has no consent copy |
| 6 | Recognition Rather Than Recall | 1 | Six unlabeled 3px segments; tabs via invisible tap zones; no keyboard path |
| 7 | Flexibility and Efficiency | 3 | Chips + free text + card buttons; 44px chips |
| 8 | Aesthetic and Minimalist Design | 1 | Gradient covers 91% of the card; photo is a backdrop |
| 9 | Error Recovery | 3 | "This profile did not load / Ask for another" |
| 10 | Help and Documentation | 3 | Ack card copy is the clearest in the flow |

## Design Specificity Verdict
Specific component, generic moment: red X + green heart, ID number for a name, six slides of field labels over a dark photo. Detector: 26 real (inline px sizes across the card, 11px pills + 28px CTA on chat-booking-card, side-tab, 12 hardcoded white/zinc/black utilities), 5 false positives. Measured: card 0% visible at 375 when the reply lands (two log-heights above the fold), -255px at 1280; Pass/Save 56px named; View profile 36px, no focus style; slides have no keyboard path; alt text identical on all 6 photos; title contrast 2.09:1 over light photo; chips 44px mobile / 30px desktop; blurb 1880px tall at 375 (old message).

## Priority Issues
- [P0] Card off screen when the match lands (auto-scroll to bottom; concierge-chat-page.tsx:3514-3524, 3665-3671, 4425). Fix: scroll to the top of a message that carries matchCards; enforce blurb cap server-side. (/impeccable layout)
- [P1] Photo is a backdrop: chatMode keeps pt-24 pb-24 from-black/80 gradient + tab body + 56px buttons on the photo (swipe-deck-card.tsx:709, 1140-1190). Fix: photo on top, name-only scrim, cream sheet for tabs, actions off the photo. (/impeccable layout)
- [P1] Identity reveal has no consent copy: BookingForm (concierge-chat-page.tsx:527-663), ack card (consultation-gates.ts:1064-1069), confirmation (calendar.controller.ts:345). (/impeccable clarify)
- [P1] Card text/photos not curated for an intro: "Abortion: Yes / Selective Reduction: Yes / Carry Twins: No", "Other / Other / N/A" (swipe-mappers.ts:558, 875-879; format-label.ts:87 PLACEHOLDER_VALUE unused), children's photos in the hero (swipe-mappers.ts:620). (/impeccable clarify)
- [P2] Tabs unreachable without a pointer and unlabeled (swipe-deck-card.tsx ~650-676): tablist + prev/next buttons. (/impeccable audit)
- [P2] Chip row no hierarchy; X and chip disagree (concierge-chat-page.tsx:2181, 5303-5317; ai-prompt-defaults.ts ~1413 ten-option list). (/impeccable harden)
- [P3] Copy hygiene: en dash ranges (swipe-mappers.ts:884, profile-summary.ts:33/84); dash replacement without spaces (ai-router.ts:11935); *italic* unsupported (render-rich-text.ts:72); Experienced badge ~2.1:1.

## Persona Red Flags
Jordan: ID number, "Abortion: Yes" over children, learns the call is a match step only after tapping "free consultation". Alex: no chips on a non-last message; not pre-filled as attendee (concierge-chat-page.tsx:960-968). Two dads: "Same Sex Couple: Yes" restates the matched chip in field voice.

## Minor Observations
"Based in USA" trivially true reason; "Schedule with Jessica" drops masked agency context, uppercase tracking-wider; calendar day labels 10px @60%; slot grid text-xs on bg-muted; pending state promises an email with no turnaround; live persona register still warm (old message); whisper has no persistent state.

## Questions
Why is the fallback headline a database ID and not "a mom of three in Anthem, Arizona"? Should "pass" in chat be a sentence to Eva rather than a swipe control? What if the ack card's content came before the calendar chip? Where on screen does the parent see identity being revealed? Should a non-portrait ever reach a first-impression card, and who owns that rule?
