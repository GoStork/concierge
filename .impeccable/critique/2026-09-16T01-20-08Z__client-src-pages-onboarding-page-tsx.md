---
target: the onboarding page
total_score: 32
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/onboarding-page.tsx"
target_fingerprint: "sha256:2caa988bf63a09b62b04d40f52905b4309118694f77cec44b4fff2193f6cd56d"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/onboarding-page.tsx
timestamp: 2026-09-16T01-20-08Z
slug: client-src-pages-onboarding-page-tsx
---
# Critique: parent onboarding (client/src/pages/onboarding-page.tsx) - run 3

Method: dual-agent (A: design review, B: detector + browser evidence). Live route http://localhost:5001/onboarding at 1280/1024 desktop, 375x812, 375x560.

## Design Health Score: 32/40 (Good) - was 20, then 28

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 4 | -- |
| 2 | Match System / Real World | 3 | Goal step names supply categories |
| 3 | User Control and Freedom | 4 | -- |
| 4 | Consistency and Standards | 3 | Raw Tailwind sizes on error/code-step copy |
| 5 | Error Prevention | 3 | Phone error fires at 3 digits while typing |
| 6 | Recognition Rather Than Recall | 3 | Goal pills give nothing to recognise |
| 7 | Flexibility and Efficiency | 3 | No way to defer location |
| 8 | Aesthetic and Minimalist Design | 4 | -- |
| 9 | Error Recovery | 3 | Phone error not associated with field |
| 10 | Help and Documentation | 2 | No help/contact affordance in the wizard |

## Design Specificity Verdict
Authored for GoStork with one generic seam: the goals step (four catalogue nouns, no descriptor, no "not sure"). Detector: CLI 0; in-page 1/screen = cream-palette on brand Warm Sand (false positive). Measured: helper 5.29:1, labels 2/2 wired, focus on first field / heading, combobox semantics on city input, no horizontal overflow at 375, welcome scrolls at 375x560.

## Priority Issues
- [P1] Short-viewport clipping under the CTA with no cue (goals 4th pill, phone consent tray at 375x560). Fix: overflow-aware bottom mask on the scroller (~:906), hairline on CTA bar (~:1015), move SmsTransactionalNotice below the opt-in. (/impeccable adapt)
- [P1] Phone error fires at 3 digits and is not associated (phone-input.tsx:269, :342-357, :381; onboarding-page.tsx:1394-1399). Fix: validate on blur/expected length; aria-invalid + aria-describedby; role=alert. (/impeccable harden)
- [P2] City combobox aria-controls points at a non-existent listbox (location-autocomplete.tsx:285, :332-370). Fix: id+role=listbox on portal, role=option rows, aria-activedescendant. (/impeccable audit)
- [P2] Goals step generic, no "not sure" path (:65, :1211-1243). Fix: descriptor under each pill, fifth pill "I'm not sure yet - help me figure it out" -> goals ["Undecided"]. (/impeccable clarify)
- [P2] Hardcoded text-sm/text-xs/text-destructive on errors; destructive red 3.42:1 on sand (:1133, :1158, :1183, :1187, :1395, :1470; phone-input.tsx:381). Fix: .t-error token with AA-passing destructive text colour. (/impeccable polish)
- [P3] No <main> landmark; resend is a text link with no 30s countdown despite the copy (:1477-1491).

## Persona Red Flags
Jordan: no "not sure" option; disabled CTA reads broken with keyboard up; "Match Call" undefined twice.
Alex: two-step flow good; Viewer gets full-member language; "one quick step" followed by densest screen.
Single parent / same-sex couple: language clean; two mothers must guess Sperm Donor + Clinic.

## Minor Observations
Underline field boundary 1.4:1; OTP placeholder /20; no 30s timer; welcome icons bg-primary/10 vs Linen/Orchid; hover-only pill affordance; large gap before resend.

## Questions
"Where are you in your journey?" first? SMS opt-in after account exists? Scripted match preview as Eva's first impression?
