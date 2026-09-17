---
target: the provider first login
total_score: 19
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/provider-home-page.tsx"
target_fingerprint: "sha256:fbfbaed47e415252df1a308cbb65e2583790ae75276fc0f3795399863c9712dd"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/provider-home-page.tsx
timestamp: 2026-09-17T14-09-45Z
slug: client-src-pages-provider-home-page-tsx
---
# Critique: the provider's first login - run 1

Method: dual-agent (A: design review, live in the user's Chrome as a provider admin at 36% onboarding, desktop 1512px + a same-origin 390px iframe for phone; email and set-password page from source · B: detector + read-only DOM evidence at 1512px). Read-only: no saves, uploads, sign-offs or check-offs.

## Design Health Score: 19/40 (Poor, high)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Progress reads "4/11" over 19 visible rows, no total time, no progressbar role, no live region; document.title empty on Home and every /account page. |
| 2 | Match System / Real World | 2 | "Settings -> Company" literal ASCII arrow 16 times; key video_room labelled "Review My Account"; the assistant is "Ariel" in some places and "Eva" in step labels. |
| 3 | User Control and Freedom | 2 | No snooze for the coach bar; a bobbing "Done" flag completes a step in one click with no undo; the page auto-scrolls 350px on arrival. |
| 4 | Consistency and Standards | 1 | The same completion action twice within 100px (green "All good - mark as done" + teal flag "Done"); a green CTA breaks the One Voice rule; the flag reads Next / Done / Got it by hidden state; "Three things on this page" vs "Section 1/5". |
| 5 | Error Prevention | 1 | On a phone the clearest control in the bar is the green 84x32 "Done" while the step name truncates to "Review your co..."; one tap self-attests "I reviewed what parents see". |
| 6 | Recognition Rather Than Recall | 3 | The Mirror strip and "Continue setup" keep the thread visible across 17 tabs. |
| 7 | Flexibility and Efficiency | 2 | No delegation to a teammate, no "these 3 now, rest later", no bulk pass through review-style steps. |
| 8 | Aesthetic and Minimalist Design | 2 | Expanded list: 16 group headings for 19 rows, 1415px tall (2.1 phone screens); Home has 10 cards and 12 tiles, mostly zeros. |
| 9 | Error Recovery | 2 | A cold load of /account/costs silently lands on /account; the work-queue failure state uses a check icon. |
| 10 | Help and Documentation | 2 | Descriptions are helpful but truncate to ~46 chars on a phone; nothing says what happens at 100% until the end. |

## Design Specificity Verdict
**LLM assessment:** a competent, generic setup guide speaking the wrong language. The mechanics are better than average (one derivation feeds the hub, coach bar and admin checklist; steps complete on real artifacts; the tour resumes after OAuth). The expression is a to-do list of Settings tabs. The provider joined to get families, and the only outcome sentence on the path is one step description. Home already holds the most motivating fact available (13 inquiries and a hot lead at 36% setup) as the eighth of ten cards, under six empty ones.
**Deterministic scan:** exit 0, 4 advisory font-size literals (11px and 10px in the hub and coach bar). Zero dashes, hex, palette utilities or dialogs. Six sites use the base status tokens as TEXT instead of the new -text tokens (provider-home-page.tsx:316, 321, 644, 668; onboarding-coach-bar.tsx:442, 448).
**Visual overlays:** not injected (real user browser session).

## Overall Impression
The plumbing is excellent and the collapsed "Next up" card is the right shape for a work tool. What fails is the first minute and the framing: a brand-new provider is told they are resetting a password, then lands on pages that never say how much work setup is, or why it matters, while a status-green button invites them to attest "reviewed" in one tap.

## What's Working
- One derivation, three faces: hub, coach bar and admin checklist cannot disagree; steps flip on real artifacts; the bar polls and celebrates in place.
- "Next up" anatomy: what, where, why and "~10 min" with one teal CTA; the list folds once past 25%.
- The Mirror strip: 50px, progress plus "Continue setup", never nagging.

## Priority Issues
- **[P1] The set-password page tells a new provider they are resetting a password.** The provider link carries no variant (provider-onboarding.controller.ts:653), so reset-password-page.tsx:133-138 renders "Reset your password" and auth-page.tsx:230 "has been reset successfully"; the only other variant is family copy. Fix: a data-driven audience (validate-reset-token returns it): "Welcome to GoStork - set your password", "Your account for {providerName} is ready", banner "Password set. Sign in to finish setting up {providerName}." /impeccable clarify
- **[P1] The coach bar asks for two competing actions, one in status green at 2.59:1.** "All good - mark as done" is white on #10b77f (201x40 desktop, 84x32 phone) beside an infinitely bobbing teal flag that also marks done on its last section; no reduced-motion guard on the bob; the phone label truncates so "Done" is the clearest thing in the bar. Fix: one completion control, teal, 44px on phone, shown after the last section or as a secondary "Mark reviewed"; bob twice then stop, never under reduced motion; label wraps to two lines. onboarding-coach-bar.tsx:309-332, 466-476. /impeccable harden
- **[P1] "How much work is this?" is never answered, and the list is organized by our nav.** 19 rows under 16 "SETTINGS -> X" headings, no minutes per row, no total (47 min required, 84 in all), "4/11" ignores 8 visible rows, 32px rows. Fix: two groups ("Required to go live - 7 left, about 45 min" and "Worth a look later"), the tab as a trailing muted label, minutes per row, an outcome headline ("7 steps until parents can find you"), 44px rows on phone, progressbar semantics. provider-own-onboarding.tsx:182-216. /impeccable distill
- **[P2] A day-one duplicate alarm and a broken deep link.** The queue shows "Connect your calendar - Overdue - medium" (systemKey calconn:) under a hub that already lists the calendar step; ONBOARDING_TASK_PREFIXES lacks calconn:. A cold load of /account/costs redirects to /account because showCosts is false until services load (account-page.tsx:1872, 2110). /impeccable harden
- **[P2] The setup path is invisible where providers live, and a real requirement is missing.** /chat and the nav carry no setup signal; Home says "Welcome back" on a first visit; the strongest motivator sits eighth; /account/security says two-factor is "Required from 9/15/2026" (past) and appears in none of the 19 steps; the first-ever landing coaches an optional step. Fix: a count dot on the Home pill, a slim Mirror strip in the /chat sidebar, a live demand line in the hub, two-factor as a required step, first landing on the next required step. /impeccable onboard

## Persona Red Flags
**Alex (owner):** no total time, no delegation though Team is step 7, 17 tabs of reviews one by one, "Overdue" on day one, will hit green "mark as done" without reading. **Jordan (first-time coordinator):** "Reset your password" reads as an error; the Company page opens mid-scroll with its heading under the bar; Next / Done / Got it mean three things; "Ariel" and "Eva" look like two assistants; a red Sign Out sits beside the coach on phone. **Sam:** empty titles; no progress role, value or live region; step status by icon and strikethrough only; no list semantics or aria-expanded; the flag is portaled to the end of the tab order; step rows use the browser's default focus ring; unlabeled inputs and switches across the account pages (0 of 9 labels have a for attribute on Company; every weekday switch unnamed on Calendar).

## Minor Observations
Hub buttons 32px with 12px text; the phone hub nests page, tray and card leaving a 262px text column; the "->" literal; the flag overlaps the logo dropzone, team search and upload icon; Payouts coach text says "through Stripe" while the page recommends entering bank info in GoStork; the work-queue failure state uses a check icon; service badges on Company are 2.31:1 (green on green tint); 43-54 decorative SVGs per account page without aria-hidden; Settings tab links have no focus-visible rule; raw Tailwind text sizes at call sites.

## Questions to Consider
If 13 parents are already asking, why is setup "Getting started" and not "13 parents are asking about you - 7 steps to let them book"? Should review-style steps be steps at all, or a faster "here is the parent's view, tap what is wrong"? Is a 19-row list ordered by Settings tab the provider's model or ours: what would three milestones look like (get visible, get bookable, get paid)? Why does the owner do all of it when Team could come second? What does a false "done" cost, and why is the fastest phone control the one that asserts it?
