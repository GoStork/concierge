import { Injectable, Logger } from "@nestjs/common";
import { prisma } from "../../../db";
import { TEST_CASES, TestCaseDef } from "./test-cases";
import {
  RunnerState,
  TestProgress,
  TestStatus,
  SSEEvent,
} from "./test-runner.types";

const BASE_URL = "http://localhost:5001";
const TEST_PASSWORD = "TestPass123!";
const MSG_TIMEOUT_MS = 240_000; // 4 min per message
const DELAY_BETWEEN_MSGS_MS = 600;

interface Msg {
  send: string;
  assert?: {
    contains?: string[];
    notContains?: string[];
    hasQR?: boolean;
    hasMatchCard?: boolean;
  };
}

interface TurnResult {
  content: string;
  quickReplies: string[];
  hasMatchCard: boolean;
  sessionId: string | null;
}

// ─── Message block helpers (mirrors scripts/test-ai-concierge.ts) ──────────

const P0 = ["Yes, that's right", "Yes, makes sense!", "I understand, let's get started"];
const I_SOLO_MAN_STRAIGHT = ["Solo man", "No, I'm not LGBTQ+"];
const I_SOLO_MAN_GAY      = ["Solo man", "Yes, I identify as LGBTQ+"];
const I_SOLO_WOMAN        = ["Solo woman", "No, I'm not LGBTQ+"];
const I_TWO_DADS          = ["Two dads"];
const I_TWO_MOMS          = ["Two moms"];
const I_MW_WOMAN          = ["A woman and a man", "No, we're not LGBTQ+"];
const I_MW_MAN            = ["A woman and a man", "No, we're not LGBTQ+"];

const CLINIC_NEED  = ["I need help finding a clinic"];
const CLINIC_HAVE  = ["I already have a fertility clinic", "My IVF Clinic"];
const EMB_NO       = ["No, I don't have frozen embryos"];
const EMB_YES      = (count: string, tested: "Yes" | "No" | "I'm not sure"): string[] =>
  ["Yes, I do", count, tested];

const EMB_CONFLICT_USE = ["Use my existing embryos"];
const EMB_CONFLICT_NEW = ["Create new embryos with a fresh egg donor"];

const EGG_OWN     = ["I'll be using my own eggs"];
const EGG_DONOR   = ["I need help finding an egg donor"];
const EGG_HAVE    = ["I already have an egg donor"];

const SPERM_OWN    = ["I'll use my own sperm"];
const SPERM_PART   = ["My partner's sperm"];
const SPERM_DONOR  = ["Donor sperm"];
const SPERM_NEED   = ["I need help finding a sperm donor"];
const SPERM_HAVE   = ["I already have a sperm donor"];

const SPERM_CONFLICT_USE = ["Use my existing embryos"];

const CARRIER_ME        = ["I'll carry the pregnancy myself"];
const CARRIER_PARTNER   = ["My partner will carry the pregnancy"];
const CARRIER_SURROGATE = ["A gestational surrogate will carry the pregnancy"];

const SURR_NEED = ["I need help finding a surrogate"];
const SURR_HAVE = ["I already have a surrogate"];

const surrogateMatch = (country: string, termination: string, twins: string): Msg[] => [
  { send: country },
  { send: termination },
  { send: twins },
  { send: "Yes, I'm ready!" },
];
const agencyMatch = (country: string): Msg[] => [
  { send: country },
  { send: "Yes, I'm ready!" },
];

const eggDonorMatch: Msg[] = [
  { send: "Yes, I'm ready!" },
  { send: "I prefer someone with brown eyes, college educated, healthy", assert: { hasMatchCard: true } },
];

const spermDonorMatch: Msg[] = [
  { send: "Yes, I'm ready!" },
  { send: "Open identity preferred, tall, athletic build" },
  { send: "Open", assert: { hasMatchCard: true } },
];

const clinicMatch: Msg[] = [
  { send: "Yes, I'm ready!" },
  { send: "35" },
  { send: "No" },
  { send: "No" },
  { send: "First time" },
  { send: "Success rates", assert: { hasMatchCard: true } },
];

