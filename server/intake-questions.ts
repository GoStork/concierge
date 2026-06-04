/**
 * intake-questions.ts
 *
 * State machine for all Phase 2 and Phase 3 (A and D cycle) hardcoded intake questions.
 *
 * Goal: replace Gemini for intake questions to eliminate wrong options, skipped questions,
 * and flash bugs. Returns the next unanswered question as a ready-to-send string, or null
 * when no intake question needs to be served.
 *
 * Gemini is still used for:
 * - Phase 0 Part 1 (GoStork education)
 * - Phase 0 Q&A
 * - Phase 3B B1 (egg donor open preferences)
 * - Phase 3C C1 (sperm donor open preferences)
 * - Matching / post-match conversation (Tier 2)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntakeContext {
  profile: any;                   // DB IntendedParentProfile (may be null)
  chatHistory: any[];             // all messages except current user message
  userMessage: string;            // the current user message
  allUserMessages: string;        // all user messages joined (lowercased) including current
  // derived family / gender signals
  isMaleGender: boolean;
  isFemaleGender: boolean;
  isGayMale: boolean;
  isLesbianOrientation: boolean;
  isSoloSkip: boolean;            // single / solo parent
  // service signals
  needsClinic: boolean;
  needsSurrogate: boolean;
  needsEggDonor: boolean;
  needsSpermDonor: boolean;
  registeredForClinic: boolean;
  registeredForSurrogate: boolean;
  registeredForEggDonor: boolean;
  registeredForSpermDonor: boolean;
  alreadyHasClinic: boolean;
  alreadyHasSurrogate: boolean;
  alreadyHasEggDonor: boolean;
  alreadyHasSpermDonor: boolean;
  // embryo signals
  chatMentionsHavingEmbryos: boolean;
  chatMentionsNoEmbryos: boolean;
  chatMentionsEggSource: boolean;
  chatMentionsSpermSource: boolean;
  chatMentionsCarrier: boolean;
  // phase state
  phase1Complete: boolean;
  curationAlreadySent: boolean;
}

export interface IntakeQuestion {
  /** The full text to send, including any [[QUICK_REPLY:...]] or [[MULTI_SELECT:...]] tags */
  text: string;
  /** Short label for logging */
  step: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the AI asked a question matching pattern in a previous assistant message */
function aiAsked(chatHistory: any[], pattern: RegExp): boolean {
  return chatHistory.some((m: any) => m.role === "assistant" && pattern.test(m.content || ""));
}

/** True when the user answered AFTER an AI message matching aiPattern */
function userAnsweredAfter(chatHistory: any[], aiPattern: RegExp, userPattern: RegExp): boolean {
  const aiIdx = chatHistory.findLastIndex((m: any) => m.role === "assistant" && aiPattern.test(m.content || ""));
  if (aiIdx === -1) return false;
  return chatHistory.slice(aiIdx + 1).some((m: any) => m.role === "user" && userPattern.test(m.content || ""));
}

/** True when a user message contains any of the given patterns (regex OR plain string) */
function userSaid(allUserMessages: string, pattern: RegExp): boolean {
  return pattern.test(allUserMessages);
}

