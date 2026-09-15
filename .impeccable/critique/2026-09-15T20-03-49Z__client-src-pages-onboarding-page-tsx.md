---
target: the onboarding page
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/onboarding-page.tsx"
target_fingerprint: "sha256:f01d6f411173ffef6821666114d957c20163571e2881d6285e67aba056d901c4"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/onboarding-page.tsx
timestamp: 2026-09-15T20-03-49Z
slug: client-src-pages-onboarding-page-tsx
---
# Critique: parent onboarding (client/src/pages/onboarding-page.tsx) - re-run after fixes

Method: dual-agent (A: design review, B: detector + browser evidence). Live route http://localhost:5001/onboarding, desktop + mobile + 375x560.

## Design Health Score: 28/40 (Good) - was 20/40

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Step count + honest bar; no Turnstile-wait feedback |
| 2 | Match System / Real World | 3 | Goal labels are supply nouns |
| 3 | User Control and Freedom | 3 | Reload/Back/clamp verified |
| 4 | Consistency and Standards | 2 | Raw pills/OTP/back lack brand focus ring; selected pill resting shadow |
| 5 | Error Prevention | 2 | Global Enter handler advances step from any element |
| 6 | Recognition Rather Than Recall | 3 | No read-back before account creation |
| 7 | Flexibility and Efficiency | 3 | No autocomplete tokens on name; phone step no autofocus |
| 8 | Aesthetic and Minimalist Design | 4 | -- |
| 9 | Error Recovery | 3 | Final submit failure = raw destructive toast |
| 10 | Help and Documentation | 2 | No "why phone before email" |

## Design Specificity Verdict
Authored at the surface (sand, pills, teal, product copy, named Eva finale); skeleton still a generic four-question wizard with Eva invisible until after the account. Detector: CLI 0; in-page 1/screen = cream-palette on brand Warm Sand (false positive). Prior helper-contrast and disabled-CTA hits gone. Measured: helper 5.29:1, pills white + 1px hairline, disabled CTA teal @ 0.4.

## Priority Issues
- [P0] Window keydown Enter handler (onboarding-page.tsx ~475-484) advances step from any focused element; blocks keyboard multi-select on pills; Enter in city list picks + leaves step. Fix: per-step <form onSubmit>, remove global listener, Enter selects-only when list open. (/impeccable harden)
- [P1] Inputs have placeholder-only names at ~1.8:1 (muted/40); no <label>/aria-label on name, city, phone, email, password. Fix: visible Slate Label above each, normal placeholder opacity, autocomplete given-name/family-name. (/impeccable audit)
- [P1] Focus not managed between steps (activeElement=BODY); raw controls show browser default outline not teal ring. Fix: focus h1 on step change, aria-live step count, focus-visible ring on PillButton/back/OTP/checkbox. (/impeccable polish)
- [P2] Welcome screen fixed inset-0 justify-center with no overflow; CTA below fold at 375x560. Fix: overflow-y-auto. (/impeccable adapt)
- [P2] No read-back before "Create account and finish". Fix: summary strip linking to steps. (/impeccable onboard)

## Persona Red Flags
Jordan: supply-noun goal labels; phone step no autofocus; disabled CTA unexplained; empty <title>.
Alex: no join-partner path; flow always creates a new account.
Single parent / same-sex couple: copy + tints pass; no "Not sure yet" goal option.

## Minor Observations
Selected pill shadow-md; country dropdown not portaled (clips); city list lacks combobox semantics, hover fights keyboard; nominatim + ipapi called from browser pre-account; resend is a text link; eye toggle no aria-label; password min 6; Terms/Privacy links 15px tall; AI intro pads a second card from a hardcoded list.

## Questions
Meet Eva on screen one? Phone before email? Alex's 90-second flow?
