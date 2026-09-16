---
target: the first Eva conversation
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx"
target_fingerprint: "sha256:1688143fdc1740c8d74d3e1a23d9419650ecd2d7dccf6b06cd53fb42caf61ab4"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx
timestamp: 2026-09-16T16-22-33Z
slug: client-src-pages-concierge-chat-page-tsx
---
# Critique: the first Eva conversation - run 4

Method: dual-agent (A: design review sub-agent, B: detector + browser-evidence sub-agent). LIVE INSPECTION LARGELY BLOCKED: the server supervisor was in a rebuild loop for ~25 min (uncommitted @nestjs/common 11.2.5 vs core 11.1.14 bump in the working tree, "Could not resolve sse-signal.decorator"); after it recovered the pane session was invalidated (401), so A reviewed from source only and B measured pre-rendered tabs whose transcript still ends on the pre-fix curation turn. Not like-for-like with run 3.

## Design Health Score: 26/40 (Needs work; 22 -> 25 -> 26 -> 26)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Pending facts show before save; curation overlay shows fake timed progress |
| 2 | Match System / Real World | 3 | Jargon: PGT-A, gestational surrogate, Open/Anonymous/Exclusive donor |
| 3 | User Control and Freedom | 2 | Chip sends immediately, no undo; overlay uninterruptible; no tap-to-correct |
| 4 | Consistency and Standards | 3 | Empty states route to /account/concierge (admin) instead of /matchmaker-selection |
| 5 | Error Prevention | 3 | Yes/no styling only on real pairs now; "Yes, I'm ready!" has no way back |
| 6 | Recognition Rather Than Recall | 3 | Newest-first fold; ~37 chars visible on a phone |
| 7 | Flexibility and Efficiency | 3 | Chips, free text, voice, multi-select |
| 8 | Aesthetic and Minimalist Design | 2 | Phase 0: two paragraphs + three gates before the first question; 7 embryo-count chips |
| 9 | Error Recovery | 2 | "Profile unavailable" card dead-ends |
| 10 | Help and Documentation | 2 | No per-question why beyond the two fixed frames |

## Design Specificity Verdict
Specific with one generic seam: the CurationOverlay (concierge-chat-page.tsx:200-300) is a fixed, blurred, portalled, timer-driven takeover with stock AI copy at the climax. Persona voice layer, pending-fact strip, honest ready screen and shared match card are GoStork's own. Detector 39 hits / 17 false positives; real: 21 x 10-11px literals, 1 side-tab. Measured (rendered tabs): 44px back/team on phones with visible "Team", chips 15px mobile / 14px desktop, one italic pending fact, all controls named, no overflow, no hardcoded colours.

## Priority Issues
- [P0] CurationOverlay is a full-screen modal with generic copy (concierge-chat-page.tsx:216-300). Fix: inline "working" turn in the persona's voice with the parent's real facts; thread stays visible; the real MATCH_CARD ends it. (/impeccable distill)
- [P1] Phase 0 explains before it listens: three gates + third introduction before Step 0 (ai-prompt-defaults.ts Phase 0, ai-router.ts:2535). Fix: drop the self-intro when the session comes from the ready screen; merge Parts 1+2 into one short paragraph with one gate; founder-vetting line moves to the first match card. Push to DB. (/impeccable distill)
- [P1] "Choose your concierge" empty states navigate to /account/concierge (conversations-page.tsx:2262, concierge-chat-page.tsx:4849); parent picker is /matchmaker-selection. (/impeccable harden)
- [P2] Match card Pass/Save post ghostwritten parent bubbles with an emoji (concierge-chat-page.tsx:2254-2256). Fix: system line + system trigger. (/impeccable harden)
- [P2] D1 is a brochure ("our most popular option", "delivered hundreds of healthy babies", intake-questions.ts:122-146). Fix: two turns; remove unsourced claim. (/impeccable clarify)
- [P3] Termination headlines the folded strip (what-i-know-strip.tsx fold). Fix: exclude from the fold. (/impeccable clarify)

## Persona Red Flags
Jordan: promise-breaking Phase 0; bare "How old are you?" and PGT-A; "Profile unavailable" dead end. Alex: "Age 38 · Partner age 41" with no owner; own/other bubble identity by exact senderName equality. Sam / two dads: "Couple" is the only unmarked family label; intro shows the first two goals only.

## Minor Observations
"Human" label on phones during takeover; Sparkles as generic AI glyph; persona difference oversold (half of scripted turns identical); curation summary is one lowercase list with a colon; expanded strip 321px on a 667px phone; success-token hex fallback is Tailwind green; empty-pane copy generic. Environment: uncommitted NestJS bump breaks the supervisor rebuild; sessions appeared to die on respawn during this run (unverified).

## Questions
Why does Eva's first act contradict "a few short questions, one at a time"? Should the first match ever be swipeable? Is six seconds of theatre more trustworthy than a visible thread? Why can't a parent fix a fact by tapping it? Is a persona picker the right first screen? Should Eva greet the second member?
