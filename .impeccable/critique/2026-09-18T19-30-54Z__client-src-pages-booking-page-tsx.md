---
target: parent consultation booking flow
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/eranamir/Documents/GitHub/concierge/client/src/pages/booking-page.tsx"
target_fingerprint: "sha256:f8dfcd227ccf1ea605410e13d3a6eaf921f5e41abdedea75099a6a2f39f6baa9"
target_path: /Users/eranamir/Documents/GitHub/concierge/client/src/pages/booking-page.tsx
timestamp: 2026-09-18T19-30-54Z
slug: client-src-pages-booking-page-tsx
---
# Critique: parent consultation booking flow (run 1)

Method: dual-agent (A: design review, B: detector + browser evidence). Overlay injection failed (HTTPS page cannot load http://localhost detect.js).

## Heuristics 20/40
1 Status 1 - four surfaces, four states (card awaiting / Eva "all set" / header "Schedule with" / Home "consultation completed")
2 Real world 2 - "the Egg Donor's Agency" vs "Asian Egg Bank"; nonexistent "Provider Conversations"; raw "PENDING"
3 Control 3 - Booking Not Found dead end
4 Consistency 1 - /book page vs chat card are two design systems; "Confirm Booking" vs "Confirm booking"
5 Error prevention 3
6 Recognition 3
7 Flexibility 2 - no timezone change in chat
8 Minimalism 2 - ~70-word gate; equal-weight pending card stack
9 Recovery 1 - "may have been cancelled" for a live booking; silent inline cancel failure
10 Help 2 - no confirmation-time expectation; /book never says provider must confirm

## Specificity
Chat path authored (consent at identity reveal, masked agency, Booking-as summary, partner auto-attendee). /book is stock Calendly + frosted glass, hardcoded DM Sans, Title Case, invisible slot edges, no title/H1. Detector: 12 advisory, 11 false positives (var() radius fallbacks), 1 real (10px text concierge-cards.tsx:1080).

## Priority issues
- [P0] Eva "all set" for every PENDING booking - calendar.controller.ts:2772 + :561; "Provider Conversations" does not exist; call-prep pivot in same message.
- [P1] Home "consultation completed" for a future call (chat-router.ts:4709, parent-home-page.tsx:201); "Needs your attention (1)" over 3 rows.
- [P1] /booking/:bookingId looks up publicToken only (calendar.controller.ts:2870) -> 404 for own booking; dead-end miss state.
- [P1] Pending banner uses raw --brand-warning as text (~2:1, inline-booking-notification.tsx:204); header stays "Schedule with..." after booking; no role=status.
- [P2] /book page: no title/H1, unnamed month arrows, calendar has no selected/today semantics, slots below fold with no scroll, focus drops to body, no pending notice. Rebuild on InlineBookingCalendar/SelectedDateSlots/BookingForm.

## Personas
Casey: 70 words before calendar, sticky slot tint, off-screen slots, 32px Reschedule/Cancel. Jordan: three contradictory states, missing "Provider Conversations", masked-to-real name jump. Sam: 2:1 amber, unannounced status, /book unnamed arrows, Home aria-controls to missing id.

## Minor
Home concierge name "Ariel" vs chat "Adam" (useConciergeName takes matchmakers[0], not the parent's chosen one); "she" assumed in consent gate (consultation-gates.ts:1107); "Request Submitted" vs "Awaiting Confirmation"; 32px buttons; 10px badge.

## Questions
Auto-confirm free consultations? Eva owns the post-booking moment? Who is /book/:slug for?
