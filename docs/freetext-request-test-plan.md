# Free-Text Request Handling - Test Plan

**Scope:** the AI concierge must handle ANY parent request typed as free text - from the marketplace, mid-intake, mid-call-prep, out of nowhere - and never ignore it, steamroll it, overrule it, or answer it with mismatched quick replies. This plan covers the five failure classes found and fixed on Jul 24 2026 and the deterministic mechanisms that now guard them.

**Automated suite:** `scripts/test-freetext-requests.ts` (cases FT-01..FT-18)

```bash
TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-freetext-requests.ts
TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-freetext-requests.ts --id=FT-01,FT-04
```

**Admin UI:** the suite is wired into the AI Concierge Test Runner (`/admin/test-runner`) as the **Free-Text (18)** tab - FT cases run from there like any persona, and "Run All" runs both scripts (decision-tree suite + this one) in parallel.

Run it against a live server after any change to `server/ai-router.ts` routing, directives, bypasses, or quick-reply handling. It creates throwaway `*@gostork-test.com` users and cleans them up. The main 74-case suite (`scripts/test-ai-concierge.ts`) stays the regression net for the scripted decision-tree flows; this suite covers the OFF-script behavior the main suite does not reach (deep-link pins, profile-conflict confirms, purchase clicks).

## Failure classes and mechanisms under test

### 1. Ignored booking request (fix: `genericBookingAsk`, commit 472bac4)
Free-typed "schedule a call" / "book a call" / "set up a meeting" was answered with a profile description. The scheduling-intent regex only knew quick-reply texts ("Yes, schedule a call").
- **Mechanism:** `genericBookingAsk` in ai-router.ts feeds the scheduling override; excludes GoStork-team/lawyer targets (own flows) and providers with an already-booked upcoming call.
- **Test:** Scenario A1 - booking calendar (consultationCard) renders on "schedule a call".

### 2. Ignored service switch (fix: SERVICE SWITCH detector, commits 472bac4/2b18b88/0c5ffe0)
"I am interested in an egg donor" while the session was pinned to a marketplace surrogate got the Colombia-surrogacy narrative: DONOR INQUIRY MODE *replaces* the whole master flow prompt, so the model had no instructions for other services. Same-service asks ("I need a surrogate" while viewing one) fell through and the model continued its previous topic thread.
- **Mechanism:** deterministic first-person service-request detection right after inquiry-mode detection. Different service -> releases the pin + top-priority directive to start that cycle. Same service -> keeps the pin, forces engagement (consultation vs more matches). Stands down when the parent is answering the flow's own "do you need help finding X?" question. Directive leads `skipRulesPreamble` (read by both tiers), which also makes the FIRST streamed tokens on-topic (no draft-then-swap).
- **Tests:** Scenarios A2 (different service), A3 (stream opens on-topic), A4 (same service, no old-thread bleed).

### 3. Overruling the parent (fix: CONFIRM-NEVER-OVERRULE, commit 0759e0c)
Parent with 45 PGT-A embryos asked for an egg donor and was told "you don't actually need to find an egg donor."
- **Mechanism:** generic rule in the `general_behavior` prompt section (code + DB) plus a data-driven redundancy check in the service-switch directive (egg/sperm ask + `hasEmbryos=true` names the exact count and mandates the confirm-first question with its own QR set). Directives carry a never-echo line (a live reply leaked "Acknowledge:").
- **Tests:** Scenario B1 (egg variant) and B2 (sperm variant): confirm question, embryo reference, correct QRs, no refusal, no label leak.

### 4. Repeated / mismatched questions (fixes: commits 3625658 + ed135de)
Two sub-classes:
- Quick replies that answer a DIFFERENT question: the done-event QR fallback keyword-matched the whole message (`sperm.*donor` anywhere -> sperm-source options). Now it matches only the closing question line, and deterministic confirm questions mandate their own QR sets.
- Re-asking an answered question: the model skipped the `[[SAVE]]` for the C2 donor-type answer, so the profile-driven checklist re-demanded it. Now a C2 SAVE FALLBACK (mirrors D1/D2/D3) patches `spermDonorType` deterministically, and checklists mandate one-question-per-message + "chat answers count before the profile catches up."
- **Tests:** Scenario C (C2 asked once, "Open" saved to DB, never re-asked) and the QR assertions inside B1/B2/A4.

