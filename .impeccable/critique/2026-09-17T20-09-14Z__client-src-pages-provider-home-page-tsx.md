---
target: the provider first login
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/provider-home-page.tsx"
target_fingerprint: "sha256:392e1282f7c172bc749c163171aeca6e17e52d7551fdbb5811d585d91c7800a5"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/provider-home-page.tsx
timestamp: 2026-09-17T20-09-14Z
slug: client-src-pages-provider-home-page-tsx
---
# Critique: the provider's first login - run 2 (clean re-run)

Method: dual-agent (A: design review, live in the user's Chrome as a provider admin at 4 of 11 required steps, desktop 1440px + a same-origin 390px iframe for phone; email, set-password page and login banner from source · B: detector + read-only DOM evidence at 1440px). Read-only.

## Design Health Score: 25/40 (Acceptable; 19 -> 25)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Counts agree on every surface (hub, rows, nav badge, Chats strip: 7 steps / 47 min). The Home pill badge is an 8px "7" in a 14px chip. |
| 2 | Match System / Real World | 3 | Calendar bar says "Three things on this page" while the tour says "Section 1/5". |
| 3 | User Control and Freedom | 2 | The tour scrolls the page on load (400px on phone at company, 252px on payouts); nothing pauses it. |
| 4 | Consistency and Standards | 2 | Up to three identical filled teal pills on one page (team); every settings page is titled "Settings - GoStork"; the flag reads Next / Done / Got it. |
| 5 | Error Prevention | 2 | A 10-minute review can be marked done in one tap at first paint (44px "Done" on phone) with no undo; on artifact pages "Got it" completes nothing yet is the only filled CTA. |
| 6 | Recognition Rather Than Recall | 3 | 5 of 17 Settings tabs sit off-screen at 1440 with no scroll cue, including the required AI Concierge. |
| 7 | Flexibility and Efficiency | 3 | The Chats strip goes to Home, not to the step it names; an open list puts 19 tab stops before the queue. |
| 8 | Aesthetic and Minimalist Design | 2 | Home is 3,217px with 10 cards under the hub, 8 of 12 tiles at zero; nested 2rem trays leave a 262px text column on phone. |
| 9 | Error Recovery | 3 | Queue failure is honest, expired invites offer a fresh link; some onboarding query errors are silent. |
| 10 | Help and Documentation | 2 | Good per-step descriptions; the only offer of help on the path is "reply to this email". |

## Design Specificity Verdict
**LLM assessment:** specific in structure, generic in finish. One derivation feeds four surfaces and they agree everywhere measured; the headline states the provider's goal and its cost; the section tour is a real idea. The finish is low-alpha teal that renders grey-green on sand, a tray inside a tray, and a tour flag that is the loudest element on pages where it completes nothing.
**Deterministic scan:** exit 0, zero findings in the six files. Zero dashes, hex, palette utilities, dialogs or literal pixel sizes; every status-as-text site now uses the -text tokens. Outside the six files: "Egg Donor Agency: APPROVED" 2.31:1 on company and the two-factor "Off" badge 1.90:1 on security.
**Visual overlays:** not injected (real user browser session).

## Confirmed fixed since run 1 (live)
Outcome headline with cost; two groups with minutes summing to the headline; progressbar, list and aria-expanded semantics; calendar duplicate gone from the queue; cold load of /account/costs stays; mark-as-done teal at 5.76:1; flag nudges twice with a reduced-motion rule; titles on Home and Settings; Home pill count; Chats strip; set-password audience copy (source).

## Priority Issues
- **[P1] The tour flag outranks the real action, and on Payouts it rings the wrong thing.** On costs the only filled CTA is "Got it" (completes nothing; the drop zone is a div with no keyboard-reachable control); on calendar the flag beats the outline "Connect"; on payouts the payouts-setup anchor only exists in the already-ready branch (provider-payouts-tab.tsx:160), so the tour scrolls past the chooser and rings a read-only card. Fix: anchor the chooser, make the flag a ghost pointer on artifact steps or drop the terminal "Got it", no auto-scroll when the first section is already at the top. onboarding-coach-bar.tsx:50, 326, 345. /impeccable harden
- **[P1] Coach-bar completion controls at phone width.** Label truncates ("Review your company...") because the meta is shrink-0; bar is 108px (16% of the screen); page loads pre-scrolled 400px; a context-free 44px "Done" sits 60px from a "Next" that does the opposite. Fix: meta wraps under the label, phone button "Mark done" with an aria-label naming the step, flag says "Next section", scroll-margin start for the first section. onboarding-coach-bar.tsx:435-439, 483, 350. /impeccable adapt
- **[P2] Home pill badge and the Next chip.** 8px text in a 14px teal chip on the active teal pill; accessible name "7Home" (mobile label drops the count); no aria-current; the hub's "Next" chip is 4.24:1. layout-shell.tsx:1065; provider-own-onboarding.tsx:150. /impeccable audit
- **[P2] Day-one Home buries the promise under an empty dashboard.** 10 cards, 8 zero tiles; a green "All clear" directly under "7 steps"; the Chats empty state says "continue where you left off" to someone with no threads. Fix: while setup is open, fold zero-state cards into one line, queue copy "No family tasks yet - finish setup above", a provider-first Chats empty state. /impeccable distill
- **[P3] Promise drift and ring clipping.** "about 45 minutes" is hardcoded on the set-password page against a derived 54-62; the highlight ring clips text on team and costs; "Three things" vs five sections. reset-password-page.tsx:150; onboarding-coach-bar.tsx:51-53; provider-onboarding.controller.ts:717. /impeccable clarify

## Persona Red Flags
**Alex (owner):** loves "47 min" and "Do it now"; clicks "Got it" on costs and believes he is done; the Chats strip costs an extra hop; the required AI Concierge tab is off-screen. **Jordan (first-time coordinator):** "mark as done" is on screen before anything is read; the page scrolls itself; "Section 1/5" contradicts "Three things". **Sam:** the flag is portalled to the end of the tab order with no aria-label tying "Next" to a section; "7Home"; every settings page shares one title; smooth auto-scroll ignores reduced motion; unlabeled inputs and switches across company and calendar; the account tabs nav has no label.

## Minor Observations
The Chats strip's second line truncates; on the concierge page two steps share one tour but the button closes only one; third-person copy on the knowledge tab; the Mirror progressbar lacks aria-valuetext; the email button is Title Case; calendar section headings render at 12px; /chat jumps from h1 to h3; 41-52 decorative SVGs per settings page without aria-hidden.

## Questions to Consider
If the provider joined to get families, why does nothing on day one show a family? Should review steps be completable before the tour is walked, and if so what is the tour for? Is the ring-and-flag tour earning its complexity on single-section pages? Could the strip, the Mirror and the badge be one component with the step as the destination?
