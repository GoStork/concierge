---
target: parent home
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/parent-home-page.tsx"
target_fingerprint: "sha256:91512c8809b035c42c63bc45aa0e3cf4d89cc7a8b242df50395aa6526bd64217"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/parent-home-page.tsx
timestamp: 2026-09-16T23-51-36Z
slug: client-src-pages-parent-home-page-tsx
---
# Critique: Parent Home (/home) - client/src/pages/parent-home-page.tsx

Method: dual-agent (A: design review sub-agent with browser · B: detector + read-only DOM sub-agent). Measured live on dev-mbp at 1024x768 and 375x812, account with 2 journeys at "Registered", no meetings, cost sheets, invoices or agreements.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | While the queue query is in flight the card shows the green "You're all caught up" line (10s on phone), then flips to "Needs your attention (2)". |
| 2 | Match System / Real World | 2 | Ladder rungs are CRM vocabulary shown to a parent: "Registered", "Parent Form Submitted", "Invoice Sent", "Handed Off". "Deposit payment" appears before any price. |
| 3 | User Control and Freedom | 2 | Both "Explore" rows go to the same bare /marketplace; meeting details open a modal; "Pay now" opens a new tab. |
| 4 | Consistency and Standards | 2 | Neutral empty states in success green; journey trays use a gray border, not the warm hairline; 20px card padding vs 24px; h1 24px vs 30px token. |
| 5 | Error Prevention | 2 | "Cancel Booking" fires on one click with no confirmation. |
| 6 | Recognition Rather Than Recall | 2 | On a phone both attention rows truncate to "Start exploring ..." / "Ariel has matches" (115px text column). |
| 7 | Flexibility and Efficiency | 3 | Deep links to the exact chat message are excellent; held back by a 60x16px CTA. |
| 8 | Aesthetic and Minimalist Design | 2 | At 1024px the horizontal ladder puts 11px labels in 47px columns and 15 of 23 collide; two zero KPI tiles on an empty account. |
| 9 | Error Recovery | 1 | Every failed query is silent and renders as "all caught up". |
| 10 | Help and Documentation | 3 | Empty-state copy explains when things arrive; no way to ask what a rung means. |
| **Total** | | **20/40** | **Acceptable (low)** |

## Design Specificity Verdict

**LLM assessment:** an authored shell around an interchangeable dashboard. The material system is unmistakably GoStork (Warm Sand page, Paper trays with the 1px warm hairline and 32px radius, rest shadow only, Linen stat tiles, teal 6%/18% task rows). The information design is a generic SaaS home: greeting, a numbered attention queue, a 2x2 of summary cards with "View all", two zero KPI tiles. The one signature element, the journey ladder, is the provider CRM ladder verbatim pointed at the parent. Ariel exists only as a name in a 13px helper line. Principle 1 says "guide, do not list"; this page lists.

**Deterministic scan:** exit 0, 3 advisory findings, all `design-system-font-size` in journey-timeline-card.tsx (:234 and :309 `text-[11px]` rung labels, :687 event label not rendered on /home). Zero hardcoded colors, zero palette utilities, zero em/en dashes in the six files. Out of scope but live on the page: ServiceTag renders 10px uppercase text. Detector agrees with the review on the rung label size; it cannot see the loading-state, contrast, truncation or breakpoint problems the review found.

**Visual overlays:** not injected (shared tab; injection would have disrupted the parallel review). No user-visible overlay is available for this run.

## Overall Impression

The chrome is right and the deep links are thoughtful, but on the day a parent needs this page most (nothing booked yet) it is six cards proving absence, a ten-second false "all caught up", and 22 unfilled CRM rungs ending in "Handed Off". The biggest opportunity is to make Home read as Ariel's one-paragraph status plus only the sections that exist yet, with a parent-language ladder that shows done, now and next.

## What's Working

- **The material system is applied correctly.** Measured values match DESIGN.md almost exactly: Paper on Sand, 1px warm hairline, 32px trays, Linen recede tiles, teal task tint.
- **Deep links carry context.** Cost sheet rows land on the exact quote message, the IP form resumes at the last section, proposals open at the proposal message (parent-home-page.tsx:230, 253, 292).
- **Empty-state copy explains the future.** "Providers share their pricing here after your consultations" is the best writing on the page and should own its tone.

## Priority Issues