const noSpermQ   = { notContains: ["will you be using your own sperm", "for sperm, will you", "sperm donor or your own"] };
const noCarrierQ = { notContains: ["who will carry", "who is planning to carry", "who is carrying the pregnancy"] };

function msgs(...blocks: (string | string[] | Msg | Msg[])[]): Msg[] {
  const result: Msg[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      result.push({ send: block });
    } else if (Array.isArray(block)) {
      for (const item of block) {
        if (typeof item === "string") result.push({ send: item });
        else result.push(item as Msg);
      }
    } else {
      result.push(block as Msg);
    }
  }
  return result;
}

// ─── Full test case message definitions ────────────────────────────────────

function getMessagesForId(id: string): Msg[] {
  switch (id) {
    // ── SOLO MAN ──────────────────────────────────────────────────────────────
    case "SM-01": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_NEED, EMB_NO,
      { send: "I need help finding an egg donor", assert: noCarrierQ },
      SPERM_OWN, SURR_NEED,
    );
    case "SM-02": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE, EMB_NO,
      EGG_HAVE, SPERM_OWN, SURR_NEED,
      ...surrogateMatch("USA", "Pro-life surrogate", "Hoping for twins"),
    );
    case "SM-03": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE, EMB_NO,
      SPERM_OWN, SURR_HAVE,
    );
    case "SM-04": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_NEED, EMB_NO,
      { send: "I need help finding an egg donor", assert: noCarrierQ },
      SPERM_DONOR, SPERM_NEED, SURR_NEED,
    );
    case "SM-05": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_DONOR, SPERM_HAVE, SURR_NEED,
      ...agencyMatch("Colombia"),
    );
    case "SM-06": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_DONOR, SPERM_NEED, SURR_NEED,
      ...agencyMatch("Mexico"),
    );
    case "SM-07": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_OWN, SURR_NEED,
      { send: "USA, Colombia" },
      { send: "Pro-choice surrogate" },
      { send: "No preference" },
      { send: "Yes, I'm ready!" },
    );
    case "SM-08": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE,
      "Yes, I have frozen embryos", "2", "Yes",
      "I already have an egg donor",
      "I'll use my own sperm", SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
    );
    case "SM-09": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE,
      ...EMB_YES("1", "No"), "I already have an egg donor",
      "My own", SURR_NEED,
      ...agencyMatch("Colombia"),
    );
    case "SM-10": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_NEED,
      "Yes, I have frozen embryos", "3", "Yes",
      SPERM_CONFLICT_USE, SURR_NEED,
    );
    case "SM-11": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      EMB_CONFLICT_NEW,
      EGG_DONOR, SPERM_NEED, SURR_NEED,
    );
    case "SM-12": return msgs(
      P0, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_OWN, SURR_NEED,
      { send: "USA" },
      "Pro-choice surrogate",
      { send: "Singleton only" },
      { send: "Yes, I'm ready!" },
    );
    case "SM-13": return msgs(
      P0, I_SOLO_MAN_GAY, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_OWN, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Hoping for twins"),
    );
    case "SM-14": return msgs(
      P0, I_SOLO_MAN_STRAIGHT, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_DONOR, SPERM_NEED, SURR_NEED,
      ...agencyMatch("Colombia"),
    );

    // ── SOLO WOMAN ────────────────────────────────────────────────────────────
    case "SW-01": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_HAVE, EMB_NO,
      { send: "I'll be using my own eggs", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...spermDonorMatch,
    );
    case "SW-02": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED, EMB_NO,
      { send: "I'll be using my own eggs", assert: noSpermQ },
      CARRIER_ME, SPERM_HAVE,
      ...clinicMatch,
    );
    case "SW-03": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_HAVE, EMB_NO,
      { send: "I need help finding an egg donor", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "SW-04": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED, EMB_NO,
      { send: "I already have an egg donor", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "SW-05": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED, EMB_NO,
      { send: "I'll be using my own eggs", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
      ...spermDonorMatch,
    );
    case "SW-06": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED, EMB_NO,
      { send: "I'll be using my own eggs", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_HAVE,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "SW-07": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_HAVE, EMB_NO,
      { send: "I need help finding an egg donor", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Hoping for twins"),
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "SW-08": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED, EMB_NO,
      { send: "I need help finding an egg donor", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...agencyMatch("Colombia"),
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "SW-09": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_HAVE,
      ...EMB_YES("2", "Yes"),
      { send: "My own eggs", assert: noSpermQ },
      CARRIER_ME,
      ...spermDonorMatch,
    );
    case "SW-10": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED,
      ...EMB_YES("3", "Yes"),
      EMB_CONFLICT_USE,
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-life surrogate", "Singleton only"),
    );
    case "SW-11": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      EMB_CONFLICT_NEW,
      EGG_DONOR,
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "No preference"),
      ...eggDonorMatch,
    );
    case "SW-12": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_NEED, EMB_NO,
      { send: "I'll be using my own eggs", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "No preference", "No preference"),
    );
    case "SW-13": return msgs(
      P0, I_SOLO_WOMAN, CLINIC_HAVE, EMB_NO,
      { send: "I need help finding an egg donor", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...agencyMatch("Mexico"),
      ...eggDonorMatch,
    );
    case "SW-14": return msgs(
      P0, ["Solo woman", "Yes, I identify as LGBTQ+"],
      CLINIC_NEED, EMB_NO,
      { send: "I'll be using my own eggs", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );

    // ── TWO DADS ──────────────────────────────────────────────────────────────
    case "TD-01": return msgs(
      P0, I_TWO_DADS, CLINIC_HAVE, EMB_NO,
      { send: "I need help finding an egg donor", assert: noCarrierQ },
      SPERM_OWN, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
      ...eggDonorMatch,
    );
    case "TD-02": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED, EMB_NO,
      EGG_DONOR, SPERM_PART, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Hoping for twins"),
      ...eggDonorMatch,
    );
    case "TD-03": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED, EMB_NO,
      EGG_DONOR, SPERM_DONOR, SPERM_NEED, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "TD-04": return msgs(
      P0, I_TWO_DADS, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_DONOR, SPERM_HAVE, SURR_NEED,
      ...agencyMatch("Colombia"),
      ...eggDonorMatch,
    );
    case "TD-05": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED, EMB_NO,
      EGG_HAVE, SPERM_OWN, SURR_NEED,
      ...surrogateMatch("USA", "Pro-life surrogate", "No preference"),
    );
    case "TD-06": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED, EMB_NO,
      EGG_DONOR, SPERM_OWN, SURR_HAVE,
      ...clinicMatch,
      ...eggDonorMatch,
    );
    case "TD-07": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      "My own", SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
    );
    case "TD-08": return msgs(
      P0, I_TWO_DADS, CLINIC_HAVE,
      ...EMB_YES("3", "Yes"),
      "My partner's", SURR_NEED,
      ...agencyMatch("Colombia"),
    );
    case "TD-09": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      SPERM_CONFLICT_USE,
      SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
    );
    case "TD-10": return msgs(
      P0, I_TWO_DADS, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_PART, SURR_NEED,
      ...agencyMatch("Mexico"),
      ...eggDonorMatch,
    );
    case "TD-11": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED, EMB_NO,
      EGG_DONOR, SPERM_OWN, SURR_NEED,
      { send: "USA, Colombia" },
      { send: "Pro-choice surrogate" },
      { send: "Hoping for twins", assert: { hasMatchCard: true } },
    );
    case "TD-12": return msgs(
      P0, I_TWO_DADS, CLINIC_NEED, EMB_NO,
      EGG_DONOR, SPERM_DONOR, SPERM_NEED, SURR_NEED,
      ...surrogateMatch("USA", "No preference", "No preference"),
    );

    // ── TWO MOMS ──────────────────────────────────────────────────────────────
    case "TM-01": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "My own eggs", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "TM-02": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "My own eggs", assert: noSpermQ },
      CARRIER_ME, SPERM_HAVE,
      ...clinicMatch,
    );
    case "TM-03": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "My partner's eggs", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "TM-04": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "I need help finding an egg donor", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...clinicMatch,
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "TM-05": return msgs(
      P0, I_TWO_MOMS, CLINIC_HAVE, EMB_NO,
      { send: "I already have an egg donor", assert: noSpermQ },
      CARRIER_ME, SPERM_NEED,
      ...spermDonorMatch,
    );
    case "TM-06": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "My own eggs", assert: noSpermQ },
      CARRIER_PARTNER, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "TM-07": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "My partner's eggs", assert: noSpermQ },
      CARRIER_PARTNER, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "TM-08": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "My own eggs", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
      ...spermDonorMatch,
    );
    case "TM-09": return msgs(
      P0, I_TWO_MOMS, CLINIC_HAVE, EMB_NO,
      { send: "I need help finding an egg donor", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Hoping for twins"),
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "TM-10": return msgs(
      P0, I_TWO_MOMS, CLINIC_HAVE, EMB_NO,
      { send: "My partner's eggs", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_NEED,
      ...agencyMatch("Colombia"),
      ...spermDonorMatch,
    );
    case "TM-11": return msgs(
      P0, I_TWO_MOMS, CLINIC_HAVE,
      ...EMB_YES("2", "Yes"),
      { send: "My own eggs", assert: noSpermQ },
      CARRIER_PARTNER,
      ...spermDonorMatch,
    );
    case "TM-12": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      EMB_CONFLICT_USE,
      CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
    );
    case "TM-13": return msgs(
      P0, I_TWO_MOMS, CLINIC_NEED, EMB_NO,
      { send: "I need help finding an egg donor", assert: noSpermQ },
      CARRIER_SURROGATE, SURR_HAVE,
      ...clinicMatch,
      ...eggDonorMatch,
      ...spermDonorMatch,
    );

    // ── MAN & WOMAN ───────────────────────────────────────────────────────────
    case "MW-01": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED, EMB_NO,
      "My own eggs", "My partner's", CARRIER_ME,
      ...clinicMatch,
    );
    case "MW-02": return msgs(
      P0, I_MW_MAN, CLINIC_NEED, EMB_NO,
      "My partner's eggs", "My own", CARRIER_PARTNER,
      ...clinicMatch,
    );
    case "MW-03": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED, EMB_NO,
      EGG_DONOR, "My partner's", CARRIER_ME,
      ...clinicMatch,
      ...eggDonorMatch,
    );
    case "MW-04": return msgs(
      P0, I_MW_MAN, CLINIC_NEED, EMB_NO,
      EGG_HAVE, "My own", CARRIER_PARTNER,
      ...clinicMatch,
    );
    case "MW-05": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED, EMB_NO,
      "My own eggs", SPERM_DONOR, CARRIER_ME, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "MW-06": return msgs(
      P0, I_MW_MAN, CLINIC_HAVE, EMB_NO,
      "My partner's eggs", SPERM_DONOR, CARRIER_PARTNER, SPERM_HAVE,
    );
    case "MW-07": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED, EMB_NO,
      EGG_DONOR, SPERM_DONOR, CARRIER_ME, SPERM_NEED,
      ...clinicMatch,
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "MW-08": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED, EMB_NO,
      "My own eggs", "My partner's", CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
      ...clinicMatch,
    );
    case "MW-09": return msgs(
      P0, I_MW_MAN, CLINIC_HAVE, EMB_NO,
      "My partner's eggs", "My own", CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Hoping for twins"),
    );
    case "MW-10": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED, EMB_NO,
      EGG_DONOR, "My partner's", CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "No preference"),
      ...clinicMatch,
      ...eggDonorMatch,
    );
    case "MW-11": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED, EMB_NO,
      "My own eggs", SPERM_DONOR, CARRIER_SURROGATE, SURR_HAVE, SPERM_NEED,
      ...clinicMatch,
      ...spermDonorMatch,
    );
    case "MW-12": return msgs(
      P0, I_MW_MAN, CLINIC_NEED, EMB_NO,
      EGG_DONOR, SPERM_DONOR, CARRIER_SURROGATE, SPERM_NEED, SURR_NEED,
      ...surrogateMatch("USA", "Pro-life surrogate", "Singleton only"),
      ...clinicMatch,
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "MW-13": return msgs(
      P0, I_MW_WOMAN, CLINIC_HAVE, EMB_NO,
      EGG_DONOR, SPERM_DONOR, CARRIER_SURROGATE, SPERM_NEED, SURR_NEED,
      ...agencyMatch("Colombia"),
      ...eggDonorMatch,
      ...spermDonorMatch,
    );
    case "MW-14": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      "My own eggs", "My partner's", CARRIER_ME,
      ...clinicMatch,
    );
    case "MW-15": return msgs(
      P0, I_MW_MAN, CLINIC_NEED,
      ...EMB_YES("4", "Yes"),
      "My partner's eggs", "My own", CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "Singleton only"),
    );
    case "MW-16": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      EMB_CONFLICT_USE,
      "My partner's", CARRIER_ME,
      ...clinicMatch,
    );
    case "MW-17": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      EMB_CONFLICT_NEW,
      EGG_DONOR, "My partner's", CARRIER_SURROGATE, SURR_NEED,
      ...surrogateMatch("USA", "Pro-choice surrogate", "No preference"),
      ...clinicMatch,
      ...eggDonorMatch,
    );
    case "MW-18": return msgs(
      P0, I_MW_WOMAN, CLINIC_NEED,
      ...EMB_YES("2", "Yes"),
      "My own eggs",
      SPERM_CONFLICT_USE,
      CARRIER_ME,
      ...clinicMatch,
    );
    case "MW-19": return msgs(
      P0, I_MW_MAN, CLINIC_NEED, EMB_NO,
      EGG_DONOR, "My own", CARRIER_SURROGATE, SURR_NEED,
      ...agencyMatch("Mexico"),
      ...clinicMatch,
      ...eggDonorMatch,
    );
    default: return [];
  }
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function createTestUser(testId: string, interestedServices: string[]): Promise<{ userId: string; cookie: string }> {
  const email = `test-${testId.toLowerCase()}-${Date.now()}@gostork-test.com`;
  const regRes = await fetch(`${BASE_URL}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, name: `Test ${testId}` }),
  });
  if (!regRes.ok) throw new Error(`Register failed: ${await regRes.text()}`);
  const user = await regRes.json();

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${await loginRes.text()}`);
  const loginBody = await loginRes.json();
  const jwtToken = loginBody?.token;
  const cookie = jwtToken ? `Bearer ${jwtToken}` : (loginRes.headers.get("set-cookie") || "");

  try {
    let parentAccountId = (await prisma.user.findUnique({
      where: { id: user.id }, select: { parentAccountId: true }
    }))?.parentAccountId;

    if (!parentAccountId) {
      const account = await prisma.parentAccount.create({ data: {} });
      parentAccountId = account.id;
      await prisma.user.update({ where: { id: user.id }, data: { parentAccountId } });
    }

    await prisma.intendedParentProfile.upsert({
      where: { parentAccountId },
      update: { interestedServices },
      create: { parentAccountId, interestedServices },
    });
  } catch (e: any) {
    // non-fatal, test still runs
  }

  return { userId: user.id, cookie };
}

