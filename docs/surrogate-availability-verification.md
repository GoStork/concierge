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

## Decisions (all three settled, 27 Jul 2026)

1. **Digest cycle: 7 days.** The save-triggered whisper carries the urgency;
   the sweep is only a backstop for profiles nobody has looked at yet.
2. **Recipient: `Provider.surrogateCoordinatorEmail`**, falling back to
   `Provider.email`. Built. Sending to a general ops inbox would mean
   auto-hiding listings on silence we caused ourselves.
3. **Parents DO see a confirmation line** - but only where a real confirmation
   exists, never as a default. A human at the agency saying "yes, she is free"
   on a given day is genuinely different from a scraper re-reading a page, and
   it will be absent on most profiles rather than reading the same everywhere.
   Watch for it re-teaching parents to look for a timestamp, so that its
   absence starts implying something we do not mean.

## Build state

**Done (27 Jul 2026):**
- `SurrogateVerification` model + `Provider.surrogateCoordinatorEmail`, with the
  migration SQL applied to Supabase and the `PrismaService` getter added (a
  missing getter makes the model silently undefined and every call a 500).
- Verified reachable from a live client: the table reads, the field resolves.

**Not built - no behaviour exists yet.** In dependency order:

1. `requestVerification(surrogateId, trigger)` - creates a row, sends the
   branded email, posts the whisper for `PARENT_SAVE`.
2. Parent-save hook: fire on save, but only for upload-only surrogates.
3. Provider response endpoint + UI: the digest with one-click-for-all AND
   per-profile answers, plus the provider home queue row.
4. Relay the confirmation back to the parent, warmly.
5. The 7-day sweep and the reminder/auto-PENDING ladder. **Build this last.**
   It is the only part that changes what parents can see without a human
   deciding, so it should go in once everything feeding it is proven - a bug
   here hides available surrogates, which is worse than the stale profiles this
   feature exists to fix.
6. The parent-facing confirmation line (decision 3).

The scheduler in step 5 must be cross-process idempotent via an advisory lock:
the iMac and the local Mac both run schedulers against the shared DB.
