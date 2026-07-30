# Parent CRM - test plan

Covers the parent record at `/parents/:id`, the two `/parents` tables, and the
CRM layer (notes, next step, lead owner, tags).

Status legend: `[x]` verified, `[ ]` not yet run, `[!]` known gap.

**Roles used below**
- **P** = provider staff. Reference account: Jered Mercer / Family Creations.
- **A** = GoStork admin. Reference account: Eran Amir.
- Reference parent: **Eran Test** (`natan123+lala@gmail.com`) - three provider
  orgs, a contact release from exactly one of them, a MATCHED surrogate.

---

## 0. Automated suites

Run both before shipping anything that touches parent scoping. They hit the real
database, so they catch "a WHERE clause quietly stopped scoping" in a way a
single-provider fixture cannot.

```bash
npx tsx scripts/test-parent-record.ts
```

```bash
npx tsx scripts/test-parent-crm-scope.ts
```

```bash
npx tsx scripts/test-parent-gate-a.ts
```

- [x] **A-1** `test-parent-record.ts` - 24 assertions, ALL PASSED
- [x] **A-2** `test-parent-crm-scope.ts` - 19 assertions, ALL PASSED
- [x] **A-3** `test-parent-gate-a.ts` - 6 assertions, ALL PASSED
- [ ] **A-4** Wire all three into the main suite / CI rather than running by hand

---

## 1. Privacy - the part that must never regress

The two gates are the reason this feature is allowed to exist. Everything here
is verified by A-1 unless noted.

- [x] **PR-1** Provider sees ONLY their own org across conversations, saved
      profiles, money and `providerOrgs`
- [x] **PR-2** Provider never receives `historySummary` (admin-only field)
- [x] **PR-3** Gate B closed (IFLG, no release row): email + mobile withheld,
      name still visible, account members redacted too
- [x] **PR-4** `ipForm.responseId` withheld behind Gate B, but `status` still
      readable so the page can say "submitted, unlocks when…" rather than the
      flat lie "not submitted yet"
- [x] **PR-5** Provider with no relationship at all gets 403
- [x] **PR-6** GOSTORK-scope note is invisible to the provider - posted
      "price shopper" as admin through the UI, asserted absent for Family Creations
- [x] **PR-7** Provider still sees its own PROVIDER-scope note
- [x] **PR-8** Follow-ups, tags and owner rows are all scoped the same way
- [x] **PR-9** Engagement counts scoped to the provider's own roster
      (12 / 1606 for P vs 16 / 1997 for A on the same parent)
- [ ] **PR-10** Gate B closed on the **record page in a browser** - only the
      table has been eyeballed (the un-released couple row shows the
      "Shared after intake or invoice" chip). Needs a provider login for an org
      with no release, then inspect the DOM for a literal `null`
- [ ] **PR-11** Saved-profile roster filter with real data - the fixture parent
      has no saved profiles, so the "agency A sees bank B's donor" guard is
      covered by code + A-1 shape only, never by live rows
- [ ] **PR-12** Note body contact-guard: as admin, write a PROVIDER-scoped note
      containing a phone number to an org whose Gate B is closed. Expect a 422
      with the explanatory body, not a silent write

---

## 2. Parents table

### Provider view
- [x] **T-1** Renders with Owner / Next step / Tags columns
- [x] **T-2** Quick-filter pills render (All / My leads / Overdue / No owner)
- [x] **T-3** Active pill highlights *(regression: it never highlighted - the
      comparison normalised `""` vs `"all"` differently)*
