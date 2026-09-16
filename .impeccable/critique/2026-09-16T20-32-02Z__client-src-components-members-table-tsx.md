---
target: the invited partner's first open
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/components/members-table.tsx"
target_fingerprint: "sha256:520d8e38c8b083e1c5e84872328a973327d45ee3d4a23a9eb4a8911b9ad12217"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/components/members-table.tsx
timestamp: 2026-09-16T20-32-02Z
slug: client-src-components-members-table-tsx
---
# Critique: the invited partner's first open - run 1

Method: dual-agent (A: design review, B: detector + browser evidence). Signed in as the OWNER; live coverage partial by construction (Members tab, invite form, set-password expired state, the shared thread as a second reader). Member landing, valid set-password form and member onboarding assessed from source. No invite sent.

## Design Health Score: 18/40 (Needs work)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Toast on 201 while email is fire-and-forget; no "Alex joined" anywhere |
| 2 | Match System / Real World | 2 | "New Password" for a first password; "Match Calls" undefined in the email; role names |
| 3 | User Control and Freedom | 2 | No revoke / edit of an invite short of Remove |
| 4 | Consistency and Standards | 1 | Two password policies; two invite forms; gray table border |
| 5 | Error Prevention | 2 | Missing token still emailed as a link |
| 6 | Recognition Rather Than Recall | 1 | "Hi Eran!" + forty "you"s; strip reads the seat, drops Home/Ages for the partner |
| 7 | Flexibility and Efficiency | 3 | Resend, one-turn card, desktop auto-open |
| 8 | Aesthetic and Minimalist Design | 2 | Six-column CRM table with copy buttons for a family of one |
| 9 | Error Recovery | 1 | Expired link -> reset flow without invite flag; email says ask the inviter |
| 10 | Help and Documentation | 2 | Email never says a phone verification is coming |

## Design Specificity Verdict
Split: in-chat invite + member onboarding are GoStork; the reset page wearing an invite hat, the "password reset" login banner, the CRM table and the owner-addressed transcript are borrowed. Detector: 2 hits (10px badges, members-table.tsx:336,339). Measured: empty titles on /account/members, /users/new, /reset-password; 0/4 invite inputs labelled; pending badge 1.91:1; resend icon-only unnamed below sm; invite submit below the fold at 667; no shared-account signal in the thread or list.

## Priority Issues
- [P0] Other parent's messages render under the concierge avatar (concierge-chat-page.tsx:5161-5166, 5218-5228, 5339-5343). Fix: monogram from senderName for isOtherParent. (/impeccable harden)
- [P1] Strip reads the seat not the family (what-i-know-strip.tsx:113,131-137). Fix: owner row + named ages/home. (/impeccable harden)
- [P1] Set-password/login copy claims a reset (reset-password-page.tsx:138-167,218,78; auth-page.tsx:189-193). Fix: invite labels, "Set password and continue", passwordSet banner + prefilled email. (/impeccable clarify)
- [P1] Two password policies (reset-password-page.tsx:41-48 vs onboarding-page.tsx:441,605). (/impeccable harden)
- [P2] Landing does not land (onboarding-page.tsx:511,720; conversations-page.tsx:931,935); expired recovery forks (reset-password-page.tsx:110). (/impeccable onboard)
- [P2] Members tab is a provider table on a parent surface (members-table.tsx). (/impeccable distill)

## Persona Red Flags
Alex: "invited you to join their family account"; opens "Hi Eran!"; no arrival marker; Home/Ages gone from the strip. Jordan: success toast before dispatch; no acceptance signal; CRM row with copy buttons. Medical party who is not the owner: her body discussed in third person, facts on the owner's row; as "Viewer" cannot book her own consultation.

## Minor Observations
Passive title-case email heading; loading screen drops the member's name; fold shows newest facts not orienting ones; set-password card shadow with no hairline; expired title red 3.8:1; show/hide buttons unnamed; no required markers on the invite form; success dot used as decoration in the strip; "Confirmed by Eran" third person to Eran (stored content).

## Questions
Should the second reader ever start at "Hi Eran!"? Is the Members tab a parent surface at all? Whose "you" does Adam mean once two people share a thread? Should the medical party be required to be Intended Parent 2 and answer their own medical questions?
