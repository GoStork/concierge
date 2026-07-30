# Consultation Focus Lock + Match Call Gates: Test Plan

What shipped: parents are held to **one open consultation per provider type**; a new profile at an agency they already work with opens a thread instead of a second call; and a match call needs three acknowledgements first (Intended Parent Form, both parents attending, the 24-hour decision window and deposit).

Automated coverage runs in CI and from `/admin/test-runner`. **Section A is the regression gate - run it before shipping anything that touches booking, chat sessions, or Eva's prompt.** Sections B onward are the things automation cannot reach: Eva's actual conversational judgment, the cards in a real browser, and behaviour against real provider data rather than fixtures.

Status legend: `[ ]` not run · `[x]` passed · `[!]` failed, needs a bug

---

## A. Automated - the regression gate

```bash
npx tsx scripts/test-unit-guards.ts        # 18 cases, no DB, ~1s
npx tsx scripts/test-provider-flows.ts     # 19 cases, needs the server up
npx tsx scripts/test-parent-privacy.ts     # 9 cases
npx tsx scripts/test-ai-concierge.ts       # 74 cases, ~5 min
```

Single case: `npx tsx scripts/test-provider-flows.ts --id=CL-01`. All of these also run from `/admin/test-runner`.

> **Do not rebuild or restart the server while the concierge suite is running.** It runs from source with no watch; a restart mid-run shows up as "Lost server connection" and costs a case a retry.

| | Case | Proves |
|---|---|---|
| [ ] | **UT-13** | Types are independent; account expansion; each of the 4 releases works; the Prisma `notIn`-drops-NULL trap |
| [ ] | **UT-14** | Service line resolves from `subjectType`, or **fails open** when a multi-service org is ambiguous |
| [ ] | **UT-15** | Gates fire in fixed order; an `ai_proposed` cost-sheet schedule is refused rather than quoted |
| [ ] | **UT-16** | All 3 cards parent-visible; preliminary ack parent-private; the 2 match-call cards visible to the provider |
| [ ] | **UT-17** | A whisper-stamped Eva session never counts as a provider connection |
| [ ] | **UT-18** | Every tag the prompt promises to strip is stripped (no raw `[[CONSULT_RELEASE:…]]` in chat) |
| [ ] | **CL-01** | Second same-type agency refused, other types unaffected, same agency never self-blocked |
| [ ] | **CL-02** | Admin unlock needs a written reason and is recorded; parent-moved-on releases identically |
| [ ] | **CL-03** | 7-day self-release; a live match call suspends it |
| [ ] | **CL-04** | Connected agency opens a `PROVIDER_CONNECTED` thread with **no booking attached**, idempotent, dual-audience correct |
| [ ] | **PR-08** | All three match-call gates, in order, on every route including the raw `/book/<slug>?subtype=MATCH_CALL` link |
| [ ] | **PR-02** | The two privacy gates: booking reveals the name, contact stays gated |

---

## B. The lock, as a parent actually experiences it

Automation proves the 409. This proves Eva handles it like a concierge rather than a bouncer.

1. [ ] **Book a surrogacy consultation**, then ask Eva to book a *different* surrogacy agency.
   - Expected: **no calendar card**. She names the call you already have and offers a real choice ("keep that call, or move on from them"), in first person. She must not cite "policy", "the system", or "GoStork requires".
2. [ ] **Keep browsing while locked.** Ask for more surrogates, favorite one, ask questions about her.
   - Expected: everything still works. The lock is about calls, not browsing. If Eva goes cold or stops showing profiles, that is a bug.
3. [ ] **Ask for an egg donor agency** while the surrogacy lock is on.
   - Expected: calendar appears normally. Repeat for an IVF clinic.
4. [ ] **Say "I want to move on from them."**
   - Expected: Eva confirms **once** with a yes/no before releasing. She must not release on a first mention or on hesitation ("I'm not sure about them").
5. [ ] After confirming, book the second agency.
   - Expected: succeeds. A `CONSULTATION_LOCK_RELEASED` row with `reason: PARENT_MOVED_ON` exists.
6. [ ] **Reschedule** the locking consultation.
   - Expected: the lock follows the new booking; the 7-day window measures from the new date.

## C. The three consent cards, in a browser

1. [ ] **Preliminary step** - ask Eva to book an agency consultation about a specific surrogate.
   - Expected: Eva names the profile and says this is the first step toward a match call, *not* an info session. The card appears in the concierge chat. Picking a time before ticking it is refused, with readable copy - never raw JSON.
   - Expected: the agency's **name is masked** on this card ("the Surrogate's Agency"). It is pre-booking.
2. [ ] Tick it, then book.
   - Expected: succeeds. Card collapses to "Confirmed by <name>".
3. [ ] **Book a second consultation with the same agency.**
   - Expected: asked to acknowledge again. This is intended - "every agency, every time" includes a second call with the same one.
4. [ ] **Both parents** - as a married/partnered parent, have the agency propose match-call times.
   - Expected: refused; the card appears in the **shared thread** naming your partner; the provider sees "Waiting on the parents" with no button.
