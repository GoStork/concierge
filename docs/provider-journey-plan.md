# Provider Journey Automation - Master Plan

Automating the provider workflow from first parent contact through signed
agreement, per provider type (Egg Donor Agency, Surrogacy Agency, IVF Clinic,
Sperm Bank, Egg Bank, Legal Services).

Status legend: [x] done and tested - [ ] not started - [~] in progress

## The 13-stage spine

1. Anonymous whisper Q&A (parent masked, provider answers via Eva)
2. Consultation call booked (identity revealed, cost sheet auto-drafts)
3. Provider approves cost sheet draft -> sent to parent (email + SMS)
4. Parent soft-acknowledges cost sheet (call proceeds either way)
5. Consultation call happens
6. Match Call (surrogacy) / Doctor Call (IVF) - provider-initiated
7. Readiness check per type: Yes / Not yet / Need more time (12h reminder)
8. Match Call surrogate = hard 24h reservation window ("On Hold for 24 Hours")
9. Invoice auto-drafts on "Yes, ready" (provider approves, editable line items)
10. AT_CLEARANCE surrogacy: invoice waits for manual "Mark surrogate cleared"
11. Parent pays invoice
12. Agreement auto-generates on invoice PAID (PandaDoc)
13. All parties sign -> journey handoff

## Locked decisions (do not re-litigate)

- Cost sheet drafts PRE-call with provider approval gate; send immediately on
  approve (email + SMS as today); one draft card per matching sheet
- Parent acknowledgement is SOFT - the call proceeds without it, and no
  invoice messaging is shown at this stage
- Call buttons (Match Call / Doctor Call) are provider-initiated in the chat
  composer, reusing the New Appointment widget, with external-attendee
  yes/no email
- Match Call = hard 24h surrogate reservation: visible "On Hold for 24 Hours"
  badge, AI must NOT suggest held surrogates, auto-release + Eva notify at
  expiry with re-reserve offer
- Invoice auto-drafts on "Yes ready" with editable line items + free-text
  comment; AT_CLEARANCE surrogacy waits for manual "Mark surrogate cleared"
- Agreement auto-generates on invoice PAID (manual trigger preserved); AI
  auto-sends via PandaDoc if the parent asks to see the contract and a
  template is configured
- Legal Services is a PROVIDER TYPE (roles: ADMIN, LAWYER, SCHEDULER,
  BILLING_MANAGER, IP_LEGAL_COORDINATOR); lawyer-intro fires on legal
  keywords OR path-commitment; cost sheets rules-based by service type
- Egg/Sperm Banks get skip-to-checkout - both a marketplace button AND an
  Eva chat card
- Approval UI = inline chat card (ApprovalCard) with Approve & Send / Edit /
  Reject - reused for cost sheets, invoices, agreements
- Automation toggles are admin-only, per provider (Provider.autoFeaturesEnabled)
- Multiple matching sheets = one draft card per sheet, stacked iMessage-style

## Phases

### [x] Phase 1 - Foundation (commit 1b340f8)

- [x] Legal Services provider type + LAWYER / IP_LEGAL_COORDINATOR roles,
      canSendProviderMessage() helper, 3 mirror arrays synced
- [x] Schema: ProviderCostSheet category/description/matchingRules/
      lineItemTemplate; Surrogate reservedByParentId/reservationExpiresAt;
      Provider.statesLicensedIn; IntendedParentProfile.detectedLegalNeeds;
      AiChatSession.handoffCompletedAt
- [x] Admin-only automation toggles UI (autoCostSheetDraft /
      autoInvoiceDraft / autoAgreementDraft)

### [x] Phase 2 - Cost sheet auto-draft (commits 3260c4c, 246595b, 1db41e7)

- [x] Auto-draft fires on consultation booking (two-gate: global prompt
      section + per-provider toggle), pre-call
- [x] Subject-context-first sheet matching via canonical subTypes[]
      (surrogacy / egg_donor_fresh / egg_donor_frozen / sperm_donor + 14 IVF
      leaves); parent-profile fallback for clinic/untagged sessions
- [x] Real compensation substitution per type: fresh donor comp, surrogate
      base comp, sperm = vial pricing only, frozen = lot pricing (no comp)
- [x] One draft card per matching sheet; inline Approve & Send / Edit /
      Reject; attach-original-PDF checkbox; NOT INCLUDED section
- [x] Unified manual flow: "+ Send Cost Sheet" supersedes pending drafts and
      regenerates a fresh complete set (legacy form only on genuine no-match)
- [x] Parent soft acknowledge (provider-only factual note, no invoice talk)
- [x] iMessage-style stacked deck for multiple draft cards (peek offsets,
      count chip, click/swipe flip, auto-promote next pending after resolve)
- [x] Program classification top bar (coverage leaves, IVF subtype popover,
      fixed-cost toggle, confirm)
- [x] Regression matrix scripts/test-auto-draft-matrix.ts - 6/6 across all
      provider types, self-cleaning

### [x] Phase 3 - Readiness check + invoice auto-draft (tested 2026-07-07)

