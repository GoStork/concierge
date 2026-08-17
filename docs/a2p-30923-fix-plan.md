# A2P 10DLC campaign fix - error 30923 (consent cannot be required)

**Status:** not started. Written Aug 17 2026 for execution in a fresh session.
**Read this whole file before touching anything.** Background context lives in the
memory note `project_sms_deliverability.md` - read that too, it carries the traps.

---

## 1. Where things stand

The Standard A2P campaign was rejected a SECOND time on Aug 17 2026.

- Compliance SID `QE2c6890da8086d771620e9b13fadeba0b`, status **FAILED**, campaign_id null
- `error_code`: **30923**
- `fields`: **["MESSAGE_FLOW"]**
- Description, verbatim: *"The campaign submission has been reviewed and rejected because
  consent cannot be a required condition for service or transaction completion."*
- https://www.twilio.com/docs/api/errors/30923

This is NOT the earlier 30909 CTA-not-found rejection. Both evidence URLs were verified
live and correct on the rejection date (`gostork.com/terms` and `gostork.com/sms-consent`,
both 200, both carrying program name / data rates / frequency / bold STOP+HELP /
support@gostork.com). The reviewer found and read the CTA. The objection is the SHAPE of
the consent, not its visibility or its wording checklist.

**Nothing is broken and no cutover has happened.** Live SMS still runs on the old
sole-proprietor campaign `CX4XS4N` via messaging service `MGa6b8064464ed2c6cdd94fe2848d70255`,
which holds both numbers (+12058962077 production, +19785106884 idle).
`TWILIO_MESSAGING_SERVICE_SID` in `.env` still points at `MGa6b8...`. Do not change any of
that. The cutover runbook only runs once the NEW campaign shows VERIFIED, and it is
recorded in the memory note - it is out of scope for this plan.

Key SIDs for this work:

| Thing | SID |
|---|---|
| New (rejected) compliance registration | `QE2c6890da8086d771620e9b13fadeba0b` |
| New messaging service (0 numbers, deliberate) | `MG6c4e651e006fe5b8a47523b244db96cd` |
| Brand - APPROVED, unaffected, do NOT touch | `BN6108e1d38e5bcc6736eddd453978e389` |
| Live sole-prop service - do NOT touch | `MGa6b8064464ed2c6cdd94fe2848d70255` |
| Live sole-prop campaign - do NOT touch | `CX4XS4N` |

Re-check current status before starting, in case it changed:

```bash
cd /Users/eranamir/Documents/GitHub/concierge && set -a && source .env >/dev/null 2>&1 && set +a && curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" "https://messaging.twilio.com/v1/Services/MG6c4e651e006fe5b8a47523b244db96cd/Compliance/Usa2p" | python3 -c "import json,sys; d=json.load(sys.stdin); c=(d.get('compliance') or [{}])[0]; print(c.get('campaign_status'),'|',c.get('sid'),'|',c.get('campaign_id'),'|',c.get('errors'))"
```

---

## 2. Root cause

One sentence buys two different consents, and signup cannot proceed without it.

`client/src/components/ui/sms-consent-disclosure.tsx` currently reads:

> "By tapping Verify phone number, you agree to receive text messages from GoStork at the
> number above: your verification code, **plus** updates about your matches, appointments,
> and messages from your providers."

The verification code is required to finish signup. So a user cannot obtain the service
without also consenting to the ongoing notification stream. That is exactly what 30923
forbids.

The same defect is live in Terms section 17 (WordPress page 2092):

> "By providing your mobile number, you consent to receive text messages from GoStork,
> **including** account verification codes, match updates, appointment reminders, and
> messages from providers you connect with."

...and its escape clause is too narrow:

> "Consent to receive **marketing** texts is not a condition of **purchase**."

That covers neither our notification texts (which are not marketing) nor plain use of the
service (as opposed to a purchase).

**The fix is to SPLIT the two consents, not to reword harder.** Rewording alone will be
rejected again.

