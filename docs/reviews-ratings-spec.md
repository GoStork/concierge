# Phase 8 - Reviews & Ratings (Spec)

Status: **awaiting approval** - no code until Eran signs off.
Decisions locked 2026-07-14 (Eran): milestone reviews, always editable, overall + categories,
orgs + doctors reviewable, in-chat collection, check-in 1 week post-handoff, first name + initial
with anonymous option, all four display surfaces, no minimum-count hiding, display-only (no rank
influence), auto-publish with AI screening + instant admin notification, provider replies +
private offramp for 1-2 star reviews, provider flag-for-recheck.

## 1. What gets reviewed

- **Provider organizations** (agencies, clinics, banks, law firms) - one review per parent
  account per org.
- **Doctors** (the only reviewable individuals) - one review per parent account per doctor.
- Surrogates and donors are NEVER reviewable.

## 2. Review structure

- Overall rating: 1-5 stars (required).
- Category ratings (1-5 each, optional but shown in the form):
  - Organizations: Communication, Transparency & Pricing, Responsiveness, Support & Care.
  - Doctors: Communication, Expertise, Care & Empathy.
- Free text: optional, nudged ("a sentence or two helps other families").
- Anonymous checkbox: display becomes "Verified GoStork Parent" instead of "Eran A.".
  All reviews are verified-journey either way.

## 3. Eligibility & checkpoints (milestone model)

A review is unlocked by real journey evidence (derived server-side from the same machinery as
the journey timeline - never self-declared):

| Checkpoint | Evidence | Eva behavior |
|---|---|---|
| Consultation completed | booking outcome COMPLETED with that org | First review ask |
| Matched | MATCH_CONFIRMED / readiness commitment | Ask again: new review or update |
| Handed off + 7 days | handoffCompletedAt + 7d | Post-handoff check-in ("how did everything go?") that doubles as the final review/update ask |

- Doctor reviews unlock when a completed booking's host resolves to that doctor profile.
- Reviews are **always editable** afterward; the public review shows the latest version with
  "Updated <date>" and the journey stage context at last update ("Reviewed after handoff").
- One gentle reminder if the post-handoff ask is ignored for 3 days. No other reminders.

## 4. Collection UX

- **In-chat review card** (`review_prompt` uiCardType) posted by Eva in the parent's concierge
  chat at each checkpoint: star tap + expandable category/text form, submit inline. No modals.
- IMPORTANT privacy rule: review prompts and drafts must NEVER be visible to the provider.
  The messages endpoint must exclude `review_prompt` (and the submitted-confirmation card)
  from provider/admin-as-provider views of any session that carries them.
- **Self-serve**: "Write a review" button on the provider profile page (and doctor profile),
  parent-only, eligibility-gated, opens an inline section (no dialog).
- Post-handoff check-in fires exactly once per journey via the 10-min sweep
  (handoffCompletedAt + 7 days; idempotent - guarded by existing card / REVIEW_PROMPTED event).

## 5. Display (all four surfaces, no minimum count)

1. **Marketplace / swipe cards**: star average + review count badge (denormalized columns for
   cheap reads). Shown from the first review.
2. **Provider profile page**: Reviews section - average, count, star-distribution bars,
   category averages, paginated review list (reviewer label, stage context, text, provider
   reply inline). Same pattern on doctor profiles.
3. **Eva recommendations**: search/matching tools return avgRating + count so Eva can say
   "rated 4.8 by GoStork families" - **display-only**; ratings do NOT affect ranking,
   matching, or marketplace sort in v1.
4. **Provider dashboard**: Reviews tab (Performance page) - their reviews, reply box, flag
   button, category breakdown.

## 6. Moderation (option B - auto-publish + AI screen + instant admin notification)

- On submit: Gemini screening for profanity, PII (emails/phones), surrogate/donor names,
  and abuse. Pass -> status PUBLISHED immediately. Fail -> PENDING_REVIEW (parent told it's
  being looked at; admin queue).
- **Admin gets an in-app notification the moment any review publishes** (and for every
  PENDING_REVIEW).
- **1-2 star offramp**: before a 1-2 star review is submitted publicly, the form offers
  "Post publicly" vs "Share privately with the GoStork team". Private -> stored as feedback
  for admin (LEAD/quality signal), never published, provider not notified.
- **Admin queue** (`/admin/reviews`): all reviews + statuses + flags; remove (with reason) /
  restore; private feedback inbox.
- **Provider flag**: flags a published review for admin re-check (reason text). No
  auto-takedown; review stays up until admin decides. Flag badge in the admin queue.

## 7. Provider replies

- One public reply per review, editable, no pre-approval. Parent notified in-app when the
  provider replies. Reply shows under the review on all display surfaces.

## 8. Data model (new)

```prisma
model ProviderReview {
  id                  String    @id @default(uuid())
  parentAccountId     String    // one review per account per target
  authorUserId        String    // who wrote / last edited
  providerId          String
  doctorId            String?   // set for doctor reviews
  journeyType         String?   // surrogacy | egg_donation | ivf | bank | legal
  stage               String    // consult_completed | matched | handed_off (at last update)
  rating              Int       // 1-5
  categories          Json?     // { communication: 5, transparency: 4, ... }
  text                String?
  anonymous           Boolean   @default(false)
  visibility          String    @default("PUBLIC")  // PUBLIC | PRIVATE_FEEDBACK
  status              String    @default("PUBLISHED") // PUBLISHED | PENDING_REVIEW | REMOVED
  aiScreenNotes       String?
  flaggedByProviderAt DateTime?
  flagReason          String?
  providerReply       String?
  providerReplyAt     DateTime?
  providerReplyUserId String?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  @@index([providerId, status])
  @@index([doctorId, status])
  @@index([parentAccountId])
}
```

- Uniqueness (account x provider x doctor-or-null) enforced in code (Postgres treats NULLs as
  distinct in unique indexes) via upsert-by-lookup.
- Denormalized aggregates: `Provider.avgRating` / `Provider.reviewCount` (and same on Doctor),
  recomputed on every review write/remove - keeps marketplace cards free of joins.
- Journey events: REVIEW_PROMPTED, REVIEW_SUBMITTED, REVIEW_UPDATED appended to JourneyEvent.
- PrismaService getter for the new model (per project rule) + migration SQL file in the same
  commit + Supabase MCP apply.

## 9. API surface

| Endpoint | Who | Purpose |
|---|---|---|
| GET /api/reviews/provider/:providerId | public (authed) | list + aggregates |
| GET /api/reviews/doctor/:doctorId | public (authed) | list + aggregates |
| GET /api/reviews/eligibility?providerId=&doctorId= | parent | unlocked checkpoints + existing review |
| POST /api/reviews | parent | create/update (upsert), triggers AI screen + aggregates + notifications |
| POST /api/reviews/:id/reply | provider | public reply (own org's reviews only) |
| POST /api/reviews/:id/flag | provider | flag for admin re-check |
| GET /api/admin/reviews | admin | queue (filters: status, flagged, rating, provider) |
| POST /api/admin/reviews/:id/remove / restore | admin | moderation actions |

## 10. Build order (each step shippable)

1. **8.1 Schema + API + aggregates** (model, migration, endpoints, AI screen, notifications).
2. **8.2 Eva collection** (review_prompt card + checkpoint triggers + post-handoff sweep +
   provider-visibility exclusion + 1-2 star offramp).
3. **8.3 Display** (marketplace cards, provider/doctor profile sections, Eva tool data,
   provider dashboard tab).
4. **8.4 Admin queue + provider replies/flags.**
