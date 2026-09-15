---
target: the onboarding page
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/onboarding-page.tsx"
target_fingerprint: "sha256:054caa82650b20db6f8a8bf19870133fe156b3210fcd10580c678f70139bde03"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/onboarding-page.tsx
timestamp: 2026-09-15T19-35-04Z
slug: client-src-pages-onboarding-page-tsx
---
# Critique: parent onboarding (client/src/pages/onboarding-page.tsx)

Method: dual-agent (A: design review, B: detector + browser evidence). Live route http://localhost:5001/onboarding, desktop + mobile.

## Design Health Score: 20/40 (Needs work)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Progress track Fog on sand, invisible at step 1; no step count; 100% before account exists |
| 2 | Match System / Real World | 2 | "users are real people"; "free consultation" not Match Call; "IVF" never appears |
| 3 | User Control and Freedom | 2 | Step + answers in local state; reload/back at step 4 loses everything (verified) |
| 4 | Consistency and Standards | 1 | Raw buttons, hardcoded pink/blue/amber, disabled CTA identical to unselected option |
| 5 | Error Prevention | 2 | Email-in-use surfaces on step 6 after OTP |
| 6 | Recognition Rather Than Recall | 2 | Placeholder-only inputs at 40% opacity |
| 7 | Flexibility and Efficiency | 2 | No partner-join path; goals re-asked for returning users |
| 8 | Aesthetic and Minimalist Design | 3 | Phone step stacks five elements + legal paragraph |
| 9 | Error Recovery | 3 | OTP errors humane; other failures toast "Error" |
| 10 | Help and Documentation | 1 | No "why we ask"; no support contact |

## Design Specificity Verdict
Half-authored. Welcome + selected pill are GoStork; steps 1+ are a generic wizard. Eva never named (lines 525, 535, 549, 608). Detector: CLI 0 findings; in-page 10 (6 low-contrast: 3x .t-helper 4.2:1 on sand = real, 3x disabled CTA = WCAG-exempt; 4x cream-palette on brand Warm Sand = false positive). Detector missed pinch-zoom, hardcoded tints, lost state.

## Priority Issues
- [P0] Helper text fails AA: Slate Muted #64748B on Warm Sand #F6F3EE = 4.2-4.3:1. Lines 946, 983, 1072, 1156, 1168 + sms-consent-disclosure t-helper. Fix: Slate Label on sand, or Paper card per step; correct DESIGN.md note. (/impeccable audit)
- [P0] Pinch-zoom disabled: maximum-scale=1 in client/index.html:5. Fix: remove. (/impeccable audit)
- [P1] Step/answers not in URL: useState line 165, data line 236; reload at step 4 -> welcome. Fix: ?step= search param + sessionStorage draft minus password/otp. (/impeccable harden)
- [P1] Unselected pill (115), disabled CTA (776), progress track (659) all Fog on sand ~1.1:1. Fix: Linen + hairline pills; primary at reduced opacity for disabled; track = border. (/impeccable polish)
- [P2] Eva never named; intro ends on "Our AI is not perfect yet" (549). Use loaded matchmaker name (505); replace glitch line. (/impeccable clarify)
- [P2] Gendered hardcoded tints lines 17-22, 34-35 (pink egg, blue sperm, amber surrogate). Fix: --service-* at 10% or teal->orchid gradient. (/impeccable colorize)

## Persona Red Flags
Jordan: step 1 reads disabled; "providers will see it" before anonymity promise; tab eviction restarts flow; landline/VoIP dead end.
Alex: no join-partner path; household email discovered at step 6; goals re-asked; intro replays.
Single parent / same-sex couple: copy clean; pink/blue/amber card tints gendered; goals step gives no path guidance.

## Minor Observations
No aria-pressed on goal pills; country trigger unnamed; opt-in checkbox announces "on"; opt-in box mixes teal border + orchid tint; "Verify phone number" sends a code; 6-char password minimum; "Create Account & Finish" title case + ampersand; setTimeout 2000 on welcome; location step no helper; Tailwind text-* at call sites; Return on name step may not advance.

## Questions
Account after meeting Eva? Which identity promise is true? Is "Welcome to the family" safe after loss? Ask who they are and let Eva propose services?
