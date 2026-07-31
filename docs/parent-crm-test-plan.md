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
- [x] **PR-10** Gate B closed on the record page - the couple record shows the hidden-contact chip in the header, in the Parent Profile CONTACT row, and per member in the household block. No literal `null` anywhere
- [x] **PR-11** Saved-profile roster filter proven with LIVE rows: a different org sees none of the owning org's saved profiles (now asserted in `test-parent-record.ts`)
- [x] **PR-12** Note contact-guard, and it discriminates correctly: a phone number in a note bound for a GATE-B-CLOSED org returns 422 with the guard's explanation; the same text to a RELEASED org is allowed (the guard is about the gate, not about banning digits); a GOSTORK-internal note is unaffected

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
- [x] **T-12** Sort by Owner and by Next step - both headers reorder rows, no errors
- [ ] **T-18** `owner=<userId>` still has no UI control - only the All / My
      leads / No owner pills. A per-person owner dropdown is unbuilt
- [x] **T-13** `owner=me` / "My leads" - assigned Eran Amir, filtered to that
      one parent, Owner column renders the monogram + first name
- [x] **T-14** `tag=` filter with a tag assigned. *Gap found and closed: the
      param worked but had NO UI control, so it was reachable only by typing a
      URL. Added an "All tags" dropdown to both views, populated from the
      viewer-scoped vocabulary endpoint*
- [x] **T-15** Clear-filters reset all eight params in one atomic URL update
- [x] **T-16** Bulk select shows "Delete Selected (n)" and a "Remove 1 User / cannot be undone" confirmation. *Verified up to the confirmation and CANCELLED - not run to completion, since it destroys real parent accounts*
- [x] **T-17** Couple rows stay adjacent with the household tint and "Couple -" badges, ordering intact through the new columns

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
- [x] **R-14** `?sec=none` collapses all sections and survives a fresh load
- [x] **R-15** Household block on a couple account - 2 members, each with the hidden-contact chip rather than a blank
- [ ] **R-16** IP form "submitted but locked" copy (fixture form not submitted)
- [ ] **R-17** Doctor and clinic profile links (only surrogate exercised;
      doctor uses `/doctors/:slug`, clinic uses `/providers/:id`)
- [x] **R-18** 403 state renders "Forbidden" with the explanatory copy and the "Back to parents" button
- [x] **R-19** Saved-profiles grid with real data (2 saved surrogates). Note: 7 further favourites are ORPHANED - the donor rows no longer exist - and are correctly skipped

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
- [x] **R-26** "Unlock contact" requires a written reason (recorded on the journey timeline), then flips that org to "Shared - unlocked by GoStork". Critically, the OTHER orgs stayed Hidden - per-org isolation holds
- [x] **R-27** "Revoke this unlock" appears ONLY on the ADMIN-reason release, not on Family Creations' invoice-earned one. Revoked afterwards, so the fixture is back as found
- [x] **R-28** "Open in monitor" opens the monitor at the parent's most recent session

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
- [x] **C-9** Assign a lead owner - inline picker (not a popover), correctly
      listing GoStork staff only for an admin
- [x] **C-10** Owner validation - assigning a non-org user returns 400 "That user does not belong to this provider"; a garbage uuid returns 400 "Unknown owner". Also confirmed a provider CANNOT name a scope: a body of `scope: GOSTORK, providerId: null` was silently forced to PROVIDER + own org
- [x] **C-11** "Mark done" on a next step - card returns to "Nothing scheduled"
- [x] **C-12** Note edit works, and `scope`/`providerId` are immutable - an edit attempting to re-scope to GOSTORK left it PROVIDER + own org
- [x] **C-13** Delete is a soft delete - verified at the DB level that the row survives with `deletedAt` stamped
- [x] **C-14** Remove a tag
- [x] **C-15** Tag-id probing returns 404 for BOTH a nonexistent id and a real GoStork-private id (created one to prove it), so the two are indistinguishable. The private tag also never appears in the provider's vocabulary
- [x] **C-16** Two concurrent "set next step" calls both returned 200 but left exactly ONE open row - the partial unique index held

---

## 5. Regressions in surfaces this work changed underneath

The shared components were modified, so their original mount sites need a look.

- [x] **X-1** `ParentProfileCard` still renders single-column in the 288px
      rail (verified in the monitor); the `layout` default of `"rail"` holds
- [x] **X-2** `ContactReleaseSection` in the monitor still shows the default
      "Contact sharing" heading and its own divider
- [x] **X-3** Chat match cards still link correctly - "View Full Profile" resolves to `/surrogate/{providerId}/{profileId}`
- [x] **X-4** `/api/agreements` still registered and auth-guarded (401, not 404)
      after `server/routes.ts` was deleted; no dangling imports of it remain.
      *Endpoint-level only - the agreements page itself is X-4b below*
- [x] **X-4b** Agreements list renders. *Premise corrected: there is no
      `/agreements` list route - only `/agreements/:id`. The real list is
      `/provider/agreements`, which loads 9 agreements and shows parent
      NAMES not emails, confirming the gated handler is the live one*

- [x] **X-5** All five W-9 routes still registered and auth-guarded - the ones
      that looked orphaned when grepping `routes.ts`, because `W9Controller`
      declares them as Nest decorator fragments a literal grep cannot see
- [x] **X-5b** W-9 still served by the live Nest controller -
      `/api/provider/w9` returns real data, and the admin-only template
      correctly 403s for a provider


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

## 7. Test data - CLEARED

All CRM test rows have been deleted; every CRM table is back to 0. The table
below records what was created during testing, in case the same fixtures are
useful next time.

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
