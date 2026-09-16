---
target: the first Eva conversation
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx"
target_fingerprint: "sha256:65992d6d601f5bbca510a7c847201fb07d4afd2cd295453848f4f68c05f1a00b"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx
timestamp: 2026-09-16T02-10-00Z
slug: client-src-pages-concierge-chat-page-tsx
---
# Critique: the first Eva conversation (persona picker -> intro -> /concierge chat) - run 1

Method: dual-agent (A: design review, B: detector + browser evidence), signed-in fresh parent account, 1280x900 + 375x812. In-page detector could not run (pane blocks localhost script on https); CLI scan + DOM measurements only.

## Design Health Score: 22/40 (Needs work)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Fast typing dots / first token; subtitle flicker on load |
| 2 | Match System / Real World | 1 | "fraction of US" over a table showing Mexico higher; mock meeting dated 5 months ago |
| 3 | User Control and Freedom | 1 | Back -> about:blank (replace:true chain); no edit / summary |
| 4 | Consistency and Standards | 3 | Hardcoded pink/amber tints on onboarding-ai-intro-page |
| 5 | Error Prevention | 2 | Decline chip expanded into a stronger claim |
| 6 | Recognition Rather Than Recall | 3 | Asks partner age just given |
| 7 | Flexibility and Efficiency | 2 | Composer disabled while sending -> loses focus |
| 8 | Aesthetic and Minimalist Design | 2 | 154 + 96 word monologues before first question |
| 9 | Error Recovery | 2 | No acknowledgment of a correction |
| 10 | Help and Documentation | 3 | Talk to GoStork Team always present; no "what I know so far" |

## Design Specificity Verdict
Authored shell, generic engine: every intake turn a verbatim template regardless of persona; whisper/anonymity never surfaced. CLI: 43 findings, 40 false-positive/trivial (var fallback radii, 10-11px timestamps/badges, fallback green); real: animate-bounce typing dots (concierge-chat-page.tsx:5633,5675), 4px left border selected row (conversations-page.tsx:2636), 11px timestamps. Measured: assistant bubble 13.4:1, parent 5.8:1, timestamps 2.9:1 effective; composer no label; send/back no name; no role=log/aria-live; document.title empty; persona cards div onClick no keyboard; mobile bottom-nav icons unnamed; no horizontal overflow at 375.

## Priority Issues
- [P0] expandQuickReply (concierge-chat-page.tsx:4615) sends "No, I'm not specifically looking for a clinic" for "Not exactly"; prompt (ai-prompt-defaults.ts:422) treats it as licence to skip Step 0; Step 1 embryos also skipped; IVF cycle A1-A4 run on two dads. Fix: verbatim/weaker chip text; gate questions skippable only on saved profile fields. (/impeccable harden)
- [P0] "I'm 38 and my husband is 41" -> "And how old is your partner?" -> "He's 41, like I said" -> "Are you hoping for twins?". Fix: parse compound ages; acknowledgment rule after repeat/correction (DB prompt section). (/impeccable clarify)
- [P1] replace:true chain (matchmaker-selection-page.tsx:84, onboarding-ai-ready-page.tsx:32, onboarding-ai-intro-page.tsx:144) -> Back exits; answered QRs removed (~:4046); no edit/summary. (/impeccable harden)
- [P1] Turns 3-4 monologues; turn 7 self-contradicting price claim; unverified network counts in prompt. (/impeccable distill)
- [P2] A11y: persona radiogroup, aria-labels (back, send), role=log, timestamp contrast, 44px chips. (/impeccable audit)
- [P3] Composer disabled={sending...} (~:5853) drops focus each send; not focused on mount.

## Persona Red Flags
Jordan: 2-screen monologue; bare "How old are you?"; mock Meeting Confirmed = loss of control; header dominated by Talk to GoStork Team; Back leaves app.
Alex: transcript addressed to Eran, no sender names, no catch-up; desktop /chat empty state with single thread unselected; "Not now" visible after later invite.
Solo / same-sex: chips inclusive; no "Something else"; no solo family-member offer; intro always Ariel + stock doctor/donor.

## Minor Observations
Persona voice never heard (generic greeting ai-router.ts:2488); intro closes on the glitch disclaimer; D1 ack dropped; trailing hyphen artifact (ai-prompt-defaults.ts:384-386); affirmative chip also over-expanded; ready page defaults to "fertility clinic"; "Your AI Matchmaker" subtitle; voice preview renders nothing.

## Questions
Persona theatre? Lecture before listening? Where is anonymity explained? Who audits expandQuickReply against skip rules?