Supporting fact confirmed Aug 17 2026: there is no per-user SMS preference anywhere in the
schema - no `NotificationPreference` model, no opt-in field on `User`. Every notification
SMS currently goes out unconditionally to anyone with a phone number. So the split is a
real product change, not a copy change.

---

## 3. THE NEVER-DRIFT RULE (read before editing any copy)

The consent wording is carrier-registered and lives in THREE places that must stay
word-for-word identical. Changing one without the others is what fails a carrier audit:

1. `client/src/components/ui/sms-consent-disclosure.tsx` - the shared component, mounted on
   the onboarding phone step AND rendered by the public `/sms-consent` route
2. `https://www.gostork.com/sms-consent` - WordPress page ID **5461**, the URL written into
   the campaign's declared message flow. It must stay published forever, including after
   launch.
3. The campaign's "How do end-users consent to receive messages?" field in the Twilio Console

Also: never write inline consent copy on a new surface. Mount the shared component.

---

## 4. PART A - code (Claude does this)

Ordinary project rules apply: push to `main` only, migration file in the same commit as any
schema change, no em dashes, brand tokens only, no modals.

### A1. Schema + migration

Add to `model User` in `prisma/schema.prisma`:

```prisma
smsNotificationsOptIn Boolean @default(false)
```

Default **false** is required. Defaulting to true is a pre-checked box, which is its own
A2P violation.

Create `prisma/migrations/20260817_sms_notifications_opt_in/migration.sql` in the SAME
commit, using `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS ...`.

Run `npx prisma generate` before restarting the server.

### A2. Split the shared component

`client/src/components/ui/sms-consent-disclosure.tsx` becomes two exports from the one
file. Do NOT fork it - it is the shared source for both the phone step and `/sms-consent`.

- `<SmsTransactionalNotice />` - the one-time code only. States that we will text a
  verification code to this number and that msg & data rates may apply. No ongoing
  consent language, no STOP/HELP promise attached to a message the user explicitly
  requested by tapping Verify.
- `<SmsNotificationsOptIn />` - the optional stream: match updates, appointment
  notifications, messages from providers. Frequency varies, msg & data rates may apply,
  Reply STOP to unsubscribe or HELP for help, Terms + Privacy links, and one explicit
  sentence along the lines of **"This is optional. You can use GoStork without it."**

Keep the doc comment at the top of the file current, including the never-drift rule.

### A3. Rewire the onboarding phone step

`client/src/pages/onboarding-page.tsx` line ~1012 currently mounts the single bundled
disclosure inside `StepPhone`. Replace with:

- `<SmsTransactionalNotice />` above the Verify button
- an **unticked** checkbox rendering `<SmsNotificationsOptIn />` as its label

**The Verify button must stay enabled whether or not the box is ticked.** If declining
blocks the button, the rejection reason still stands and this whole exercise fails. Signup
must complete either way.

Persist the checkbox value to `smsNotificationsOptIn` when the phone is verified.

### A4. Update the public evidence route

`client/src/pages/sms-consent-page.tsx` renders the disclosure so the declared flow and the
live UI cannot drift. Update it to render BOTH new pieces, showing the same two-step
structure. Keep the route public with no auth guard.

### A5. Gate the sends

Non-OTP SMS must check `smsNotificationsOptIn` before dispatch:

- `server/src/modules/notifications/notification.service.ts`
- `server/notify-ip-form.ts`

The OTP path stays unconditional - it is transactional and tied to an action the user just
took. Email is unaffected, and that is deliberate: email is what a declining user still
gets, which is what makes the SMS opt-in genuinely optional rather than a service gate.

### A6. Settings toggle

Add a toggle so the preference is changeable after signup, in the existing account settings
area. Twilio reviewers look for a revocation path that is not just the STOP keyword.

### A7. Build and restart

Server + schema changes, so the full sequence: `npm run build`, `npx prisma generate`, kill
port 5001 with `lsof -ti :5001 -sTCP:LISTEN` and let the supervisor respawn, verify ngrok is
up. On BOTH Macs (this repo, and the iMac clone at `~/GitHub-iMac`).