Discovery: a readiness -> invoice pipeline already existed pre-phases
(readiness_prompt card after video calls, parent-confirm-ready endpoint,
direct auto-invoice, AT_CLEARANCE pre-auth + confirm-clearance capture/void
with clearance tracker card). Phase 3 added the provider approval gate and
the missing readiness options on top of it.

- [x] Invoice auto-draft with provider approval gate: on "Yes, I'm ready",
      two-gate check (ConciergePromptSection auto_invoice_on_ready +
      autoFeaturesEnabled.autoInvoiceDraft) -> provider-only approval card
      (reuses ApprovalCard) with line items, GoStork fee + payout breakdown;
      Approve & Send creates the real invoice + payment card + email/SMS;
      Edit opens the invoice panel pre-filled (send supersedes the draft);
      Reject dismisses. Gates off -> legacy direct auto-invoice unchanged.
- [x] Subject-aware service resolution (egg-donor session drafts an
      EGG_DONATION line with the egg-donation fee config, not the agency's
      first approved service)
- [x] Blocked states preserved (no cost sheet / no fee config / incomplete
      Legal Identity -> provider nudge, never a fabricated invoice); also
      fixed the dead "Billing Identity" regex that never matched
- [x] Match-call deposits (24h surrogate hold) intentionally skip the
      approval gate - the payment link stays immediate
- [x] Readiness card third option "Need more time" -> 12h re-ask via the
      10-min scheduler (one reminder max per card)
- [x] Readiness "Not yet" -> Eva asks what the blocker is in the parent
      chat + provider-only heads-up note in the provider session
- [x] AT_CLEARANCE surrogacy: covered by the existing authorize-then-capture
      clearance flow (confirm-clearance endpoint + clearance tracker card);
      no draft hold needed
- [x] Provider-facing billing visibility (added mid-phase on request):
      /provider/billing hub with a "Billing" nav item - Invoices tab (all
      invoices sent to parents with amount / GoStork fee / payout split) +
      Payouts tab (bank transfer history), search + status + service-type
      filters, rows open the invoice document. Fee setup and bank accounts
      stay in Settings. Provider chat sidebar also gets the same read-only
      Cost Sheets + Invoices history sections parents have (no Pay link).
- [x] Parent-facing billing visibility (added mid-phase on request):
      "Invoices" section in the parent chat sidebar (per session, next to
      Cost Sheets, with Pay-now links), plus a centralized parent Billing
      page at /my/billing (Invoices + Cost Sheets tabs across all providers,
      search, status filters, receipt/file downloads, open-conversation
      links) with a "Billing" nav item (desktop top nav + mobile bottom bar)
- [x] User acceptance testing passed 2026-07-07 (yes-ready draft flow,
      approve -> paid invoice, parent + provider billing hubs, readiness
      options; the 12h re-ask sweep is code-verified via the scheduler)

Known gap discovered during testing, moved to Phase 5 (order swapped with
agreements): the readiness prompt fires after ANY call for surrogacy/IVF
because nothing ever sets Booking.meetingSubtype - the MATCH_CALL /
DOCTOR_CONSULTATION branches in video.controller are dead code until the
call buttons exist.

### [ ] Phase 4 - Call buttons + surrogate reservation (order swapped with
        agreements on 2026-07-07 - the readiness trigger gap makes this more
        urgent)

- [ ] Match Call (surrogacy) / Doctor Call (IVF) buttons in provider
      composer, reusing New Appointment widget; external attendee yes/no
      email; coordinator answers inside the widget. Bookings created with
      meetingSubtype MATCH_CALL / DOCTOR_CONSULTATION
- [ ] Readiness trigger gating per type: surrogacy fires ONLY after a
      MATCH_CALL, IVF ONLY after a DOCTOR_CONSULTATION; egg/sperm/banks
      keep firing after the first consultation
- [ ] Match call ends -> surrogate goes on hard 24h hold: "On Hold for 24
      Hours" badge everywhere, AI excludes held surrogates from suggestions,
      auto-release + Eva notify + re-reserve offer at expiry; deposit paid
      inside the window makes the reservation stick
- [ ] IVF admin-defined matching requirements (simple AND rules)

### [ ] Phase 5 - Agreement automation

- [ ] Agreement auto-generates on invoice PAID via PandaDoc (manual trigger
      preserved; idempotency guard)
- [ ] AI auto-sends contract preview when parent asks to see the contract
      and provider has pandaDocTemplateId configured

### [ ] Phase 6 - Banks skip-to-checkout + Legal Services activation

- [ ] Egg/Sperm Bank skip-to-checkout: marketplace button + Eva chat card
- [ ] Lawyer-intro trigger (legal keywords OR path-commitment), one yes/no
      connect question, creates 3-way chat with lawyer
- [ ] Legal cost sheets rules-based by service type

### [ ] Phase 7 - Polish, journey handoff, analytics

- [ ] Journey stage sidebar/timeline per session
- [ ] handoffCompletedAt flow + post-signature wrap-up
- [ ] Funnel analytics per stage

## Deferred / out of scope

- Cost-sheet versioning lock-at-draft
- Marketplace AI respecting IVF matching requirements (audit later)
- Refunds
