# CRM Phase 9 - seven features

Decisions taken 12 Aug 2026. Each section is buildable as written; the two that
needed design (playbooks, silence) carry their full model here.

Build order is A then B. A is cheap and additive; B introduces new models and
settings surfaces.

**A** - 2a Home identifier · 4 Log a call · 6 Bulk actions · 7 @mentions · 1 Search
**B** - 3 Stage playbooks · 5 Silence signal · 2b Manual merge
**S** - 8 Signup abuse defence. Ahead of everything: it is costing money now.

---

## 1. Search that reaches what people wrote

Today `/parents` matches name, email and phone only. Notes and tasks - the
writing the team produces - are unreachable.

**Scope (decided):** note bodies, task subjects, task notes. Not chat messages,
not sent emails.

**Server** - `GET /api/parents/search?q=` on `parent-record-router`:

- `ILIKE '%q%'` over `ParentNote.body` (HTML stripped at write time into a new
  `bodyText` column, so search never matches a tag name) and over
  `ParentTask.title` + `ParentTask.notes`.
- Audience scope is the existing `crmWhere`: an admin sees everything, a
  provider sees `scope = PROVIDER AND providerId = own`. **A GOSTORK note must
  never appear in a provider's results** - this is the one hard rule.
- Returns `{ parentUserId, parentName (gated), kind, snippet, at }`, capped at
  50, newest first. Parent names run through `resolveParentGatesBatch`.
- `q` shorter than 3 characters returns nothing rather than everything.

**Schema** - `ParentNote.bodyText String?`, written by `noteHtmlToText()` on
create and edit, backfilled once. Index: `pg_trgm` GIN on `bodyText`,
`ParentTask.title`, `ParentTask.notes` if ILIKE proves slow at volume.

**Client**

- `/parents` search keeps its instant client-side name/email/phone filter and
  gains a second section below the table: "Found in notes and tasks (4)", each
  row a snippet linking to `/parents/:id`.
- Record page: a find box above the Activity feed filtering loaded entries by
  text, so a long timeline is navigable.

**Done when** searching a word that exists only inside a note body finds that
family, and the same search as a provider whose org did not write the note
finds nothing.

---

## 2a. Telling two families apart on Home

Two accounts named "Eran Amir" made the Home queue unreadable.

- Each queue row gains a second identifier under the title: **the family's
  email when Gate B is open**, otherwise the service line and stage
  ("Surrogacy · Matched"). Never show contact details a release withholds.
- Queue rows also gain the **service tag** they already carry in the data
  (`ParentTask.serviceLine`), drawn with the shared `ServiceTag`.

**Done when** two same-named families are distinguishable at a glance on
`/provider/home`, and a gated family shows no email.

---

## 2b. Merge or link two families - manual only

**Revised 12 Aug.** The platform does **not** suggest duplicates. A production
bot signup wave (thousands of `gostork.*@gmail.com` accounts) makes automatic
suggestion actively dangerous: the same detection that finds a husband and wife
would offer to merge ten thousand bot accounts, and one careless click would
destroy real records. Suggestion is also the wrong shape - only a human knows
that two records are the same family.

**Merge** and **Link as household** are actions on the record, under the same
Actions menu that holds pin, edit and delete - HubSpot's shape.

1. The coordinator opens **Actions → Merge with another family**.
2. A picker searches by name, email or phone. It shows what each record holds -
   services, stage, notes, tasks, invoices - so the choice is informed.
3. A confirmation names both records and states plainly what moves.
4. On merge: sessions, notes, tasks, owners, invoices, agreements, quotes,
   releases and journey events move to the surviving key. `ParentAccountMerge`
   records who did it and when; the absorbed `User` keeps a
   `mergedIntoUserId` pointer so old links still resolve.

**Link as household** is the lighter action: two accounts stay separate but are
shown as one family (the household badge the table already draws), for a couple
who each signed up.

Merge is admin-only and irreversible; link is available to providers and can be
undone.

---

## 3. Stage playbooks

When a family reaches a stage, raise the steps that always follow.

**Authoring (decided):** each org authors its own, starting from GoStork
starter playbooks it can copy. Lives at `/account/playbooks`.

### Model

