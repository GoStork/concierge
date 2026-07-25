# Free-Text Request Handling - Test Plan

**Scope:** the AI concierge must handle ANY parent request typed as free text - from the marketplace, mid-intake, mid-call-prep, out of nowhere - and never ignore it, steamroll it, overrule it, or answer it with mismatched quick replies. This plan covers the five failure classes found and fixed on Jul 24 2026 and the deterministic mechanisms that now guard them.

**Automated suite:** `scripts/test-freetext-requests.ts` (cases FT-01..FT-08)

```bash
TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-freetext-requests.ts
TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-freetext-requests.ts --id=FT-01,FT-04
```

**Admin UI:** the suite is wired into the AI Concierge Test Runner (`/admin/test-runner`) as the **Free-Text (4)** tab - FT cases run from there like any persona, and "Run All" runs both scripts (decision-tree suite + this one) in parallel.

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
