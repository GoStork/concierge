---
target: the first Eva conversation
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx"
target_fingerprint: "sha256:a6b7d959d752ccb1fcb510a6bc36eaccbeb1b55b305f7d490c0c8e2922e3c4d3"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx
timestamp: 2026-09-16T17-31-04Z
slug: client-src-pages-concierge-chat-page-tsx
---
# Critique: the first Eva conversation - run 4 (clean live pass)

Method: dual-agent (A: design review sub-agent, B: detector + browser-evidence sub-agent), signed in, 1280x900 / 375x812 / 375x667, one live "ready" sent. Overlay injection blocked (mixed content). Live build = last commit; the run-4 fixes written earlier (inline working turn, greeting, empty states, frames) are not deployed yet. Supersedes the blocked entry written earlier today.

## Design Health Score: 24/40 (Needs work; 22 -> 25 -> 26 -> 24)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Typed "ready": nothing distinct for 6.7s until the card |
| 2 | Match System / Real World | 2 | Strip labels are database words (Countries USA, Carrier Gestational Surrogate, Termination) |
| 3 | User Control and Freedom | 3 | No "I'd rather not say" on termination |
| 4 | Consistency and Standards | 2 | Same thread at two URLs; chip/timestamp values drift from DESIGN.md |
| 5 | Error Prevention | 1 | Stored transcript shows "He's 41, like I said" and twins twice (pre-fix history a returning parent still reads) |
| 6 | Recognition Rather Than Recall | 3 | Strip shows 8 facts; curation summary under it says only "open to surrogacy in USA" |
| 7 | Flexibility and Efficiency | 3 | Chips + free text, multi-select Done, voice |
| 8 | Aesthetic and Minimalist Design | 2 | First match = 236-word essay; bubble 1187px tall on a phone, card scrolled off the top |
| 9 | Error Recovery | 3 | Stream failure has no retry chip |
| 10 | Help and Documentation | 3 | "Match Call" never explained on first use |

## Design Specificity Verdict
Specific everywhere except the match moment: intro trio, persona framing, ready-screen privacy promise and the So far strip are GoStork's; the first match is a long grey essay with the card bolted above it and an "I don't like her" chip. Detector 39 hits / 21 false positives; real: 21 x 10-11px literals, 1 side-tab. Measured: no overlay in DOM, 44px back/team with "Team" label on phones, 15px chips mobile / 14px desktop, 1 italic pending fact, all controls named, no overflow, no bounce, titles everywhere.

## Priority Issues
- [P0] Match card Pass / Save / View profile icon buttons have no accessible name (client/src/components/marketplace/swipe-deck-card.tsx:319,641,866,1159,1178). (/impeccable audit)
- [P1] Card renders above the text that introduces it; "Here is her profile:" followed by 3 blank lines (concierge-chat-page.tsx card slot ~5175, line split ~5265). Fix: card after the colon paragraph, collapse blank runs. (/impeccable layout)
- [P1] First match is a 236-word essay in the wrong persona register. Fix: cap the match blurb, gate register by persona (prompt). (/impeccable distill)
- [P1] Pre-fix history (un-heard age, double twins) persists in old transcripts; expectation note, no code.
- [P2] Decline copy: "I don't like her" chip + Pass button (ai-prompt-defaults.ts:993,1410). Fix: one exit about fit. (/impeccable clarify)
- [P2] Curation summary reads profile.familyType (often null) while the strip derives family from gender/orientation (intake-questions.ts d_curation). Derive the same way. (/impeccable harden)
- [P3] Ready screen hides 20px at 667 tall; list-row aria-label "AI Concierge Chat" vs visible "Adam" (conversations-page.tsx:1921).

## Persona Red Flags
Jordan: ~450 words + price table before any question about her; the match essay where a face should be. Alex: header names a voice someone else chose; no later "Add my partner" affordance after "Not now". Two dads: intro shows Egg Donors / Top Clinics (first two goals in stored order).

## Minor Observations
Persona cards use per-component shadows; Tier 2 unspaced hyphens as dashes; disabled teal send circle before any text; timestamps 0.7 vs DESIGN.md 0.45; desktop thread column with 512px of sand either side and no list; All/Unread pills for a one-thread account.

## Questions
Should the summary just be the strip, spoken? What if the card were the message and the prose the caption? Is the picker a promise the scripted intake can keep? Should a five-figure table arrive before Eva knows one thing about the parent? Would GoStork be comfortable with how parents are taught to decline?