5. [ ] **24h + deposit** - same flow, with an agency that has a **provider-confirmed** cost sheet.
   - Expected: the card shows the real figure, who it is paid to (usually Escrow), the trigger wording and the refund line. Check the amount stays on one line and nothing wraps oddly.
6. [ ] Same, with an agency that has **no cost sheet**.
   - Expected: no invented number - it says the agency confirms the amount. Ticking still unblocks the call.
7. [ ] Same, with a provider whose `depositMilestone` is `AT_CLEARANCE`.
   - Expected: copy says nothing is due the day of the call, but the 24-hour decision still is.
8. [ ] [Mobile] Repeat 5 on a phone-width viewport.
9. [ ] After ticking the deposit card, check the ledger:
   ```sql
   SELECT metadata->'depositSnapshot', metadata->'liveDepositAtAck'
   FROM "JourneyEvent" WHERE "eventType" = 'MATCH_CALL_DECISION_ACKNOWLEDGED';
   ```
   - Expected: `depositSnapshot` matches **what the card displayed**, not a re-resolution.

## D. Connected agency - no second call

CL-04 proves the mechanism. This proves Eva reaches it.

1. [ ] With a booked/completed consultation at Agency A, get Eva to surface a **different** surrogate represented by Agency A, and express interest.
   - Expected: **no calendar**. She says the existing call covers this profile and points to the new thread, without narrating that she "created a chat".
2. [ ] The new thread appears in the conversations list **without a reload**.
   - This is the one wiring step with no automated coverage. If it needs a refresh to show up, that is a bug.
3. [ ] Open the new thread as the parent, then as the provider.
   - Expected: the parent's copy is second person ("You're already connected…"); the provider's copy is about the family ("<Name> is interested in…"). A parent must never read about themselves in third person.
4. [ ] Confirm no phantom call: the new thread shows **no booking**, and the journey sidebar does not claim a consultation on it.
5. [ ] A **whispered-only** agency must NOT trigger this. Whisper Agency B a question without booking, then express interest in a B profile.
   - Expected: a normal calendar card. This is the whisper trap - if it skips the consultation, that is a serious bug.

## E. Admin unlock

1. [ ] `/admin/concierge-monitor` → a locked family's session → **Consultation focus lock** panel.
   - Expected: "N active" badge, service-line badge, provider, scheduled time, "Locking" pill, and the auto-release date.
2. [ ] Try to unlock with a blank reason. Expected: button stays disabled / refused.
3. [ ] Unlock with a reason.
   - Expected: row flips to "Unlocked by GoStork", badge clears, and a `CONSULTATION_LOCK_RELEASED` row records `reason: ADMIN` plus the note and the admin's name.
4. [ ] The parent can now book that type again.
5. [ ] **Providers must have no unlock control anywhere.** Check the provider surfaces.

## F. Real-data checks (staging, not fixtures)

These are where fixture-based tests are weakest.

1. [ ] **Multi-service org** (e.g. Eggspecting = IVF Clinic + Surrogacy Agency + Egg Donor Agency). Book a surrogacy consult there, then try an egg-donor consult **at the same org**.
   - Expected: allowed. See "Accepted behaviour" below.
2. [ ] **International two-call program** (Colombia/Mexico): book the agency, then the partner IVF clinic.
   - Expected: both book. The partner carve-out must hold with a real lock active.
3. [ ] **Legal**: `[[LAWYER_CONNECT]]` after a first agency call.
   - Expected: firm card renders. If a Legal lock is active the calendar is withheld but the card still shows.
4. [ ] **Banks**: an Egg/Sperm Bank donor still goes straight to `[[BANK_CHECKOUT]]` with no consultation and no gate.
5. [ ] **Couple sharing an account**: partner A books; partner B must see the lock and the same gate cards.

## G. Must not have broken

1. [ ] A provider sharing their own `/book/<slug>` link (no concierge session) still books with no gates.
2. [ ] Doctor calls (`DOCTOR_CONSULTATION`) are unaffected everywhere.
3. [ ] Win-back reschedule cards still work - and a **match call** through one is now gated (this was a bypass).
4. [ ] Existing chats with no gates render unchanged for both sides.
5. [ ] Unread badges clear. A card the parent cannot see must never inflate the count.
6. [ ] `/admin/test-runner` lists CL-01..04 and UT-13..18, and single-case filtering runs them.

---

## Accepted behaviour - do not file these as bugs

- **Multi-service org with no subject → no lock.** Deliberate: a wrong lock is a dead end the parent cannot see or undo, a missed one is a soft miss. Pinned by UT-14. Changing this is a product decision, not a fix.
- **The raw `/book/<slug>` link bypasses the *lock*.** Only concierge-path bookings are locked, so providers can share their own calendar. Match calls through that link *are* gated.
- **Re-acknowledging the preliminary step for a repeat consultation with the same agency** is intended.
- **Two-tab race**: two account members booking two same-type agencies within the same instant can both succeed. Self-correcting.

## Known gaps in automation

- Eva's conversational judgment (sections B, D) - prompt-driven, so only manual testing covers it.
- The conversations-list refresh after the connected-agency shortcut (D2) - server side is covered by CL-04; the client hook is inspection-only.
- Deposit figures against real cost sheets (C5) - automated tests use seeded tranches.