- **[P0] Loading and error states render as success.** `actionCount` is 0 while the queue query is in flight and after any failed fetch, so the card prints the green "You're all caught up" line; measured for 10s on phone, permanent on error. A parent with an unpaid invoice or unsigned agreement is told nothing is waiting. Fix: track loading and error across the five queries; skeleton row while loading, inline "We couldn't load your tasks. Retry" on error, caught-up line only once everything resolved. parent-home-page.tsx:155-164, 184-188, 323-326. Suggested: /impeccable harden.
- **[P1] Horizontal ladder labels collide at lg widths.** The desktop ladder switches on at 1024px where 12 columns give 47px of label width; "Consultation" is 68px, so 15 of 23 labels overflow into neighbours. Fix: switch at xl (about 81px columns) or give columns a min-width inside an overflow-x track. journey-timeline-card.tsx:629, 208-210, 233-237. Suggested: /impeccable adapt.
- **[P1] Status colours as text fail AA.** Success green on white 2.6:1 at 14px ("all caught up", "No upcoming meetings", "Paid", "Signed"); warning amber on its tint about 2.0:1 at 12px ("Awaiting Payment", attention chip); Egg Donation ServiceTag 2.9:1 at 10px, Surrogacy 4.3:1. Fix: add darker `--brand-success-text` and `--brand-warning-text` steps like the existing error-text token, use ink for neutral empty states, lift ServiceTag to 11px with a darker text step. invoice-status-badge.tsx, agreements-list.tsx, journey-timeline-card.tsx:160/426, parent-home-page.tsx:185/324, ui/service-tag.tsx. Suggested: /impeccable audit.
- **[P1] The two "Explore" rows are indistinguishable on phone and go to the same place.** Titles truncate to "Start exploring ..." and details to "Ariel has matches"; both CTAs route to bare /marketplace. Fix: lead with the differentiator ("Surrogacy: explore your matches"), allow two-line titles, route each row to the service-scoped marketplace, collapse rows that would share a URL. parent-home-page.tsx:147; home-sections.tsx:38-39. Suggested: /impeccable clarify.
- **[P2] QueueRow accessibility.** The "Explore" CTA is a 60x16px button separate from the 40px row button that does the same thing (two tab stops per row), the row's accessible name concatenates title and detail with no separator, and focus falls back to the UA outline, not the Stork Teal ring. Fix: one button per row at min-h-11 with the CTA as a presentational span, brand focus ring, sr-only separator. home-sections.tsx:32-57. Suggested: /impeccable audit.
- **[P2] Meeting details are a modal with one-click cancel and third-person pills.** BookingDetailDialog opens a Dialog for read-only details plus Reschedule and Cancel; cancel mutates immediately; pills read "Parent Cancelled" to the parent; inputs are 12px (iOS zoom) and buttons 28px. Fix: expand inline under the row or link to the calendar with the booking selected, confirm cancellation, second-person pills. booking-detail-dialog.tsx:186-187, 371, 250-256. Suggested: /impeccable harden.

## Persona Red Flags

**Jordan (first-timer):** 22 empty rungs including "Parent Form Submitted" and "Handed Off" with no explanation; "(2)" attention count for what are suggestions; "deposit payment" before any price; both Explore rows do the same thing; nothing says "talk to Ariel" as the next move.

**Casey (one-handed phone at night):** 2580px page with 1161px of empty ladder before billing; the 60x16px "Explore" target near the right edge; both rows read identically; 10s of "all caught up" then a flip; "Pay now" opens a new tab, which leaves a home-screen web app; the "Upcoming meetings" h2 wraps to two lines beside "View all".

**Sam (screen reader / keyboard):** document.title is empty so the page announces as its URL; two tab stops per row with identical purpose; UA focus ring; the ladder is 46 divs with no list semantics and no aria-current="step", so state is conveyed by dot fill only; 8 standalone icons lack aria-hidden; success and amber text at 2.0 to 2.6:1.

## Minor Observations

- Tailwind text sizes throughout (text-2xl h1 at 24px vs the 30px token, text-lg, text-sm, text-xs, text-[11px], 10px ServiceTag), all bugs under the Brand Variable Rule.
- Card padding p-5 (20px) vs the system's 24px.
- Journey tray borders resolve to gray-200 because `border` is used without the border token (journey-timeline-card.tsx:631, 641).
- Invoices shows "$0" and "0" tiles on an empty account while Cost Sheets and Agreements use a sentence; pick one behaviour.
- Agreements empty state is centred with a 32px icon and py-10; Cost Sheets is left-aligned text with py-2; they sit 20px apart.
- Section header icons (8) carry no aria-hidden; no section or list landmarks inside main.
- Booking times use the browser locale, not the account's schedule timezone.

## Questions to Consider

- If Chat is the front door and Home is the overview, why does Home not open with Ariel's one-sentence read of where things stand, in her voice?
- Should a parent ever see 12 rungs? What if the ladder showed done, now and next, with "show the whole road" as an inline expand?
- Why does the parent see CRM stage names at all? A parent-facing label map costs one object and changes the emotional register.
- Is "Needs your attention" the right container for suggestions? If standing next-steps lived under their journey, the attention card's empty state could be honestly reassuring.
- What is this page for on the day the account has nothing in it? Could Home skip sections that are empty and unreachable yet, and grow as the journey does?
