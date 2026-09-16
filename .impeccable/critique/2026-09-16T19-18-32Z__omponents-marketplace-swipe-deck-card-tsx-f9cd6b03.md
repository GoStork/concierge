---
target: the first match
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx"
target_fingerprint: "sha256:19b702056bf718ee3e055e3326f2f13ce1e7000f4db9809be827b8bbb0684899"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx
timestamp: 2026-09-16T19-18-32Z
slug: omponents-marketplace-swipe-deck-card-tsx-f9cd6b03
---
# Critique: the first match - run 2

Method: dual-agent (A: design review, 6 live turns; B: detector + browser evidence). Signed in; tab cap forced a shared tab so B missed the arrival instant (A captured it at phone width). Fresh card rendered under the new rules; path walked to the booking form (no slot confirmed).

## Design Health Score: 22/40 (Needs work; 21 -> 22)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Calendar never shows its timezone (bookerTimezone computed, not rendered) |
| 2 | Match System / Real World | 3 | Slide phrasing right; masked agency renders "the Surrogate's Agency" |
| 3 | User Control and Freedom | 1 | "I have some questions" replaced the surrogate with a new card |
| 4 | Consistency and Standards | 1 | Three chip vocabularies on three consecutive cards; model-authored |
| 5 | Error Prevention | 2 | Empty bubble + the same 10 reason chips after "Something else" |
| 6 | Recognition Rather Than Recall | 3 | Ack card names the profile six times in 124 words |
| 7 | Flexibility and Efficiency | 3 | Partner pre-filled, form pre-filled |
| 8 | Aesthetic and Minimalist Design | 2 | Blurb: "another wonderful option", zero facts, direct persona |
| 9 | Error Recovery | 2 | The questions-became-a-card failure is silent |
| 10 | Help and Documentation | 3 | Consent line + ack explain; blurb does not do its job |

## Design Specificity Verdict
Specific at the card (matched reasons lead, "Mom of 2", "No C-sections", real tablist, lands on her face on a phone), generic after it (32px 12px calendar/form, title-case Confirm, 124-word institutional ack). Detector 21 real (inline px sizes in the shared card, 1 side-tab), 5 false positives. Measured: Pass/Save hidden in chat, View profile 36px with ring, chips 44px mobile, no <12px text, no overflow, blurb cap 219 -> 39 words.

## Priority Issues
- [P0] "I have some questions" discards the current match: declarative chip, no questions interceptor (ai-router.ts:8190-8196; FAVORITE pattern at 8272/8358). Fix: interceptor drops any new card on a questions reply. (/impeccable harden)
- [P0] Empty reply + 10-chip row after "Something else": QR injector at ai-router.ts:459 fires on empty text. Fix: never attach chips to an empty reply; route "something else" + "show me another" to a new search. (/impeccable harden)
- [P1] Blurb generic/off-voice; cap has no floor (ai-router.ts:10277-10290; ai-prompt-defaults.ts:1146-1160). Fix: regenerate once when no card fact is cited or a banned word appears for a direct persona. (/impeccable clarify)
- [P1] Chip vocabulary drifts per card (ai-prompt-defaults.ts:993; ai-router.ts:456, 7095, 8358; client 5296-5300 keys on text). Fix: one canonical post-card set injected server-side. (/impeccable harden)
- [P2] Calendar/form: 12px labels, 32px controls, var(--radius) not the pill, no timezone, Name/Email/Phone re-asked though pre-filled (concierge-chat-page.tsx:575-583, 1228-1298, 661-669, 1199-1205). (/impeccable layout)
- [P2] Ack card 124 words, senderName "GoStork", profile named 6x, "the Surrogate's Agency" (consultation-gates.ts:1060-1068, 1003-1006, 940-943). (/impeccable clarify)

## Persona Red Flags
Jordan: ten reasons to reject a woman right after "no", incl. appearance and BMI. Alex: asking a question loses the surrogate Eran was booking, no notice. Two dads: "Mom of 2" shown as a matched preference they never stated (card.reasons taken verbatim, concierge-chat-page.tsx:1720-1745).

## Minor Observations
Photo slides "Section 6 of 10" unnamed; View profile arrow disc over her face on phones; desktop bubble 592px under a 380px card; "Confirmed by Eran" third person to Eran; month prev/next 28px unnamed; day buttons no focus style; disabled days 0.2 alpha; requirements block wording with multiple failures; callback card uppercase tracking-wider header.

## Questions
Why does a parent ever see ten reasons to reject a woman? What if the confirmation re-showed her photo and reasons? Could the ack be one line in the calendar header? Should the blurb be assembled from the card's facts plus one model clause? Who owns the words the parent taps, the prompt or the product?