```
TaskPlaybook
  id, providerId (null = GoStork starter, read-only to orgs)
  name                     "Matched - surrogacy handoff"
  serviceLine              surrogacy | egg_donation | ... | null = any line
  triggerStage             a JOURNEY_STAGE_ORDER id
  isActive                 Boolean
  createdByUserId, createdAt, updatedAt

TaskPlaybookStep
  id, playbookId
  title                    "Send the intended parent form"
  notes                    rich text, optional
  type                     TODO | CALL | EMAIL
  priority                 NONE | LOW | MEDIUM | HIGH
  dueOffsetDays            0 = the day it fires, 3 = three days later
  dueTime                  "09:00" in the assignee's own timezone
  reminderMinutesBefore    Int?
  sortOrder                Int
```

### Firing

- Runs in the existing 10-minute sweep, beside the materializer, over families
  whose derived stage per service line was reached since the last pass.
- One task per step, `systemKey = playbook:<stepId>:<accountKey>:<line>`. The
  unique index makes it once-only across both machines **and** makes dismissal
  permanent, exactly as the work-queue tasks behave.
- `dueAt = stageReachedAt + dueOffsetDays` at `dueTime`.
- **Assignment (decided):** the family's lead owner; with no owner, the org's
  name, visible to the whole team.
- Stage regression never re-raises - the key already exists.
- Editing a playbook affects future firings only; tasks already raised are real
  rows and are left alone.

### Authoring UI

`/account/playbooks` - a list of the org's playbooks plus GoStork starters with
"Copy to my agency". The editor is one page: name, service line, trigger stage,
and the steps with add / remove / reorder. A preview sentence states plainly
what will happen: *"When a family reaches Matched on Surrogacy, these 5 tasks
appear, due 0-7 days later, on the lead owner."*

**Done when** moving a test family to a trigger stage raises exactly the steps
once, they carry the right due dates and owner, and a second sweep raises
nothing.

---

## 4. Log a call or an email

**Shape (decided):** a note with a kind, not a separate model - so it inherits
the timeline card, search, service line, pinning, editing and the gates.

**Schema** - on `ParentNote`:
```
kind             NOTE | CALL | EMAIL | MEETING   (default NOTE)
outcome          reached | voicemail | no_answer | rescheduled   (calls only)
durationMinutes  Int?                                            (calls only)
occurredAt       DateTime?   defaults to now, editable - you log yesterday's call
```

**Composer** - a kind selector beside the service line. Choosing Call reveals
outcome and duration; choosing anything but Note reveals "when did this
happen".

**Card** - the icon and title follow the kind ("Call logged", "Email logged"),
outcome and duration render as chips, and the card sorts by `occurredAt`.

**Done when** a call logged for yesterday appears in yesterday's place on the
timeline with its outcome, and is findable by search.

---

## 5. Silence as a first-class signal

A family that simply goes quiet is invisible today.

**Last touch** = the most recent of: a message either direction on any of this
family's threads with this org, a meeting that happened, a note or logged call,
a completed task, a payment.

**Thresholds (decided):** per stage, GoStork defaults, each org can change them.

| Stage | Quiet after |
|---|---|
| registered, exploring | 14 days |
| consult_scheduled, consult_completed | 7 |
| ip_form_submitted, doctor_call_scheduled, doctor_call_completed | 7 |
| match_call_scheduled, matched | 5 |
| invoice_sent | 3 |
| invoice_paid, agreement_sent | 3 |
| agreement_signed, handed_off | never - the journey is done |

**The ladder (decided):** Eva first, the coordinator second.

1. **At the threshold** - Eva sends one warm check-in in the family's own
   thread. Dual-audience per the house rule: second person to the parent in
   `content`, a plain statement of what she did in
   `uiCardData.providerContent`. Recorded as a journey event so the record
   shows it.
2. **At the threshold again with no reply** - a SYSTEM task,
   `systemKey = silence:<accountKey>:<line>:<nth>`, titled "No reply from
   <family> since <date>", on the lead owner or the org, deep-linked to the
   thread. It closes itself the moment the family replies, through the same
   read-time reconcile the other system tasks use.

**Never fires when** the line is handed off, the family matched elsewhere on
it, a future booking exists, the family has opted out of messages, or an open
silence task is already sitting there. Both machines are safe: `dedupeKey` on
the notification and the unique `systemKey` on the task.

**Shipping state (revised 12 Aug).** On by default - a feature that ships off
is a feature nobody uses. The only staged part is the half that talks to
families: for the first 7 days per org, Eva's check-in runs in **shadow** -
it computes and records who it would have messaged, visible to GoStork admin,
and sends nothing. The coordinator task fires for real from day one, because a
task cannot embarrass anyone. After the window it starts sending, with no
switch for anyone to remember to flip.

