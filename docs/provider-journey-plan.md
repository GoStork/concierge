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
      - Dual-audience messages: uiCardData.providerContent carries a
        provider-phrased variant of shared system messages (parent reads
        "your invoice is coming", provider reads "the invoice was sent");
        provider chat renders the variant automatically
      - SCHEDULER flow (propose-accept, locked): Match/Doctor Call tiles
        open a schedule-on-behalf panel - host picker shows ONLY people who
        can host (coordinators/doctors/admins; pure schedulers and billing
        managers excluded), defaults to self for coordinators or to the
        parent's engaged coordinator (latest booking host) for schedulers;
        brand calendar (ui/calendar) + the host's live slots; scheduler
        multi-selects up to 6 options (surrogate's offline availability),
        parent gets a proposed_times card and NOTHING books until they tap
        a slot - acceptance re-checks conflicts, creates the meetingSubtype
        booking, and invites everyone (parent account + surrogate email +
        host); "or let the parent pick any time" fallback remains
- [x] IVF matching requirements (audit + full enforcement): clinic-defined
      typed requirements already existed (Settings -> Company) with partial
      AI enforcement; now unified on shared/ivf-requirements.ts evaluator -
      AI clinic search derives the parent's context SERVER-side from their
      profile (age from DOB, partner age, patient type from relationship/
      gender/orientation, embryos-elsewhere from hasEmbryos, biological
      connection from egg/sperm source) with model args as overrides;
      biological-connection rule now enforced; marketplace clinic cards show
      an amber "May not meet requirements" badge with reasons; booking
      widget shows a soft heads-up (never blocks). Unknown parent data
      always passes - conservative by design. DONE (pushed 6e0ee5d):
      shared evaluator in shared/ivf-requirements.ts, server-derived parent
      context, gender-selection field end to end, egg-donor-type display,
      form-sync bugfix in both provider editors
- [x] User acceptance testing (tiles -> subtyped booking -> gated readiness
      -> badge + hold lifecycle -> both-sides gate -> prep bundle)

### Phase 4 addendum - surrogate status lifecycle (BUILT - awaiting UAT;
    verified 2026-07-09 that NO surrogate has organically hit ON_HOLD or
    MATCHED yet - needs one surrogacy run with a surrogate-subject session:
    schedule match call -> ON_HOLD badge/filter -> both-sides yes ->
    MATCHED + hidden from parent marketplace)

- [x] Match call scheduled -> surrogate status ON_HOLD (set at booking
      creation/confirm; reverted to AVAILABLE on cancel/decline while no
      reservation exists); post-call 24h hold also stamps ON_HOLD
- [x] Official match (both-sides yes) -> status MATCHED; deposit paid keeps
      it; expired unpaid hold reverts to AVAILABLE (expiry sweep); provider
      decline reverts to AVAILABLE
- [x] MATCHED surrogates hidden from the parent marketplace entirely (only
      their agency sees them; Matched filter option hidden for parents);
      AI search + look-alike already exclude ON_HOLD/MATCHED via status
- [x] "On Hold" added to the marketplace Status filter + amber card badge;
      nightly scraper sync preserves GoStork-owned statuses while a
      reservation/hold is active

### [ ] Phase 5 - Agreement automation (BUILT - awaiting UAT)

- [x] Agreement auto-fires on invoice PAID via PandaDoc, on all three PAID
      transitions (Stripe webhook, AT_CLEARANCE capture, admin mark-paid).
      Two gates: global auto_agreement_on_paid kill switch (active) +
      per-provider effective mode. Idempotent (one live agreement per
      session, one pending approval card); manual + menu trigger preserved
      and shares the same engine (server/agreement-flow.ts)
- [x] Provider automation setting in Settings > Documents (off / draft for
      my approval / fully automated) - overrides the GoStork-admin
      autoAgreementDraft rollout toggle (all 3 admin switches now live)
- [x] Approval mode posts a provider-only agreement_draft_approval card
      (ApprovalCard reuse) with approve/reject endpoints + inline
      second-signer form; auto_send generates AND sends immediately,
      falling back to the approval card when partner info is missing
- [x] Per-service agreement templates (ProviderAgreementTemplate) - one
      contract per service for multi-service agencies (surrogacy vs egg
      donation), with fallback to the legacy single template; Documents
      tab renders one editor per approved service
- [x] Eva auto-shares the contract when the parent asks ([[AGREEMENT_PREVIEW]]
      tag): existing agreement card, else template file preview (streamed
      via /api/agreements/template-preview/:sessionId), else honest note +
      provider nudge. No template = loud nudge, never fabricated
- [x] Stage 13 journey handoff: fully signed + PAID -> handoffCompletedAt
      stamped (atomic claim), dual-voice celebration message with confetti
- [x] Agreements visibility: dedicated pages replaced the old 3-tab
      billing hubs. Parent: /my/invoices + /my/cost-sheets (agreements
      inline on Home - only 1-2 per parent). Provider: /provider/invoices
      + /provider/payouts + /provider/agreements (agencies hold many
      agreements -> dedicated page with search + status filter). Shared
      AgreementRows renderer; Agreements column in the provider Parents
      table; /my/billing and /provider/billing remain as invoice aliases
