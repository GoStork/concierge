# Phase 8 - Reviews & Ratings: UAT Test Plan

Spec: [reviews-ratings-spec.md](reviews-ratings-spec.md). Automated coverage: `npx tsx --env-file=.env scripts/test-reviews-e2e.ts` (27 checks, all passing as of 2026-07-14 - API lifecycle, eligibility gate, privacy, aggregates, admin queue). This plan covers what the script cannot: the UI surfaces, the in-chat cards, and the cron-driven prompts.

## A. Eva's in-chat review prompt (parent)

1. **Consultation checkpoint** - As a parent with a provider journey, complete a Match Call and have the provider (or admin) mark the outcome Completed. Within 10 minutes (call-outcome sweep), Eva posts a review prompt card in your AI Concierge chat: warm copy + a tappable 1-5 star row.
   - Expected: card appears ONCE (re-running the sweep must not duplicate it).
2. **Star tap opens the form inline** - Tap a star. The full form expands in place: overall stars (pre-filled), 4 category star rows (Communication / Transparency & Pricing / Responsiveness / Support & Care), optional text, "Post anonymously" checkbox.
3. **Submit 4-5 stars** - Publishes immediately. Card collapses to "Review submitted" chip with your stars. Check the provider profile page - your review is live with "FirstName L." and "Reviewed after their consultation".
4. **Submit 1-2 stars** - Before submitting you get two buttons: "Post publicly" and "Share privately with GoStork". Choose private: review does NOT appear on any public surface, provider gets no notification, admin gets a REVIEW_PRIVATE_FEEDBACK notification and sees it in /admin/reviews under "Private feedback".
5. **Anonymous** - Check the box, submit. Public list shows "Verified GoStork Parent" instead of your name.
6. **Matched checkpoint** - Complete a match (surrogate double-yes, or egg-donor invoice paid). Eva posts a second prompt for the "matched" stage (the consult-stage prompt does not repeat).
7. **Handoff check-in** - Set a journey's `handoffCompletedAt` to 8+ days ago (or wait). The 10-min sweep posts the post-handoff check-in prompt. 3 days later (unanswered), exactly one reminder.
8. **Provider must never see any of this** - Open the same session as the provider (and as provider via Q&A inbox): the review prompt card and the submitted-review chip must be absent from the transcript AND from the sidebar last-message preview.

## B. Self-serve review (profile pages)

1. **Provider profile** (`/providers/:id` as an eligible parent) - "Parent Reviews" section shows aggregates (avg + count + category averages), the review list, and a "Write a review" button. Submit and edit from here; the button flips to "Update your review" and the form pre-fills your previous answers.
2. **Ineligible parent** - a parent with no completed consultation with this provider sees the reviews list but NO write button.
3. **Doctor profile** (`/doctors/:slug`) - same section with doctor categories (Communication / Expertise / Care & Empathy). A doctor review is separate from the org review (you can have both).
4. **Rating badge** - once a provider has >= 1 review, a star badge ("4.5 (2)") appears next to the provider name on the profile page hero, and a "★ 4.5 (2 parent reviews)" chip appears on the marketplace agency/clinic swipe cards (Overview tab).

## C. Provider side

1. **Performance > Reviews tab** - as a provider admin, open Performance; a third "Reviews" tab lists your published reviews (doctor reviews tagged with the doctor's name).
2. **Reply** - "Respond publicly" posts one reply; it renders under the review on all public surfaces; "Edit response" updates it. Parent gets an in-app notification.
3. **Flag** - "Flag for re-check" with a reason; badge flips to "Flagged - GoStork is reviewing"; admin sees it under the Flagged filter.
4. **Privacy re-check** - private feedback must NOT appear in this tab, and reviews must never reveal reviewer email or full name beyond "FirstName L.".

## D. Admin

1. **/admin/reviews** - filter chips: All / Flagged by provider / Private feedback / 1-2 stars / Removed. Each row: stars, provider (+doctor), author name AND email (admin only), stage, text, AI screening notes, flag reason, provider reply.
2. **Remove** - pulls the review off all public surfaces and recomputes aggregates. **Restore** - brings it back and clears the provider flag.
3. **Admin home** - "Latest parent reviews" card (top 3, with Private/Flagged badges) links to the queue.
4. **Notifications** - every publish fires REVIEW_PUBLISHED to all admins instantly; private feedback fires REVIEW_PRIVATE_FEEDBACK.

## E. AI screening

1. Submit a review containing profanity or a phone number/email. Expected: Gemini screen either publishes with notes or holds it in PENDING (visible in admin queue, not public). If the Gemini call fails, the review publishes anyway (fail-safe) with a note - never silently lost.

## F. Regression checks

1. Existing chats: no rendering change for parents/providers with no reviews.
2. Marketplace cards without reviews: no star chip (nothing shows at 0 reviews).
3. Doctor cards: the "Reviews" tab now says "X/5 overall" (was /10).
4. Journey timeline unaffected; REVIEW_SUBMITTED / REVIEW_UPDATED events appear in Recent Activity.
