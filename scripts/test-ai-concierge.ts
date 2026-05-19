/**
 * GoStork AI Concierge Automated Test Suite
 *
 * Tests all biological permutations for every parent persona.
 * Creates throwaway users per test, deletes them after.
 * Generates an HTML report at scripts/test-results/report-<timestamp>.html
 *
 * Usage:
 *   TEST_BASE_URL=http://localhost:5001 npx tsx scripts/test-ai-concierge.ts
 *
 * Requires the GoStork server to be running.
 */

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../server/db";

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5001";
const REPORT_DIR = path.join(__dirname, "test-results");
const TEST_PASSWORD = "TestPass123!";
const TIMEOUT_MS = 90_000; // 90s per message (Claude can be slow)
const ADMIN_EMAIL = "eran.amir@gostork.com";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || "";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MessageAssertion {
  /** Index of the AI message being asserted (0 = first AI response) */
  aiMsgIndex: number;
  contains?: string[];         // AI response must contain ALL of these
  notContains?: string[];      // AI response must NOT contain any of these
  hasQuickReplies?: boolean;   // must have at least one QR button
  hasMatchCard?: boolean;      // must have a [[MATCH_CARD]] or rendered card
  noQuickRepliesFor?: string[]; // none of these sperm/carrier options should appear
}

interface DBAssertion {
  field: string;
  expected: string | boolean | number | null;
}

interface TestMessage {
  send: string;               // message to send
  assertions?: MessageAssertion; // optional assertions on THIS ai response
}

interface TestCase {
  id: string;
  name: string;
  persona: string;
  description: string;
  /** Registered services the user signs up for */
  interestedServices: string[];
  /** Messages to send in order */
  messages: TestMessage[];
  /** DB field assertions after all messages complete */
  dbAssertions: DBAssertion[];
}

interface TestResult {
  testCase: TestCase;
  passed: boolean;
  errors: string[];
  transcript: { role: "user" | "ai"; content: string; assertions?: string[] }[];
  durationMs: number;
  userId?: string;
}

// ─── Test Case Definitions ────────────────────────────────────────────────────

