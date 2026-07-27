# Surrogate availability verification

**Status: specified, not yet built.** Every decision below is Eran's, captured
from the 27 Jul 2026 session so the build can start cold.

## The problem

Agencies upload surrogate profiles by hand and forget to remove them. Those
profiles have no sync behind them (`Surrogate.lastFullSyncAt` is null), so
nothing ever corrects them - a parent can save, enquire about, or book a call on
someone who was matched months ago. Surrogates are reserved almost daily, so the
window for this to happen is short and constant.

Scraped surrogates are out of scope: the nightly sync already corrects them, and
asking coordinators about profiles we maintain ourselves trains them to ignore
the request.

## Two triggers, not one

### 1. Parent interest (immediate, the important one)

When a parent **saves** an upload-only surrogate, fire an availability question
to that agency straight away. This rides the existing whisper protocol
(`[[WHISPER:PROVIDER_ID]]` -> `SilentQuery`), which already keeps the parent
anonymous until the provider answers.

When the coordinator confirms, tell the parent - warmly, not clerically. She was
just saved by someone who is deciding about her; "her agency confirmed she's
available" is genuinely good news and should read that way.

Effort follows real parent interest rather than treating every profile alike.

### 2. Periodic digest (the sweep)

One email per agency covering **all** their unverified upload-only surrogates,
not one email per profile. Batching is what makes a short cycle bearable: the
cost to a coordinator is the interruption, not the number of rows in it.

Baseline cycle: **7 days** (open - see below).

## What the coordinator can answer

Both paths must be available in the same digest:

- **One click for all** - "all still available", clears the whole batch.
- **Profile by profile** - more accurate, and the only way to say something
  other than "available".

Statuses are exactly the marketplace filter vocabulary, so what a coordinator
sets is what a parent filters on:

| Status | Parent-visible | Keep asking? |
| --- | --- | --- |
| `AVAILABLE` | yes | yes, next cycle |
| `ON_HOLD` | yes | yes - she is coming back |
| `PENDING` | yes | yes |
| `MATCHED` | no (hidden at the API layer) | no |
| `INACTIVE` (Removed) | no | no |

## Non-response

Two reminders, then **14 days**, then auto-move to `PENDING`.

Hidden from parents, not deleted, and restorable by the coordinator in one
click. Unverified-and-silent fails closed on purpose: a parent enquiring about
someone who is gone costs more trust than an agency losing a listing for a few
days.

## Delivery

Branded email (`buildBrandedEmail()`, per the project rule - no SendGrid
templates) plus a row in the provider home queue beside the existing approvals,
so it appears where coordinators already action work.

## Open questions

1. **Cycle length for the digest.** 7 days is the assumed baseline. The
   save-triggered whisper covers the urgent case, so the sweep is a backstop -
   but if reservations really move daily, 3-4 days may be worth the extra email.
2. **Who at the agency receives it.** Provider contact email, or a per-provider
   "surrogate coordinator" address? Today there is no such field.
3. **Does a parent see the confirmation state on the profile?** e.g. "Availability
   confirmed 2 days ago" once an agency has answered. This is the one case where
   a date IS information, because a human confirmed it rather than a scraper
   re-reading a page. Deliberately deferred - it reintroduces the label we just
   removed, so it needs its own decision.

## Build notes

- New model, roughly `SurrogateVerification` (surrogateId, providerId,
  requestedAt, respondedAt, respondedBy, resultStatus, trigger:
  `PARENT_SAVE | SWEEP`, reminderCount).
- Scheduler alongside the existing 10-minute sweeps - must be
  cross-process idempotent via advisory lock, since the iMac and the local Mac
  both run schedulers against the shared DB.
- Schema change needs a matching `prisma/migrations/` SQL file in the same
  commit, per the project rule.