- [x] User acceptance testing - CORE PATH VERIFIED 2026-07-09 (two full
      runs in DB: Egg Donation Agreement Jul 8 -> signed Jul 9 + Surrogacy
      Agreement Jul 9, both with handoffCompletedAt stamped = celebration
      fired; two service types = per-service templates proven)
- [ ] UAT still open: fully-automated (auto_send) mode; Eva contract
      preview ([[AGREEMENT_PREVIEW]]); partner-info-missing fallback

### Home dashboards (BUILT - awaiting UAT; admin command center pending)

Locked decisions: dashboard = action queue first, never just relocated
tables; full pages stay routable via View-all links; chat remains the
parent's default landing; provider nav slims to Home / Marketplace / Chats /
Parents / Calendar (Billing + Performance fold into Home); parent nav gets
Home where Billing was.

- [x] Parent Home (/home): action queue (unpaid invoices w/ Pay Now,
      agreements awaiting MY signature, proposed call times to confirm,
      unacknowledged cost sheets), upcoming meetings, billing summary
      tiles + recent invoices, agreements section. VIEWER accounts see no
      billing. Backed by GET /api/my/dashboard-queue + existing endpoints
- [x] Provider Home (/provider/home): work queue (unresolved cost-sheet/
      invoice/agreement approval cards + readiness prompts via GET
      /api/provider/dashboard-queue, live PENDING booking requests,
      unanswered whispers), out-for-signature tracker (n/m signed),
      upcoming meetings, revenue tiles + recent invoices, Performance +
      Payouts quick-link cards, agreements section
- [x] Nav rewire: Home first in both bars; /my/billing, /provider/billing,
      /performance remain routable (reached from Home)
- [x] GoStork admin command center (/admin/home): Needs-attention queue
      (human escalations -> monitor takeover deep link, overdue deposit
      deadlines, failed payouts), 30-day platform funnel (sessions, hot
      leads, calls, on-hold/matched surrogates, deposits, signatures),
      upcoming deposit deadlines, platform-wide out-for-signature list,
      money tiles (collected / fees / pending payouts), automation
      adoption per feature, quick links. Admin nav: Home first, Billing
      folded in (/admin/billing routable); admins land on /admin/home
      after login. Shared QueueRow/SectionHeader/StatTile extracted to
      components/home/home-sections.tsx and reused by all 3 dashboards
- [ ] User acceptance testing (both dashboards, mobile bottom bar, nav)

### [ ] Phase 6 - Banks skip-to-checkout + Legal Services activation

Locked decisions (2026-07-09): bank checkout = AUTO INVOICE VIA EVA (button
on bank donor cards + Eva chat card -> parent confirms -> session with the
bank -> cost sheet posted -> invoice auto-fires with Pay Now; no bank staff
action). Lawyer intro = AUTO-PICK the best-matching approved Legal Services
provider; triggers on legal keywords OR proactively ONCE after the parent's
first consultation call is created with a Surrogacy or Egg Donation agency
(do NOT wait for a match); one yes/no question; yes -> 3-way chat with the
lawyer. Legal pricing = existing AI cost-sheet upload pipeline (no separate
rules engine) - just ensure the Legal service type works end to end.

- [x] Egg/Sperm Bank skip-to-checkout (BUILT 2026-07-09): Buy button on
      bank donor cards (marketplace, parents only, banks with a published
      totalCost only) + Eva [[BANK_CHECKOUT:DONOR_ID]] checkout card ->
      POST /api/bank-checkout (BillingService.bankCheckout): find-or-create
      3-way session (CONSULTATION_BOOKED = identity reveal), dual-audience
      kickoff message, ProviderQuote + cost_sheet card, auto invoice
      (lineItems from donor totalCost, triggerSource BANK_CHECKOUT) + Pay
      Now notifications + bank in-app notification. Idempotent per donor
      session; loud failures (no price / no fee config / agency donor)
- [x] Lawyer intro (BUILT 2026-07-09): one-time proactive offer (atomic
      lawyerIntroOfferedAt claim) posted into the parent's private Eva
      session right after their first consultation session with a
      Surrogacy/Egg Donor agency (hook in createConsultationChatSession);
      keywords path via prompt; Eva emits [[LAWYER_CONNECT]] -> auto-picks
      approved Legal Services provider (parent-state match, else first),
      creates/reuses 3-way chat (dual-audience intro), notifies lawyer
      users; honest note + admin notification when no legal provider exists
- [x] Legal service type end to end (BUILT 2026-07-09): "legal" added to
      cost-sheet AI classifier tags + prompts, LEGAL_SERVICES in billing
      maps (humanize / providerTypeName / subjectType), Legal coverage
      leaf + labels in the provider costs tab
- [ ] User acceptance testing (bank Buy button -> invoice chat; Eva
      checkout card; lawyer offer after first agency call; yes ->
      3-way lawyer chat; legal cost-sheet upload classification)

### [ ] Phase 7 - Polish, journey handoff, analytics

- [ ] Journey stage sidebar/timeline per session
- [ ] handoffCompletedAt flow + post-signature wrap-up
- [ ] Funnel analytics per stage

## Deferred / out of scope

- Cost-sheet versioning lock-at-draft
- Marketplace AI respecting IVF matching requirements (audit later)
- Refunds
