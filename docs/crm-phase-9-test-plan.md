# CRM Phase 9 - test plan for #3 Playbooks, #5 Silence, #2b Merge/Link

Written 12 Aug 2026 against commits f556cee0 / 76e6364a / 6281b297.

## Before you start

**Accounts you need**
- A GoStork admin login (eran.amir@gostork.com works).
- A provider staff login at an agency with real families on its books (a
  surrogacy agency is best - its ladder has the most rungs).
- Two **disposable** parent accounts for the merge test (create them via
  /parents → Add Parent). Never merge real families while testing - merge is
  irreversible by design.

**Timing realities**
- The playbook and silence sweeps run on the 10-minute cron. After you take a
  triggering action, results appear within 10 minutes - not instantly.
- Playbooks only fire on stages reached in the **last 72 hours** (older
  history is the bulk "Apply playbook" action's job).
- Eva's silence check-in is in **shadow for each org's first 7 days** - it
  records a `SILENCE_EVA_SHADOW` journey event and sends nothing. The
  coordinator task needs a full threshold period *after* the check-in.
- So the deep silence-ladder steps cannot be tested same-day with real time.
  The "fast-forward" notes below say what to backdate in the DB (ask Claude
  to run them - each is a one-line UPDATE) to compress days into one tick.

---

## #3 Stage Playbooks

### Admin (GoStork)

1. **Authoring page.** Go to /account → Playbooks tab.
   - Expect: "GoStork playbooks" (empty at first) and "GoStork starters"
     with the two seeded starters (*Matched - surrogacy handoff*,
     *After the consultation*), each editable by you.
2. **Create a playbook.** New playbook → name "Test - consult follow-up",
   line = Surrogacy, trigger = Consultation Completed, 2 steps:
   - Step 1 "Call the family" (Call, High, due 0 days at 09:00, remind 30 min)
   - Step 2 "Send recap email" (Email, due 1 day at 10:00)
   - Expect: the preview sentence reads *"When a family reaches Consultation
     Completed on Surrogacy, these 2 tasks appear, due 0-1 days later, on the
     lead owner."* Save; it appears under GoStork playbooks.
3. **Edit in place.** Edit it, reorder the steps with the arrows, rename step
   1, save. Reopen - order and title held.
4. **Starter flag.** Create another playbook and toggle "Offer as GoStork
   starter". Log in as a provider - it must appear in their starters list
   with **Copy to my agency**, and must NOT fire for anyone.
5. **Automatic firing.** Pick a test family, complete a consultation with a
   surrogacy agency (or have the test family's booking outcome recorded).
   Within 10 min of the stage flipping:
   - Expect: on /parents/:id → Activity, two GOSTORK-scope tasks titled from
     your steps, due dates 0 and 1 day out at the step times, assigned to
     the family's GoStork lead owner (or "GoStork" if none).
6. **Once-only.** Wait one more sweep (10 min). Expect: no duplicates.
   Dismiss one task, wait another sweep - it must NOT come back.
7. **Bulk apply.** On /parents, select 2-3 families → **Apply playbook** →
   pick your playbook.
   - Expect: toast reports families applied + tasks created; each record now
     has the steps, due dates counted from *now*. The family from step 5
     gets **no duplicates** (same systemKey).
8. **Deactivate.** Toggle the playbook off (Paused). Move another family to
   the trigger stage - nothing fires.

### Provider

1. /account → Playbooks. Expect: your own list (empty), plus GoStork
   starters marked read-only with **Copy to my agency** - no Edit/Delete on
   them.
2. Copy a starter. Expect: an editable copy in "Your playbooks", active.
3. Create your own: trigger = Matched, line = Surrogacy, 1-2 steps.
4. Move one of your families to Matched (confirm a match). Within 10 min:
   - Expect: tasks appear on the family record and in your Home queue /
     /provider tasks, assigned to your org's lead owner for that family
     (or the org name). serviceLine tag = Surrogacy.
5. **Privacy check (important).** As this provider you must never see the
   GoStork admin playbook from the admin test, and its GOSTORK-scope tasks
   must never appear in your task list or on your view of the record.
6. Bulk apply from /parents is admin-only today - confirm the provider
   /parents page simply has no selection checkboxes (unchanged behavior).

**Fast-forward for step 5/4:** if no family is conveniently near the trigger,
ask Claude to backdate the family's `ParentStageSnapshot` row one rung below
the trigger; the next real stage change then fires normally.

---

## #5 Silence signal

### Admin

1. **Settings.** /account → Automation.
   - Expect: the spec's default day counts per stage (14/14/7/7/7/7/7/5/5/
     3/3/3, blank for Agreement Signed and Handed Off), all lines on, Eva
     step on. You are told you're editing platform defaults.
2. Change *Matched* to 4 days, save, reload - it sticks. (Org rows without
   overrides inherit this.)
3. **Quiet-for column.** /parents → the new "Quiet for" column (far right).
   - Expect: values like "Today"/"N days"; 7+ days renders in the warning
     color; sorting by the column works; the **Quiet for** dropdown filter
     (3+/7+/14+/30+) narrows the list.
4. **Shadow is recording, not sending.** Ask Claude to list
   `SILENCE_EVA_SHADOW` journey events (15 existed after the first tick).
   Pick one, open that family's chat as the parent (or the admin monitor):
   there must be NO Eva check-in message in the thread.
5. **Never-fires guards.** Verify no shadow/check-in exists for: a family
   with a future booking; a handed-off line; a family whose line was won by
   another org. (Claude can cross-check the event table against these.)

### Provider

1. /account → Automation. Expect: same form, no "platform defaults" wording,
   plus the shadow banner ("Eva's check-in is in its 7-day shadow period...").
2. Set your own *Consultation Completed* threshold to 3 days, save. This
   overrides the platform default for your org only.
3. **Quiet-for** column + filter on your /parents - values are quiet time
   with *your* org specifically.
4. **The touch definition.** Pick a quiet family, log a call on their record
   (dated today). Within 10 min the Quiet-for value resets to "Today".
   Sending them a chat message, completing a task, or a paid invoice must
   do the same; an Eva message must NOT.

### The full ladder (needs fast-forwarding)

Real time would take a week-plus. To compress, ask Claude to (for one test
family x org):
1. Backdate `SilenceState.lastTouchAt` past the stage threshold → next tick
   records the **shadow** event (org still in shadow) - verify nothing was
   sent in-thread.
2. Backdate the org's `SilenceConfig.shadowSince` by 8 days and delete the
   test shadow event → next tick **sends** the real Eva check-in.
   - Expect in the SHARED provider thread: parent side reads a warm
     second-person check-in; provider side reads "Eva checked in with
     <family> after N days of quiet on surrogacy." (dual-audience rule).
3. Backdate that check-in's journey event past the threshold again → next
   tick raises the task **"No reply from <family> since <date>"** on the
   lead owner, deep-linked to the thread. Exactly one; a second tick adds
   nothing.
4. Reply as the parent in that thread → open the record or Home queue as
   the provider: the silence task closes immediately (read-time reconcile);
   at worst within 10 minutes.
5. Toggle **Eva's check-in step** off at /account/automation and repeat 1-3:
   no Eva message ever, but the coordinator task still arrives.

---

## #2b Merge / Link as household

Use the two disposable parents. Give parent A some texture first: a note, a
task, a lead owner; leave parent B with a chat thread if possible.

### Admin - merge

1. Open /parents/A → the header's **⋯** Actions menu.
   - Expect: "Merge with another family" and "Link as household".
2. Choose Merge. Search for parent B by name, then again by email fragment,
   then phone.
   - Expect: candidates show what each holds - per-line stages, note/task/
     invoice/agreement/conversation counts. Fewer than 2 characters returns
     nothing. Parent A never appears in its own results.
3. Pick B. Expect a red-bordered confirmation naming both records and
   stating what moves, with the holdings summary repeated.
4. Confirm. Expect: page reloads; B's notes/tasks/chats now on A's record;
   /parents shows one family (B's login listed as a member); B can still
   log in and lands on the shared account. Ask Claude to verify the
   `ParentAccountMerge` audit row and `mergedIntoUserId` on B.
5. **No auto-suggest anywhere.** Confirm nothing on /parents or the record
   ever proposes a merge on its own - the only entry is the Actions menu.
6. As a **provider**, open the Actions menu: "Merge with another family"
   must be absent (admin-only); hitting the API directly returns 403.

### Admin + provider - link as household

1. On another pair of (real or test) families: Actions → Link as household,
   search, pick, confirm.
   - Expect: toast; /parents (admin) now shows the household badge
     ("Couple - X & Y") on both rows and groups them together; each record
     keeps its own journey, notes and money - nothing moved.
2. Reopen Actions → Link as household on either record.
   - Expect: the existing link listed with an **Unlink** button. Unlink;
     the badge disappears. Re-link; linking the same pair twice never
     creates a duplicate.
3. As a provider: the Link option exists, but the picker only offers
   families already on your books - search for a family you have no
   relationship with and expect zero results.

---

## Regression spot-checks (10 minutes)

The reconcile changes and the table column touch shared machinery:

- **Work-queue tasks still close.** Approve a pending cost sheet/agreement
  card - its SYSTEM task disappears from Home immediately (read-time
  reconcile unchanged for the four queue kinds).
- **Playbook/silence tasks survive the sweep.** Any playbook task from the
  tests above must still be OPEN 20+ minutes later (the old reconcile would
  have auto-closed foreign systemKeys - the fix under test).
- **Parents table alignment.** Column headers line up with cells all the way
  to Actions (a stray duplicate Next-step cell was removed when Quiet-for
  went in). Check both admin and provider tables at full width.
- **Existing bulk actions** (Assign owner / New task / Export CSV / Delete)
  still work with the new Apply-playbook control between them.