Exception: if a test run is in progress, hold the restart and say so.

### A8. Hand the final copy to Eran

Once the component copy is settled, paste the EXACT final wording of both blocks into the
session output. Eran needs it verbatim for Part B and Part C - that is what keeps the three
places identical.

---

## 5. PART B - WordPress (Eran does this, needs wp-admin)

Both pages are on the WordPress marketing site. Watch for a caching plugin serving anonymous
visitors - i.e. reviewers - a stale copy; always re-check in a private window after
publishing.

### B1. Terms section 17

Edit here: https://www.gostork.com/wp-admin/post.php?post=2092&action=edit

(That is page ID **2092**, title "Terms and conditions". `gostork.com/terms` REDIRECTS to
`/terms-and-conditions/`. Do not confuse it with the similarly-named "Cookie Policys" page
that also matches a search for "terms".)

Rewrite section 17 as two separate paragraphs matching the new split:

- verification codes as transactional, sent because the user asked for them
- ongoing notifications as separately opted into, optional, revocable

and change the final sentence from *"Consent to receive marketing texts is not a condition
of purchase"* to cover both service and purchase, e.g. **"Consent to receive text messages
is not a condition of using GoStork or of any purchase."**

Section 17 must still pass Twilio's full checklist, which is stricter than it looks: program
name ("GoStork SMS Alerts"), description, msg & data rates, message frequency, support
contact info (support@gostork.com), and opt-out instructions with **HELP and STOP in bold**.

### B2. Evidence page

Edit here: https://www.gostork.com/wp-admin/post.php?post=5461&action=edit

Public URL: https://www.gostork.com/sms-consent

Replace the body with the new two-block copy, **word for word identical** to what Claude
hands over in step A8.

Replace the screenshot. It must show the phone step with the **unticked** checkbox next to
an **enabled** Verify phone number button, both visible in one crop, with **no browser
chrome** - deliberate, so no ngrok URL contradicts the declared `app.gostork.com`. Keep the
image large; the site's PageSpeed module passes it through undegraded and its whole job is
letting a reviewer read the small consent text.

Keep this page published forever, including after launch.

### B3. Verify anonymously

In a private window (or ask Claude to curl both), confirm `gostork.com/terms` and
`gostork.com/sms-consent` are 200 and carry the new language.

---

## 6. PART C - Twilio Console (Eran does this)

A rejected campaign CANNOT be edited or resubmitted. The Console offers only "Delete
Campaign" and "View connected Campaign", so the path is delete-then-recreate.

Console URL formats - two different prefixes, do not mix them up:
- account-level: `/us1/develop/sms/...` - services list is
  https://console.twilio.com/us1/develop/sms/services (confirmed working)
- per-service: `/us1/service/sms/<SID>/<subpage>` - the bare `/us1/service/sms/<SID>` with
  no subpage 404s

