---
target: the first match
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx"
target_fingerprint: "sha256:dcb36048a137c9cb793432ca221a52606a51ee67c4335be8f3cc700d2b38035d"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/components/marketplace/swipe-deck-card.tsx
timestamp: 2026-09-17T00-16-57Z
slug: omponents-marketplace-swipe-deck-card-tsx-f9cd6b03
---
# Critique: the first match - run 4 (clean re-run)

Method: dual-agent (A: design review, 4 live turns on desktop and phone; B: detector + read-only DOM evidence). Shared tab (cap). Run 3's fixes were deployed before this run.

## Design Health Score: 20/40 (Acceptable, low; 21 -> 22 -> 23 -> 20)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | New card lands at +12px within 12s and holds (fixed). But the four chips then sit 123-279px below the pane bottom on a phone, and a reload lands 259px below the last card. |
| 2 | Match System / Real World | 2 | "first-time surrogate ... three live births" beside a "Mom of 3" chip; "free consultation" with no provider named; product term is Match Call. |
| 3 | User Control and Freedom | 1 | "I have questions about her" returned a DIFFERENT surrogate (#23065 under #23078) with no acknowledgment; chips render only on the last message, so the person just asked about has no actions left. |
| 4 | Consistency and Standards | 3 | Canonical four chips held on all three card turns (fixed); refinement chips identical between prompt and guard. |
| 5 | Error Prevention | 2 | Pass guard held: no calendar, no card (fixed). The thread still carried the pre-fix "#23076" blurb under the #23073 card; the CAP path keeps the model's first three sentences unchecked. |
| 6 | Recognition Rather Than Recall | 2 | Five of six card sections behind 3px tab bars and an unmarked right-half tap zone; the blurb repeats the three chips instead of what the card hides (agency, cost band). |
| 7 | Flexibility and Efficiency | 3 | 44px chips on phone, free text works, Save persists. |
| 8 | Aesthetic and Minimalist Design | 2 | Card + blurb = 927px per turn on a 609px pane; the ten-reason bubble is 670px and its question scrolls off on arrival; the card overlay covers 59% of the photo in chat. |
| 9 | Error Recovery | 1 | A 42-char profile lookup was silently converted into a different woman, and the model's internal reasoning ("The parent is asking about Surrogate #23078...") streamed to the parent for ~2s before the reset. |
| 10 | Help and Documentation | 2 | No gloss for Match Call, BMI or "first-time surrogate"; SO FAR bar truncates. |

## Design Specificity Verdict

**LLM assessment:** distinctive shell, generic moment. The card is specific (photo hero, 29px headline, orchid checks, teal matched chips, one filled action). The moment reads as a chat transcript wrapped around a marketplace card: LLM filler in a Straight Talker costume ("aligning perfectly with your path to parenthood"), a 258px-wide bubble of 21px type on a phone (about 18 characters per line), and a deck-mode overlay never re-cut for chat.

**Deterministic scan:** exit 0, 31 advisory findings in two rules: 17 font-size literals (nine inline 13px sizes on the card slides, 20/38/42px display sizes, three 10px labels in the chat page) and 14 radius literals (0.5rem in the chat page; the consent-ack 8px is a token fallback, false positive). Zero hardcoded fills in the card; ten legacy brand-hex fallbacks in the chat page's chip styles (old accent #0DA4EA) that only apply when brand settings are missing. One em dash in a code comment. No dialogs. The detector agrees with the review on off-ramp sizes; it cannot see the question-turn regression, the reasoning leak, or the below-fold chips.

**Visual overlays:** not injected (shared tab).

## Confirmed fixed since run 3 (live)
Card lands at the top of the log and holds while the prose drains (+12px through t=34s, fraction 1.0). Pass returns the refinement question with ten chips, no calendar, no card. Canonical four chips on every card turn. Blurb and card named the same profile on both fresh turns.

## Priority Issues
- **[P0] "I have questions about her" replaces the person.** The question interceptor requires the model to have shown a new match at that instant; here the model emitted no tag, the profile lookup came back 42 chars, the model searched again, the prose fallback injected a card, and the FLOOR rewrite introduced #23065. Fix: handle the question intent deterministically before Tier 2 (no tools; "Of course. What would you like to know about her?"), make the fallback and owed-card injectors no-ops on a question turn, and when the profile lookup fails say so in second person instead of searching. ai-router.ts asksToAsk (~8306), MATCH_CARD FALLBACK (~10564/10640), FLOOR (~10744). /impeccable harden
- **[P1] Chips below the fold after a card lands (phone).** Bubble 258px wide (avatar indent + 85%), 57 words become 12 lines, card + bubble 927px. Fix: let the AI bubble under a card span the card width on phones (chip-styles.ts:21), tighten the person-card CAP to about 40 words / 2 sentences, or render the four chips directly under the card before the prose. /impeccable layout
- **[P1] Internal reasoning streams to the parent.** Tier 2 prose streams before CAP/FLOOR; the reset fires only after the retry (~10766). Fix: hold prose for person-card turns until the checks pass, or strip third-person "The parent ..." sentences before the first token. /impeccable harden
- **[P2] The overlay sits on her face in chat.** The gradient block reserves pb-24 for the action row (swipe-deck-card.tsx:735) but chat hides the actions, so content rides 90px too high and covers 59% of the card. Fix: pb-6 when hideActions; consider dropping the "Matches N" line in chat when the chips carry check marks. /impeccable layout
- **[P2] Ten-reason presentation.** 670px bubble, 9 rows, the question scrolled off on arrival, body-related reasons second and seventh. Fix: full-width bubble so two chips fit per row, land the bubble top like a card, softer reasons first, add "I'd rather not say". /impeccable layout
- **[P3] Copy.** "first-time surrogate ... three live births" next to "Mom of 3": say "her first surrogacy journey, mom of three"; add "perfectly" and "aligning" to the direct-persona banned list. /impeccable clarify

## Persona Red Flags
**Jordan:** "first-time" vs "Mom of 3"; consultation with an unnamed provider; no Match Call definition; BMI and C-sections as bare chips. **Casey:** 1.5 viewports per card turn; primary Schedule chip at y=927; sections behind an invisible tap zone and 3px bars; 36px View-profile button. **Sam:** img alt duplicates the h3 (announced twice); 42x3px tab buttons; streamed reset may announce prose twice; tablist has no aria-controls or tabpanels.

## Minor Observations
Sender label "Adam" clipped by the SO FAR bar on phone; card entry animation has no reduced-motion guard (chat page ~2226) while the text drain does; chip text 15px on phone vs the 13px quick-reply spec; nine 13px inline sizes on the card slides; legacy brand-hex fallbacks in chip styles; desktop chips 30px tall.

## Questions to Consider
Why does any canonical chip reach the model at all? Should the blurb say what the card cannot show (agency, cost band, availability)? Is "Schedule a free consultation" with an unnamed agency the right primary action on first meeting, or is "Ask about her" the parent-first default? Why must a parent grade a woman's appearance or BMI to be shown the next person?