**Settings** - `/account/automation`: the per-stage day counts, an on/off per
service line, and whether Eva's step is enabled at all (an agency may want the
task only).

**Surfacing** - a "Quiet for" column and filter on `/parents`, sortable, so the
list can be worked by silence rather than only by stage.

**Done when** a family with no touch for longer than its stage's threshold gets
exactly one Eva check-in, a task appears if the silence continues, and both
stop the instant they reply.

---

## 6. Bulk actions

The admin table already has the checkbox column, wired only to delete. All four
actions, for admins **and** providers, on their own rows:

- **Assign a lead owner** - one write per family, the same endpoint the row uses.
- **Create the same task for each** - one composer, N tasks, each on its own
  record with its own due date.
- **Apply a playbook** - run a playbook across the selection, for families who
  passed the trigger stage before the playbook existed.
- **Export selected to CSV** - the visible columns, gated fields excluded.

A selection bar appears above the table with the count and the four actions.
Every bulk write reports how many succeeded and names any that failed.

---

## 7. @mentioning a colleague

**In a note's rich text**, typing `@` opens a typeahead of people who can
already see that note - the same audience scope, so a mention can never
disclose a note to someone outside it. Mentions are stored in the body as
`<span data-mention-user-id="...">@Name</span>` and sanitised like everything
else.

**On save**, each newly mentioned person gets:
- an in-app notification, and
- an email carrying the note's text and a link to the record.

Editing a note notifies only people added by that edit. You are never notified
about your own mention.

**Done when** mentioning a colleague reaches them by both channels, the
typeahead offers nobody who cannot see the note, and re-saving does not notify
the same person twice.

---

## 8. Signup abuse defence · ships first

Production is carrying thousands of bot accounts: `gostork.<random>@gmail.com`,
created in bursts, with phone numbers from Ethiopia, Azerbaijan, Serbia,
Pakistan, Kyrgyzstan and Tajikistan. That pattern is **SMS toll fraud** - a
script triggers OTPs to premium ranges and the fraudster takes a share of the
carrier revenue. Every verification was billed to GoStork.

### What this platform already does

`sendOtp` goes through Twilio Verify rather than raw SMS, and
`assertPhoneIsReachable` calls Twilio Lookup and rejects VoIP and landline
numbers. Good, and not enough.

### What is missing

No country restriction, no rate limit on `send-otp` or on registration, no
CAPTCHA, no record of where a signup came from. A script can call `send-otp` in
a loop today.

### Layer 1 - never send a message we would not want to pay for

- **Country allowlist for OTP.** SMS goes only to countries GoStork serves.
  Everywhere else verifies by email. This single control ends the pattern in
  the screenshot.
- **Per-phone** 3 sends an hour, 5 a day. **Per-IP** 5 an hour.
  **Per-prefix**: if a country prefix spikes past its normal rate
  platform-wide, it is blocked automatically and GoStork is alerted.
- Twilio Verify **Fraud Guard** on at the service, and Verify's own rate limits
  configured rather than left at default.

### Layer 2 - make bulk signup expensive

- **Turnstile** (invisible, free) on register and on send-otp, verified
  server-side.
- **Per-IP** 3 accounts an hour, 10 a day; per /24 subnet 20 a day.
- **Email**: MX check, disposable-domain blocklist, and Gmail normalisation
  (dots and `+aliases` collapse) so one mailbox cannot become many accounts.

### Layer 3 - contain whatever still gets through

```
User.trustState   ACTIVE | PENDING_REVIEW | BLOCKED
User.signupRisk   { ip, userAgent, country, asn, score, reasons[] }
```

A high score lands in `PENDING_REVIEW`: the account can browse, and can do
nothing else. It cannot message a provider, does not appear in any provider's
CRM or queue, raises no notifications, and starts no Eva thread. Nothing
reaches a coordinator until a human clears it.

### Layer 4 - the admin surface

`/admin/signups`: the review queue with each account's signals, bulk approve
and block, and **block this pattern** - an email prefix, a phone prefix or an
IP range, stored as a rule that future signups are checked against. Plus a
one-shot classifier for cleaning an inherited mess: it labels and blocks in
bulk, and never merges.

**Done when** a scripted burst of registrations from a non-served country
receives no SMS, is rate-limited within seconds, lands in review rather than in
anyone's CRM, and shows up as one pattern an admin can block in a single click.