- [x] **T-4** Overdue filter returns 0 rows when the only step is due today
- [x] **T-5** Filtered-to-empty shows "No parents match your filters."
      *(regression: showed "No parent contacts yet… when the AI concierge
      connects them with you" on a list that has parents)*
- [x] **T-6** Row click opens `/parents/:id`
- [x] **T-7** CRM writes on the record appear in the columns

### Admin view
- [x] **T-8** Row click and name link both open `/parents/:id`, not `/users/:id`
- [x] **T-9** Search filters correctly
- [x] **T-10** Cost-sheet chip opens `/admin/concierge-monitor?sessionId=…&msg=quote:…`
      with the card highlighted *(regression: `hasProviderRole` is false for
      GOSTORK_ADMIN, so `/chat/:sessionId` dumped admins on `/chat`)*
- [x] **T-11** Admin Next-step column shows the GOSTORK step, not a provider's
- [ ] **T-12** Sort by Owner and by Next step (nulls last)
- [ ] **T-13** `owner=me` / "My leads" with an owner actually assigned
- [ ] **T-14** `tag=` filter with a tag assigned
- [ ] **T-15** Clear-filters resets all eight params in one atomic update
- [ ] **T-16** Bulk select + delete still works after the column changes
- [ ] **T-17** Couple rows stay adjacent (household grouping) with new columns

---

## 3. Parent record page

### Shared (both roles)
- [x] **R-1** Header: name, match status, service chips, contact line
- [x] **R-2** Contact reason reads "Shared - invoice sent" *(regression: read
      "Shared because the invoice sent")*
- [x] **R-3** Profile section: Journey + Biological Baseline + Clinic /
      Surrogate preferences
- [x] **R-4** Interested profiles: per-thread match status, last-message
      preview, profile photo with status dot
- [x] **R-5** "Open chat" lands on the exact thread for that profile
- [x] **R-6** "Profile" opens `/{slug}/{providerId}/{profileId}`
- [x] **R-7** Saved-not-contacted empty state
- [x] **R-8** Engagement line
- [x] **R-9** Journey timeline renders the full stage ladder
- [x] **R-10** Money section, uncapped, one row per item
- [x] **R-11** Money rows do not repeat the org name *(regression: every cost
      sheet said "- Family Creations -" under a header already saying it)*
- [x] **R-12** `?sec=` opens exactly the named sections; survives Back
- [x] **R-13** Mobile 390px: single column, no horizontal overflow
- [ ] **R-14** `?sec=none` collapses all and survives a reload
- [ ] **R-15** Household block on a couple account (reference parent is solo)
- [ ] **R-16** IP form "submitted but locked" copy (fixture form not submitted)
- [ ] **R-17** Doctor and clinic profile links (only surrogate exercised;
      doctor uses `/doctors/:slug`, clinic uses `/providers/:id`)
- [ ] **R-18** 403 error state and its "Back to parents" button
- [ ] **R-19** Saved-profiles grid with real saved data

### Provider only
- [x] **R-20** Flat conversation list, no org group headers
- [x] **R-21** No "Account settings", no "Open in monitor", no "GoStork only"
      section *(confirmed absent in the accessibility tree, not just visually)*

### Admin only
- [x] **R-22** Conversations grouped by provider org with logos and counts
- [x] **R-23** Concierge threads do not repeat the org name as title + chip
      *(regression: "IFLG… / Handed Off / IFLG…" under an "IFLG" header)*
- [x] **R-24** "Account settings" opens `/users/:id`; Back preserves `?sec=`
- [x] **R-25** "GoStork only": one contact-sharing panel per org, correctly
      showing released vs "Unlock contact"
- [ ] **R-26** Clicking "Unlock contact" actually opens Gate B, and only for
      that org
- [ ] **R-27** Revoke is offered only for an `ADMIN`-reason release
- [ ] **R-28** "Open in monitor" button from the header

---

## 4. CRM layer

- [x] **C-1** Provider sees a single locked scope chip, not a choice
- [x] **C-2** Admin sees GoStork internal + one pill per org
- [x] **C-3** Post a note - correct scope chip, author, timestamp
- [x] **C-4** Set a next step inline (quick-picks + inline calendar, no modal)
- [x] **C-5** "Today" is not instantly overdue *(regression: the quick-pick set
      17:00, so clicking it after 5pm created a red chip immediately)*
- [x] **C-6** Add a tag; it appears in the header strip and the table
- [x] **C-7** Admin sees a next-step card per scope
- [x] **C-8** Mobile: owner / next step / tags render above the notes feed
- [ ] **C-9** Assign a lead owner; verify the picker lists the right people
      (GoStork staff for A, own-org staff for P)
- [ ] **C-10** Owner validation: a provider cannot assign a user outside their
      org (server returns 400) - the staff-directory enumeration guard
- [ ] **C-11** "Mark done" on a next step
- [ ] **C-12** Edit a note within the 15-minute window; confirm scope and
      providerId are immutable
- [ ] **C-13** Delete a note is a soft delete (row survives for audit)
- [ ] **C-14** Remove a tag
- [ ] **C-15** Tag-id probing returns 404, not 403, for an invisible tag
- [ ] **C-16** Two concurrent "set next step" calls cannot create two OPEN rows
      (partial unique index) - proven at the SQL level for ParentOwner, not yet
      exercised through the API

---

## 5. Regressions in surfaces this work changed underneath

The shared components were modified, so their original mount sites need a look.

- [ ] **X-1** Provider chat sidebar (`/chat`) - `ParentProfileCard` gained a
      `layout` prop; default `"rail"` must be unchanged
- [ ] **X-2** `/admin/concierge-monitor` - `ContactReleaseSection` gained
      `divider` / `heading`; defaults must render byte-identically
- [ ] **X-3** Chat match cards still link correctly - `getProfileUrlSlug` is now
      a wrapper over the single `TYPE_TO_SLUG` map
- [x] **X-4** `/api/agreements` still registered and auth-guarded (401, not 404)
      after `server/routes.ts` was deleted; no dangling imports of it remain.
      *Endpoint-level only - the agreements page itself is X-4b below*
- [ ] **X-4b** Open `/agreements` in the UI and confirm the list renders
- [x] **X-5** All five W-9 routes still registered and auth-guarded - the ones
      that looked orphaned when grepping `routes.ts`, because `W9Controller`
      declares them as Nest decorator fragments a literal grep cannot see
- [ ] **X-5b** Walk one W-9 flow end to end in the UI
- [x] **X-6** Gate A fix pinned by `scripts/test-parent-gate-a.ts`: a derived
      `MATCHED` closes Gate A (the bug), a raw `PROVIDER_CONNECTED` opens it
      (the fix), neither opens Gate B, a booking alone still rescues, an
      ACTIVE-only thread stays closed, and one booked sibling unmasks the whole
      account. No longer blocked on constructing live data

---

## 6. Known gaps and deferred work

- [!] **G-1** `EvaKnowledgePanel` was **not** extracted from
      `admin-concierge-monitor.tsx`, so the record page has no "What Eva knows"
      block. Deferred because another session had an active 160-line insertion
      in that file
- [!] **G-2** The two table views were **not** structurally converged. They
      share the cells, the filter predicate and the CRM columns, but the table
      scaffolding is still two copies. Deferred as a large refactor with real
      regression risk
- [!] **G-3** Admin vs provider service filters still differ: admin
      substring-matches free-text labels, provider equality-matches an enum key.
      Normalising `/api/admin/parents-overview` onto `SERVICE_LABELS` keys is a
      follow-up
- [!] **G-4** `server/auth.ts` is now fully orphaned (zero importers) after
      `routes.ts` was deleted. It still exports `hashPassword`; deleting it is a
      judgment call, not a cleanup

---

## 7. Test data currently in the database

Created while testing, all on the **Eran Test** account. Delete when done:

| What | Scope | Content |
|---|---|---|
| Note | PROVIDER (Family Creations) | "Family is deciding between Surrogate #25714 and #25996…" |
| Note | GOSTORK | "INTERNAL ONLY: price shopper, comparing us against two other agencies…" |
| Next step | PROVIDER (Family Creations) | "Send updated surrogate cost sheet", due 7/30/2026 |
| Tag | PROVIDER (Family Creations) | "high intent" |

---

## 8. Environment notes

- Server runs Vite dev middleware, so client edits are live over HMR - but the
  **Vite module cache went stale mid-session**. If a UI edit appears not to
  apply even after a hard reload: `rm -rf node_modules/.vite` and restart.
- Hold any server restart while `scripts/test-*.ts` is running; restarting
  mid-run orphans tests.
- The `/parents` record endpoint is `GET /api/parents/:id/record`. The old
  `GET /api/provider/parents/:id` is now a thin alias over the same builder.
