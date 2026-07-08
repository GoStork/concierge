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

Known gap discovered during testing, fixed in Phase 4 (order swapped with
agreements): the readiness prompt used to fire after ANY call for
surrogacy/IVF because nothing ever set Booking.meetingSubtype.

### [ ] Phase 4 - Call buttons + surrogate reservation (order swapped with
        agreements on 2026-07-07 - the readiness trigger gap makes this more
        urgent)

- [x] Match Call (surrogacy) / Doctor Call (IVF) tiles in the provider
      composer + drawer - same calendar-share flow as the Meeting tile
      (which already supports external attendees by email), but the
      consultation card + booking link carry meetingSubtype, and BOTH
      booking paths (in-chat widget + /book/:slug page via ?subtype=)
      persist it. Tiles gated: Match Call = approved Surrogacy service +
      surrogate-subject session; Doctor Call = approved IVF Clinic service
- [x] Readiness trigger gating per type in video.controller: flow type
      resolved from the SESSION subject first (multi-service agencies),
      then provider type. Surrogacy fires ONLY after MATCH_CALL, IVF ONLY
      after DOCTOR_CONSULTATION, donor/bank flows keep firing after the
      first consultation
- [x] Match call ends -> hard 24h hold (reservedByParentId +
      reservationExpiresAt), provider-only note with the release time,
      "On Hold for 24 Hours" badge on surrogate cards (all 4 card surfaces),
      AI exclusion in search_surrogates + find_lookalike_matches (active AND
      permanent holds; expired holds searchable immediately), 10-min sweep
      auto-releases + Eva re-reserve offer with quick replies + in-app
      notification, deposit PAID inside the window clears the expiry so the
      hold sticks. Smoke-tested 5/5 (exclusion x3 states, sweep, Eva msg)
- [x] Match-call UX round 2 (user feedback 2026-07-07):
      - Parent readiness copy is match-call-specific + humanized (names the
        surrogate, explains the 24h hold and the release consequence) -
        keyed off isMatchCall, not providerType, so multi-service agencies
        get the right copy
      - Pre-call prep: when a match call is CONFIRMED, Eva tells the parent
        about the 24h-hold rule upfront and attaches the admin-uploaded
        prep-questions PDF (new ConciergeAsset model + upload/serve
        endpoints + "Parent Prep Guides" card in Settings -> AI Concierge;
        also fixed the long-dead /surrogacy-match-call-guide.pdf links)
      - BOTH-SIDES match gate: provider gets a structured readiness card
        ("does she want to move forward?") instead of the free-text
        assessment; the deposit invoice fires ONLY when parent + agency
        both say yes (tryFinalizeMatch), due 24h from the double-yes, with
        countdown reminders and the hold extended to cover the window.
        Provider "no" releases the hold and Eva tells the parent gently
      - Provider sees "Start Meeting" (host); parent keeps "Join Meeting"
      - Message routing (locked): INFORMATIONAL match-call content (prep
        bundle, post-call hold recap, match announcement + invoice) lives in
        the surrogate's 3-WAY chat; DECISION prompts stay private (parent's
        readiness card in the Eva chat, provider's readiness card
        provider-only) so both sides can answer honestly
- [ ] IVF admin-defined matching requirements (simple AND rules) - not
      started, next item in this phase
- [ ] User acceptance testing (tiles -> subtyped booking -> gated readiness
      -> badge + hold lifecycle -> both-sides gate -> prep bundle)

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