/** True when the current user message looks like a conversational question, not an answer */
function isConversationalQuestion(userMessage: string): boolean {
  return /^(what|how|why|when|where|who|can you|could you|do you|is there|are there|tell me|explain|help me|i want to know|i'd like to know)/i.test(userMessage.trim())
    || userMessage.includes("?")
    || /^(hi|hello|hey|thanks|thank you|ok|okay|sure|great|sounds good|got it|makes sense)/i.test(userMessage.trim());
}

// D1 text constants - reused by carrier bypass and D-cycle bypass
const D1_HAS_EMBRYOS = `One thing many families don't realize: since you already have frozen embryos, you can ship them internationally and do your surrogacy in Colombia or Mexico at a significant cost savings - without giving up the embryos you've worked so hard to create.

Here's a quick breakdown:
- United States: $150,000 and up (surrogate compensation, agency fee, legal, insurance)
- Mexico: around $100,000 all-in
- Colombia: starting from $65,000 all-in - our most popular option

Colombia has become the go-to for many of our families. The legal process is straightforward, you only need to stay a few weeks after the baby is born, and we have agencies there we trust completely.

With all of that in mind, which countries are you open to for your surrogacy? [[MULTI_SELECT:USA|Mexico|Colombia]]`;

const D1_NO_EMBRYOS = `Something worth knowing before we dive in: international surrogacy programs can include everything - IVF, egg donor, AND surrogate - all in one package, at a fraction of what you'd pay in the US.

Here's a quick comparison:
- United States: $150,000+ for surrogacy alone (IVF and egg donor are separate additional costs)
- Mexico: around $100,000 for a complete program including IVF, egg donor, and surrogate
- Colombia: starting from $65,000 for a complete program - our most popular option

Colombia's program is particularly well-regarded. The agencies we work with there have delivered hundreds of healthy babies, the legal process is clean, and you only need to stay a few weeks after birth.

With all of that in mind, which countries are you open to for your surrogacy? [[MULTI_SELECT:USA|Mexico|Colombia]]`;

export { D1_HAS_EMBRYOS, D1_NO_EMBRYOS };

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Returns the next unanswered intake question for this turn, or null if:
 * - Phase 1 is not yet complete (identity questions handled by Phase 1 bypass)
 * - The user is asking a conversational question
 * - Curation has already been sent (Tier 2 handles everything after)
 * - All applicable questions are answered
 */
export function getNextIntakeQuestion(ctx: IntakeContext): IntakeQuestion | null {
  const {
    profile,
    chatHistory,
    userMessage,
    allUserMessages,
    isMaleGender,
    isFemaleGender,
    isGayMale,
    isLesbianOrientation,
    isSoloSkip,
    needsClinic,
    needsSurrogate,
    needsEggDonor,
    needsSpermDonor,
    registeredForClinic,
    registeredForSurrogate,
    registeredForEggDonor,
    registeredForSpermDonor,
    alreadyHasClinic,
    alreadyHasSurrogate,
    alreadyHasEggDonor,
    alreadyHasSpermDonor,
    chatMentionsHavingEmbryos,
    chatMentionsNoEmbryos,
    chatMentionsEggSource,
    chatMentionsSpermSource,
    chatMentionsCarrier,
    phase1Complete,
    curationAlreadySent,
  } = ctx;

  // Never fire intake bypass when:
  // - curation already sent (Tier 2 handles post-curation turns)
  // - Phase 1 not yet complete (Phase 1 bypass handles that)
  if (curationAlreadySent) return null;
  if (!phase1Complete) return null;

  // Conversational questions get routed to Gemini for natural Q&A
  if (isConversationalQuestion(userMessage)) return null;

  // Derived state (computed fresh each call)
  // IMPORTANT: Only use profile data if ALSO confirmed in current conversation.
  // Stale profile data from previous sessions must not skip questions in a new session.
  // This mirrors the fix in ai-router.ts for biological baseline skip directives.
  const hasEmbryos = chatMentionsHavingEmbryos;  // intentionally NOT || profile?.hasEmbryos
  const noEmbryos = chatMentionsNoEmbryos;        // intentionally NOT || profile?.hasEmbryos === false
  const embryoStatusKnown = hasEmbryos || noEmbryos;

  // Gay/single male: egg donor is always required, no egg source question needed
  const isGayOrSingleMale = isGayMale || (isMaleGender && isSoloSkip);

  // Two moms: sperm always donor (silent save)
  const isTwoMoms = isLesbianOrientation || (!isMaleGender && isFemaleGender && !isSoloSkip && profile?.familyType === "two_moms");

  // Solo woman
  const isSoloWoman = isFemaleGender && isSoloSkip;

  // Female in straight couple (not solo, not two moms)
  const isFemaleInStraightCouple = isFemaleGender && !isSoloSkip && !isTwoMoms;

  // Straight male (not gay, not solo)
  const isStraightMale = isMaleGender && !isGayMale && !isSoloSkip;

  // Whether clinic questions apply - only when needing HELP finding a clinic
  const needsHelpFindingClinic = (needsClinic || registeredForClinic) && !alreadyHasClinic;

  // Whether clinic cycle A questions apply (clinic found or needs help)
  const clinicCycleApplies = needsClinic || registeredForClinic;

  // ===========================================================================
  // PHASE 2 QUESTIONS
  // ===========================================================================

  // -----------------------------------------------------------------------
  // STEP 0: Clinic status
  // -----------------------------------------------------------------------
  // Ask the clinic question UNLESS we already know whether the parent needs
  // help finding one. Previously the guard `!registeredForClinic &&
  // !registeredForSurrogate && !needsClinic && !needsSurrogate` evaluated true
  // for any new user before they'd said anything, treating them as donor-only
  // and skipping Phase 2 entirely. That caused the bypass to jump to Step 2
  // (eggs) and the conversation to misalign. Real "donor-only" users will
  // either say "I already have a clinic" (alreadyHasClinic=true so Step 0
  // doesn't repeat) or answer the question naturally.
  const clinicStatusKnown = needsClinic || alreadyHasClinic ||
    profile?.needsClinic != null ||
    userSaid(allUserMessages, /i need help finding a clinic|i already have a clinic|need help.*clinic/i);
  if (!clinicStatusKnown) {
    const step0Asked = aiAsked(chatHistory, /do you already have a fertility clinic.*need help finding one|need help finding.*clinic.*already have a clinic/i);
    const step0Answered = userSaid(allUserMessages, /i need help finding a clinic|i already have a clinic|already have a clinic|need help.*clinic/i)
      || profile?.needsClinic != null;
    if (!step0Asked && !step0Answered) {
      return {
        step: "step0_clinic_status",
        text: "Do you already have a fertility clinic you're working with, or do you need help finding one? [[QUICK_REPLY:I need help finding a clinic|I already have a clinic]]",
      };
    }
  }

  // -----------------------------------------------------------------------
  // STEP 0a: Clinic name (only if has clinic)
  // Must be checked OUTSIDE the !clinicStatusKnown block - once the user
  // answers "I already have a clinic", clinicStatusKnown becomes true and
  // we'd otherwise skip the name follow-up entirely.
  // -----------------------------------------------------------------------
  const parentAlreadyHasClinic = alreadyHasClinic
    || userSaid(allUserMessages, /i already have a clinic|already.*have.*a clinic|already have a fertility clinic/i)
    || profile?.needsClinic === false;
  if (parentAlreadyHasClinic) {
    const step0aAsked = aiAsked(chatHistory, /what'?s the name of.*ivf clinic.*currently with|name of the.*clinic|name of the ivf clinic/i);
    const step0aAnswered = !!(profile?.currentClinicName)
      || userAnsweredAfter(chatHistory, /what'?s the name of.*ivf clinic|name of the.*clinic/i, /.+/);
    if (!step0aAsked && !step0aAnswered) {
      return {
        step: "step0a_clinic_name",
        text: "What's the name of the IVF clinic you're currently with?",
      };
    }
  }

  // -----------------------------------------------------------------------
  // STEP 1: Frozen embryos
  // Skip for: gay/single male + needs egg donor (can have prior embryos but uncommon path)
  // Actually per spec: skip ONLY if "gay/single male + needs egg donor"
  // -----------------------------------------------------------------------
  const skipEmbryoQuestion = isGayOrSingleMale && (needsEggDonor || registeredForEggDonor);

  // donorOnlyParent: registered ONLY for egg/sperm donor (no clinic, no surrogate, no
  // clinic/surrogate mention). Skip embryo question because pure donor-only browsing
  // doesn't need embryo context.
  const donorOnlyParent = (registeredForEggDonor || registeredForSpermDonor)
    && !registeredForClinic && !registeredForSurrogate
    && !needsClinic && !needsSurrogate && !alreadyHasClinic;
  if (!skipEmbryoQuestion && !embryoStatusKnown && !donorOnlyParent) {
    const step1Asked = aiAsked(chatHistory, /do you already have frozen embryos|already have frozen embryos/i);
    if (!step1Asked) {
      return {
        step: "step1_embryos",
        text: "Do you already have frozen embryos? [[QUICK_REPLY:Yes, I do|No, not yet|Working to create them]]",
      };
    }
  }

  // From here, we know embryo status is established (or skipped for the right reason)

  // -----------------------------------------------------------------------
  // STEP 1a: Embryo count (only if has embryos)
  // -----------------------------------------------------------------------
  if (hasEmbryos) {
    const step1aAsked = aiAsked(chatHistory, /how many embryos do you have/i);
    const step1aAnswered = profile?.embryoCount != null
      || userAnsweredAfter(chatHistory, /how many embryos do you have/i, /\d+|1|2|3|4|5|6-10|above 10/i);
    if (!step1aAsked && !step1aAnswered) {
      return {
        step: "step1a_embryo_count",
        text: "How many embryos do you have? [[QUICK_REPLY:1|2|3|4|5|6-10|Above 10]]",
      };
    }

    // -----------------------------------------------------------------------
    // STEP 1b: PGT-A tested (only if has embryos)
    // -----------------------------------------------------------------------
    const step1bAsked = aiAsked(chatHistory, /have they been pgt-?a tested|pgt-?a test/i);
    const step1bAnswered = profile?.embryosTested != null
      || userAnsweredAfter(chatHistory, /have they been pgt-?a tested|pgt-?a test/i, /yes|no|not sure/i);
    if (!step1bAsked && !step1bAnswered) {
      return {
        step: "step1b_pgta",
        text: "Have they been PGT-A tested? [[QUICK_REPLY:Yes|No|I'm not sure]]",
      };
    }

    // -----------------------------------------------------------------------
    // STEP 1c: Egg donor conflict (only if has embryos AND registered for egg donation)
    // -----------------------------------------------------------------------
    if (registeredForEggDonor || needsEggDonor) {
      const step1cAsked = aiAsked(chatHistory, /planning to use your existing embryos.*also looking to create new embryos|use your existing embryos.*fresh donor|existing embryos.*create new/i);
      const step1cAnswered = userAnsweredAfter(
        chatHistory,
        /planning to use your existing embryos.*fresh donor|existing embryos.*create new/i,
        /use my existing embryos|create new embryos/i
      );
      if (!step1cAsked && !step1cAnswered) {
        return {
          step: "step1c_embryo_conflict",
          text: "You mentioned you already have frozen embryos - and you're also registered for egg donation. Just to clarify: are you planning to use your existing embryos, or are you also looking to create new embryos with a fresh donor? [[QUICK_REPLY:Use my existing embryos|Create new embryos with a fresh donor]]",
        };
      }
      // If user said "use my existing embryos" - skip egg donor path for gay/single male
      const userChoseExistingEmbryos = userSaid(allUserMessages, /use my existing embryos/i);
      if (userChoseExistingEmbryos && isGayOrSingleMale) {
        // Skip to sperm step - egg source is already done (donor)
        // fall through to step 3
      }
    }
  }

  // -----------------------------------------------------------------------
  // STEP 2: Egg source
  // Skip for: gay/single male (always donor, handled silently)
  // -----------------------------------------------------------------------
  if (!isGayOrSingleMale && !chatMentionsEggSource) {
    // Don't use profile?.eggSource to skip - stale from previous sessions.
    // Only skip if egg source was confirmed IN THIS conversation.
    const step2Asked = aiAsked(chatHistory, /what'?s your plan for eggs|for those embryos.*were the eggs|partner'?s.*own eggs.*donor/i);
    const step2Answered = chatMentionsEggSource
      || userAnsweredAfter(chatHistory,
        /what'?s your plan for eggs|for those embryos.*were the eggs|were the eggs yours/i,
        /partner'?s eggs|my own eggs|donor eggs|not sure yet/i);

    if (!step2Asked && !step2Answered) {
      // Build the right variant
      let text: string;

      if (isStraightMale) {
        text = hasEmbryos
          ? "For those embryos, were the eggs your partner's or from a donor? [[QUICK_REPLY:My partner's eggs|Donor eggs]]"
          : "What's your plan for eggs - are you thinking of using your partner's own eggs, or considering a donor? [[QUICK_REPLY:My partner's eggs|Donor eggs|I'm not sure yet]]";
      } else if (isFemaleInStraightCouple) {
        text = hasEmbryos
          ? "For those embryos, were the eggs yours, your partner's, or from a donor? [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]"
          : "What's your plan for eggs? [[QUICK_REPLY:My own eggs|Donor eggs|I'm not sure yet]]";
      } else if (isTwoMoms) {
        text = hasEmbryos
          ? "For those embryos, were the eggs yours, your partner's, or from a donor? [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs]]"
          : "What's your plan for eggs? [[QUICK_REPLY:My own eggs|My partner's eggs|Donor eggs|I'm not sure yet]]";
      } else if (isSoloWoman) {
        text = hasEmbryos
          ? "For those embryos, were the eggs yours or from a donor? [[QUICK_REPLY:My own eggs|Donor eggs]]"
          : "What's your plan for eggs? [[QUICK_REPLY:My own eggs|Donor eggs|I'm not sure yet]]";
      } else {
        // Fallback (unknown family type at this point - let Gemini handle)
        return null;
      }

      return { step: "step2_egg_source", text };
    }
  }

  // -----------------------------------------------------------------------
  // STEP 2a: Egg donor help (only if donor eggs + no embryos)
  // -----------------------------------------------------------------------
  // Determine if egg source is donor and no embryos exist.
  // IMPORTANT: Do NOT trust profile?.eggSource alone - stale values from prior sessions
  // (e.g. "Egg donor" persisted from previous test) cause step 2a to fire when the user
  // just said "partner's eggs" in the current chat. Only trust profile?.eggSource when
  // egg source was ALSO confirmed in current chat AND that confirmation was "donor eggs".
  const eggSourceIsDonor = chatMentionsEggSource
    ? userSaid(allUserMessages, /donor eggs|egg donor/i)
    : /donor eggs|egg donor|donor/i.test(profile?.eggSource || "");
  const needsEggDonorHelp = eggSourceIsDonor && !hasEmbryos && !alreadyHasEggDonor;

  if (needsEggDonorHelp && !alreadyHasEggDonor && profile?.needsEggDonor == null) {
    const step2aAsked = aiAsked(chatHistory, /do you need help finding an egg donor.*already have one|need help.*egg donor/i);
    const step2aAnswered = profile?.needsEggDonor != null
      || userAnsweredAfter(chatHistory, /need help.*egg donor|finding an egg donor/i, /i need help|already have/i);
    if (!step2aAsked && !step2aAnswered) {
      return {
        step: "step2a_egg_donor_help",
        text: "Do you need help finding an egg donor, or do you already have one? [[QUICK_REPLY:I need help finding an egg donor|I already have an egg donor]]",
      };
    }
  }

  // -----------------------------------------------------------------------
  // STEP 3b: Sperm conflict (only if has embryos AND registered for sperm donation)
  // Mirrors Step 1c (egg conflict) for the sperm-donor + existing-embryos case.
  // Must fire BEFORE Step 3 because the user already has embryos - we need to
  // know whether they're keeping them or creating new ones with donor sperm
  // before we can ask the standard sperm-source question.
  // -----------------------------------------------------------------------
  if (hasEmbryos && (registeredForSpermDonor || needsSpermDonor) && !registeredForEggDonor) {
    const step3bAsked = aiAsked(chatHistory, /looking to create new embryos with donor sperm|use your existing embryos.*donor sperm|create new embryos.*donor sperm/i);
    const step3bAnswered = userAnsweredAfter(
      chatHistory,
      /create new embryos with donor sperm|use your existing embryos.*donor sperm/i,
      /use my existing embryos|create new embryos/i
    );
    if (!step3bAsked && !step3bAnswered) {
      return {
        step: "step3b_sperm_conflict",
        text: "You're looking for a sperm donor but already have frozen embryos. Just to confirm - are you looking to create new embryos with donor sperm, or will you use your existing embryos? [[QUICK_REPLY:Use my existing embryos|Create new embryos with donor sperm]]",
      };
    }
  }

  // -----------------------------------------------------------------------
  // STEP 3: Sperm source
  // Skip for: solo woman + two moms (always sperm donor - save silently)
  // Also skip when 3b was answered with "Use my existing embryos" - the sperm
  // source is already baked into the existing embryos, no question needed.
  // Also skip when the parent already registered for / explicitly asked for
  // sperm donation AND has no existing embryos: the answer is obviously
  // "Donor sperm" and re-asking is annoying. (When they DO have embryos, the
  // 3b conflict question handles disambiguation.)
  // -----------------------------------------------------------------------
  const chose3bExisting = hasEmbryos && (registeredForSpermDonor || needsSpermDonor) &&
    userSaid(allUserMessages, /use my existing embryos/i);
  const spermDonorAlreadyConfirmed = (registeredForSpermDonor || needsSpermDonor) && !hasEmbryos;
  const skipSpermQuestion = isSoloWoman || isTwoMoms || chose3bExisting || spermDonorAlreadyConfirmed;
  const spermSourceKnown = chatMentionsSpermSource; // intentionally NOT || profile?.spermSource (stale)

  if (!skipSpermQuestion && !spermSourceKnown) {
    const step3Asked = aiAsked(chatHistory, /for sperm.*will you be using|for those embryos.*did you use.*sperm|for sperm.*will you.*using|and for sperm/i);
    const step3Answered = spermSourceKnown
      || userAnsweredAfter(chatHistory,
        /for sperm.*will you|for those embryos.*sperm|and for sperm/i,
        /my own|donor sperm|my partner'?s|not sure/i);

    if (!step3Asked && !step3Answered) {
      let text: string;

      if (isStraightMale) {
        text = hasEmbryos
          ? "And for sperm, did you use your own or a sperm donor? [[QUICK_REPLY:My own|Donor sperm]]"
          : "And for sperm, will you be using your own or a sperm donor? [[QUICK_REPLY:My own|Donor sperm|Not sure yet]]";
      } else if (isFemaleInStraightCouple) {
        text = hasEmbryos
          ? "And for sperm, did you use your partner's or a sperm donor? [[QUICK_REPLY:My partner's sperm|Donor sperm]]"
          : "And for sperm, will you be using your partner's or a sperm donor? [[QUICK_REPLY:My partner's sperm|Donor sperm|Not sure yet]]";
      } else if (isGayOrSingleMale && !isSoloSkip) {
        // Two dads
        text = hasEmbryos
          ? "And for sperm, did you use your own, your partner's, or a sperm donor? [[QUICK_REPLY:My own|My partner's|Donor sperm]]"
          : "And for sperm, will you be using your own, your partner's, or a sperm donor? [[QUICK_REPLY:My own|My partner's|Donor sperm|Not sure yet]]";
      } else if (isGayOrSingleMale && isSoloSkip) {
        // Single male
        text = hasEmbryos
          ? "For those embryos, did you use your own sperm or a sperm donor? [[QUICK_REPLY:My own|Donor sperm]]"
          : "For sperm, will you be using your own or a sperm donor? [[QUICK_REPLY:My own|Donor sperm]]";
      } else {
        return null; // Unknown type - let Gemini handle
      }

      return { step: "step3_sperm_source", text };
    }
  }

  // -----------------------------------------------------------------------
  // STEP 3a: Sperm donor help (only if donor sperm + no embryos)
  // -----------------------------------------------------------------------
  // Same stale-profile concern as eggSourceIsDonor above - only trust profile.spermSource
  // when sperm source was ALSO confirmed in current chat.
  const spermSourceIsDonor = chatMentionsSpermSource
    ? userSaid(allUserMessages, /donor sperm|sperm donor/i)
    : /sperm donor|donor sperm|donor/i.test(profile?.spermSource || "");
  const needsSpermDonorHelp = spermSourceIsDonor && !hasEmbryos && !alreadyHasSpermDonor;

  if (needsSpermDonorHelp && profile?.needsSpermDonor == null) {
    const step3aAsked = aiAsked(chatHistory, /do you need help finding a sperm donor.*already have one|need help.*sperm donor/i);
    const step3aAnswered = profile?.needsSpermDonor != null
      || userAnsweredAfter(chatHistory, /need help.*sperm donor|finding a sperm donor/i, /i need help|already have/i);
    if (!step3aAsked && !step3aAnswered) {
      return {
        step: "step3a_sperm_donor_help",
        text: "Do you need help finding a sperm donor, or do you already have one? [[QUICK_REPLY:I need help finding a sperm donor|I already have a sperm donor]]",
      };
    }
  }

  // -----------------------------------------------------------------------
  // STEP 4: Carrier
  // Skip for: solo male / gay male / already-needs-surrogate
  // DO ASK for: female (any) AND straight male in a couple (his female partner can carry).
  // For MW male the partner is female and CAN carry, so we MUST ask. Previously the
  // guard was `isMaleGender` which over-skipped for MW male and left the AI to infer
  // surrogate from biology - giving the wrong carrier="Gestational surrogate" save.
  // -----------------------------------------------------------------------
  const maleWithoutFemalePartner = isMaleGender && (isGayMale || isSoloSkip);
  const skipCarrierQuestion = maleWithoutFemalePartner || needsSurrogate || alreadyHasSurrogate
    || chatMentionsCarrier; // intentionally NOT || profile?.carrier (stale)

  if (!skipCarrierQuestion && (isFemaleGender || isStraightMale)) {
    // Female or straight male registered for surrogacy - skip and save silently
    if (registeredForSurrogate) {
      // Skip step 4 entirely - will be saved silently by caller
    } else {
      const step4Asked = aiAsked(chatHistory, /who is planning to carry.*pregnancy|who.*carrying the pregnancy/i);
      const step4Answered = chatMentionsCarrier
        || userAnsweredAfter(chatHistory,
          /who is planning to carry|who.*carrying/i,
          /\bme\b|my partner|gestational surrogate/i);
      if (!step4Asked && !step4Answered) {
        // Each persona has different valid carriers:
        //   - Straight male in couple: partner (female) or surrogate. HE cannot carry.
        //   - Female solo: herself or surrogate. No partner.
        //   - Female in couple (incl. Two Moms): herself, partner, or surrogate.
        const carrierQR = isStraightMale
          ? "[[QUICK_REPLY:My partner|A gestational surrogate]]"
          : isSoloSkip
            ? "[[QUICK_REPLY:Me|A gestational surrogate]]"
            : "[[QUICK_REPLY:Me|My partner|A gestational surrogate]]";
        return {
          step: "step4_carrier",
          text: `And who is planning to carry the pregnancy? ${carrierQR}`,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // STEP 4a: Surrogate help - MUST fire independently of step 4's gating.
  // The user can imply a surrogate carrier via the chat ("a gestational
  // surrogate will carry the pregnancy") which sets chatMentionsCarrier=true
  // and so skips the step 4 block entirely. But step 4a (do you need help
  // finding one?) is still pending - if we skip it the AI either asks it from
  // Tier 1 with wrong QR options, or proceeds to D1 without the answer and
  // the test message stream misaligns.
  // -----------------------------------------------------------------------
  const carrierIsSurrogateGlobal = needsSurrogate || alreadyHasSurrogate
    || /gestational surrogate/i.test(profile?.carrier || "")
    || userSaid(allUserMessages, /gestational surrogate/i);
  if (carrierIsSurrogateGlobal && !alreadyHasSurrogate && profile?.needsSurrogate == null) {
    const step4aAsked = aiAsked(chatHistory, /do you need help finding a surrogate.*already have one|need help.*surrogate/i);
    const step4aAnswered = profile?.needsSurrogate != null
      || userAnsweredAfter(chatHistory, /need help.*surrogate|finding a surrogate/i, /i need help|already have/i);
    if (!step4aAsked && !step4aAnswered) {
      return {
        step: "step4a_surrogate_help",
        text: "Do you need help finding a surrogate, or do you already have one? [[QUICK_REPLY:I need help finding a surrogate|I already have a surrogate]]",
      };
    }
  }

  // ===========================================================================
  // INTERNATIONAL SURROGACY EARLY COUNTRY GATE
  // When parent needs BOTH a clinic AND a surrogate, D1 (international country
  // selection) MUST fire before any Cycle A clinic question - otherwise we
  // waste questions asking about US clinic preferences when the parent might
  // pick Mexico/Colombia (which bundles the IVF clinic and skips US clinics
  // entirely). See ai-prompt-defaults.ts:526-534 for the canonical rule.
  // ===========================================================================
  const needsBothClinicAndSurrogate = needsHelpFindingClinic
    && (needsSurrogate || registeredForSurrogate)
    && !alreadyHasSurrogate;
  const d1AlreadyAsked = aiAsked(chatHistory, /which countries are you open to for your surrogacy|colombia.*mexico.*surrogate/i);
  const surrogateCountriesRaw: string = profile?.surrogateCountries || "";
  const usaSelected = /usa|united states/i.test(surrogateCountriesRaw)
    || userSaid(allUserMessages, /\busa\b|united states/i);
  // After D1 is answered, international-only (no USA) means Cycle A is skipped.
  const internationalOnly = d1AlreadyAsked
    && !!surrogateCountriesRaw
    && !usaSelected;
  // Skip Cycle A until D1 is answered when parent needs both.
  const skipClinicCycleForD1 = needsBothClinicAndSurrogate && !d1AlreadyAsked;

  // ===========================================================================
  // PHASE 3A: CLINIC CYCLE (only if needsHelpFindingClinic)
  // ===========================================================================

  if (needsHelpFindingClinic && !skipClinicCycleForD1 && !internationalOnly) {
    const currentYear = new Date().getFullYear();

    // A1: Age
    const a1Asked = aiAsked(chatHistory, /^how old are you\?$|how old are you\?.*\[\[/i)
      || aiAsked(chatHistory, /how old are you/i);
    const ageFromProfile = profile?.birthYear ? currentYear - profile.birthYear : null;
    const ageAnsweredInChat = chatHistory.some((m: any) =>
      m.role === "user" && /^\d{2}$/.test((m.content || "").trim()) && parseInt((m.content || "").trim()) >= 18 && parseInt((m.content || "").trim()) <= 70
    );
    const a1Answered = !!(ageFromProfile) || ageAnsweredInChat;
    if (!a1Asked && !a1Answered) {
      return { step: "a1_age", text: "How old are you?" };
    }

    // A2: Partner age (skip if solo/single)
    if (!isSoloSkip) {
      const a2Asked = aiAsked(chatHistory, /how old is your partner/i);
      const partnerAgeFromProfile = profile?.partnerBirthYear ? currentYear - profile.partnerBirthYear : null;
      const partnerAgeAnsweredInChat = a1Answered && chatHistory.some((m: any, idx: number) => {
        if (m.role !== "user") return false;
        const prevAi = chatHistory.slice(0, idx).reverse().find((p: any) => p.role === "assistant");
        if (!prevAi) return false;
        return /how old is your partner/i.test(prevAi.content || "") && /^\d{2}$/.test((m.content || "").trim());
      });
      const a2Answered = !!(partnerAgeFromProfile) || partnerAgeAnsweredInChat;
      if (!a2Asked && !a2Answered) {
        return { step: "a2_partner_age", text: "And how old is your partner?" };
      }
    }

    // A3: Twins preference
    const a3Asked = aiAsked(chatHistory, /are you hoping for twins/i);
    const a3Answered = !!(profile?.hopingForTwins)
      || userSaid(allUserMessages, /hoping for twins|singleton only|no preference.*twins|no twins/i)
      || userAnsweredAfter(chatHistory, /are you hoping for twins/i, /hoping for twins|singleton|no preference/i);
    if (!a3Asked && !a3Answered) {
      return {
        step: "a3_twins",
        text: "Are you hoping for twins? [[QUICK_REPLY:Hoping for twins|Singleton only|No preference]]",
      };
    }

    // A4: First IVF
    const a4Asked = aiAsked(chatHistory, /is this your first ivf journey.*done ivf before|first ivf|ivf before/i);
    const a4Answered = profile?.isFirstIvf != null
      || userAnsweredAfter(chatHistory, /first ivf journey.*ivf before|is this your first ivf/i, /first time|i'?ve done ivf/i);
    if (!a4Asked && !a4Answered) {
      return {
        step: "a4_first_ivf",
        text: "Is this your first IVF journey, or have you done IVF before? [[QUICK_REPLY:First time|I've done IVF before]]",
      };
    }

    // A5: Clinic priorities
    const a5Asked = aiAsked(chatHistory, /what'?s most important.*choosing a clinic|matters most.*choosing a clinic|clinic.*priorities/i);
    const a5Answered = !!(profile?.clinicPriority)
      || userAnsweredAfter(chatHistory, /what'?s most important.*choosing a clinic/i, /.+/);
    if (!a5Asked && !a5Answered) {
      return {
        step: "a5_clinic_priorities",
        text: "What's most important to you when choosing a clinic? [[MULTI_SELECT:Success rates|Location|Cost|Volume of cycles|Physician gender]]",
      };
    }

    // A CURATION: all A questions answered - trigger CURATION summary
    // (A5 curation is handled by the existing A5 CURATION BYPASS in ai-router.ts,
    //  so we only fire if somehow that bypass didn't catch it)
    if (a1Answered && a4Answered && a5Answered) {
      const allUserMsgs = chatHistory.filter((m: any) => m.role === "user").map((m: any) => m.content || "");
      const ageAnswerMsg = allUserMsgs.find((s: string) => /^\d{2}$/.test(s.trim()) && parseInt(s.trim()) >= 18 && parseInt(s.trim()) <= 70);
      const ageFromChat = ageAnswerMsg ? parseInt(ageAnswerMsg.trim()) : null;
      const age = ageFromChat || ageFromProfile;
      const eggSource = allUserMsgs.find((s: string) => /partner'?s eggs|my own eggs|donor eggs/i.test(s))?.match(/partner'?s eggs|my own eggs|donor eggs/i)?.[0] || profile?.eggSource;
      const twins = userSaid(allUserMessages, /hoping for twins/) ? "hoping for twins"
        : userSaid(allUserMessages, /singleton only|no twins/) ? "preferring singleton"
        : profile?.hopingForTwins === "yes" ? "hoping for twins"
        : profile?.hopingForTwins === "no" ? "preferring a singleton pregnancy"
        : null;
      const lastUserMsg = allUserMsgs[allUserMsgs.length - 1] || "";
      const agePart = age ? `you're ${age}` : "";
      const eggPart = eggSource ? (eggSource.toLowerCase().includes("partner") ? ", using your partner's eggs" : eggSource.toLowerCase().includes("own") ? ", using your own eggs" : ", using donor eggs") : "";
      const twinsPart = twins ? `, ${twins}` : "";
      const priorityPart = profile?.clinicPriority ? `, with ${profile.clinicPriority} being your top priority for a clinic` : lastUserMsg ? `, with ${lastUserMsg} being your top priority` : "";
      return {
        step: "a_curation",
        text: `Here's what I have: ${agePart}${eggPart}${twinsPart}${priorityPart}. Shall I find your perfect clinic matches now? [[CURATION]]`,
      };
    }
  }

  // ===========================================================================
  // PHASE 3D: SURROGATE CYCLE (only if needsSurrogate)
  // ===========================================================================

  if ((needsSurrogate || registeredForSurrogate) && !alreadyHasSurrogate) {
    // D1: Which countries (with cost-comparison education).
    // Must fire here in the intake state machine for parents whose flow doesn't
    // hit the carrier-bypass or D-cycle-pre-bypass paths in ai-router.ts - e.g.
    // a solo woman with CLINIC_HAVE + EGG_DONOR + SURR_NEED never says "sperm"
    // explicitly (silent save) and already has a clinic, so neither bypass
    // fires. Without this, Tier 1 Gemini takes over and asks the wrong cycle.
    //
    // D1 fires before Cycle A when parent needs both (see
    // INTERNATIONAL SURROGACY EARLY COUNTRY GATE above). Allow D1 if:
    //   (a) parent doesn't need Cycle A at all (!needsHelpFindingClinic), OR
    //   (b) parent needs both and we're skipping Cycle A pending D1, OR
    //   (c) Cycle A is already done (A curation was sent).
    const aCurationSent = aiAsked(chatHistory, /shall i find your perfect clinic matches|perfect clinic matches/i);
    const clinicCycleDone = !needsHelpFindingClinic || skipClinicCycleForD1 || aCurationSent;
    if (clinicCycleDone && !d1AlreadyAsked) {
      const d1Text = hasEmbryos ? D1_HAS_EMBRYOS : D1_NO_EMBRYOS;
      return { step: "d1_countries", text: d1Text };
    }

    // D2: Termination preference (skip if parent did NOT select USA in D1)
    const d1Answered = d1AlreadyAsked; // alias for downstream readability
    const surrogateCountries: string = surrogateCountriesRaw;
    const selectedUSA = usaSelected;

    // Declared at the OUTER scope so the D CURATION check below (line ~674) can read it.
    // Previously this was a `const d2Asked` inside the `if (d1Answered && selectedUSA)`
    // block - the variable went out of scope before the curation check that references
    // it, throwing ReferenceError: d2Asked is not defined and aborting the request before
    // sendDone could fire. SM-13 (USA surrogate path) hit this every single time.
    let d2Asked = false;
    if (d1Answered && selectedUSA) {
      d2Asked = aiAsked(chatHistory, /preferences regarding termination|termination.*medically necessary|pro-choice.*pro-life/i);
      const d2Answered = !!(profile?.surrogateTermination)
        || userAnsweredAfter(chatHistory, /preferences.*termination|termination.*medically/i, /pro-choice|pro-life|no preference/i);
      if (!d2Asked && !d2Answered) {
        return {
          step: "d2_termination",
          text: "What are your preferences regarding termination if medically necessary? [[QUICK_REPLY:Pro-choice surrogate|Pro-life surrogate|No preference]]",
        };
      }
    }

    // D3: Twins preference for surrogate
    // Skip ONLY if twins preference was explicitly stated earlier (A3 answered OR in allUserMessages)
    const twinsAlreadyAnswered = !!(profile?.hopingForTwins)
      || userSaid(allUserMessages, /hoping for twins|singleton only|no preference.*twins/i);

    if (d1Answered && !twinsAlreadyAnswered) {
      const d3Asked = aiAsked(chatHistory, /are you hoping to have twins.*singleton|singleton.*twins.*preference/i);
      const d3Answered = twinsAlreadyAnswered
        || userAnsweredAfter(chatHistory, /hoping to have twins|singleton.*twins/i, /hoping for twins|singleton only|no preference/i);
      if (!d3Asked && !d3Answered) {
        return {
          step: "d3_twins",
          text: "Are you hoping to have twins, or would you prefer a singleton pregnancy? [[QUICK_REPLY:Hoping for twins|Singleton only|No preference]]",
        };
      }
    }

    // D CURATION: build from profile data when D questions are answered
    if (d1Answered && (twinsAlreadyAnswered || !selectedUSA || !!(profile?.surrogateTermination) || d2Asked)) {
      const familyType = profile?.familyType || "your family";
      const countries = surrogateCountries || "USA";
      const termPref = profile?.surrogateTermination || null;
      const twinsPref = profile?.hopingForTwins === "yes" ? "hoping for twins"
        : profile?.hopingForTwins === "no" ? "singleton preferred"
        : userSaid(allUserMessages, /hoping for twins/) ? "hoping for twins"
        : userSaid(allUserMessages, /singleton/) ? "singleton preferred"
        : null;

      const alreadySentDCuration = aiAsked(chatHistory, /shall i find your perfect.*surrogate.*matches|perfect surrogate matches/i);
      if (!alreadySentDCuration) {
        let summary = `Here's what I have: `;
        const parts: string[] = [];
        if (familyType && familyType !== "your family") parts.push(familyType.replace(/_/g, " "));
        if (countries) parts.push(`open to surrogacy in ${countries}`);
        if (termPref) parts.push(`termination preference: ${termPref}`);
        if (twinsPref) parts.push(twinsPref);
        summary += (parts.length ? parts.join(", ") : "your surrogacy preferences") + ". Shall I find your perfect surrogate matches now? [[CURATION]]";
        return { step: "d_curation", text: summary };
      }
    }
  }

  // ===========================================================================
  // PHASE 3C: C2 (sperm donor type) - only if sperm donor needed and C1 answered
  // ===========================================================================
  if (needsSpermDonor || !!(profile?.needsSpermDonor)) {
    const c1Asked = aiAsked(chatHistory, /what matters most.*sperm donor|sperm donor.*preferences|looking for.*sperm donor/i);
    const c1Answered = c1Asked && chatHistory.some((m: any, idx: number) => {
      if (m.role !== "user") return false;
      const prevAi = chatHistory.slice(0, idx).reverse().find((p: any) => p.role === "assistant");
      return !!(prevAi && /what matters most.*sperm donor|sperm donor.*preferences/i.test(prevAi.content || ""));
    });

    if (c1Answered) {
      const c2Asked = aiAsked(chatHistory, /prefer.*open.*anonymous.*exclusive|open donor.*anonymous donor|would you prefer.*open|would you prefer.*anonymous/i);
      const c2Answered = !!(profile?.spermDonorType)
        || userAnsweredAfter(chatHistory, /prefer.*open.*anonymous|open donor.*anonymous/i, /open|anonymous|exclusive|no preference/i);
      if (!c2Asked && !c2Answered) {
        return {
          step: "c2_sperm_donor_type",
          text: "Would you prefer an Open donor, an Anonymous donor, or an Exclusive donor? [[QUICK_REPLY:Open|Anonymous|Exclusive|No preference]]",
        };
      }
    }
  }

  // All applicable questions answered (or not applicable)
  return null;
}
