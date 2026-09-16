---
target: the first Eva conversation
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx"
target_fingerprint: "sha256:5d6ecf0c3b5edb16741e4b41e57a1a23f677fccadd15be98ebea77c301eaaf32"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/concierge-chat-page.tsx
timestamp: 2026-09-16T04-45-20Z
slug: client-src-pages-concierge-chat-page-tsx
---
# Critique: the first Eva conversation (persona picker -> intro -> ready -> /concierge chat) - run 2

Method: dual-agent (A: design review sub-agent, B: detector + browser-evidence sub-agent), signed-in onboarded test parent, 1280x900 + 375x812 + 375x667. Overlay injection blocked (http localhost script on https page = mixed content); CLI scan + DOM measurements. Findings covered by ignore.md dropped.

## Design Health Score: 25/40 (Needs work, up from 22)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Typing dots 208ms, first token 1.2s; "So far" fold line truncated (696px of content in 615px desktop / 222px mobile) |
| 2 | Match System / Real World | 2 | Fold line is label-less ("38", "Egg Donor" ambiguous, "New York, New York") |
| 3 | User Control and Freedom | 2 | No way back from ready screen to persona picker; 1.5s untouchable interstitial; regex-missed free text gets re-asked |
| 4 | Consistency and Standards | 2 | Two concierge headers (page-level vs embedded on /chat), two AI-intro implementations, three CTA shapes across three screens |
| 5 | Error Prevention | 2 | Binary chips styled positive/decline by position ("First time" filled, "I've done IVF before" muted) |
| 6 | Recognition Rather Than Recall | 3 | Strip hides everything after ~30 chars on a phone |
| 7 | Flexibility and Efficiency | 3 | Desktop autofocus good; post-reply refocus also fired on mobile (fixed this run); persona voice on ~50% of turns |
| 8 | Aesthetic and Minimalist Design | 2 | Old threads still carry the 981-char education wall; one-thread inbox shows search + filters |
| 9 | Error Recovery | 3 | "Just tell Adam" is right, but partner age never persists so the strip contradicts the parent |
| 10 | Help and Documentation | 3 | Ready screen steps are the best help text; onboarding pages have empty document.title |

## Design Specificity Verdict
Authored, with one interchangeable seam. The chat is unmistakably this product (So far strip, named personas, human escape hatch, anonymity stated in plain words on the ready screen). The intro screen (rotated stock photo cards, mock "I found a wonderful surrogate" bubble) and the 1.5s "Connecting you with Adam" interstitial are the generic 2024 AI-assistant pattern and promise an instant match the next fifteen turns do not deliver.
Detector: 43 findings, 18 false positives (token radii/colour with fallbacks). Real: animate-bounce typing dots (concierge-chat-page.tsx:5671,5713), 4px side-tab on provider inbox row (conversations-page.tsx:2665), 22 x 10-11px literals (timestamps render 11px). Measured: assistant bubble 13.35:1, parent bubble 5.76:1, timestamps 6.64:1 at 0.7 opacity, strip labels 4.96:1 (lowest real text), no horizontal overflow at 375, zero hardcoded Tailwind colour utilities rendered, role=log + aria-live present, send/textarea/bottom-nav named, radiogroup on picker (source).

## Priority Issues
- [P0] /onboarding/ai-intro clips its only CTA on short phones. Verified at 375x667: fixed inset-0 container, overflow-y visible, content 682px, Continue bottom at 682 > 667, page cannot scroll (onboarding-ai-intro-page.tsx:95). First screen after phone verification. Fix: overflow-y-auto + min-h-dvh (ready page already does), delete the duplicate inline intro in onboarding-page.tsx:768-822. (/impeccable adapt)
- [P1] Post-reply refocus raised the keyboard on mobile (concierge-chat-page.tsx:3221-3227, no width guard). FIXED in this run: guarded to >= 768px.
- [P1] Embedded /chat header has two unnamed icon buttons on mobile: back (conversations-page.tsx:2114-2122, no aria-label) and "Talk to GoStork Team" (label hidden sm:inline, :2210-2225). The page-level header that is labelled is not the one rendered on /chat. Fix: aria-labels now, one header later. (/impeccable audit)
- [P1] Quick replies 32px tall and positionally styled right/wrong (concierge-chat-page.tsx:5395,5410-5414). Fix: 44px min-height on mobile; positive/decline styling only when option 0 is affirmative and option 1 negates. (/impeccable harden)
- [P2] "So far" strip: Show toggle renders Slate grey (t-helper colour wins over text-primary, what-i-know-strip.tsx:135, measured rgb(87,102,122)), 34x20px; fold shows 222 of 696px on mobile; partner age never persisted after "my husband is 41" (user.partnerAge only set on an explicit partner-age question, ai-router.ts:~8832); "New York, New York". Fix: order classes / use link token, 44px row-click toggle, label the fold ("Age 38 · USA"), persist partnerAge from compound answers. (/impeccable clarify)
- [P2] Termination and twins questions ship as bare one-liners on ~50% of turns (intake-questions.ts:765, :667; persona-voice.ts:93 alternation). Fix: exempt both from alternation, fixed one-sentence frame. (/impeccable clarify)

## Persona Red Flags
Jordan (first-timer, phone): clipped CTA at 667px; 21px text in 258px bubbles makes education two screens; bare twins/termination questions; intro promises an instant match.
Alex (invited partner): catch-up lives behind a grey 34x20 "Show"; mobile inbox shows search + All/Unread for one thread; persona register fires on alternate turns only.
Sam / Priya and Dana (solo dad, two moms): options complete and unranked; sperm-donor intro variant is the least warm ("Tell me more!" vs "She sounds great!"); solo path is four bare questions in a row.

## Minor Observations
Empty document.title on both onboarding pages; intro/ready CTAs are raw buttons with their own hover/press styles and no focus ring; three CTA radii across three screens; radiogroup uses tabIndex 0 on every radio (no roving); ready page falls back to matchmakers[0] without ?matchmaker; character-drain + aria-relevant=additions may announce fragments; only elevate utilities honour prefers-reduced-motion; attach-menu items focusable while aria-hidden; nav elements lack aria-label; historic threads keep the retired "60+/10,000+" copy; every Eva turn repeats avatar + name (grouping would return ~40px per turn).

## Questions
Why does a flow whose ready screen says "a few short questions, one at a time" open with three confirmations of Eva's own speech? Why is the only place a parent sees what GoStork believes about them folded, grey and 34x20px? Is a persona that fires on every other turn a persona? Which of each duplicated pair (header, intro, chip style path) gets deleted this week?
