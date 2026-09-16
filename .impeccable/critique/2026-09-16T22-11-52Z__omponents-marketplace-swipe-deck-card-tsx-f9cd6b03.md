---
target: the first match
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 1
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx"
target_fingerprint: "sha256:19b702056bf718ee3e055e3326f2f13ce1e7000f4db9809be827b8bbb0684899"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx
timestamp: 2026-09-16T22-11-52Z
slug: omponents-marketplace-swipe-deck-card-tsx-f9cd6b03
---
# Critique: the first match - run 3

Method: dual-agent (A: design review, 7 live turns; B: detector + browser evidence). Signed in; shared tab (cap). Whole path walked live with the run-2 fixes deployed.

## Design Health Score: 23/40 (Needs work; 21 -> 22 -> 23)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | New card lands with 38px visible on a phone: landing effect finds no testid on the loading placeholder |
| 2 | Match System / Real World | 3 | Blurb "first-time surrogate" vs Q&A "one transfer, no pregnancy achieved" |
| 3 | User Control and Freedom | 1 | "Not the right fit for us" answered with a calendar for the same surrogate; three live calendars for one agency |
| 4 | Consistency and Standards | 2 | Canonical chips only on the card turn; next turn reverts to prompt-authored labels, none filled |
| 5 | Error Prevention | 3 | Ack-before-calendar and consent line strong; duplicate calendars posted |
| 6 | Recognition Rather Than Recall | 2 | Chips 850px below the face on a phone; vanish after the next turn |
| 7 | Flexibility and Efficiency | 3 | Typed questions stay on the profile; contact summary with Edit |
| 8 | Aesthetic and Minimalist Design | 2 | Uppercase tracked calendar header; 10 x 3px tabs; 21px ack eyebrow |
| 9 | Error Recovery | 2 | Composer swallowed one message silently (possibly the pane) |
| 10 | Help and Documentation | 3 | Info-call one-liner is exactly right |

## Confirmed fixed (live)
Questions chip invites the question, no new card; blurb 41 words citing age/state/births, no banned words; canonical 4 chips with one fill on the card turn; ack 61 words in Adam's name; calendar timezone, named 36px month buttons, 40px days, 44px pill slots.

## Priority Issues
- [P0] Pass answered with a calendar for the same surrogate; duplicates (ai-router.ts isSkipAction ~8263 guards only the question interceptor; Processing CONSULTATION_BOOKING ~11193). Fix: deterministic pass suppresses booking tags; no second live calendar per provider. (/impeccable harden)
- [P0] New card lands off screen: MatchCardComponent loading branch (~2206) has no match-card testid; landing effect (~3764) never retries. (/impeccable layout)
- [P1] Chip vocabulary canonical only on card turns (ai-prompt-defaults.ts:994, 1381; ai-router.ts canonical block; client cardForChips keyed on msg.matchCards). (/impeccable harden)
- [P2] "Confirmed by Eran" to Eran: first-name vs full-name compare (consent-ack-card.tsx:199). (/impeccable clarify)
- [P2] Ack fork button Orchid + 36px (consent-ack-card.tsx:296-321). (/impeccable harden)
- [P3] Medical-history answers unframed; "first-time" vs prior journey (post_match_behavior). (/impeccable clarify)

## Persona Red Flags
Jordan: pass becomes a re-sell; "no pregnancy was achieved" raw. Alex: three identical calendar trays, no way to tell which is live; chips gone from older messages. Solo parent: "open to single parents" false is silently omitted; surface before consent.

## Minor Observations
Photo tabs "Section 6 of 10"; header 12px uppercase tracked; retry prompt hardcodes "You are Ariel" (ai-router.ts ~7161); ack eyebrow inherits 21px; chips wrap one per row at 375; attendee sub-form inputs 28px.

## Questions
Is Pass a chip or a hope if a sentence can be heard as "book me"? Should a new calendar ever post while one is live for the same provider? Why is the rejection turn the only high-stakes moment with no deterministic copy?