async function deleteTestUser(userId: string): Promise<void> {
  try {
    await prisma.aiChatMessage.deleteMany({ where: { session: { userId } } });
    await prisma.aiChatSession.deleteMany({ where: { userId } });
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
    if (u?.parentAccountId) {
      await prisma.intendedParentProfile.deleteMany({ where: { parentAccountId: u.parentAccountId } });
      await (prisma as any).journeyPreferences?.deleteMany({ where: { parentAccountId: u.parentAccountId } }).catch(() => {});
      await prisma.parentAccount.delete({ where: { id: u.parentAccountId } }).catch(() => {});
    }
    await prisma.user.delete({ where: { id: userId } });
  } catch (e: any) {
    // best-effort cleanup
  }
}

async function sendMessage(cookie: string, message: string, sessionId: string | null): Promise<TurnResult> {
  const body: Record<string, unknown> = { message };
  if (sessionId) body.sessionId = sessionId;

  const authHeaders: Record<string, string> = cookie.startsWith("Bearer ")
    ? { Authorization: cookie }
    : { Cookie: cookie };

  const res = await fetch(`${BASE_URL}/api/ai-concierge/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Chat API ${res.status}: ${await res.text()}`);

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    let content = "", newSid: string | null = null, qr: string[] = [], hasCard = false;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const d = JSON.parse(line.slice(6));
        if (d.type === "token") content += d.delta;
        else if (d.type === "done") {
          newSid = d.sessionId || newSid;
          qr = d.quickReplies || [];
          hasCard = !!(d.matchCards?.length);
          if (d.message !== undefined && d.message !== null) content = d.message.content || "";
        }
      } catch {}
    }
    if (/\[\[MATCH_CARD:/i.test(content)) hasCard = true;
    return { content, quickReplies: qr, hasMatchCard: hasCard, sessionId: newSid };
  }
  const d = await res.json();
  return {
    content: d.message?.content || "",
    quickReplies: d.quickReplies || [],
    hasMatchCard: !!(d.matchCards?.length),
    sessionId: d.sessionId || null,
  };
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT: ${label}`)), ms)),
  ]);
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class TestRunnerService {
  private readonly logger = new Logger(TestRunnerService.name);
  private subscribers = new Set<(json: string) => void>();
  private state: RunnerState = {
    runId: "",
    startedAt: "",
    status: "idle",
    tests: {},
  };
  private abortController: AbortController | null = null;

  // ─── Subscription ──────────────────────────────────────────────────────────

  subscribe(cb: (json: string) => void): () => void {
    this.subscribers.add(cb);
    // Send current state immediately
    cb(JSON.stringify({ type: "state", state: this.state }));
    return () => this.subscribers.delete(cb);
  }

  private emit(event: SSEEvent): void {
    const json = JSON.stringify(event);
    this.subscribers.forEach(cb => {
      try { cb(json); } catch {}
    });
  }

  getState(): RunnerState {
    return this.state;
  }

  // ─── Run management ────────────────────────────────────────────────────────

  stopRun(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.state.status === "running") {
      this.state.status = "done";
      this.emit({ type: "state", state: this.state });
    }
  }

  clearResults(): void {
    this.state = {
      runId: "",
      startedAt: "",
      status: "idle",
      tests: {},
    };
    this.emit({ type: "state", state: this.state });
  }

  async startRun(filter?: string): Promise<void> {
    if (this.state.status === "running") {
      throw new Error("A run is already in progress");
    }

    const toRun = TEST_CASES.filter(tc => {
      if (!filter) return true;
      const f = filter.toLowerCase();
      return tc.id.toLowerCase() === f ||
        tc.persona.toLowerCase().includes(f) ||
        tc.persona.toLowerCase().replace(/-/g, " ").includes(f);
    });

    const runId = `run-${Date.now()}`;
    const tests: Record<string, TestProgress> = {};
    for (const tc of toRun) {
      tests[tc.id] = {
        id: tc.id,
        status: "pending",
        currentMessage: 0,
        totalMessages: tc.messageCount,
        errors: [],
        durationMs: 0,
      };
    }

    this.state = {
      runId,
      startedAt: new Date().toISOString(),
      status: "running",
      filter,
      tests,
    };

    this.emit({ type: "state", state: this.state });

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Run all tests in parallel, no await - fire and forget (async background)
    this.executeRun(toRun, signal, runId).catch(err => {
      this.logger.error(`Run ${runId} failed: ${err.message}`);
    });
  }

  private async executeRun(toRun: TestCaseDef[], signal: AbortSignal, runId: string): Promise<void> {
    const startedAt = Date.now();

    await Promise.all(toRun.map(async (tc) => {
      if (signal.aborted) return;
      await this.runSingleTest(tc, signal);
    }));

    if (signal.aborted) return;

    const passCount = Object.values(this.state.tests).filter(t => t.status === "pass").length;
    const failCount = Object.values(this.state.tests).filter(t => t.status === "fail").length;

    this.state.status = "done";
    this.emit({
      type: "run_done",
      passCount,
      failCount,
      durationMs: Date.now() - startedAt,
    });
    this.emit({ type: "state", state: this.state });
  }

  private async runSingleTest(tc: TestCaseDef, signal: AbortSignal): Promise<void> {
    const start = Date.now();
    const errors: string[] = [];
    let userId: string | undefined;

    this.state.tests[tc.id] = {
      ...this.state.tests[tc.id],
      status: "running",
      currentMessage: 0,
    };
    this.emit({ type: "test_start", id: tc.id });

    try {
      if (signal.aborted) return;
      const messages = getMessagesForId(tc.id);

      const { userId: uid, cookie } = await createTestUser(tc.id, tc.interestedServices);
      userId = uid;
      let sessionId: string | null = null;
      let msgIdx = 0;

      for (const step of messages) {
        if (signal.aborted) break;

        const turn: TurnResult = await withTimeout(
          sendMessage(cookie, step.send, sessionId),
          MSG_TIMEOUT_MS,
          `"${step.send.slice(0, 40)}"`,
        );
        if (turn.sessionId) sessionId = turn.sessionId;

        // Run assertions
        if (step.assert) {
          const lc = turn.content.toLowerCase();
          for (const req of step.assert.contains || []) {
            if (!lc.includes(req.toLowerCase())) {
              errors.push(`[${tc.id}] msg "${step.send.slice(0, 30)}": missing "${req}"`);
            }
          }
          for (const bad of step.assert.notContains || []) {
            if (lc.includes(bad.toLowerCase())) {
              errors.push(`[${tc.id}] msg "${step.send.slice(0, 30)}": MUST NOT contain "${bad}"`);
            }
          }
          if (step.assert.hasQR === true && turn.quickReplies.length === 0) {
            errors.push(`[${tc.id}] msg "${step.send.slice(0, 30)}": expected quick replies, got none`);
          }
          if (step.assert.hasMatchCard === true && !turn.hasMatchCard) {
            errors.push(`[${tc.id}] msg "${step.send.slice(0, 30)}": expected match card, got none`);
          }
        }

        msgIdx++;
        const progress = this.state.tests[tc.id];
        if (progress) {
          progress.currentMessage = msgIdx;
          progress.lastUserMsg = step.send.slice(0, 80);
          progress.lastAiSnippet = turn.content.slice(0, 100);
        }

        this.emit({
          type: "test_progress",
          id: tc.id,
          currentMessage: msgIdx,
          lastUserMsg: step.send.slice(0, 80),
          lastAiSnippet: turn.content.slice(0, 100),
        });

        await sleep(DELAY_BETWEEN_MSGS_MS);
      }
    } catch (e: any) {
      errors.push(`[${tc.id}] ERROR: ${e.message}`);
    } finally {
      if (userId) await deleteTestUser(userId);
    }

    const durationMs = Date.now() - start;
    const status: TestStatus = signal.aborted ? "skipped" : (errors.length === 0 ? "pass" : "fail");

    const progress = this.state.tests[tc.id];
    if (progress) {
      progress.status = status;
      progress.errors = errors;
      progress.durationMs = durationMs;
    }

    this.emit({
      type: "test_done",
      id: tc.id,
      status,
      durationMs,
      errors,
    });
  }
}