const TEST_CASES: TestCase[] = [
  // ══════════════════════════════════════════════════════════
  // SOLO MAN
  // ══════════════════════════════════════════════════════════
  {
    id: "solo-man-own-sperm",
    name: "Solo Man - Own Sperm + Donor Egg + Surrogate",
    persona: "Solo Man",
    description: "Single man using his own sperm, donor egg, gestational surrogate",
    interestedServices: ["Surrogate", "Egg Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Solo man", assertions: { aiMsgIndex: 0, notContains: ["who will carry", "Are you hoping to carry"] } },
      { send: "No, I'm not LGBTQ+" },
      { send: "I need help finding a clinic" },
      { send: "No, I don't have frozen embryos" },
      {
        send: "I need help finding an egg donor",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["sperm source", "will you be using your own sperm", "your partner's"],
        },
      },
      { send: "My own" }, // sperm source
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      {
        send: "Yes, I'm ready!",
        assertions: { aiMsgIndex: 0, hasMatchCard: true },
      },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "My sperm" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Gestational surrogate" },
      { field: "needsSurrogate", expected: true },
      { field: "needsEggDonor", expected: true },
    ],
  },
  {
    id: "solo-man-donor-sperm",
    name: "Solo Man - Donor Sperm + Donor Egg + Surrogate (Embryo Donation)",
    persona: "Solo Man",
    description: "Embryo donation - both sperm and egg from donors, gestational surrogate",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Solo man" },
      { send: "No, I'm not LGBTQ+" },
      { send: "I need help finding a clinic" },
      { send: "No, I don't have frozen embryos" },
      { send: "I need help finding an egg donor" },
      { send: "Donor sperm" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Gestational surrogate" },
    ],
  },

  // ══════════════════════════════════════════════════════════
  // SOLO WOMAN
  // ══════════════════════════════════════════════════════════
  {
    id: "solo-woman-self-carry-own-eggs",
    name: "Solo Woman - Self Carry + Own Eggs + Sperm Donor",
    persona: "Solo Woman",
    description: "Single woman carrying herself, using her own eggs and donor sperm",
    interestedServices: ["Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      {
        send: "Solo woman",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["will you be using your own sperm", "sperm donor or your own", "for sperm"],
        },
      },
      { send: "No, I'm not LGBTQ+" },
      { send: "I already have a fertility clinic" },
      { send: "IVF Clinic Test" },
      { send: "No, I don't have frozen embryos" },
      {
        send: "I'll be using my own eggs",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["will you be using your own sperm", "for sperm", "sperm donor"],
        },
      },
      // Sperm question should be SKIPPED - next should be about carrier or sperm donor help
      { send: "I'll carry the pregnancy myself" },
      { send: "I need help finding a sperm donor" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "My eggs" },
      { field: "carrier", expected: "Me" },
    ],
  },
  {
    id: "solo-woman-self-carry-donor-eggs",
    name: "Solo Woman - Self Carry + Donor Eggs + Sperm Donor",
    persona: "Solo Woman",
    description: "Single woman carrying herself, using donor eggs and donor sperm (embryo donation)",
    interestedServices: ["Egg Donor", "Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Solo woman" },
      { send: "No, I'm not LGBTQ+" },
      { send: "I already have a fertility clinic" },
      { send: "IVF Clinic Test" },
      { send: "No, I don't have frozen embryos" },
      {
        send: "I need help finding an egg donor",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["will you be using your own sperm", "for sperm"],
        },
      },
      { send: "I'll carry the pregnancy myself" },
      { send: "I need help finding a sperm donor" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Me" },
    ],
  },
  {
    id: "solo-woman-surrogate-own-eggs",
    name: "Solo Woman - Surrogate + Own Eggs + Sperm Donor",
    persona: "Solo Woman",
    description: "Single woman using surrogate, her own eggs, and donor sperm",
    interestedServices: ["Surrogate", "Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Solo woman" },
      { send: "No, I'm not LGBTQ+" },
      { send: "I already have a fertility clinic" },
      { send: "IVF Clinic Test" },
      { send: "No, I don't have frozen embryos" },
      {
        send: "I'll be using my own eggs",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["will you be using your own sperm", "for sperm"],
        },
      },
      { send: "A gestational surrogate will carry the pregnancy" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "My eggs" },
      { field: "carrier", expected: "Gestational surrogate" },
      { field: "needsSurrogate", expected: true },
    ],
  },
  {
    id: "solo-woman-surrogate-donor-eggs",
    name: "Solo Woman - Surrogate + Donor Eggs + Sperm Donor",
    persona: "Solo Woman",
    description: "Single woman using surrogate, donor eggs, and donor sperm",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Solo woman" },
      { send: "No, I'm not LGBTQ+" },
      { send: "I already have a fertility clinic" },
      { send: "IVF Clinic Test" },
      { send: "No, I don't have frozen embryos" },
      {
        send: "I need help finding an egg donor",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["will you be using your own sperm", "for sperm"],
        },
      },
      { send: "A gestational surrogate will carry the pregnancy" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Gestational surrogate" },
    ],
  },

  // ══════════════════════════════════════════════════════════
  // MAN & WOMAN COUPLE
  // ══════════════════════════════════════════════════════════
  {
    id: "mw-couple-female-carries-own-eggs-own-sperm",
    name: "Man & Woman - Female Carries + Her Eggs + His Sperm",
    persona: "Man & Woman Couple",
    description: "Opposite-sex couple, female partner carries, uses her eggs and his sperm",
    interestedServices: [],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "A woman and a man" },
      { send: "No, we're not LGBTQ+" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "Her own eggs" },
      { send: "His own" },
      { send: "She will carry the pregnancy" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "My partner's sperm" },
      { field: "eggSource", expected: "My eggs" },
      { field: "carrier", expected: "Me" },
    ],
  },
  {
    id: "mw-couple-female-carries-donor-eggs-own-sperm",
    name: "Man & Woman - Female Carries + Donor Eggs + His Sperm",
    persona: "Man & Woman Couple",
    description: "Opposite-sex couple, female carries, donor eggs, his sperm",
    interestedServices: ["Egg Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "A woman and a man" },
      { send: "No, we're not LGBTQ+" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "I need help finding an egg donor" },
      { send: "His own" },
      { send: "She will carry the pregnancy" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "My partner's sperm" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Me" },
    ],
  },
  {
    id: "mw-couple-female-carries-own-eggs-donor-sperm",
    name: "Man & Woman - Female Carries + Her Eggs + Donor Sperm",
    persona: "Man & Woman Couple",
    description: "Opposite-sex couple, female carries, her own eggs, donor sperm",
    interestedServices: ["Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "A woman and a man" },
      { send: "No, we're not LGBTQ+" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "Her own eggs" },
      { send: "Donor sperm" },
      { send: "She will carry the pregnancy" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "My eggs" },
      { field: "carrier", expected: "Me" },
    ],
  },
  {
    id: "mw-couple-surrogate-own-eggs-own-sperm",
    name: "Man & Woman - Surrogate + Her Eggs + His Sperm",
    persona: "Man & Woman Couple",
    description: "Opposite-sex couple using surrogate with their own genetics",
    interestedServices: ["Surrogate"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "A woman and a man" },
      { send: "No, we're not LGBTQ+" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "Her own eggs" },
      { send: "His own" },
      { send: "A gestational surrogate will carry the pregnancy" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "My partner's sperm" },
      { field: "eggSource", expected: "My eggs" },
      { field: "carrier", expected: "Gestational surrogate" },
      { field: "needsSurrogate", expected: true },
    ],
  },
  {
    id: "mw-couple-surrogate-donor-eggs-donor-sperm",
    name: "Man & Woman - Surrogate + Donor Eggs + Donor Sperm",
    persona: "Man & Woman Couple",
    description: "Opposite-sex couple using surrogate and full embryo donation",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "A woman and a man" },
      { send: "No, we're not LGBTQ+" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "I need help finding an egg donor" },
      { send: "Donor sperm" },
      { send: "A gestational surrogate will carry the pregnancy" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Gestational surrogate" },
    ],
  },

  // ══════════════════════════════════════════════════════════
  // TWO DADS
  // ══════════════════════════════════════════════════════════
  {
    id: "two-dads-own-sperm",
    name: "Two Dads - Donor Egg + His Own Sperm + Surrogate",
    persona: "Two Dads",
    description: "Gay male couple, one partner's sperm, donor egg, gestational surrogate",
    interestedServices: ["Surrogate", "Egg Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Two dads" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      {
        send: "I need help finding an egg donor",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["will you be using your own eggs", "egg source"],
        },
      },
      { send: "My own" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "My sperm" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Gestational surrogate" },
    ],
  },
  {
    id: "two-dads-partner-sperm",
    name: "Two Dads - Donor Egg + Partner Sperm + Surrogate",
    persona: "Two Dads",
    description: "Gay male couple, partner's sperm, donor egg, gestational surrogate",
    interestedServices: ["Surrogate", "Egg Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Two dads" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "I need help finding an egg donor" },
      { send: "My partner's" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "My partner's sperm" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Gestational surrogate" },
    ],
  },
  {
    id: "two-dads-donor-sperm",
    name: "Two Dads - Donor Egg + Donor Sperm + Surrogate (Embryo Donation)",
    persona: "Two Dads",
    description: "Gay male couple, full embryo donation, gestational surrogate",
    interestedServices: ["Surrogate", "Egg Donor", "Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Two dads" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "I need help finding an egg donor" },
      { send: "Donor sperm" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "Egg donor" },
      { field: "carrier", expected: "Gestational surrogate" },
    ],
  },

  // ══════════════════════════════════════════════════════════
  // TWO MOMS (representative - one direction)
  // ══════════════════════════════════════════════════════════
  {
    id: "two-moms-partner-a-carries-own-eggs",
    name: "Two Moms - Partner A Carries + Her Own Eggs + Donor Sperm",
    persona: "Two Moms",
    description: "Lesbian couple, Partner A carries using her own eggs and donor sperm",
    interestedServices: ["Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      {
        send: "Two moms",
        assertions: {
          aiMsgIndex: 0,
          notContains: ["will you be using your own sperm", "for sperm", "sperm donor or your own"],
        },
      },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "Her own eggs" },
      { send: "She will carry the pregnancy" },
      { send: "I need help finding a sperm donor" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "My eggs" },
      { field: "carrier", expected: "Me" },
      { field: "isLGBTQ", expected: true },
    ],
  },
  {
    id: "two-moms-reciprocal-ivf",
    name: "Two Moms - Reciprocal IVF (Partner A Carries + Partner B Eggs + Donor Sperm)",
    persona: "Two Moms",
    description: "Lesbian couple, reciprocal IVF - Partner A carries, Partner B provides eggs",
    interestedServices: ["Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Two moms" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "My partner's eggs" },
      { send: "She will carry the pregnancy" },
      { send: "I need help finding a sperm donor" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "My partner's eggs" },
      { field: "carrier", expected: "Me" },
    ],
  },
  {
    id: "two-moms-surrogate",
    name: "Two Moms - Surrogate + Partner A Eggs + Donor Sperm",
    persona: "Two Moms",
    description: "Lesbian couple using surrogate with one partner's eggs and donor sperm",
    interestedServices: ["Surrogate", "Sperm Donor"],
    messages: [
      { send: "Yes, that's right" },
      { send: "Yes, makes sense!" },
      { send: "I understand, let's get started" },
      { send: "Two moms" },
      { send: "I need help finding a clinic" },
      { send: "No, we don't have frozen embryos" },
      { send: "Her own eggs" },
      { send: "A gestational surrogate will carry the pregnancy" },
      { send: "I need help finding a surrogate" },
      { send: "USA" },
      { send: "Pro-choice surrogate" },
      { send: "Singleton only" },
      { send: "Yes, I'm ready!", assertions: { aiMsgIndex: 0, hasMatchCard: true } },
    ],
    dbAssertions: [
      { field: "spermSource", expected: "Sperm donor" },
      { field: "eggSource", expected: "My eggs" },
      { field: "carrier", expected: "Gestational surrogate" },
      { field: "needsSurrogate", expected: true },
    ],
  },
];

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