From the services list, open **`MG6c4e651e006fe5b8a47523b244db96cd`** ("Low Volume Mixed A2P
Messaging Service") - pick by SID, not by name; the account has 5 services and several look
alike. The one you must NOT touch is `MGa6b8...0255` ("Sole Proprietor A2P Messaging
Service"), which carries all live traffic. Then left nav > **A2P & Compliance**.

### C1. Delete the rejected campaign

Safe: that service has 0 numbers, and the live campaign `CX4XS4N` on `MGa6b8...` with both
numbers is untouched. Deleting DESTROYS the campaign content, which is why everything needed
to re-enter it is preserved below.

### C2. Recreate - unchanged fields

Brand `BN6108e1d38e5bcc6736eddd453978e389`, use case **Low Volume Mixed**.

Description (verbatim, was never the problem):

> GoStork is a fertility care marketplace. We send account holders transactional
> notifications about their own activity: one-time verification codes at signup, appointment
> request, confirmation, reminder, reschedule and cancellation notices for consultations they
> booked with fertility providers, alerts when an agreement is ready to sign, and invitations
> from a partner on the same shared account.

Sample messages (verbatim):

1. `Hi Sarah, Pacific Fertility Center confirmed your meeting. / When: Monday, August 17, 2026 at 9:30 AM PDT / Join: https://app.gostork.com/link/l_O3yAa4108`
2. `Hi Sarah, reminder: your meeting with Pacific Fertility Center starts in 1 hour. / Join: https://app.gostork.com/link/b3-b5NuacM6`
3. `Your GoStork verification code is: 565903`
4. `Hi Sarah, your agreement from Bright Futures Agency is ready to sign. / Review and sign: https://app.gostork.com/link/58PYG_JwEtF`
5. `Michael invited you to join their GoStork account! Log in to browse providers, schedule appointments & manage your fertility journey together: https://app.gostork.com/link/x7Kq2mB`

Flags: embedded links **YES**; embedded phone numbers **NO**; age-gated **NO**; direct
lending **NO**.

Opt-in Keywords and Opt-in Message: leave **BLANK**. Users cannot text a keyword to join.
The START/UNSTOP keywords in Advanced Opt-Out are resubscribe handling, not an opt-in
method, and claiming a text opt-in flow we do not have is itself a rejection risk.

### C3. Recreate - the message flow (the ONLY field that actually changes)

It must describe the two-step split explicitly. It has to say, in substance:

- the user enters their mobile number during signup to receive a one-time verification code,
  which is required to create the account and is sent only because they requested it
- separately, on the same screen, an **unticked** checkbox offers ongoing notifications
  (match updates, appointment reminders, provider messages)
- **signup completes whether or not that box is ticked**, and consent to those messages is
  not a condition of using GoStork
- consent is revocable at any time by replying STOP or via the toggle in account settings
- cite the evidence page `https://www.gostork.com/sms-consent`, which shows the exact
  on-screen wording and a screenshot of the step

Declared flow URL stays `https://app.gostork.com` - unchanged, and still true at launch by
design, so launch day needs no Twilio action.

Whatever final wording goes in this field, it must match the component and the WordPress
page word for word.

### C4. Confirm Advanced Opt-Out is still enabled

Per-service left nav > Opt-Out Management on `MG6c4e...`. The badge should read "Enabled"
next to the page title; the toggle applies instantly, there is no Save button. Our disclosure
promises STOP and HELP work, so this must be on. It is a Console-only flag, not exposed by
the API, so it cannot be checked from code.

### C5. Do NOT attach a phone number

Skip the wizard's "Register Phone Numbers" step. **THE TRAP:** a number lives in exactly ONE
messaging service, so adding +12058962077 to the new service silently REMOVES it from
`MGa6b8...`, which is still what `TWILIO_MESSAGING_SERVICE_SID` points at - every SMS would
start failing immediately. Attach nothing, or at most the idle +19785106884.

---

## 7. After submission

- Re-enable or recreate the daily watcher so the new registration gets polled. The previous
  one was the scheduled task `twilio-a2p-campaign-watch` (7am daily), which carries the full
  cutover runbook and is meant to delete itself once VERIFIED and the cutover is done. Point
  it at whatever new compliance SID comes back.
- Update the memory note `project_sms_deliverability.md` with the new SID, the submission
  date, and the fact that the split shipped.
- The cutover itself (move the number, flip `TWILIO_MESSAGING_SERVICE_SID` on both Macs,
  rebuild/restart both, one real test SMS, then delete the old sole-prop brand and campaign)
  happens ONLY after VERIFIED, in one sitting, in that exact order. It is written out in the
  memory note.

---

## 8. Open decision for Eran

Gating non-OTP SMS on the new flag means parents who decline get email only for appointment
reminders, which costs some reach. The alternative is to make the opt-in prominent and
well-worded rather than buried, so most people tick it - but it must remain genuinely
declinable with signup completing either way, or we land straight back on 30923. There is no
version of this where the notification consent can be mandatory.
