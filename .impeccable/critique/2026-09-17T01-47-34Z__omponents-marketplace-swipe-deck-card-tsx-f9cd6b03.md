---
target: the first match
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx"
target_fingerprint: "sha256:8886f6e8f50948b29c3eaaa8fe0909404fd5a45b7a730f79a68806cad763320a"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx
timestamp: 2026-09-17T01-47-34Z
slug: omponents-marketplace-swipe-deck-card-tsx-f9cd6b03
---
# Critique: the first match - run 5 (clean re-run after run 4 fixes)

Method: dual-agent (A: design review, 4 live turns on phone + desktop inspection; B: detector + read-only DOM evidence). Shared tab (cap). Live lane this run was egg donation (Donor #61268).

## Design Health Score: 26/40 (Acceptable, high; 21 -> 22 -> 23 -> 20 -> 26)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Card arrives in 8.5s, lands at +33px fully visible and holds (fixed). After Save nothing changes on the card and no toast fires; prose is the only evidence. |
| 2 | Match System / Real World | 2 | The pass-reason list served for an EGG DONOR was the surrogate list (pregnancies, C-sections, BMI). "Fresh Donor" is trade jargon. |
| 3 | User Control and Freedom | 3 | "I'd rather not say" exists but is chip 11 of 11, 95px below the fold. No undo on Save. |
| 4 | Consistency and Standards | 2 | Chips sit under the card on card turns but inside the bubble on the next turns. Save posts "Save Donor #61268 as a favorite." as the parent's own words. |
| 5 | Error Prevention | 3 | Canonical chips deterministic (confirmed: card count unchanged across question and save). The row re-offers "I have questions" right after a question. |
| 6 | Recognition Rather Than Recall | 3 | Card and chips co-located (fixed). The prose question arrives 224px below and repeats the chips. |
| 7 | Flexibility and Efficiency | 3 | Free text stays on the same person. Eleven pass reasons render one per row: a 572px tower, three under the fold. |
| 8 | Aesthetic and Minimalist Design | 2 | 35 progress segments (4 sections + 31 photos) at about 6x3px across a 303px card. A 66-word blurb follows a decision the chips already posed. |
| 9 | Error Recovery | 3 | Missing data answered honestly ("no previous retrieval numbers on file"). No leaked reasoning in four turns (fixed). |
| 10 | Help and Documentation | 2 | "Fresh Donor", "Overview", "free consultation" with an unnamed agency; the 36px arrow button has only an aria-label. |

## Design Specificity Verdict
**LLM assessment:** specific card, generic conversation around it. The card is unmistakably GoStork (29px heading, one filled teal chip, linen secondaries, 44px targets). What the concierge says around it is interchangeable AI chat: a bubble restating the card's own fields and closing with a question the four chips already ask. The blurb should be the one thing the card cannot show: why her, for this family.
**Deterministic scan:** exit 0, 31 advisory findings in two rules; all 14 radius hits are the fallback arm of a token read (false positives); the 13px cluster is one card-meta size repeated; every card entry animation is now motion-safe. One em dash in a code comment. No dialogs.
**Visual overlays:** not injected (shared tab).

## Confirmed fixed since run 4 (live)
Landing at +33px with the sender label 12px below the log top, chips between card and prose, bubble equal to the card width, blurb and heading name the same profile, no contradiction, no "perfectly"/"aligning", canonical chips never reach the model, no scratchpad text.

## Priority Issues
- **[P1] 35 tap targets of about 6x3px on the chat card.** Each photo is a role=tab button; a screen reader hears "Photo 12 of 31" thirty-one times. Fix: in chat mode collapse photos into one "Photos" segment (4-5 tabs) and give each segment a 24px hit area while keeping the 3px bar. swipe-deck-card.tsx:654-675. /impeccable audit
- **[P1] Pass reasons are not typed to the service line.** A donor gets pregnancies, C-sections, BMI. Fix: one list per type (donor: location, cost, age, education, medical or genetic history, appearance, personality, donation history, something else, rather not say) and keep "I'd rather not say" visible without scrolling. ai-router.ts canonical bypass, chip table, pass guard. /impeccable clarify
- **[P2] The fourth chip is under the fold on the card turn.** "Not the right fit for us" at y=752-796 against a 752px log bottom. Fix: collapse the SO FAR strip while a card lands, or a 4/5 aspect in chat mode. concierge-chat-page.tsx:5502. /impeccable layout
- **[P2] The blurb repeats the card and the chips.** Fix: strip a trailing question sentence when quick replies are present, and require the sentence to cite a stated preference rather than card fields. ai-router.ts CAP block. /impeccable clarify
- **[P2] Save writes words into the parent's mouth and leaves no trace on the card.** Fix: show the chip label as the parent's message and flip a heart on the card from the persisted favorite. concierge-chat-page.tsx:5405-5408. /impeccable delight
- **[P3] Chip home moves** (under the card on card turns, inside the bubble otherwise). One rule: always under the bubble. /impeccable layout

## Persona Red Flags
**Jordan:** "Fresh Donor" and "Overview" unexplained; C-section questions about a donor read as not listening. **Casey:** 6x3px segments; fourth chip and three pass reasons need a scroll; 21px body in a 460px bubble costs a thumb-scroll. **Sam:** 35 tabs per card; choices read before the explanation; hidden action row correctly display:none.

## Minor Observations
Chip tower pairing misses the inner width by 9px ("Her age" + "Too many pregnancies"); the title block covers 50% of the card; desktop chips 32px and phone 44px as specified; two zero-height gradient elements from the hidden action buttons.

## Questions to Consider
Why does the concierge speak after the decision chips rather than one sentence between the face and the buttons? Why does a recommendation card carry 31 photos? Should the first pass trigger a reason survey, or the second? Would a parent trust a transcript with a sentence they never typed?