async function createTestUser(testId: string): Promise<{ userId: string; cookie: string }> {
  const email = `test-${testId}-${Date.now()}@gostork-test.com`;
  const name = `Test ${testId}`;

  // Register
  const regRes = await fetch(`${BASE_URL}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD, name }),
  });
  if (!regRes.ok) {
    throw new Error(`Failed to register user: ${await regRes.text()}`);
  }
  const user = await regRes.json();

  // Login
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`Failed to login: ${await loginRes.text()}`);

  const cookie = loginRes.headers.get("set-cookie") || "";
  return { userId: user.id, cookie };
}

async function deleteTestUser(userId: string): Promise<void> {
  try {
    // Delete all related data then the user via Prisma directly
    await prisma.aiChatMessage.deleteMany({ where: { session: { userId } } });
    await prisma.aiChatSession.deleteMany({ where: { userId } });
    const account = await prisma.user.findUnique({ where: { id: userId }, select: { parentAccountId: true } });
    if (account?.parentAccountId) {
      await prisma.intendedParentProfile.deleteMany({ where: { parentAccountId: account.parentAccountId } });
      await prisma.parentAccount.deleteMany({ where: { id: account.parentAccountId } });
    }
    await prisma.user.delete({ where: { id: userId } });
  } catch (e: any) {
    console.warn(`  [CLEANUP] Failed to delete user ${userId}: ${e.message}`);
  }
}

async function sendChatMessage(cookie: string, message: string, sessionId: string | null): Promise<{
  content: string;
  newSessionId: string | null;
  quickReplies: string[];
  hasMatchCard: boolean;
}> {
  const body: any = { message };
  if (sessionId) body.sessionId = sessionId;

  const response = await fetch(`${BASE_URL}/api/ai-concierge/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Chat API error ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers.get("content-type") || "";

  // Handle SSE streaming
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const lines = text.split("\n");
    let fullContent = "";
    let newSessionId: string | null = null;
    let quickReplies: string[] = [];
    let hasMatchCard = false;

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "token") {
          fullContent += data.delta;
        } else if (data.type === "done") {
          if (data.sessionId) newSessionId = data.sessionId;
          if (data.quickReplies) quickReplies = data.quickReplies;
          if (data.matchCards && data.matchCards.length > 0) hasMatchCard = true;
          if (data.message?.content) {
            fullContent = data.message.content;
          }
        }
      } catch {}
    }

    // Also check content for match card tags
    if (/\[\[MATCH_CARD:/i.test(fullContent)) hasMatchCard = true;

    return { content: fullContent, newSessionId, quickReplies, hasMatchCard };
  }

  // JSON response
  const data = await response.json();
  return {
    content: data.message?.content || data.content || "",
    newSessionId: data.sessionId || null,
    quickReplies: data.quickReplies || [],
    hasMatchCard: !!(data.matchCards?.length),
  };
}

