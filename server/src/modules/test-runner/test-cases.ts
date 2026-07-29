import { TestCaseInfo } from "./test-runner.types";

// ─── Shared message block lengths (mirrors scripts/test-ai-concierge.ts) ─────
// P0=3, identity=2, clinic=1 or 2, emb=1 or 3, egg=1, sperm=1, carrier=1, surr=1
// surrogateMatch=4, agencyMatch=2, eggDonorMatch=2, spermDonorMatch=3, clinicMatch=6

export interface TestCaseDef {
  id: string;
  persona: string;
  name: string;
  desc: string;
  interestedServices: string[];
  messageCount: number;
}

export const TEST_CASES: TestCaseDef[] = [
  // ── SOLO MAN (SM-01 to SM-14) ─────────────────────────────────────────────
  {
    id: "SM-01", persona: "solo-man",
    name: "SM-01: No embryos - Own sperm - Needs all services - Intake only",
    desc: "Most common solo man path - validates intake: no carrier Q, no egg source Q, sperm Q asked",
    interestedServices: ["Surrogate", "Egg Donor", "Fertility Clinic"],
    messageCount: 10,
  },
  {
    id: "SM-02", persona: "solo-man",
    name: "SM-02: No embryos - Own sperm - Has egg donor - CLINIC_HAVE - USA - Pro-life - Twins",
    desc: "CLINIC_HAVE: egg donor skipped, D-cycle validates pro-life + twins preferences saved",
    interestedServices: ["Surrogate"],
    messageCount: 14,
  },
  {
    id: "SM-03", persona: "solo-man",
    name: "SM-03: No embryos - Own sperm - Already has surrogate - CLINIC_HAVE - Egg donor match",
    desc: "CLINIC_HAVE: Step 2 egg source SKIPPED for solo man. Sperm then has surrogate",
    interestedServices: ["Egg Donor"],
    messageCount: 9,
  },
  {
    id: "SM-04", persona: "solo-man",
    name: "SM-04: No embryos - Donor sperm - All services - Intake only",
    desc: "Validates donor sperm path + sperm donor help Q asked, no carrier Q",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor", "Fertility Clinic"],
    messageCount: 11,
  },
  {
    id: "SM-05", persona: "solo-man",
    name: "SM-05: No embryos - Donor sperm - Has sperm donor - CLINIC_HAVE - Colombia",
    desc: "CLINIC_HAVE: sperm donor skipped, egg donor then Colombia agency",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 13,
  },
  {
    id: "SM-06", persona: "solo-man",
    name: "SM-06: No embryos - Donor sperm - CLINIC_HAVE - Mexico",
    desc: "CLINIC_HAVE: Mexico agency match (D2 termination skipped for international)",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 13,
  },
  {
    id: "SM-07", persona: "solo-man",
    name: "SM-07: No embryos - Own sperm - CLINIC_HAVE - Mixed USA + Colombia",
    desc: "CLINIC_HAVE: Path C mixed countries intake - validates D1 accepts multi-country",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 14,
  },
  {
    id: "SM-08", persona: "solo-man",
    name: "SM-08: Has embryos (2, tested) - Own sperm - Has egg donor - CLINIC_HAVE - USA",
    desc: "CLINIC_HAVE: existing embryos, D-cycle validates USA singleton preferences",
    interestedServices: ["Surrogate"],
    messageCount: 15,
  },
  {
    id: "SM-09", persona: "solo-man",
    name: "SM-09: Has embryos (1, not tested) - CLINIC_HAVE - Colombia",
    desc: "CLINIC_HAVE: ships embryos to Colombia, D-cycle runs",
    interestedServices: ["Surrogate"],
    messageCount: 14,
  },
  {
    id: "SM-10", persona: "solo-man",
    name: "SM-10: Has embryos - Step 3b use existing - Intake only",
    desc: "Step 3b conflict: validates sperm conflict USE branch",
    interestedServices: ["Surrogate", "Sperm Donor", "Fertility Clinic"],
    messageCount: 11,
  },
  {
    id: "SM-11", persona: "solo-man",
    name: "SM-11: Has embryos - Step 3b create new embryos - Intake only",
    desc: "Step 3b conflict: creates new embryos - validates Step 3b create branch",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor", "Fertility Clinic"],
    messageCount: 13,
  },
  {
    id: "SM-12", persona: "solo-man",
    name: "SM-12: No embryos - Own sperm - CLINIC_HAVE - USA - Cost education check",
    desc: "CLINIC_HAVE: D-cycle checks cost education",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 14,
  },
  {
    id: "SM-13", persona: "solo-man",
    name: "SM-13: LGBTQ+ - No embryos - Own sperm - CLINIC_HAVE - USA - Twins",
    desc: "Gay solo man - CLINIC_HAVE: isLGBTQ=true saved, D-cycle includes twins pref",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 14,
  },
  {
    id: "SM-14", persona: "solo-man",
    name: "SM-14: No embryos - Donor sperm - CLINIC_HAVE - Colombia",
    desc: "CLINIC_HAVE: clinic already set, Colombia agency match runs",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 13,
  },

  // ── SOLO WOMAN (SW-01 to SW-14) ───────────────────────────────────────────
  {
    id: "SW-01", persona: "solo-woman",
    name: "SW-01: No embryos - Own eggs - Self carry - Needs sperm donor - Has clinic",
    desc: "Simplest solo woman path - IUI/IVF with own eggs, self-carry, sperm donor",
    interestedServices: ["Sperm Donor"],
    messageCount: 14,
  },
  {
    id: "SW-02", persona: "solo-woman",
    name: "SW-02: No embryos - Own eggs - Self carry - Already has sperm donor - Needs clinic",
    desc: "Solo woman already has sperm donor - sperm match cycle entirely skipped",
    interestedServices: ["Fertility Clinic"],
    messageCount: 13,
  },
  {
    id: "SW-03", persona: "solo-woman",
    name: "SW-03: No embryos - Donor eggs - Self carry - Needs egg donor + sperm donor - Has clinic",
    desc: "Embryo donation - solo woman with donor eggs and donor sperm, self-carry",
    interestedServices: ["Egg Donor", "Sperm Donor"],
    messageCount: 16,
  },
  {
    id: "SW-04", persona: "solo-woman",
    name: "SW-04: No embryos - Donor eggs - Already has egg donor - Self carry - Needs sperm donor - Needs clinic",
    desc: "Solo woman already has egg donor - egg match cycle skipped",
    interestedServices: ["Sperm Donor"],
    messageCount: 16,
  },
  {
    id: "SW-05", persona: "solo-woman",
    name: "SW-05: No embryos - Own eggs - Surrogate - Needs surrogate + sperm donor + clinic - USA",
    desc: "Solo woman with surrogate - all services needed",
    interestedServices: ["Surrogate", "Sperm Donor", "Fertility Clinic"],
    messageCount: 24,
  },
  {
    id: "SW-06", persona: "solo-woman",
    name: "SW-06: No embryos - Own eggs - Already has surrogate - Needs sperm donor - Needs clinic",
    desc: "Solo woman already has surrogate - surrogate Phase 3 entirely skipped",
    interestedServices: ["Sperm Donor"],
    messageCount: 18,
  },
  {
    id: "SW-07", persona: "solo-woman",
    name: "SW-07: No embryos - Donor eggs - Surrogate - Needs all three - USA - Pro-choice - Twins",
    desc: "Solo woman full embryo donation + surrogate - all services run",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 21,
  },
  {
    id: "SW-08", persona: "solo-woman",
    name: "SW-08: No embryos - Donor eggs - Surrogate - All services - Colombia",
    desc: "Solo woman Colombia path - agency search instead of individual surrogate",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 24,
  },
  {
    id: "SW-09", persona: "solo-woman",
    name: "SW-09: Has embryos (2, tested) - Own eggs - Self carry - Has clinic",
    desc: "Solo woman with existing tested embryos, self-carry - past-tense questions",
    interestedServices: [],
    messageCount: 15,
  },
  {
    id: "SW-10", persona: "solo-woman",
    name: "SW-10: Has embryos - Step 1c fires - Uses existing - Surrogate - USA - Pro-life",
    desc: "Step 1c: registered for egg donation but has embryos - uses existing embryos",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 21,
  },
  {
    id: "SW-11", persona: "solo-woman",
    name: "SW-11: Has embryos - Step 1c create new embryos - Surrogate - USA",
    desc: "Step 1c: creates new embryos with fresh egg donor, needs surrogate",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 19,
  },
  {
    id: "SW-12", persona: "solo-woman",
    name: "SW-12: No embryos - Own eggs - Surrogate - USA - No preference",
    desc: "Solo woman verifying no-preference answers on D2 and D3",
    interestedServices: ["Surrogate", "Sperm Donor"],
    messageCount: 20,
  },
  {
    id: "SW-13", persona: "solo-woman",
    name: "SW-13: No embryos - Donor eggs - Surrogate - Mexico",
    desc: "Solo woman Mexico path - international agency card, D2 termination skipped",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 17,
  },
  {
    id: "SW-14", persona: "solo-woman",
    name: "SW-14: LGBTQ+ - No embryos - Own eggs - Self carry - Sperm donor - Needs clinic",
    desc: "LGBTQ+ solo woman - isLGBTQ saved, otherwise same flow",
    interestedServices: ["Sperm Donor"],
    messageCount: 16,
  },

  // ── TWO DADS (TD-01 to TD-12) ─────────────────────────────────────────────
  {
    id: "TD-01", persona: "two-dads",
    name: "TD-01: No embryos - My own sperm - Needs egg donor + surrogate - Has clinic - USA",
    desc: "Base two-dads path - own sperm, USA surrogate",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 17,
  },
  {
    id: "TD-02", persona: "two-dads",
    name: "TD-02: No embryos - Partner's sperm - Needs all - USA - Pro-choice - Twins",
    desc: "Two dads with partner's sperm - verifies partner's sperm option available",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 23,
  },
  {
    id: "TD-03", persona: "two-dads",
    name: "TD-03: No embryos - Donor sperm - All services - USA - Pro-choice - Singleton",
    desc: "Two dads embryo donation - all donor, all services",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 20,
  },
  {
    id: "TD-04", persona: "two-dads",
    name: "TD-04: No embryos - Donor sperm - Already has sperm donor - Needs egg donor + surrogate - Colombia",
    desc: "Two dads already have sperm donor - sperm match skipped, Colombia international",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 17,
  },
  {
    id: "TD-05", persona: "two-dads",
    name: "TD-05: No embryos - My own sperm - Already has egg donor - USA - Pro-life",
    desc: "Two dads with existing egg donor - egg match skipped, pro-life surrogate",
    interestedServices: ["Surrogate"],
    messageCount: 20,
  },
  {
    id: "TD-06", persona: "two-dads",
    name: "TD-06: No embryos - My own sperm - Needs egg donor - Already has surrogate",
    desc: "Two dads already have surrogate - Phase 3 D-cycle skipped entirely",
    interestedServices: ["Egg Donor"],
    messageCount: 17,
  },
  {
    id: "TD-07", persona: "two-dads",
    name: "TD-07: Has embryos (2, tested) - My own sperm - Needs surrogate - USA",
    desc: "Two dads with existing tested embryos - past-tense sperm question",
    interestedServices: ["Surrogate"],
    messageCount: 21,
  },
  {
    id: "TD-08", persona: "two-dads",
    name: "TD-08: Has embryos (3) - Partner's sperm - Needs surrogate - Colombia",
    desc: "Two dads ship existing embryos with partner's sperm to Colombia",
    interestedServices: ["Surrogate"],
    messageCount: 13,
  },
  {
    id: "TD-09", persona: "two-dads",
    name: "TD-09: Has embryos - Registered sperm donor - Step 3b use existing",
    desc: "Step 3b conflict for two dads - chooses to use existing embryos",
    interestedServices: ["Surrogate", "Sperm Donor"],
    messageCount: 20,
  },
  {
    id: "TD-10", persona: "two-dads",
    name: "TD-10: No embryos - Partner's sperm - Needs egg donor + surrogate - Mexico",
    desc: "Two dads Mexico international path with partner's sperm",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 15,
  },
  {
    id: "TD-11", persona: "two-dads",
    name: "TD-11: No embryos - My own sperm - Mixed USA + Colombia - Twins",
    desc: "Two dads Path C mixed countries with twins preference",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 20,
  },
  {
    id: "TD-12", persona: "two-dads",
    name: "TD-12: No embryos - Donor sperm - All services - USA - No preference",
    desc: "Two dads embryo donation with all no-preference answers",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 23,
  },

  // ── TWO MOMS (TM-01 to TM-13) ─────────────────────────────────────────────
  {
    id: "TM-01", persona: "two-moms",
    name: "TM-01: No embryos - Partner A eggs - Partner A carries - Needs sperm donor - Needs clinic",
    desc: "Simplest two-moms path: same person provides eggs and carries",
    interestedServices: ["Sperm Donor"],
    messageCount: 18,
  },
  {
    id: "TM-02", persona: "two-moms",
    name: "TM-02: No embryos - Partner A eggs - Partner A carries - Already has sperm donor - Needs clinic",
    desc: "Two moms already have sperm donor - sperm match cycle skipped",
    interestedServices: [],
    messageCount: 15,
  },
  {
    id: "TM-03", persona: "two-moms",
    name: "TM-03: No embryos - Partner B eggs - Partner A carries (Reciprocal IVF) - Needs sperm donor + clinic",
    desc: "Reciprocal IVF: Partner A carries, Partner B provides eggs",
    interestedServices: ["Sperm Donor"],
    messageCount: 18,
  },
  {
    id: "TM-04", persona: "two-moms",
    name: "TM-04: No embryos - Donor eggs - Partner A carries - Needs egg donor + sperm donor + clinic",
    desc: "Two moms with third-party egg donor, self-carry - embryo donation path",
    interestedServices: ["Egg Donor", "Sperm Donor"],
    messageCount: 21,
  },
  {
    id: "TM-05", persona: "two-moms",
    name: "TM-05: No embryos - Donor eggs - Already has egg donor - Partner A carries - Needs sperm donor",
    desc: "Two moms already have egg donor - egg match skipped",
    interestedServices: ["Sperm Donor"],
    messageCount: 14,
  },
  {
    id: "TM-06", persona: "two-moms",
    name: "TM-06: No embryos - Partner A eggs - Partner B carries - Needs sperm donor + clinic",
    desc: "Partner B carries with Partner A's eggs - carrier = My partner",
    interestedServices: ["Sperm Donor"],
    messageCount: 18,
  },
  {
    id: "TM-07", persona: "two-moms",
    name: "TM-07: No embryos - Partner B eggs - Partner B carries (both) - Needs sperm donor + clinic",
    desc: "Partner B provides eggs AND carries - full partner path",
    interestedServices: ["Sperm Donor"],
    messageCount: 18,
  },
  {
    id: "TM-08", persona: "two-moms",
    name: "TM-08: No embryos - Partner A eggs - Surrogate carries - Needs surrogate + sperm donor + clinic",
    desc: "Two moms using surrogate with own eggs",
    interestedServices: ["Surrogate", "Sperm Donor"],
    messageCount: 25,
  },
  {
    id: "TM-09", persona: "two-moms",
    name: "TM-09: No embryos - Donor eggs - Surrogate carries - All services - USA - Twins",
    desc: "Two moms all-donor + surrogate with twins preference",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 22,
  },
  {
    id: "TM-10", persona: "two-moms",
    name: "TM-10: No embryos - Partner B eggs - Surrogate carries - Colombia - Needs sperm donor",
    desc: "Two moms reciprocal IVF eggs + surrogate + Colombia",
    interestedServices: ["Surrogate", "Sperm Donor"],
    messageCount: 17,
  },
  {
    id: "TM-11", persona: "two-moms",
    name: "TM-11: Has embryos (2, tested) - Partner A eggs - Partner B carries - Has clinic",
    desc: "Two moms with existing tested embryos, partner carries - Phase 2 validation only (no match cycle)",
    interestedServices: [],
    messageCount: 12,
  },
  {
    id: "TM-12", persona: "two-moms",
    name: "TM-12: Has embryos - Step 1c fires - Uses existing - Surrogate - USA",
    desc: "Step 1c for two moms: registered for egg donation + has embryos - use existing",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 22,
  },
  {
    id: "TM-13", persona: "two-moms",
    name: "TM-13: No embryos - Donor eggs - Surrogate carries - Already has surrogate - Needs sperm donor + clinic",
    desc: "Two moms already have surrogate - Phase 3 D-cycle skipped",
    interestedServices: ["Egg Donor", "Sperm Donor"],
    messageCount: 22,
  },

  // ── MAN & WOMAN (MW-01 to MW-19) ──────────────────────────────────────────
  {
    id: "MW-01", persona: "man-woman",
    name: "MW-01: No embryos - Her eggs - His sperm - She carries - Needs clinic (Woman speaking)",
    desc: "Simplest MW path - own genetics, self-carry, clinic only",
    interestedServices: [],
    messageCount: 15,
  },
  {
    id: "MW-02", persona: "man-woman",
    name: "MW-02: No embryos - Her eggs - His sperm - She carries - Needs clinic (Man speaking)",
    desc: "Same biology as MW-01 but man is speaking - verifies correct option framing",
    interestedServices: [],
    messageCount: 15,
  },
  {
    id: "MW-03", persona: "man-woman",
    name: "MW-03: No embryos - Donor eggs - His sperm - She carries - Needs egg donor + clinic (Woman speaking)",
    desc: "MW couple with donor eggs, self-carry",
    interestedServices: ["Egg Donor"],
    messageCount: 19,
  },
  {
    id: "MW-04", persona: "man-woman",
    name: "MW-04: No embryos - Donor eggs - His sperm - She carries - Already has egg donor - Needs clinic (Man speaking)",
    desc: "Already has egg donor - egg match skipped, man speaking",
    interestedServices: [],
    messageCount: 14,
  },
  {
    id: "MW-05", persona: "man-woman",
    name: "MW-05: No embryos - Her eggs - Donor sperm - She carries - Needs sperm donor + clinic (Woman speaking)",
    desc: "MW couple with donor sperm, her own eggs, self-carry",
    interestedServices: ["Sperm Donor"],
    messageCount: 19,
  },
  {
    id: "MW-06", persona: "man-woman",
    name: "MW-06: No embryos - Her eggs - Donor sperm - She carries - Already has sperm donor - Has clinic (Man speaking)",
    desc: "Already has sperm donor + clinic - no match cycles at all",
    interestedServices: [],
    messageCount: 11,
  },
  {
    id: "MW-07", persona: "man-woman",
    name: "MW-07: No embryos - Donor eggs - Donor sperm - She carries - All services (Woman speaking)",
    desc: "Full embryo donation, self-carry for MW couple",
    interestedServices: ["Egg Donor", "Sperm Donor"],
    messageCount: 22,
  },
  {
    id: "MW-08", persona: "man-woman",
    name: "MW-08: No embryos - Her eggs - His sperm - Surrogate carries - USA - Pro-choice (Woman speaking)",
    desc: "MW couple own genetics with surrogate",
    interestedServices: ["Surrogate"],
    messageCount: 21,
  },
  {
    id: "MW-09", persona: "man-woman",
    name: "MW-09: No embryos - Her eggs - His sperm - Surrogate carries - USA - Twins - Has clinic (Man speaking)",
    desc: "MW couple with surrogate + twins, man speaking",
    interestedServices: ["Surrogate"],
    messageCount: 16,
  },
  {
    id: "MW-10", persona: "man-woman",
    name: "MW-10: No embryos - Donor eggs - His sperm - Surrogate carries - Needs egg + surrogate + clinic - USA (Woman speaking)",
    desc: "MW couple donor eggs with surrogate, no preference answers",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 23,
  },
  {
    id: "MW-11", persona: "man-woman",
    name: "MW-11: No embryos - Her eggs - Donor sperm - Already has surrogate - Needs sperm donor + clinic (Woman speaking)",
    desc: "MW couple already has surrogate - Phase 3 D-cycle skipped",
    interestedServices: ["Sperm Donor"],
    messageCount: 20,
  },
  {
    id: "MW-12", persona: "man-woman",
    name: "MW-12: No embryos - Donor eggs - Donor sperm - Surrogate - All services - USA - Pro-life (Man speaking)",
    desc: "All-donor + surrogate for MW couple, pro-life termination, man speaking",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 26,
  },
  {
    id: "MW-13", persona: "man-woman",
    name: "MW-13: No embryos - Donor eggs - Donor sperm - Surrogate - Colombia (Woman speaking)",
    desc: "MW couple Colombia international path - all donor services",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messageCount: 23,
  },
  {
    id: "MW-14", persona: "man-woman",
    name: "MW-14: Has embryos (2, tested) - Her eggs - His sperm - She carries - Needs clinic (Woman speaking)",
    desc: "MW couple with existing tested embryos, self-carry - past-tense questions, clinic only",
    interestedServices: [],
    messageCount: 17,
  },
  {
    id: "MW-15", persona: "man-woman",
    name: "MW-15: Has embryos (4, tested) - Her eggs - His sperm - Surrogate carries - USA (Man speaking)",
    desc: "MW couple with existing embryos, using surrogate, man speaking",
    interestedServices: ["Surrogate"],
    messageCount: 24,
  },
  {
    id: "MW-16", persona: "man-woman",
    name: "MW-16: Has embryos - Step 1c fires - Use existing embryos - She carries - Needs clinic (Woman speaking)",
    desc: "Step 1c for MW: registered for egg donation + has embryos - uses existing",
    interestedServices: ["Egg Donor"],
    messageCount: 16,
  },
  {
    id: "MW-17", persona: "man-woman",
    name: "MW-17: Has embryos - Step 1c create new embryos - Surrogate - USA (Woman speaking)",
    desc: "Step 1c MW: creates new embryos with fresh donor, uses surrogate",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 22,
  },
  {
    id: "MW-18", persona: "man-woman",
    name: "MW-18: Has embryos - Step 3b fires - Use existing - She carries - Needs clinic (Woman speaking)",
    desc: "Step 3b MW: registered for sperm donation + has embryos - use existing",
    interestedServices: ["Sperm Donor"],
    messageCount: 16,
  },
  {
    id: "MW-19", persona: "man-woman",
    name: "MW-19: No embryos - Donor eggs - His sperm - Surrogate carries - Mexico (Man speaking)",
    desc: "MW couple Mexico international path, man speaking",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 22,
  },

  {
    id: "MW-02C", persona: "man-woman",
    name: "MW-02C: Same as MW-02 but A5 = multi-priority (Success rates, Cost)",
    desc: "Multi-priority A5 answer - exercises the A5 SAVE FALLBACK persistence and priority-aware clinic re-ranking",
    interestedServices: [],
    messageCount: 14,
  },
  {
    id: "TD-13", persona: "two-dads",
    name: "TD-13: Colombia program - SEQUENTIAL agency + partner IVF clinic booking",
    desc: "International CountryProgram must offer BOTH consultation calls one after the other - agency first, then the partner IVF clinic",
    interestedServices: ["Surrogate", "Egg Donor"],
    messageCount: 14,
  },

  // ── FREE-TEXT REQUEST HANDLING (FT-01 to FT-04) ──────────────────────────
  // Runs scripts/test-freetext-requests.ts (off-script behavior the scripted
  // decision-tree cases above cannot reach). See docs/freetext-request-test-plan.md.
  {
    id: "FT-01", persona: "free-text",
    name: "FT-01: Deep-link surrogate pin - schedule a call / service switches / same-service ask",
    desc: "Marketplace pin 4-turn replay: calendar renders, egg/sperm/surrogate free-text asks engaged, streams on-topic, coherent QRs",
    interestedServices: ["Surrogate"],
    messageCount: 4,
  },
  {
    id: "FT-02", persona: "free-text",
    name: "FT-02: Confirm-never-overrule - embryos on file, donor requested",
    desc: "45 PGT-A embryos saved + egg/sperm donor ask -> confirm question with its own QRs, no refusal, no directive leak",
    interestedServices: ["Surrogate"],
    messageCount: 2,
  },
  {
    id: "FT-03", persona: "free-text",
    name: "FT-03: Sperm C2 - donor-type answer saved, never re-asked",
    desc: "'Open' answer patched to spermDonorType via C2 SAVE FALLBACK; question never repeats",
    interestedServices: ["Sperm Donor"],
    messageCount: 4,
  },
  {
    id: "FT-04", persona: "free-text",
    name: "FT-04: Buy vials - purchase intent ends in checkout",
    desc: "'Buy vials now' -> short confirmation + bank_checkout card (or agency guidance), never a re-presented match card",
    interestedServices: ["Sperm Donor"],
    messageCount: 5,
  },
  {
    id: "FT-05", persona: "free-text",
    name: "FT-05: Profile correction acknowledged, never steamrolled",
    desc: "'actually I'm married, not single' -> correction confirmed + saved; the intake state machine stands down",
    interestedServices: ["Surrogate"],
    messageCount: 3,
  },
  {
    id: "FT-06", persona: "free-text",
    name: "FT-06: Never fabricate - financing policy, form receipt, cancellation",
    desc: "No invented GoStork payment plans, no 'I got your form', no 'I've canceled your call' - honest answers grounded in real system state",
    interestedServices: ["Surrogate"],
    messageCount: 6,
  },
  {
    id: "FT-07", persona: "free-text",
    name: "FT-07: Pinned-profile question answered from real data",
    desc: "'has she ever had a c-section?' on a marketplace pin -> real pregnancy-history answer (Tier 2 forced), not the Phase-1 intake question",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },
  {
    id: "FT-08", persona: "free-text",
    name: "FT-08: Mid-flow redirect (clinic first) followed",
    desc: "'forget the surrogate, I just want a clinic first' -> clinic flow engaged, scripted donor question suppressed",
    interestedServices: ["Surrogate", "Fertility Clinic"],
    messageCount: 3,
  },

  {
    id: "FT-09", persona: "free-text",
    name: "FT-09: Crisis/grief suppresses intake and sales framing",
    desc: "Pregnancy loss / surrogate hospitalized -> empathy + human escalation, NEVER an intake question or 'keep making progress' quick replies",
    interestedServices: ["Surrogate"],
    messageCount: 2,
  },
  {
    id: "FT-10", persona: "free-text",
    name: "FT-10: Paperwork on file answered from real data",
    desc: "Real cost sheet / pending invoice / unsigned agreement are quoted exactly - never 'no record' and never 'you owe nothing'",
    interestedServices: ["Surrogate"],
    messageCount: 3,
  },
  {
    id: "FT-11", persona: "free-text",
    name: "FT-11: Tool-backed questions never return an empty reply",
    desc: "Guards the Gemini streaming/thought-signature bug that made every tool lookup in a post-booking session return silence",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },

  {
    id: "FT-12", persona: "free-text",
    name: "FT-12: Agreement resend delivers a document, never a dangling promise",
    desc: "'send me the agreement again' -> real agreement card, template preview, or an honest 'none on file' note - never a promise followed by nothing",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },
  {
    id: "FT-13", persona: "free-text",
    name: "FT-13: Pause/cancel asks never promise an action Eva cannot perform",
    desc: "'I need to pause everything' -> meeting card with real controls + team handoff; never 'I'll cancel that for you' or a 'Yes, please cancel' quick reply",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },
  {
    id: "FT-14", persona: "free-text",
    name: "FT-14: Post-handoff routing and why-question",
    desc: "Scheduling asks route to the provider's own chat; a new lane ('thinking about an egg donor') asks the why-question first",
    interestedServices: ["Surrogate"],
    messageCount: 2,
  },

  {
    id: "FT-15", persona: "free-text",
    name: "FT-15: Knowledge base used when relevant, never leaked cross-provider",
    desc: "Global (tier 2) doc answers in a plain chat; a provider's own tier-1 doc answers only in a chat scoped to that provider and never surfaces in another provider's chat",
    interestedServices: ["Surrogate"],
    messageCount: 3,
  },
  {
    id: "FT-16", persona: "free-text",
    name: "FT-16: Answered whisper reused across the family's threads",
    desc: "A question the provider already answered is reused from any of the account's threads instead of whispering the provider again",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },

  {
    id: "FT-17", persona: "free-text",
    name: "FT-17: Provider answer reused across families, asking family invisible",
    desc: "Family B instantly gets the answer the agency already gave family A about the SAME profile - no new whisper - while the asking family's identity and context never appear",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },

  {
    id: "FT-18", persona: "free-text",
    name: "FT-18: Agency-level answers cross profiles; person facts never do",
    desc: "An agency process answer given on one donor reaches a family viewing a different donor of the same agency, while that first donor's medical facts stay locked to their own profile",
    interestedServices: ["Surrogate"],
    messageCount: 2,
  },

  {
    id: "FT-19", persona: "free-text",
    name: "FT-19: Answers become durable knowledge; relevance beats recency",
    desc: "An agency answer relayed through the real provider API is embedded into the knowledge base and answers a later differently-worded question; a person-specific answer is never ingested; a 90-day-old relevant answer is surfaced past 15 newer ones",
    interestedServices: ["Surrogate"],
    messageCount: 3,
  },

  {
    id: "FT-20", persona: "free-text",
    name: "FT-20: Provider's configured requirements are answerable",
    desc: "Parents/Surrogate Matching Requirements and Accepted Surrogate Medical History set in provider settings are quoted back exactly - age range, c-section cap, accepted conditions, gender selection",
    interestedServices: ["Surrogate"],
    messageCount: 3,
  },
  {
    id: "FT-21", persona: "free-text",
    name: "FT-21: Agency policy attributed to the agency, not GoStork",
    desc: "An agency's own screening policy is never restated as a GoStork-wide rule or in GoStork's voice, while GoStork's ASRM platform minimums ARE stated platform-wide",
    interestedServices: ["Surrogate"],
    messageCount: 2,
  },

  {
    id: "FT-22", persona: "free-text",
    name: "FT-22: Intended Parent Form gates the match call, and only the match call",
    desc: "With the form pending Eva names it, links it, refuses to schedule and never fabricates having contacted the agency; unrelated questions are still answered; once submitted it is never treated as outstanding",
    interestedServices: ["Surrogate"],
    messageCount: 3,
  },

  // ── PROVIDER-SIDE (PR-01..) ───────────────────────────────────────────────
  // Runs scripts/test-provider-flows.ts - the provider experience and the
  // parent/provider chat boundary, which the parent suites cannot reach.
  {
    id: "PR-01", persona: "provider",
    name: "PR-01: Whisper answer relays into the parent's own chat",
    desc: "Provider answers a whisper from a CONSOLIDATED sibling thread -> Eva's relay + the parent notification land in the chat the parent actually asked in",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },
  {
    id: "PR-02", persona: "provider",
    name: "PR-02: Parent identity masked before booking, revealed after",
    desc: "Provider inbox shows 'Prospective Parent' with no email pre-booking; real name + email once the consultation is booked",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-03", persona: "provider",
    name: "PR-03: Provider-only content never reaches the parent transcript",
    desc: "provider_only messages and draft-approval cards are filtered out of the parent's message feed",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-04", persona: "provider",
    name: "PR-04: Cost-sheet draft approval sends a parent-visible cost sheet",
    desc: "The draft card is invisible to the parent until the provider approves it; approval creates the real quote and the parent's chat shows the sent cost sheet",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-05", persona: "provider",
    name: "PR-05: Invoice draft approval issues a real invoice",
    desc: "Approving the invoice draft issues an invoice with a payment token and swaps the draft card for the parent-facing invoice card",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-06", persona: "provider",
    name: "PR-06: A draft cannot be approved from another session",
    desc: "Draft approvals are addressed by (sessionId, messageId) - approving a draft against a sibling session is rejected and creates nothing",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-07", persona: "provider",
    name: "PR-07: Pinned provider assistant answers without leaking parent identity",
    desc: "The PROVIDER_CONCIERGE assistant answers 'what needs my attention' from pipeline state, in its own session, without naming an anonymous parent",
    interestedServices: ["Surrogate"],
    messageCount: 1,
  },
  {
    id: "PR-08", persona: "provider",
    name: "PR-08: Match-call times are gated server-side on the Intended Parent Form",
    desc: "Proposing MATCH_CALL times is refused with IP_FORM_REQUIRED while the form is unsubmitted, other call types are unaffected, and it succeeds once submitted",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },

  {
    id: "PR-09", persona: "provider",
    name: "PR-09: Agreement draft: parent-invisible, rejectable, not re-actionable",
    desc: "The draft card never reaches the parent, cannot be actioned from a sibling session, records its rejection, creates no Agreement, and cannot then be approved (PandaDoc round trip not exercised - JR-02 covers the signed state)",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-10", persona: "provider",
    name: "PR-10: Unread badge counts only what the parent can actually see",
    desc: "A provider-side/internal card (clearance_tracker) does not inflate the parent's unread count, a visible card does, and the badge equals the number of cards actually rendered",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-11", persona: "provider",
    name: "PR-11: Merged provider view never marks the parent's private chat delivered",
    desc: "Opening the merged provider thread stamps deliveredAt only on messages the provider was actually shown - never on the parent's private Eva messages in a whisper-stamped sibling session",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },

  {
    id: "PR-12", persona: "provider",
    name: "PR-12: Auto-reply templates are the provider's own, and only theirs",
    desc: "A provider creates a booking auto-reply through the settings API; a second template for the same staff+service scope is refused while a different service line is allowed, and another provider can neither list nor edit this org's templates",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-13", persona: "provider",
    name: "PR-13: Booking auto-reply lands without faking the provider's presence",
    desc: "Booking through the real public endpoint posts the greeting and its attachment as a PROVIDER message with tokens substituted - and does NOT flip the session to PROVIDER_CONNECTED or stamp providerJoinedAt, so an automated reply never claims the provider showed up",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "PR-14", persona: "provider",
    name: "PR-14: Auto-reply covers the provider's own booking link, once per parent",
    desc: "A booking made through /book/<slug> with no aiSessionId still greets the parent in the thread they already have and links Booking.sessionId for journey scoping; a second booking links but never greets twice",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },

  // ── UNIT GUARDS (UT-01..) ─────────────────────────────────────────────────
  // Runs scripts/test-unit-guards.ts - pure logic, no server, no DB. Covers
  // the RECOVERY paths that only fire when something else already went wrong,
  // and which are therefore invisible to the end-to-end suites.
  {
    id: "UT-01", persona: "unit",
    name: "UT-01: Bare-id [[MATCH_CARD:<uuid>]] form is accepted",
    desc: "The shorthand every other tag uses (and CLAUDE.md documents) is recognised, quoted or padded - it used to throw in JSON.parse and the card was discarded",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-02", persona: "unit",
    name: "UT-02: Well-formed card JSON parses unchanged",
    desc: "The normal path still classifies as json with fields intact",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-03", persona: "unit",
    name: "UT-03: Malformed card JSON is salvaged, not dropped",
    desc: "A trailing comma or an unescaped inner quote still yields type + providerId instead of losing the card",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-04", persona: "unit",
    name: "UT-04: Unusable card ids are refused, not rendered broken",
    desc: "A display number or a name as providerId is rejected (it would render 'Profile unavailable'), while non-uuid slug ids still pass",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-05", persona: "unit",
    name: "UT-05: Tool bodies parse despite trailing prose and control chars",
    desc: "The first JSON array is bracket-matched, so a ']' in the trailing IMPORTANT note and raw control characters inside strings do not break it",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-06", persona: "unit",
    name: "UT-06: A truncated tool result still yields the top id",
    desc: "Pre-search bodies are capped at 8000 chars so the array never closes; the top id survives truncation and is taken directly",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-07", persona: "unit",
    name: "UT-07: Zero results are distinguishable from a parse failure",
    desc: "rows=0 (correctly no card) vs rows=-1 (unparseable) - conflating them sends the next diagnosis the wrong way",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-08", persona: "unit",
    name: "UT-08: The parent's private Eva session resolves, never a joined thread",
    desc: "A session with a NULL matchmakerId is still found (the silently-dropped review_prompt/ip_form_prompt bug) and neither query can ever select a thread the provider has joined",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PR-15", persona: "provider",
    name: "PR-15: The private parent briefing reaches the provider, never the parent",
    desc: "The AI-written summary of the family posted on first booking is readable by the provider, is absent from the parent's own message feed and message list, and does not inflate their unread badge - a parent must never read an assessment of themselves",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },

  {
    id: "UT-09", persona: "unit",
    name: "UT-09: Photo de-dup keeps the larger copy and never drops an unknown",
    desc: "De-duplication keeps the higher-resolution copy of a duplicated photo and leaves anything it cannot confidently match in place - a wrong drop is silent",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-10", persona: "unit",
    name: "UT-10: Auto-reply starter copy stays in sync with its tokens",
    desc: "Both default booking auto-reply templates use every available token and render with nothing left unsubstituted; exactly one promises an attachment, and the default promises no file it cannot deliver",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-11", persona: "unit",
    name: "UT-11: Contact guard blocks contact details and leaves ordinary text alone",
    desc: "Emails, phone numbers, off-platform meeting links and messaging handles are blocked in every obfuscated form, while the money, clinical and record numbers that fill real fertility conversations ($145,000, AMH 1.2, donor #1234, born 03/14/1994) all pass. The false-positive half is the acceptance bar",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "UT-12", persona: "unit",
    name: "UT-12: Every obfuscation of one address and one number still blocks",
    desc: "One canonical email and one canonical phone number, put through spacing, bracketed and spelled separators, fullwidth characters, zero-width injection and case changes - proving the normalizer pipeline composes rather than each rule catching only its favorite spelling",
    interestedServices: [], messageCount: 0,
  },

  // ── CONTACT GUARD (CG-01..) ───────────────────────────────────────────────
  // Runs scripts/test-contact-guard.ts. UT-11/UT-12 prove the detection RULES;
  // these prove the PLUMBING - that each of the six enforcement points really
  // rejects, that nothing is persisted when they do, and that the Eva exception
  // still lets a parent give Eva their own number during intake.
  {
    id: "CG-01", persona: "contact-guard",
    name: "CG-01: Parent to provider - every obfuscated form blocked, ordinary text is not",
    desc: "Phone, spaced email, bracketed at/dot, fullwidth @, Zoom, Calendly, WhatsApp and Telegram are all refused on a shared thread, while \"$145,000 and her AMH was 1.2\" sends normally - and nothing blocked is ever written to the database",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "CG-02", persona: "contact-guard",
    name: "CG-02: The rejection explains itself and echoes nothing back",
    desc: "The 422 carries brand copy naming what it found and saying GoStork is free, with no em dash, and never returns the matched text or the rule internals - echoing them would hand a determined sender an oracle to tune obfuscations against",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "CG-03", persona: "contact-guard",
    name: "CG-03: THE EVA EXCEPTION - private thread accepts, shared thread blocks",
    desc: "The same phone number is accepted in the parent's private Eva thread (where she legitimately collects it during intake) and blocked on a shared one. The private session is deliberately providerId-stamped, as a whisper leaves it, proving the discriminator keys on status and providerJoinedAt rather than providerId",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "CG-04", persona: "contact-guard",
    name: "CG-04: Provider to parent is guarded the same way",
    desc: "A provider cannot send their own direct line, office email or Zoom room to a parent; an ordinary cost message still goes through",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "CG-05", persona: "contact-guard",
    name: "CG-05: A whisper answer cannot smuggle a number through Eva's relay",
    desc: "One guard covers three writes - the persisted answerText, the relay Eva quotes verbatim to the parent, and the provider's confirmation. A blocked answer leaves the whisper PENDING rather than half-answered",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "CG-06", persona: "contact-guard",
    name: "CG-06: A provider auto-reply is rejected when saved, not silently at send",
    desc: "The booking auto-reply deliberately bypasses the send endpoint, so a template carrying a number or a Calendly link would otherwise reach every parent who books. It is refused at configuration time instead",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "CG-07", persona: "contact-guard",
    name: "CG-07: Booking notes and public review replies are guarded too",
    desc: "Parent-typed booking notes are printed verbatim in the provider's email and copied into the external calendar event; the provider's public review reply was never screened while the review body always was",
    interestedServices: [], messageCount: 0,
  },

  // ── PARENT PRIVACY / TWO GATES (PP-01..) ──────────────────────────────────
  // Runs scripts/test-parent-privacy.ts. Gate A is identity, Gate B is contact,
  // and Gate B opens only when the parent commits to that specific provider.
  {
    id: "PP-01", persona: "parent-privacy",
    name: "PP-01: Booked consultation - the name is shown, the email and phone are not",
    desc: "Across the session detail, the provider inbox, the /parents list and the parent profile: real name and city, but email null, mobile null, and no IP-form PDF handle. This is the change GoStork 1.0 needed - a provider who cannot see the address cannot start an off-platform thread",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PP-02", persona: "parent-privacy",
    name: "PP-02: Contact enumeration is closed",
    desc: "/api/calendar/contacts used to return name and email for EVERY parent on the platform to any authenticated user, including other parents. Now a provider sees only their own released contacts and a parent gets 403",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PP-03", persona: "parent-privacy",
    name: "PP-03: A release opens Gate B across every provider surface at once",
    desc: "One release row makes the email and phone appear in the session detail, the /parents list and the calendar autocomplete together, with the triggering reason reported - no surface lags behind",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PP-04", persona: "parent-privacy",
    name: "PP-04: The anonymous whisper stage stays anonymous",
    desc: "Back at ACTIVE with no release the parent is \"Prospective Parent\" again, the email is gone, and the row disappears from /parents entirely rather than rendering as a line of blanks",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PP-05", persona: "parent-privacy",
    name: "PP-05: IP-form fan-out reaches booked providers, never whisper-only ones",
    desc: "The Intended Parent Form is ONE global row per account with no provider column, so who it is shared with is computed - and it used to be computed with no status filter, meaning a clinic that answered a single anonymous whisper received the parents' legal names and could download their home address",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PP-06", persona: "parent-privacy",
    name: "PP-06: The invoice list redacts rather than trusting the invariant",
    desc: "Every row in that endpoint has an Invoice, which by definition released contact, so in practice nothing is redacted - but the invariant is invisible from that file, so the redaction runs anyway. This proves it actually would, including BOTH phone fields",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PP-07", persona: "parent-privacy",
    name: "PP-07: Admin override - unlock, revoke manual, refuse to revoke earned, stay monotonic",
    desc: "A provider cannot unlock themselves; an admin can, and it takes effect with no cache to wait out. A manual unlock is revocable, an earned one returns 409 because the provider already holds a document with the address on it. Repeat releases keep the first reason and never duplicate, which is what PandaDoc webhook replays depend on",
    interestedServices: [], messageCount: 0,
  },

  // ── TRANSACTIONAL JOURNEY (JR-01..) ───────────────────────────────────────
  // Runs scripts/test-journey-flows.ts - what MOVES rather than what Eva says:
  // cost sheet -> acknowledgement -> invoice -> payment -> agreement -> handoff,
  // driven through the same endpoints a real provider and parent hit.
  {
    id: "JR-01", persona: "journey",
    name: "JR-01: Cost sheet -> acknowledge -> legal-identity gate -> invoice -> payment",
    desc: "Each artifact lands in a chat the parent can actually see; invoicing is blocked until Legal Name, Tax ID and a signed W-9 exist; payment alone does NOT complete the handoff",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },
  {
    id: "JR-02", persona: "journey",
    name: "JR-02: Signed agreement + payment completes the handoff, once and only once",
    desc: "A signed agreement alone does not fire the handoff; payment completes it, the parent is told directly with provider-facing copy attached, and a replayed payment does not re-stamp or re-post it",
    interestedServices: ["Surrogate"],
    messageCount: 0,
  },

  // ── PROFILE EXPERIENCE (PX-01..) ──────────────────────────────────────────
  // Runs scripts/test-profile-ux.ts - the twelve July 2026 profile changes.
  // Every one is a RENDERING decision, the class of change no other suite here
  // can see: the concierge suites assert what Eva says and the journey suite
  // asserts what moves, so neither notices a profile quoting a sentence she
  // never wrote or publishing a $300,000 compensation figure. Pure logic and
  // no server - PX-13 is the one exception, re-checking every quote already
  // published against the database.
  {
    id: "PX-01", persona: "profile-ux",
    name: "PX-01: Cost labels read as English, and raw keys are flagged",
    desc: "'agency_fee' / 'gs_miscellaneous' become readable on a $200k quote, while labels that are ALREADY human ('IVF Cycle', 'Embryo Transfer (One Cycle)') are left untouched - the regression that made the naive formatter unusable",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-02", persona: "profile-ux",
    name: "PX-02: Implausible compensation is suppressed, never rewritten",
    desc: "$300,000 for an egg donor is withheld rather than clamped to the band edge; a six-figure surrogate fee is legitimate and publishes; the provider side is told why a figure was hidden",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-03", persona: "profile-ux",
    name: "PX-03: Placeholders never reach a parent as content",
    desc: "'--' / 'N/A' / 'Not specified' are blanks, but 'None', '0' and 'Never' are real answers a parent wants to read - the line this feature must not cross",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-04", persona: "profile-ux",
    name: "PX-04: Freshness claims only what it can prove",
    desc: "'updated 5 days ago' is derived correctly across hour/day/month/year boundaries, and a future timestamp or an unparseable one says nothing rather than guessing",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-05", persona: "profile-ux",
    name: "PX-05: The cost ladder collapses only what is genuinely identical",
    desc: "A row moves to the shared block ONLY when identical in every variant - same key at a different price, or present in only some variants, stays visible against its own variant so collapsing can never hide a real difference",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-06", persona: "profile-ux",
    name: "PX-06: The fit line knows what THIS parent asked for",
    desc: "Marketplace filters and the stored parent profile both become preferences, 'Any' is treated as openness rather than a filter, and a trait she does not have is never reported as a match",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-07", persona: "profile-ux",
    name: "PX-07: Sections are ordered by what actually decides the choice",
    desc: "Surrogate: pregnancy history -> medical -> support system -> her letter. Egg donor: donation history -> medical -> family history -> her letter -> education. Replaced a three-band model that sorted by KIND of content and so buried the medical history a parent is actually choosing on. Unranked sections keep the agency's order, and 'Family Medical History' must not rank as her own medical history",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-08", persona: "profile-ux",
    name: "PX-08: The pull-quote is hers, whole, and not staff copy",
    desc: "A paraphrase or a grammar-fixed rewrite is refused, a sentence chopped at 180 chars is refused, agency comments about her are never collected as her voice",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-09", persona: "profile-ux",
    name: "PX-09: Saving from the action rail keeps her on the grid",
    desc: "Save and Hide stay different actions: saving marks her favorited without passing her, so a parent never loses the profile they just chose to keep",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-10", persona: "profile-ux",
    name: "PX-10: The comparison drops dead rows and keeps real gaps",
    desc: "A row no profile fills is dropped (four dashes reads as broken); a row ONE profile fills is kept because that gap is itself a difference; surrogates compare on deliveries, donors on eggs retrieved",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-11", persona: "profile-ux",
    name: "PX-11: A rate below national is stated, not condemned",
    desc: "CDC rates are not risk-adjusted, so a shortfall is neutral with an explanation rather than alarm red - no tone maps to a destructive colour",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-12", persona: "profile-ux",
    name: "PX-12: The desktop hero never renders blank",
    desc: "An index past the end of a shrunken photo array is clamped, and a video hero whose URL is gone falls back to photos instead of rendering empty",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-13", persona: "profile-ux",
    name: "PX-13: Every quote already published really is hers",
    desc: "Re-checks all ~490 stored quotes against each person's own writing in the database - PX-08 tests the gate with fixtures, this tests the sentences the gate has already let through and parents are reading now",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-14", persona: "profile-ux",
    name: "PX-14: The guards are applied where profiles are actually built",
    desc: "PX-02 and PX-03 would still pass if a mapper stopped calling them, which is the likelier regression - so this drives real rows through mapDatabase*ToSwipeProfile and buildTitle, the bug that rendered every compare column as a bare '#'",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-15", persona: "profile-ux",
    name: "PX-15: The compare shortlist behaves at its edges",
    desc: "A fifth pick is refused without evicting an earlier one, picks toggle off, and removing at the cap still works",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-16", persona: "profile-ux",
    name: "PX-16: The new surfaces are brand-managed, not hardcoded",
    desc: "No Tailwind palette utilities, hex colours or font-family in the new profile components - the standing CLAUDE.md rule, invisible until someone restyles the brand and half a page ignores it",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-17", persona: "profile-ux",
    name: "PX-17: Clinics and doctors compare on what decides those choices",
    desc: "Nobody picks a clinic on eye colour. Outcomes lead (her CDC rate, from the same lookup the clinic card uses - two lookups for one number is how a card and a comparison start disagreeing), then cost, access, scale. A doctor's rate is his CLINIC's, because CDC reports at clinic level and implying a physician-level statistic would invent a number we do not have. Specialties are matched against her own diagnoses, and a generic fallback rate must be reported as generic so the UI can label it",
    interestedServices: [], messageCount: 0,
  },
  {
    id: "PX-18", persona: "profile-ux",
    name: "PX-18: Comparing is entered deliberately, and confirmed on the cards",
    desc: "The first build put a permanent bar of name pills above the Saved grid - it asked a parent to find, by ID, profiles whose photos were already on screen, and on a phone it scrolled sideways and carried its own Compare button off the right edge. Now one visible button turns the page into a selection page, the cards themselves are the control, and picks collect in a tray that only exists once something is in it. The mode dies with the page it belongs to",
    interestedServices: [], messageCount: 0,
  },
];

export function getTestCaseInfo(): TestCaseInfo[] {
  return TEST_CASES.map(tc => ({
    id: tc.id,
    persona: tc.persona,
    name: tc.name,
    desc: tc.desc,
    interestedServices: tc.interestedServices,
    messageCount: tc.messageCount,
  }));
}