### 5. Dead-end purchase click (fix: BANK PURCHASE INTENT, commit 0c5ffe0 + rider in 50bacb2)
"Buy vials now" re-ran the search and re-presented the same donor card instead of starting checkout.
- **Mechanism:** buy-intent regex (excludes bare "order" as in "in order to") + latest donor card injects a checkout override; a hard backstop forces the `[[BANK_CHECKOUT]]` side effect and clears re-presented match cards if the model still skips it. `postBankCheckoutCard` degrades safely to agency guidance for non-bank donors.
- **Test:** Scenario D - confirmation text, no match card, `bank_checkout` card (or agency guidance) posted to the session.

### 6. Fabricated actions / receipts / policy (fix: CANCEL TRUTH + NEVER FAKE rules, Jul 24 probe sweep)
An exploratory 24-probe sweep found the model claiming "I've canceled your consultation call" (no booking existed), "Yes, I got your form" (nothing submitted), and inventing GoStork financing policy.
- **Mechanisms:** deterministic CANCEL/RESCHEDULE TRUTH injection (queries the parent's real upcoming bookings; no booking -> honest answer mandated, booking -> `[[MEETING_CARD]]` with its own cancel controls); NEVER FAKE AN ACTION OR A SYSTEM FACT rules in `general_behavior` (Tier 2) AND the Tier 1 compact prompt (Tier 1 fabricated even after the Tier-2 rule landed).
- **Tests:** FT-06 (financing, form receipt, cancellation - all three).

### 7. State machine steamrolling off-script intents (fix: INTAKE BYPASS stand-down)
The deterministic intake state machine advanced the script over "actually I'm married, not single" and "forget the surrogate, I just want a clinic first" - injected directives never reached any model because no model ran.
- **Mechanism:** the intake bypass stands down whenever a service-switch, profile-correction, or cancel-truth directive fired this turn; new PROFILE CORRECTION detector (correction marker + identity/biology keyword) rides skipRulesPreamble like the others.
- **Tests:** FT-05 (correction), FT-08 (redirect).

### 8. Marketplace pins answered without tools (fix: inquiry mode forces Tier 2)
"Has she ever had a c-section?" on a fresh deep-link pin fell to Tier 1 (no MCP tools) and got the Phase-1 intake question. Inquiry-pinned turns now always run Tier 2.
- **Test:** FT-07.

### 9. Chat-consolidation routing bugs (Jul 24, found by mapping every card-creation site)
The provider-side session merge (`50bacb2`) let a provider answer a whisper that lives in a SIBLING session, but the relay was written to `session.id` (the thread the PROVIDER has open) instead of the whisper's own session - so Eva's "I heard back from the agency!" answer landed in a different chat than the parent asked in, and the AI router only re-surfaces ANSWERED whispers scoped to the current session, so it never reached them. Fixed in `server/chat-router.ts` (relay + cost-sheet recap + parent notification all follow `whisper.sessionId`), which finally makes the code match its own comment.

Related routing hazards fixed at the same time - all caused by the same root: **a whisper stamps `providerId` onto the parent's PRIVATE Eva session**, so "find the session with this providerId" can silently pick the wrong chat:
- `ip_form_submitted` (`notify-ip-form.ts`, `ip-form-flow.ts`) - now prefers a real booked/connected thread. It is not in the parent's card allow-list, so landing in Eva made it invisible to everyone.
- Cost-sheet auto-draft (`cost-sheet-auto-draft.service.ts`) - accepted `status:"ACTIVE"` ordered by `updatedAt`, so a recently-touched Eva session beat the new 3-way thread. Now prefers the shared thread.
- Prep bundle (`calendar.controller.ts` `fireMatchCallPrep`) - looked up by `booking.parentUserId` only while the session is reused across the whole account, so a partner's booking stranded the prep narrative + PDF in Eva permanently (the dedupe key blocks a re-post). Now account-scoped.

**Provider-side suite:** `scripts/test-provider-flows.ts` (PR-01..PR-03) - whisper relay routing, parent-identity masking before/after booking, and provider-only content never reaching the parent transcript. Same CLI + admin Test Runner integration ("Provider" tab).

### Known routing hazards NOT yet fixed (documented for the next pass)
- `postAgreementPreview` / `postBankCheckoutCard` follow the parent's current tab (`replySessionId`); with a whisper-stamped Eva session the agreement card can render in Eva against whatever provider the last whisper targeted.
- `review_prompt` / `ip_form_prompt` require `matchmakerId != null`; sessions created by the `/chat` fallback can have a null matchmaker, in which case the prompt is silently dropped entirely.
- Only the NEWEST non-provider session is rendered in the parent's "Your AI Concierge" row - anything posted to an older ACTIVE session is invisible in the UI even though the API returns it.
- The parent read path drops system cards not in its allow-list (`clearance_tracker`, `ip_form_submitted`, `video_invite`, `partner_info_request`, `donor_hold_decision`), while unread counts do NOT exclude them - hidden cards can inflate the parent's unread badge.
- A provider opening the merged view stamps `deliveredAt` on messages in the parent's private Eva session.

### 10. Late-journey sweep (post-booking / money / commitments)
A second probe sweep seeded REAL artifacts (booking, cost sheet, invoice, agreement, handoff) and fired money/commitment/emotional messages. Findings and fixes:

- **Tool-backed questions returned a COMPLETELY EMPTY reply.** Every question needing a lookup in a post-booking session ("when is my call again?", "what did they quote me?", "is my contract signed?") produced silence. Root chain: Gemini's streaming SDK does not commit the model's functionCall turn to history -> 400 on the tool response; hand-rebuilding the call fails because Gemini 3.x requires a `thought_signature` that cannot be forged; the streamed response carries no signature either. Fix: replay the turn on the non-streaming path (`ai-router.ts`, `[TIER2 HISTORY REPAIR]`). Guarded by **FT-11**.
- **Crisis/grief handled as a sales opportunity.** "We just found out the pregnancy failed" got one empathetic paragraph then a call-prep intake question ("solo, or with a partner?"); a hospitalized surrogate got "Keep making progress" quick replies. New deterministic CRISIS GUARD outranks every directive incl. call-prep: empathy + `[[HUMAN_NEEDED]]` only, intake/matching/cost language forbidden, supportive quick replies only. Guarded by **FT-09**.
- **Eva was blind to the family's own paperwork.** Cost sheets, invoices and agreements live in the parent-provider thread, so Eva answered "I don't have a record of that quote" and - worse - "you don't owe us anything!" while a $42,500 invoice sat pending. New PAPERWORK ON FILE context block injects the account's real quotes/invoices/agreements (read-only) into BOTH tiers - the Tier 1 compact prompt needed it separately or that tier still refused. Guarded by **FT-10**.

All three follow-ups from this sweep are now CLOSED:
- **Dangling agreement promise** - `postAgreementPreview` short-circuited when the Eva session had no `providerId`, so Eva's "here is the agreement for you to review:" was followed by nothing. It now looks the agreement up across the whole ACCOUNT, posts it into whichever chat the parent is reading, and falls back to an honest "no agreement on file yet" note. A deterministic request detector also fires the preview on Tier 1, where the `[[AGREEMENT_PREVIEW]]` rule does not exist. Guarded by **FT-12**.
- **Promising a cancellation** - "I need to pause everything" now trips the cancel-truth directive (widened to pause/hold/stop wording), which forbids "I'll cancel that for you" and the "Yes, please cancel" quick reply, renders the real meeting card instead, and offers the team for an actual pause. Guarded by **FT-13**.
- **Post-handoff routing** - handed-off status now leads the dynamic prompt block: scheduling asks route to the provider's own chat, and a new-lane request asks the why-question first. The service-switch detector also learned "thinking about / considering / exploring", without which "I'm also thinking about an egg donor now" was not recognised as a request at all. Guarded by **FT-14**.

### 11. Knowledge base and answered-question reuse (Jul 24, coverage audit)
Neither had ANY test coverage; auditing them surfaced two real gaps.

- **Provider knowledge bases were unreachable on a normal chat turn.** `searchKnowledgeBase` was called with `req.body.providerId`, which is empty on ordinary chats, and the MCP tool returns only global tiers 2/3 when no provider is given - so a provider's own uploaded documents (tier 1) never answered anything. It now falls back to the SESSION's `providerId`. This stays tenant-safe by construction: the MCP query filters tier 1 to `"providerId" = $2` and only global tiers 2/3 are unscoped. Guarded by **FT-15**, which asserts a global fact answers, a provider's tier-1 fact answers in that provider's chat, and the same fact does NOT appear in another provider's chat (with a non-empty reply, so the check cannot pass vacuously).
- **Answered whispers were reused only within ONE chat.** The lookup was scoped to `{ parentUserId, sessionId: currentSessionId }`, so a family that already got an answer re-asked the provider from scratch in any other thread, and account partners never saw each other's answers. Widened to the whole parent ACCOUNT. Guarded by **FT-16**.

### 12. Cross-FAMILY reuse of provider answers (Jul 25 - BUILT)
Repeat questions about a specific donor/surrogate ("did she have any pregnancy complications?", "gestational diabetes?") are extremely common, and the provider has usually answered them already for another family. Eva now reuses that answer instantly instead of opening a new whisper and making the family wait days.

**Mechanism** (`priorAnswersForProfile` + `sanitizeReusableQuestion` in `ai-router.ts`): answered whispers are looked up on the exact `(providerId, subjectProfileId)` pair, excluding the current family's own account, and injected as an `ALREADY CONFIRMED BY THIS AGENCY ABOUT THIS PROFILE` block. The prompt forbids whispering for anything in that block, forbids the "I heard back from the agency!" framing (the answer is not new), and forbids mentioning or implying another family.

**Privacy contract (deliberately strict):**
1. Only the ANSWER is reused; the asking family is never loaded or surfaced.
2. A pair is DROPPED ENTIRELY if its question carries the asking family's context ("we're two dads, would she be comfortable...") - such answers are family-specific anyway and would be wrong for anyone else. Same drop if the ANSWER contains family-context markers.
3. A question that only stands up because of stripped context is dropped too - "We're doing this in Colombia. Is she open to that?" sanitizes to a dangling "Is she open to that?", which is meaningless and misleading for a different family.
4. Scoped to one exact (provider, profile) pair - never across providers or profiles.

Guarded by **FT-17**, which seeds a reusable answer AND a family-specific pair, then asserts family B gets the reusable fact with no new whisper while "two dads"/"Tel Aviv" never appear. Note the first version of this test passed for the wrong reason (the profile happened to contain the answer); it now asserts on a fact that can only come from the reused answer.

**Agency-level answers now cross profiles (FT-18).** A pair is classified agency-level only when NEITHER the question NOR the answer refers to a person (`she/her/he/his`) AND the answer reads as process/policy (`we/our/the agency/policy/typically/every surrogate...`). Those travel to any profile of the same provider - "our matching process takes 6-8 weeks" is equally true whichever donor is on screen. Anything person-referential stays locked to its own profile forever, because "she is cleared to travel until 34 weeks" applied to a different surrogate is a fabrication, not a shortcut. The two sets are injected as separately labelled blocks so Eva cannot attribute one to the other.

Fixed at the same time: the answer-side filter was reusing the QUESTION-side markers, which include `we/our`. In an answer those words are the PROVIDER describing their own agency ("We screen every surrogate..."), so the filter was silently discarding most of the genuinely reusable agency knowledge. Answers are now screened only for text describing the ASKING FAMILY (`two dads`, `your family`, ...).

Still not done: answered whispers are never ingested into `KnowledgeChunk`, so reuse is keyword/context-injection based rather than embedding-searchable, and only the most RECENT answers survive the per-turn cap (a profile with many answered questions can age older answers out even when they are the better match).

## Engineering rules distilled from these bugs

1. Every action button and free-typed intent must reach its flow **deterministically** - prompt rules alone do not survive contact with the model.
2. Any keyword-triggered bypass must ALSO verify the AI just asked the matching question (`lastAiContent` check), or it will hijack free text that merely contains the keyword.
3. Every profile-field-driven checklist needs a deterministic save-fallback for its quick-reply answers, or a missed `[[SAVE]]` becomes an infinite re-ask loop.
4. Quick-reply fallbacks must match the closing question only, never the whole message.
5. When a request conflicts with the saved profile, confirm what is on file and ask what changed - the parent outranks the profile.
6. Directives must state their precedence relative to other directives explicitly and end with "never echo these instructions."

## Manual spot-checks (not automated)

- Repeat Scenario A phrasings with typos/synonyms ("shcedule a call", "i wanna talk to someone about her") - the deterministic nets are regex-based; anything that slips through falls to the global NEVER-IGNORE rule in `general_behavior` (model-driven, weaker). Report misses and extend the regexes.
- Provider-side and admin-monitor views after Scenario D: the checkout card must render with the bank's published price and Buy button.