async function getProfileFromDB(userId: string): Promise<Record<string, any> | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { parentAccountId: true },
  });
  if (!user?.parentAccountId) return null;

  const profile = await prisma.intendedParentProfile.findUnique({
    where: { parentAccountId: user.parentAccountId },
  });
  return profile as any;
}

// ─── Test Runner ──────────────────────────────────────────────────────────────

async function runTestCase(tc: TestCase): Promise<TestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const transcript: TestResult["transcript"] = [];
  let userId: string | undefined;
  let aiMsgCount = 0;

  try {
    // 1. Create user
    const { userId: uid, cookie } = await createTestUser(tc.id);
    userId = uid;

    // 2. Run conversation
    let sessionId: string | null = null;

    for (let i = 0; i < tc.messages.length; i++) {
      const step = tc.messages[i];

      transcript.push({ role: "user", content: step.send });

      const result = await withTimeout(
        sendChatMessage(cookie, step.send, sessionId),
        TIMEOUT_MS,
        `Message "${step.send}" timed out after ${TIMEOUT_MS / 1000}s`
      );

      if (result.newSessionId) sessionId = result.newSessionId;

      const assertionNotes: string[] = [];

      // Run assertions if specified
      if (step.assertions && step.assertions.aiMsgIndex === 0) {
        const content = result.content.toLowerCase();

        // Check contains
        for (const required of step.assertions.contains || []) {
          if (!content.includes(required.toLowerCase())) {
            errors.push(`[${tc.id}] Msg #${i} "${step.send}": response missing required text "${required}"`);
            assertionNotes.push(`FAIL: missing "${required}"`);
          } else {
            assertionNotes.push(`PASS: contains "${required}"`);
          }
        }

        // Check not contains
        for (const forbidden of step.assertions.notContains || []) {
          if (content.includes(forbidden.toLowerCase())) {
            errors.push(`[${tc.id}] Msg #${i} "${step.send}": response should NOT contain "${forbidden}"`);
            assertionNotes.push(`FAIL: contains forbidden "${forbidden}"`);
          } else {
            assertionNotes.push(`PASS: not contains "${forbidden}"`);
          }
        }

        // Check QR buttons
        if (step.assertions.hasQuickReplies === true && result.quickReplies.length === 0) {
          errors.push(`[${tc.id}] Msg #${i} "${step.send}": expected quick reply buttons but got none`);
          assertionNotes.push(`FAIL: no quick reply buttons`);
        }
        if (step.assertions.hasQuickReplies !== false && result.quickReplies.length > 0) {
          assertionNotes.push(`PASS: has QR buttons: [${result.quickReplies.join(", ")}]`);
        }

        // Check match card
        if (step.assertions.hasMatchCard === true && !result.hasMatchCard) {
          errors.push(`[${tc.id}] Msg #${i} "${step.send}": expected a match card but none appeared`);
          assertionNotes.push(`FAIL: no match card`);
        }
        if (step.assertions.hasMatchCard === true && result.hasMatchCard) {
          assertionNotes.push(`PASS: match card rendered`);
        }
      }

      transcript.push({
        role: "ai",
        content: result.content,
        assertions: assertionNotes.length > 0 ? assertionNotes : undefined,
      });

      aiMsgCount++;

      // Small delay between messages to avoid overwhelming the server
      await sleep(500);
    }

    // 3. DB assertions
    const profile = await getProfileFromDB(userId);
    for (const dbA of tc.dbAssertions) {
      const actual = profile?.[dbA.field];
      const matches = typeof dbA.expected === "boolean"
        ? actual === dbA.expected
        : typeof dbA.expected === "number"
          ? Number(actual) === dbA.expected
          : dbA.expected === null
            ? actual == null
            : String(actual || "").toLowerCase().includes(String(dbA.expected).toLowerCase());

      if (!matches) {
        errors.push(`[${tc.id}] DB field "${dbA.field}": expected "${dbA.expected}" but got "${actual}"`);
      }
    }

  } catch (e: any) {
    errors.push(`[${tc.id}] Unexpected error: ${e.message}`);
  } finally {
    // 4. Cleanup
    if (userId) await deleteTestUser(userId);
  }

  return {
    testCase: tc,
    passed: errors.length === 0,
    errors,
    transcript,
    durationMs: Date.now() - startTime,
    userId,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// ─── HTML Report Generator ────────────────────────────────────────────────────

function generateHtmlReport(results: TestResult[]): string {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);

  const rows = results.map(r => {
    const statusBg = r.passed ? "#d4edda" : "#f8d7da";
    const statusColor = r.passed ? "#155724" : "#721c24";
    const statusText = r.passed ? "PASS" : "FAIL";

    const transcriptHtml = r.transcript.map(msg => {
      const isUser = msg.role === "user";
      const bg = isUser ? "#e3f2fd" : "#f5f5f5";
      const label = isUser ? "Parent" : "AI";
      const assertionsHtml = msg.assertions
        ? `<div style="margin-top:4px;font-size:11px">${msg.assertions.map(a => {
            const ok = a.startsWith("PASS");
            return `<span style="color:${ok ? "#155724" : "#721c24"};background:${ok ? "#d4edda" : "#f8d7da"};padding:1px 4px;border-radius:3px;margin:1px;display:inline-block">${a}</span>`;
          }).join(" ")}</div>`
        : "";

      return `<div style="margin:4px 0;padding:8px;background:${bg};border-radius:6px">
        <strong style="font-size:11px;color:#666">${label}</strong>
        <div style="margin-top:2px;font-size:13px;white-space:pre-wrap">${escHtml(msg.content.slice(0, 500))}${msg.content.length > 500 ? "…" : ""}</div>
        ${assertionsHtml}
      </div>`;
    }).join("");

    const errorsHtml = r.errors.length > 0
      ? `<div style="margin-top:8px">${r.errors.map(e => `<div style="color:#721c24;font-size:12px;padding:3px 0">⚠ ${escHtml(e)}</div>`).join("")}</div>`
      : "";

    return `
      <div style="border:1px solid #ddd;border-radius:8px;margin-bottom:16px;overflow:hidden">
        <div style="background:${statusBg};padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <span style="font-weight:bold;color:${statusColor}">[${statusText}]</span>
            <span style="font-size:15px;font-weight:600;margin-left:8px">${escHtml(r.testCase.name)}</span>
            <div style="font-size:12px;color:#666;margin-top:2px">${escHtml(r.testCase.description)}</div>
          </div>
          <div style="text-align:right;font-size:12px;color:#666">
            <div><strong>Persona:</strong> ${escHtml(r.testCase.persona)}</div>
            <div><strong>Duration:</strong> ${(r.durationMs / 1000).toFixed(1)}s</div>
            <div><strong>Messages:</strong> ${r.testCase.messages.length}</div>
          </div>
        </div>
        ${errorsHtml ? `<div style="padding:8px 16px;background:#fff3cd">${errorsHtml}</div>` : ""}
        <details style="padding:0 16px 12px">
          <summary style="cursor:pointer;padding:8px 0;font-size:13px;color:#444">View conversation transcript</summary>
          <div style="margin-top:8px">${transcriptHtml}</div>
        </details>
      </div>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>GoStork AI Concierge Test Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1000px; margin: 0 auto; padding: 24px; background: #fafafa; }
    h1 { color: #1a472a; }
    .summary { display:flex;gap:16px;margin:16px 0;flex-wrap:wrap; }
    .stat { background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 20px;text-align:center; }
    .stat-num { font-size:32px;font-weight:bold; }
    .stat-label { font-size:12px;color:#666;margin-top:2px; }
  </style>
</head>
<body>
  <h1>GoStork AI Concierge Test Report</h1>
  <div style="color:#666;font-size:13px">Generated: ${new Date().toLocaleString()}</div>
  <div class="summary">
    <div class="stat"><div class="stat-num" style="color:#155724">${passed}</div><div class="stat-label">Passed</div></div>
    <div class="stat"><div class="stat-num" style="color:#721c24">${failed}</div><div class="stat-label">Failed</div></div>
    <div class="stat"><div class="stat-num">${results.length}</div><div class="stat-label">Total</div></div>
    <div class="stat"><div class="stat-num">${(totalMs / 1000 / 60).toFixed(1)}m</div><div class="stat-label">Total Time</div></div>
    <div class="stat"><div class="stat-num" style="color:${failed === 0 ? "#155724" : "#721c24"}">${Math.round((passed / results.length) * 100)}%</div><div class="stat-label">Pass Rate</div></div>
  </div>
  ${rows}
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🧪 GoStork AI Concierge Test Suite`);
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   Test cases: ${TEST_CASES.length}`);
  console.log(`   Running in parallel...\n`);

  // Verify server is up
  try {
    const ping = await fetch(`${BASE_URL}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "x", password: "x" }) });
    if (ping.status === 0) throw new Error("no response");
  } catch {
    console.error(`❌ Cannot reach server at ${BASE_URL}. Is it running?`);
    process.exit(1);
  }

  // Run all tests in parallel
  const startTime = Date.now();
  const results = await Promise.all(TEST_CASES.map(tc => {
    console.log(`  ▶ Starting: ${tc.id}`);
    return runTestCase(tc).then(result => {
      const icon = result.passed ? "✅" : "❌";
      console.log(`  ${icon} ${result.passed ? "PASS" : "FAIL"}: ${tc.id} (${(result.durationMs / 1000).toFixed(1)}s)`);
      if (!result.passed) {
        result.errors.forEach(e => console.log(`     ${e}`));
      }
      return result;
    });
  }));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${totalSec}s total)`);

  // Generate HTML report
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
  fs.writeFileSync(reportPath, generateHtmlReport(results));
  console.log(`\n📄 HTML report: ${reportPath}`);
  console.log(`   Open with: open "${reportPath}"\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
