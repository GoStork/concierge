/**
 * Intended Parent Form API.
 *
 * Surrogacy agencies require intended parents to complete a profile form
 * before a match call. Parents fill it at /ip-form (both partners in
 * parallel), sign natively (drawn/typed), and submit once per parent
 * account. Connected surrogacy agencies download a PDF branded with THEIR
 * logo in two variants: full (agency records) and surrogate (private
 * section + contact/ID data stripped).
 *
 * Endpoint groups:
 *   Parent  - template+response, batched autosave, sign, invite parent 2,
 *             submit.
 *   Guest   - tokenized access for a second parent without an account
 *             (precedent: agreements guest signing). Slot-2 write scope only.
 *   Provider- list submitted forms for connected parents, download PDFs.
 *   Admin   - template CRUD + reorder (soft-delete only; keys are stable).
 */
import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "./db";
import { emitJourneyEvent } from "./journey-events";
import { maritalImpliesTwoParents } from "./ip-form-defaults";

export const ipFormRouter = Router();

const GUEST_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// JWT Bearer fallback (mobile clients + test scripts) - same contract as
// reviewsRouter's middleware; Passport session auth still takes precedence.
ipFormRouter.use(async (req: any, _res: any, next: any) => {
  if (!req.isAuthenticated?.()) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const secret = process.env.JWT_SECRET || "dev-jwt-secret-change-me";
        const payload = jwt.verify(token, secret) as any;
        if (payload?.sub) {
          const user = await prisma.user.findUnique({ where: { id: payload.sub } });
          if (user && !user.isDisabled) {
            req.user = user;
            req.isAuthenticated = () => true;
          }
        }
      } catch { /* invalid token - continue unauthenticated */ }
    }
  }
  next();
});

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!(req as any).isAuthenticated?.() || !(req as any).user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

function rolesOf(user: any): string[] {
  return user?.roles || [];
}
function isAdmin(user: any): boolean {
  const r = rolesOf(user);
  return r.includes("GOSTORK_ADMIN") || r.includes("GOSTORK_CONCIERGE");
}
function isProviderUser(user: any): boolean {
  return !!user?.providerId;
}

/** Slot for a logged-in parent: IP2 members sign slot 2, everyone else slot 1. VIEWER gets null (read-only). */
function slotOf(user: any): 1 | 2 | null {
  if (user?.parentAccountRole === "VIEWER") return null;
  return user?.parentAccountRole === "INTENDED_PARENT_2" ? 2 : 1;
}

async function accountOf(userId: string): Promise<{ accountId: string; memberIds: string[] }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, parentAccountId: true } });
  const accountId = u?.parentAccountId || userId;
  const memberIds = u?.parentAccountId
    ? (await prisma.user.findMany({ where: { parentAccountId: u.parentAccountId }, select: { id: true } })).map((m) => m.id)
    : [userId];
  return { accountId, memberIds };
}

/** Active template, ordered, questions nested. */
export async function loadIpFormTemplate(includeInactive = false) {
  const where = includeInactive ? {} : { isActive: true };
  const sections = await prisma.ipFormSection.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    include: {
      questions: {
        where: includeInactive ? {} : { isActive: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  return sections;
}

async function getOrCreateResponse(accountId: string) {
  let response = await prisma.ipFormResponse.findUnique({ where: { parentAccountId: accountId } });
  if (!response) {
    response = await prisma.ipFormResponse.create({ data: { parentAccountId: accountId } }).catch(async () =>
      // Concurrent first-load race: the partner's tab created it first.
      prisma.ipFormResponse.findUnique({ where: { parentAccountId: accountId } }),
    ) as any;
  }
  return response!;
}

async function loadResponseBundle(responseId: string) {
  const [answers, signatures] = await Promise.all([
    prisma.ipFormAnswer.findMany({ where: { responseId } }),
    prisma.ipFormSignature.findMany({ where: { responseId }, orderBy: { parentSlot: "asc" } }),
  ]);
  return { answers, signatures };
}

/**
 * Re-derive hasSecondParent from IP1's marital status, unless the parent
 * manually overrode it via the escape hatch. Returns the up-to-date response
 * (persisting a change only when the derived value actually differs). This is
 * why parents don't have to answer a separate "are there two of you?"
 * question - their relationship status already answers it.
 */
async function reconcileHasSecondParent(response: any): Promise<any> {
  if (response.hasSecondParentManual) return response;
  const maritalQ = await prisma.ipFormQuestion.findUnique({ where: { key: "ip_marital_status" }, select: { id: true } });
  if (!maritalQ) return response;
  // Marital status is a SHARED answer (slot 0), describing the couple.
  const ans = await prisma.ipFormAnswer.findUnique({
    where: { responseId_questionId_parentSlot: { responseId: response.id, questionId: maritalQ.id, parentSlot: 0 } },
    select: { value: true },
  });
  const derived = maritalImpliesTwoParents(ans?.value);
  if (derived === response.hasSecondParent) return response;
  return prisma.ipFormResponse.update({ where: { id: response.id }, data: { hasSecondParent: derived } });
}

/**
 * Which slots a question applies to. Shared questions -> [0];
 * per-parent (via section or question flag) -> [1] or [1, 2].
 */
function slotsFor(section: { perParent: boolean }, question: { perParent: boolean }, hasSecondParent: boolean): number[] {
  if (section.perParent || question.perParent) return hasSecondParent ? [1, 2] : [1];
  return [0];
}

function answerKey(questionId: string, slot: number | null | undefined): string {
  return `${questionId}:${slot || 0}`;
}

function normalizedAnswer(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  return String(value).trim().toLowerCase();
}

function answerIsEmpty(value: any): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.values(value).every((v) => v == null || String(v).trim() === "");
  return false;
}

/**
 * Visible+required questions that are missing answers. Conditional
 * follow-ups only count when their trigger matches; per-parent conditionals
 * follow the same slot as the follow-up, shared parents use the shared slot.
 */
export function findMissingRequired(
  sections: any[],
  answers: { questionId: string; parentSlot: number; value: any }[],
  hasSecondParent: boolean,
): { questionId: string; key: string; label: string; sectionKey: string; parentSlot: number }[] {
  const byId = new Map<string, any>();
  for (const s of sections) for (const q of s.questions) byId.set(q.id, q);
  const answerMap = new Map<string, any>();
  for (const a of answers) answerMap.set(answerKey(a.questionId, a.parentSlot), a.value);

  const missing: { questionId: string; key: string; label: string; sectionKey: string; parentSlot: number }[] = [];
  for (const s of sections) {
    // "I don't have a fertility clinic yet" waives the clinic section's
    // required fields.
    if (s.key === "clinic") {
      const noneQ = s.questions.find((q: any) => q.key === "clinic_none");
      if (noneQ && normalizedAnswer(answerMap.get(answerKey(noneQ.id, 0))) === "yes") continue;
    }
    for (const q of s.questions) {
      if (!q.isActive || !q.required) continue;
      for (const slot of slotsFor(s, q, hasSecondParent)) {
        if (q.conditionalOnQuestionId) {
          const parentQ = byId.get(q.conditionalOnQuestionId);
          const parentSlot = parentQ && (s.perParent || parentQ.perParent) ? slot : 0;
          const parentVal = answerMap.get(answerKey(q.conditionalOnQuestionId, parentSlot));
          if (normalizedAnswer(parentVal) !== normalizedAnswer(q.conditionalTriggerValue)) continue;
        }
        const val = answerMap.get(answerKey(q.id, slot));
        if (answerIsEmpty(val)) {
          missing.push({ questionId: q.id, key: q.key, label: q.label, sectionKey: s.key, parentSlot: slot });
        }
      }
    }
  }
  return missing;
}

/** Provider is connected to this parent account via a chat session or booking. */
async function providerConnectedToAccount(providerId: string, memberIds: string[]): Promise<boolean> {
  const session = await prisma.aiChatSession.findFirst({
    where: { userId: { in: memberIds }, providerId },
    select: { id: true },
  });
  if (session) return true;
  const booking = await prisma.booking.findFirst({
    where: { parentUserId: { in: memberIds }, providerUser: { providerId } },
    select: { id: true },
  });
  return !!booking;
}

/** Provider has an APPROVED surrogacy service (same heuristic as classifyJourneyType). */
async function providerHasSurrogacyService(providerId: string): Promise<boolean> {
  const services = await prisma.providerService.findMany({
    where: { providerId, status: "APPROVED" },
    include: { providerType: { select: { name: true } } },
  });
  return services.some((s) => (s.providerType?.name || "").toLowerCase().includes("surrogacy"));
}

/**
 * Program types a provider represents for the IP form, from its APPROVED
 * service types: "surrogacy" (surrogacy agency) and/or "ivf" (IVF/fertility
 * clinic). Drives which template sections apply. A form-collecting provider
 * with no recognized program type still gets the core sections.
 */
async function providerProgramTypes(providerId: string): Promise<string[]> {
  const services = await prisma.providerService.findMany({
    where: { providerId, status: "APPROVED" },
    include: { providerType: { select: { name: true } } },
  });
  const types = new Set<string>();
  for (const s of services) {
    const name = (s.providerType?.name || "").toLowerCase();
    if (name.includes("surrogacy")) types.add("surrogacy");
    if (name.includes("ivf") || name.includes("clinic")) types.add("ivf");
  }
  return [...types];
}

/**
 * Union of program types across every provider the account has consulted that
 * collects the IP form. Determines which sections the parent fills. Falls back
 * to ["surrogacy"] when the account was prompted but no connected provider is
 * currently flagged (legacy data / pre-toggle prompts), so existing surrogacy
 * parents keep seeing the full form.
 */
async function accountProgramTypes(memberIds: string[]): Promise<string[]> {
  const [sessions, bookings] = await Promise.all([
    prisma.aiChatSession.findMany({ where: { userId: { in: memberIds }, providerId: { not: null } }, select: { providerId: true } }),
    prisma.booking.findMany({ where: { parentUserId: { in: memberIds } }, select: { providerUser: { select: { providerId: true } } } }),
  ]);
  const providerIds = new Set<string>();
  for (const s of sessions) if (s.providerId) providerIds.add(s.providerId);
  for (const b of bookings) if (b.providerUser?.providerId) providerIds.add(b.providerUser.providerId);
  if (!providerIds.size) return ["surrogacy"];
  const collecting = await prisma.provider.findMany({
    where: { id: { in: [...providerIds] }, collectsIntendedParentForm: true },
    select: { id: true },
  });
  const types = new Set<string>();
  for (const p of collecting) for (const t of await providerProgramTypes(p.id)) types.add(t);
  return types.size ? [...types] : ["surrogacy"];
}

/** A section is shown to a parent when it's core (no appliesTo) or its tags intersect the account's program types. */
function sectionAppliesToPrograms(section: { appliesTo?: string[] | null }, programTypes: string[]): boolean {
  const tags = section.appliesTo || [];
  if (!tags.length) return true; // core
  return tags.some((t) => programTypes.includes(t));
}

/** Whether any connected provider requires an ID photocopy. */
async function accountRequiresIdPhotocopy(memberIds: string[]): Promise<boolean> {
  const [sessions, bookings] = await Promise.all([
    prisma.aiChatSession.findMany({ where: { userId: { in: memberIds }, providerId: { not: null } }, select: { providerId: true } }),
    prisma.booking.findMany({ where: { parentUserId: { in: memberIds } }, select: { providerUser: { select: { providerId: true } } } }),
  ]);
  const providerIds = new Set<string>();
  for (const s of sessions) if (s.providerId) providerIds.add(s.providerId);
  for (const b of bookings) if (b.providerUser?.providerId) providerIds.add(b.providerUser.providerId);
  if (!providerIds.size) return false;
  const req = await prisma.provider.findFirst({
    where: { id: { in: [...providerIds] }, collectsIntendedParentForm: true, requiresIdPhotocopy: true },
    select: { id: true },
  });
  return !!req;
}

/** Full legal names from answers (fallback: account member names). */
function parentNamesFrom(answers: { questionId: string; parentSlot: number | null; value: any }[], questions: any[], fallback: string[]): string[] {
  const nameQ = questions.find((q) => q.key === "ip_full_legal_name");
  if (!nameQ) return fallback;
  const names: string[] = [];
  for (const slot of [1, 2]) {
    const a = answers.find((x) => x.questionId === nameQ.id && x.parentSlot === slot);
    if (a && typeof a.value === "string" && a.value.trim()) names.push(a.value.trim());
  }
  return names.length ? names : fallback;
}

// Tiny in-memory throttle for the unauthenticated guest routes (per token+IP).
const guestHits = new Map<string, { count: number; resetAt: number }>();
function guestThrottle(req: Request, res: Response, next: () => void) {
  const key = `${String(req.params.token || "")}:${req.ip}`;
  const now = Date.now();
  const entry = guestHits.get(key);
  if (!entry || entry.resetAt < now) {
    guestHits.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > 60) return res.status(429).json({ message: "Too many requests" });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of guestHits) if (v.resetAt < now) guestHits.delete(k);
}, 300_000).unref();

async function validGuestToken(token: string) {
  if (!token || token.length < 32) return null;
  const row = await prisma.ipFormGuestToken.findUnique({ where: { token }, include: { response: true } });
  if (!row || row.revokedAt || row.expiresAt < new Date()) return null;
  if (row.response.status === "SUBMITTED") return null;
  void prisma.ipFormGuestToken.update({ where: { id: row.id }, data: { lastAccessAt: new Date() } }).catch(() => {});
  return row;
}

// ─── Parent endpoints ────────────────────────────────────────────────────────

ipFormRouter.get("/api/ip-form", requireAuth, async (req, res) => {
  const user = (req as any).user;
  try {
    const { accountId, memberIds } = await accountOf(user.id);
    const [allSections, rawResponse] = await Promise.all([loadIpFormTemplate(), getOrCreateResponse(accountId)]);
    // Always open with two-vs-solo reflecting IP1's current marital status
    // (unless manually overridden), so the inference is right from load.
    const response = await reconcileHasSecondParent(rawResponse);
    const { answers, signatures } = await loadResponseBundle(response.id);
    // Show only the sections the account's connected providers actually need
    // (surrogacy agency -> full form; IVF clinic -> basic info + ID/photocopy).
    const programTypes = await accountProgramTypes(memberIds);
    const sections = allSections.filter((s) => sectionAppliesToPrograms(s as any, programTypes));
    const idPhotocopyRequired = await accountRequiresIdPhotocopy(memberIds);
    const guestToken = await prisma.ipFormGuestToken.findFirst({
      where: { responseId: response.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { email: true, name: true, createdAt: true, expiresAt: true },
    });
    const members = await prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, name: true, email: true, parentAccountRole: true },
    });
    res.json({
      sections,
      response,
      answers,
      signatures: signatures.map((s) => ({ ...s, signatureImageUrl: s.signatureImageUrl })),
      mySlot: slotOf(user),
      guestInvite: guestToken,
      members,
      programTypes,
      idPhotocopyRequired,
    });
  } catch (e: any) {
    console.error(`[ip-form] GET failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to load form" });
  }
});

// ─── Clinic / doctor / address autocomplete (Fertility Clinic section) ───────
// Parents type their clinic; we suggest from our IVF-clinic directory (any
// approval status). Selecting a clinic scopes the RE and address pickers.

ipFormRouter.get("/api/ip-form/clinic-search", requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ clinics: [] });
    const clinics = await prisma.provider.findMany({
      where: {
        name: { contains: q, mode: "insensitive" },
        services: { some: { providerType: { name: "IVF Clinic" } } },
      },
      select: { id: true, name: true, phone: true },
      take: 10,
      orderBy: { name: "asc" },
    });
    res.json({ clinics });
  } catch (e: any) {
    console.error(`[ip-form] clinic-search failed: ${e?.message}`);
    res.status(500).json({ message: "Search failed" });
  }
});

ipFormRouter.get("/api/ip-form/doctor-search", requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const providerId = req.query.providerId ? String(req.query.providerId) : undefined;
    // Need something to scope by: either a query or a selected clinic.
    if (q.length < 2 && !providerId) return res.json({ doctors: [] });
    const doctors = await prisma.providerMember.findMany({
      where: {
        ...(q.length >= 2 ? { name: { contains: q, mode: "insensitive" } } : {}),
        ...(providerId ? { providerId } : {}),
      },
      select: { name: true, title: true },
      take: 12,
      orderBy: { name: "asc" },
    });
    res.json({ doctors });
  } catch (e: any) {
    console.error(`[ip-form] doctor-search failed: ${e?.message}`);
    res.status(500).json({ message: "Search failed" });
  }
});

ipFormRouter.get("/api/ip-form/clinic-locations", requireAuth, async (req, res) => {
  try {
    const providerId = String(req.query.providerId || "");
    if (!providerId) return res.json({ locations: [] });
    const locations = await prisma.providerLocation.findMany({
      where: { providerId },
      select: { address: true, city: true, state: true, zip: true },
      orderBy: { sortOrder: "asc" },
      take: 10,
    });
    res.json({
      // ProviderLocation has no country column; our clinic directory is US.
      locations: locations.map((l) => ({ address: l.address || "", city: l.city || "", state: l.state || "", zip: l.zip || "", country: "United States", apt: "" })),
    });
  } catch (e: any) {
    console.error(`[ip-form] clinic-locations failed: ${e?.message}`);
    res.status(500).json({ message: "Lookup failed" });
  }
});

ipFormRouter.patch("/api/ip-form", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const mySlot = slotOf(user);
  if (!mySlot) return res.status(403).json({ message: "Viewers cannot edit the form" });
  try {
    const { accountId } = await accountOf(user.id);
    const response = await getOrCreateResponse(accountId);
    if (response.status === "SUBMITTED") return res.status(409).json({ message: "Form already submitted" });
    const hasSecondParent = req.body?.hasSecondParent;
    if (typeof hasSecondParent !== "boolean") return res.status(400).json({ message: "hasSecondParent must be boolean" });
    // Explicit choice (escape hatch): lock it so marital-status changes no
    // longer flip it. This is the ONLY place hasSecondParentManual turns on
    // besides inviting a second parent.
    const updated = await prisma.ipFormResponse.update({ where: { id: response.id }, data: { hasSecondParent, hasSecondParentManual: true } });
    res.json({ response: updated });
  } catch (e: any) {
    console.error(`[ip-form] PATCH failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to update form" });
  }
});

/**
 * Batched autosave. Body: { answers: [{ questionId, parentSlot, value }] }.
 * Any non-viewer member can fill any field, including the other parent's
 * details - one partner commonly completes the whole form. Only the signature
 * is per-parent (each parent signs their own; enforced on the sign endpoint).
 */
ipFormRouter.patch("/api/ip-form/answers", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const mySlot = slotOf(user);
  if (!mySlot) return res.status(403).json({ message: "Viewers cannot edit the form" });
  try {
    const { accountId } = await accountOf(user.id);
    const response = await getOrCreateResponse(accountId);
    // A submitted form is locked - EXCEPT the ID photocopy (file widget), a
    // supplemental document a later provider can still require.
    const submitted = response.status === "SUBMITTED";

    const items = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!items.length) return res.status(400).json({ message: "answers array required" });
    if (items.length > 100) return res.status(400).json({ message: "Too many answers in one batch" });

    const sections = await loadIpFormTemplate();
    const questionMeta = new Map<string, { section: any; question: any }>();
    for (const s of sections) for (const q of s.questions) questionMeta.set(q.id, { section: s, question: q });

    let saved = 0;
    let fileUploadedPostSubmit = false;
    for (const item of items) {
      const meta = questionMeta.get(item?.questionId);
      if (!meta) continue;
      const { section, question } = meta;
      if (submitted && question.widget !== "file") continue; // only supplemental docs after submit
      const isPerParent = section.perParent || question.perParent;
      const slot: number = isPerParent ? (item.parentSlot === 2 ? 2 : 1) : 0;
      if (slot === 2 && !response.hasSecondParent) continue;
      await prisma.ipFormAnswer.upsert({
        where: { responseId_questionId_parentSlot: { responseId: response.id, questionId: question.id, parentSlot: slot } },
        create: { responseId: response.id, questionId: question.id, parentSlot: slot, value: item.value ?? null, updatedByUserId: user.id },
        update: { value: item.value ?? null, updatedByUserId: user.id },
      });
      saved++;
      if (submitted && question.widget === "file" && item.value) fileUploadedPostSubmit = true;
    }
    // A supplemental ID scan just landed on an already-submitted form - tell the
    // providers that require it.
    if (fileUploadedPostSubmit) {
      const { notifyProvidersPhotocopyUploaded } = await import("./notify-ip-form");
      void notifyProvidersPhotocopyUploaded(response.id).catch((e: any) => console.error(`[ip-form] photocopy-uploaded notify failed: ${e?.message}`));
    }
    // Marital status just changed? Re-derive two-vs-solo and hand the fresh
    // value back so the client can show/hide the second-parent sections
    // without a full refetch.
    const reconciled = await reconcileHasSecondParent(response);
    res.json({ saved, response: { hasSecondParent: reconciled.hasSecondParent, hasSecondParentManual: reconciled.hasSecondParentManual } });
  } catch (e: any) {
    console.error(`[ip-form] answers PATCH failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to save answers" });
  }
});

ipFormRouter.post("/api/ip-form/sign", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const mySlot = slotOf(user);
  if (!mySlot) return res.status(403).json({ message: "Viewers cannot sign" });
  try {
    const { accountId } = await accountOf(user.id);
    const response = await getOrCreateResponse(accountId);
    if (response.status === "SUBMITTED") return res.status(409).json({ message: "Form already submitted" });
    const { fullLegalName, signatureImageUrl, method } = req.body || {};
    if (!fullLegalName?.trim() || !signatureImageUrl || !["drawn", "typed"].includes(method)) {
      return res.status(400).json({ message: "fullLegalName, signatureImageUrl and method (drawn|typed) are required" });
    }
    const signature = await prisma.ipFormSignature.upsert({
      where: { responseId_parentSlot: { responseId: response.id, parentSlot: mySlot } },
      create: { responseId: response.id, parentSlot: mySlot, fullLegalName: fullLegalName.trim(), signatureImageUrl, method, signedByUserId: user.id },
      update: { fullLegalName: fullLegalName.trim(), signatureImageUrl, method, signedByUserId: user.id, signedAt: new Date() },
    });
    // Let the other account member(s) know a signature landed.
    const { notifyPartnerSigned } = await import("./notify-ip-form");
    void notifyPartnerSigned({ responseId: response.id, signedSlot: mySlot, signerName: fullLegalName.trim(), signerUserId: user.id });
    res.json({ signature });
  } catch (e: any) {
    console.error(`[ip-form] sign failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to save signature" });
  }
});

/**
 * Invite parent 2. mode "member": the client has already created the account
 * member via POST /parent-account/members - this just records the mode.
 * mode "guest": mint a fresh token (revoking priors) and email the link.
 */
ipFormRouter.post("/api/ip-form/invite-parent2", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const mySlot = slotOf(user);
  if (!mySlot) return res.status(403).json({ message: "Viewers cannot invite" });
  try {
    const { accountId } = await accountOf(user.id);
    const response = await getOrCreateResponse(accountId);
    if (response.status === "SUBMITTED") return res.status(409).json({ message: "Form already submitted" });
    const mode = req.body?.mode;
    if (mode === "member") {
      await prisma.ipFormResponse.update({ where: { id: response.id }, data: { parent2Mode: "member", hasSecondParent: true, hasSecondParentManual: true } });
      return res.json({ ok: true, mode });
    }
    if (mode === "guest") {
      const email = (req.body?.email || "").trim();
      const name = (req.body?.name || "").trim() || null;
      const phone = (req.body?.phone || "").trim() || null;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: "A valid email is required" });
      await prisma.ipFormGuestToken.updateMany({
        where: { responseId: response.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const token = crypto.randomBytes(32).toString("hex");
      const row = await prisma.ipFormGuestToken.create({
        data: { responseId: response.id, token, email, name, expiresAt: new Date(Date.now() + GUEST_TOKEN_TTL_MS) },
      });
      await prisma.ipFormResponse.update({ where: { id: response.id }, data: { parent2Mode: "guest", hasSecondParent: true, hasSecondParentManual: true } });
      const { getBaseUrl } = await import("./src/lib/get-base-url");
      const link = `${getBaseUrl()}/ip-form/guest/${token}`;
      const { sendIpFormGuestInvite } = await import("./notify-ip-form");
      void sendIpFormGuestInvite({ email, name, phone, inviterName: user.name || user.firstName || "Your partner", link });
      return res.json({ ok: true, mode, link, guestInvite: { email: row.email, name: row.name, createdAt: row.createdAt, expiresAt: row.expiresAt } });
    }
    res.status(400).json({ message: "mode must be member or guest" });
  } catch (e: any) {
    console.error(`[ip-form] invite failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to invite" });
  }
});

ipFormRouter.post("/api/ip-form/submit", requireAuth, async (req, res) => {
  const user = (req as any).user;
  const mySlot = slotOf(user);
  if (!mySlot) return res.status(403).json({ message: "Viewers cannot submit" });
  try {
    const { accountId, memberIds } = await accountOf(user.id);
    const response = await getOrCreateResponse(accountId);
    if (response.status === "SUBMITTED") return res.status(409).json({ message: "Form already submitted" });

    // Make sure two-vs-solo is current before validating (marital status may
    // have changed right before submit).
    const effective = await reconcileHasSecondParent(response);
    // Validate only the sections the parent actually fills (their providers'
    // program types). The ID photocopy is a supplemental doc, never a submit
    // blocker - it's requested separately when a provider needs it.
    const programTypes = await accountProgramTypes(memberIds);
    const sections = (await loadIpFormTemplate()).filter((s) => sectionAppliesToPrograms(s as any, programTypes));
    const { answers, signatures } = await loadResponseBundle(response.id);
    const missing = findMissingRequired(sections, answers as any, effective.hasSecondParent);
    const missingSignatures: number[] = [];
    if (!signatures.find((s) => s.parentSlot === 1)) missingSignatures.push(1);
    if (effective.hasSecondParent && !signatures.find((s) => s.parentSlot === 2)) missingSignatures.push(2);
    if (missing.length || missingSignatures.length) {
      return res.status(422).json({ message: "Form incomplete", missing, missingSignatures });
    }

    const submitted = await prisma.ipFormResponse.update({
      where: { id: response.id },
      data: { status: "SUBMITTED", submittedAt: new Date() },
    });
    await prisma.ipFormGuestToken.updateMany({
      where: { responseId: response.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    void emitJourneyEvent({
      eventType: "IP_FORM_SUBMITTED",
      parentAccountId: accountId,
      actorRole: "parent",
      metadata: { responseId: response.id },
    });
    const { notifyProvidersIpFormSubmitted } = await import("./notify-ip-form");
    void notifyProvidersIpFormSubmitted(response.id).catch((e: any) =>
      console.error(`[ip-form] provider notify failed: ${e?.message}`),
    );
    res.json({ response: submitted });
  } catch (e: any) {
    console.error(`[ip-form] submit failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to submit form" });
  }
});

// ─── Guest endpoints (parent 2 without an account) ───────────────────────────

ipFormRouter.get("/api/ip-form/guest/:token", guestThrottle, async (req, res) => {
  try {
    const tokenRow = await validGuestToken(String(req.params.token));
    if (!tokenRow) return res.status(404).json({ message: "This link is no longer valid" });
    const sections = await loadIpFormTemplate();
    const { answers, signatures } = await loadResponseBundle(tokenRow.responseId);
    res.json({
      sections,
      response: {
        id: tokenRow.response.id,
        status: tokenRow.response.status,
        hasSecondParent: tokenRow.response.hasSecondParent,
      },
      answers,
      signatures: signatures.map((s) => ({ parentSlot: s.parentSlot, fullLegalName: s.fullLegalName, signedAt: s.signedAt, method: s.method, signatureImageUrl: s.signatureImageUrl })),
      mySlot: tokenRow.parentSlot,
      guestName: tokenRow.name,
    });
  } catch (e: any) {
    console.error(`[ip-form] guest GET failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to load form" });
  }
});

ipFormRouter.patch("/api/ip-form/guest/:token/answers", guestThrottle, async (req, res) => {
  try {
    const tokenRow = await validGuestToken(String(req.params.token));
    if (!tokenRow) return res.status(404).json({ message: "This link is no longer valid" });
    const items = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!items.length) return res.status(400).json({ message: "answers array required" });
    if (items.length > 100) return res.status(400).json({ message: "Too many answers in one batch" });

    // A submitted form only accepts supplemental docs (the ID photocopy file).
    const submitted = tokenRow.response.status === "SUBMITTED";
    const sections = await loadIpFormTemplate();
    const questionMeta = new Map<string, { section: any; question: any }>();
    for (const s of sections) for (const q of s.questions) questionMeta.set(q.id, { section: s, question: q });

    let saved = 0;
    let fileUploadedPostSubmit = false;
    for (const item of items) {
      const meta = questionMeta.get(item?.questionId);
      if (!meta) continue;
      const { section, question } = meta;
      // Guests may only write their own slot's per-parent questions.
      if (!(section.perParent || question.perParent)) continue;
      if (submitted && question.widget !== "file") continue; // only the supplemental ID doc post-submit
      const slot = tokenRow.parentSlot;
      await prisma.ipFormAnswer.upsert({
        where: { responseId_questionId_parentSlot: { responseId: tokenRow.responseId, questionId: question.id, parentSlot: slot } },
        create: { responseId: tokenRow.responseId, questionId: question.id, parentSlot: slot, value: item.value ?? null },
        update: { value: item.value ?? null },
      });
      saved++;
      if (submitted && question.widget === "file" && item.value) fileUploadedPostSubmit = true;
    }
    if (fileUploadedPostSubmit) {
      const { notifyProvidersPhotocopyUploaded } = await import("./notify-ip-form");
      void notifyProvidersPhotocopyUploaded(tokenRow.responseId).catch((e: any) => console.error(`[ip-form] guest photocopy-uploaded notify failed: ${e?.message}`));
    }
    res.json({ saved });
  } catch (e: any) {
    console.error(`[ip-form] guest answers failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to save answers" });
  }
});

/**
 * Guests have no auth session, so POST /api/uploads is closed to them - the
 * signature arrives as a small base64 data URL instead and is stored
 * server-side (GCS when configured, local /uploads fallback).
 */
async function storeSignatureDataUrl(dataUrl: string): Promise<string | null> {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl || "");
  if (!match) return null;
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) return null;
  const name = `ip-form-signature-${crypto.randomBytes(8).toString("hex")}.png`;
  try {
    const { StorageService } = await import("./src/modules/storage/storage.service");
    const storage = new StorageService();
    return await storage.uploadBufferPublic(buffer, `uploads/${name}`, "image/png");
  } catch {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.resolve(process.cwd(), "public", "uploads");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buffer);
    return `/uploads/${name}`;
  }
}

/** Store a guest-uploaded image/PDF (as a data URL) to the private bucket. */
async function storeDataUrlFile(dataUrl: string): Promise<{ url: string; contentType: string } | null> {
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  const ok = contentType.startsWith("image/") || contentType === "application/pdf";
  if (!ok) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) return null; // 12MB cap
  const ext = contentType === "application/pdf" ? ".pdf" : `.${contentType.split("/")[1] || "bin"}`.replace(".jpeg", ".jpg");
  const name = `ip-form-file-${crypto.randomBytes(10).toString("hex")}${ext}`;
  try {
    const { StorageService } = await import("./src/modules/storage/storage.service");
    const storage = new StorageService();
    const url = await storage.uploadBufferPublic(buffer, `uploads/${name}`, contentType);
    return { url, contentType };
  } catch {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.resolve(process.cwd(), "public", "uploads");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), buffer);
    return { url: `/uploads/${name}`, contentType };
  }
}

/** Guest file upload (ID photocopy) - guests have no /api/uploads auth. */
ipFormRouter.post("/api/ip-form/guest/:token/upload-file", guestThrottle, async (req, res) => {
  try {
    const tokenRow = await validGuestToken(String(req.params.token));
    if (!tokenRow) return res.status(404).json({ message: "This link is no longer valid" });
    const { dataUrl, name } = req.body || {};
    if (!dataUrl || typeof dataUrl !== "string") return res.status(400).json({ message: "dataUrl required" });
    const stored = await storeDataUrlFile(dataUrl);
    if (!stored) return res.status(400).json({ message: "Only images or PDF up to 12MB are accepted" });
    res.json({ url: stored.url, name: (name && String(name)) || "ID document", contentType: stored.contentType });
  } catch (e: any) {
    console.error(`[ip-form] guest upload failed: ${e?.message}`);
    res.status(500).json({ message: "Upload failed" });
  }
});

ipFormRouter.post("/api/ip-form/guest/:token/sign", guestThrottle, async (req, res) => {
  try {
    const tokenRow = await validGuestToken(String(req.params.token));
    if (!tokenRow) return res.status(404).json({ message: "This link is no longer valid" });
    const { fullLegalName, signatureImageDataUrl, method } = req.body || {};
    const signatureImageUrl = signatureImageDataUrl ? await storeSignatureDataUrl(signatureImageDataUrl) : req.body?.signatureImageUrl;
    if (!fullLegalName?.trim() || !signatureImageUrl || !["drawn", "typed"].includes(method)) {
      return res.status(400).json({ message: "fullLegalName, signature and method (drawn|typed) are required" });
    }
    const signature = await prisma.ipFormSignature.upsert({
      where: { responseId_parentSlot: { responseId: tokenRow.responseId, parentSlot: tokenRow.parentSlot } },
      create: {
        responseId: tokenRow.responseId,
        parentSlot: tokenRow.parentSlot,
        fullLegalName: fullLegalName.trim(),
        signatureImageUrl,
        method,
        guestTokenId: tokenRow.id,
      },
      update: { fullLegalName: fullLegalName.trim(), signatureImageUrl, method, guestTokenId: tokenRow.id, signedAt: new Date() },
    });
    // A guest (parent 2) just signed - notify the account member(s) who invited them.
    const { notifyPartnerSigned } = await import("./notify-ip-form");
    void notifyPartnerSigned({ responseId: tokenRow.responseId, signedSlot: tokenRow.parentSlot, signerName: fullLegalName.trim() });
    res.json({ signature: { parentSlot: signature.parentSlot, fullLegalName: signature.fullLegalName, signedAt: signature.signedAt } });
  } catch (e: any) {
    console.error(`[ip-form] guest sign failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to save signature" });
  }
});

// ─── Provider endpoints ──────────────────────────────────────────────────────

/** Resolve parent accounts connected to this provider (sessions + bookings). */
async function connectedAccountIds(providerId: string): Promise<Map<string, string[]>> {
  const [sessions, bookings] = await Promise.all([
    prisma.aiChatSession.findMany({ where: { providerId, userId: { not: undefined } }, select: { userId: true } }),
    prisma.booking.findMany({ where: { providerUser: { providerId }, parentUserId: { not: null } }, select: { parentUserId: true } }),
  ]);
  const userIds = new Set<string>();
  for (const s of sessions) if (s.userId) userIds.add(s.userId);
  for (const b of bookings) if (b.parentUserId) userIds.add(b.parentUserId);
  const users = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, parentAccountId: true },
  });
  // accountId -> memberIds seen
  const map = new Map<string, string[]>();
  for (const u of users) {
    const acct = u.parentAccountId || u.id;
    map.set(acct, [...(map.get(acct) || []), u.id]);
  }
  return map;
}

ipFormRouter.get("/api/provider/ip-forms", requireAuth, async (req, res) => {
  const user = (req as any).user;
  if (!isProviderUser(user) && !isAdmin(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const providerId = user.providerId;
    let responses: any[];
    if (isAdmin(user) && !providerId) {
      responses = await prisma.ipFormResponse.findMany({ where: { status: "SUBMITTED" }, orderBy: { submittedAt: "desc" } });
    } else {
      const accounts = await connectedAccountIds(providerId);
      if (!accounts.size) return res.json({ forms: [] });
      responses = await prisma.ipFormResponse.findMany({
        where: { parentAccountId: { in: [...accounts.keys()] }, status: "SUBMITTED" },
        orderBy: { submittedAt: "desc" },
      });
    }
    if (!responses.length) return res.json({ forms: [] });

    const sections = await loadIpFormTemplate(true);
    const allQuestions = sections.flatMap((s) => s.questions);
    const forms = await Promise.all(
      responses.map(async (r) => {
        const answers = await prisma.ipFormAnswer.findMany({ where: { responseId: r.id } });
        const memberUsers = await prisma.user.findMany({
          where: { OR: [{ parentAccountId: r.parentAccountId }, { id: r.parentAccountId }] },
          select: { name: true },
        });
        const names = parentNamesFrom(answers as any, allQuestions, memberUsers.map((m) => m.name).filter(Boolean) as string[]);
        return {
          responseId: r.id,
          parentAccountId: r.parentAccountId,
          parentNames: names,
          hasSecondParent: r.hasSecondParent,
          submittedAt: r.submittedAt,
        };
      }),
    );
    res.json({ forms });
  } catch (e: any) {
    console.error(`[ip-form] provider list failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to load forms" });
  }
});

ipFormRouter.get("/api/provider/ip-forms/:responseId/pdf", requireAuth, async (req, res) => {
  const user = (req as any).user;
  if (!isProviderUser(user) && !isAdmin(user)) return res.status(403).json({ message: "Forbidden" });
  try {
    const variant = req.query.variant === "surrogate" ? "surrogate" : "full";
    const response = await prisma.ipFormResponse.findUnique({ where: { id: String(req.params.responseId) } });
    if (!response || response.status !== "SUBMITTED") return res.status(404).json({ message: "Form not found" });

    // Tenant gate: the provider must actually be connected to this account.
    const providerId = user.providerId;
    let brandProviderId = providerId;
    // Sections the DOWNLOADING provider sees: their program types (surrogacy
    // agency -> surrogacy sections; IVF clinic -> core + ivf). Admin: everything.
    let programTypes: string[] | null = null;
    if (!isAdmin(user) || providerId) {
      const memberIds = (
        await prisma.user.findMany({
          where: { OR: [{ parentAccountId: response.parentAccountId }, { id: response.parentAccountId }] },
          select: { id: true },
        })
      ).map((u) => u.id);
      const connected = await providerConnectedToAccount(providerId, memberIds);
      if (!connected) return res.status(403).json({ message: "Forbidden" });
      const provider = await prisma.provider.findUnique({ where: { id: providerId }, select: { collectsIntendedParentForm: true } });
      if (!provider?.collectsIntendedParentForm) {
        return res.status(403).json({ message: "This provider does not collect the Intended Parent Form" });
      }
      programTypes = await providerProgramTypes(providerId);
      // The surrogate-safe variant only makes sense for surrogacy agencies.
      if (variant === "surrogate" && !programTypes.includes("surrogacy")) {
        return res.status(403).json({ message: "The surrogate version is only available to surrogacy agencies" });
      }
    }
    if (!brandProviderId) {
      // GoStork admin without a provider org: brand as the first connected surrogacy agency is
      // ambiguous - use unbranded GoStork rendering instead.
      brandProviderId = null;
    }

    const { buildIpFormPdfForProvider } = await import("./ip-form-pdf");
    const { buffer, fileName } = await buildIpFormPdfForProvider({
      responseId: response.id,
      providerId: brandProviderId,
      variant: variant as "full" | "surrogate",
      programTypes,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(buffer);
  } catch (e: any) {
    console.error(`[ip-form] pdf failed: ${e?.message}`);
    res.status(500).json({ message: "Failed to generate PDF" });
  }
});

// ─── Admin template endpoints ────────────────────────────────────────────────

function requireGostorkAdmin(req: Request, res: Response, next: () => void) {
  const user = (req as any).user;
  if (!user || !rolesOf(user).includes("GOSTORK_ADMIN")) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
}

ipFormRouter.get("/api/admin/ip-form-template", requireAuth, requireGostorkAdmin, async (_req, res) => {
  try {
    const sections = await loadIpFormTemplate(true);
    res.json({ sections });
  } catch (e: any) {
    res.status(500).json({ message: "Failed to load template" });
  }
});

ipFormRouter.post("/api/admin/ip-form-sections", requireAuth, requireGostorkAdmin, async (req, res) => {
  try {
    const { title, description, perParent, excludeFromSurrogatePdf } = req.body || {};
    if (!title?.trim()) return res.status(400).json({ message: "title required" });
    const key = `custom_${crypto.randomBytes(4).toString("hex")}`;
    const max = await prisma.ipFormSection.aggregate({ _max: { sortOrder: true } });
    const section = await prisma.ipFormSection.create({
      data: {
        key,
        title: title.trim(),
        description: description?.trim() || null,
        perParent: !!perParent,
        excludeFromSurrogatePdf: !!excludeFromSurrogatePdf,
        sortOrder: (max._max.sortOrder || 0) + 10,
      },
    });
    res.json({ section });
  } catch (e: any) {
    res.status(500).json({ message: "Failed to create section" });
  }
});

ipFormRouter.put("/api/admin/ip-form-sections/:id", requireAuth, requireGostorkAdmin, async (req, res) => {
  try {
    const { title, description, perParent, excludeFromSurrogatePdf, isActive, appliesTo } = req.body || {};
    const data: any = {};
    if (typeof title === "string" && title.trim()) data.title = title.trim();
    if (description !== undefined) data.description = description?.trim() || null;
    if (typeof perParent === "boolean") data.perParent = perParent;
    if (typeof excludeFromSurrogatePdf === "boolean") data.excludeFromSurrogatePdf = excludeFromSurrogatePdf;
    if (typeof isActive === "boolean") data.isActive = isActive;
    // Program applicability: keep only known program types; [] = core (all).
    if (Array.isArray(appliesTo)) {
      const KNOWN = ["surrogacy", "ivf"];
      data.appliesTo = [...new Set(appliesTo.filter((t: any) => typeof t === "string" && KNOWN.includes(t)))];
    }
    const section = await prisma.ipFormSection.update({ where: { id: String(req.params.id) }, data });
    res.json({ section });
  } catch (e: any) {
    res.status(500).json({ message: "Failed to update section" });
  }
});

ipFormRouter.post("/api/admin/ip-form-questions", requireAuth, requireGostorkAdmin, async (req, res) => {
  try {
    const { sectionId, label, helpText, widget, options, required, perParent, excludeFromSurrogatePdf, conditionalOnQuestionId, conditionalTriggerValue } = req.body || {};
    if (!sectionId || !label?.trim() || !widget) return res.status(400).json({ message: "sectionId, label and widget required" });
    const VALID_WIDGETS = ["text", "textarea", "yes_no", "dropdown", "date", "address", "phone", "number", "photos", "file"];
    if (!VALID_WIDGETS.includes(widget)) return res.status(400).json({ message: "Invalid widget" });
    const key = `custom_${crypto.randomBytes(4).toString("hex")}`;
    const max = await prisma.ipFormQuestion.aggregate({ where: { sectionId }, _max: { sortOrder: true } });
    const question = await prisma.ipFormQuestion.create({
      data: {
        sectionId,
        key,
        label: label.trim(),
        helpText: helpText?.trim() || null,
        widget,
        options: Array.isArray(options) && options.length ? options : undefined,
        required: !!required,
        perParent: !!perParent,
        excludeFromSurrogatePdf: !!excludeFromSurrogatePdf,
        conditionalOnQuestionId: conditionalOnQuestionId || null,
        conditionalTriggerValue: conditionalTriggerValue || null,
        sortOrder: (max._max.sortOrder || 0) + 10,
      },
    });
    res.json({ question });
  } catch (e: any) {
    res.status(500).json({ message: "Failed to create question" });
  }
});

ipFormRouter.put("/api/admin/ip-form-questions/:id", requireAuth, requireGostorkAdmin, async (req, res) => {
  try {
    const { label, helpText, widget, options, required, perParent, excludeFromSurrogatePdf, conditionalOnQuestionId, conditionalTriggerValue, isActive } = req.body || {};
    const data: any = {};
    if (typeof label === "string" && label.trim()) data.label = label.trim();
    if (helpText !== undefined) data.helpText = helpText?.trim() || null;
    if (typeof widget === "string") {
      const VALID_WIDGETS = ["text", "textarea", "yes_no", "dropdown", "date", "address", "phone", "number", "photos", "file"];
      if (!VALID_WIDGETS.includes(widget)) return res.status(400).json({ message: "Invalid widget" });
      data.widget = widget;
    }
    if (options !== undefined) data.options = Array.isArray(options) && options.length ? options : null;
    if (typeof required === "boolean") data.required = required;
    if (typeof perParent === "boolean") data.perParent = perParent;
    if (typeof excludeFromSurrogatePdf === "boolean") data.excludeFromSurrogatePdf = excludeFromSurrogatePdf;
    if (conditionalOnQuestionId !== undefined) data.conditionalOnQuestionId = conditionalOnQuestionId || null;
    if (conditionalTriggerValue !== undefined) data.conditionalTriggerValue = conditionalTriggerValue || null;
    if (typeof isActive === "boolean") data.isActive = isActive;
    const question = await prisma.ipFormQuestion.update({ where: { id: String(req.params.id) }, data });
    res.json({ question });
  } catch (e: any) {
    res.status(500).json({ message: "Failed to update question" });
  }
});

ipFormRouter.put("/api/admin/ip-form-template/reorder", requireAuth, requireGostorkAdmin, async (req, res) => {
  try {
    const { sectionIds, questionIdsBySection } = req.body || {};
    if (Array.isArray(sectionIds)) {
      for (let i = 0; i < sectionIds.length; i++) {
        await prisma.ipFormSection.update({ where: { id: sectionIds[i] }, data: { sortOrder: (i + 1) * 10 } }).catch(() => {});
      }
    }
    if (questionIdsBySection && typeof questionIdsBySection === "object") {
      for (const [sectionId, ids] of Object.entries(questionIdsBySection)) {
        if (!Array.isArray(ids)) continue;
        for (let i = 0; i < ids.length; i++) {
          await prisma.ipFormQuestion
            .update({ where: { id: ids[i] as string }, data: { sectionId, sortOrder: (i + 1) * 10 } })
            .catch(() => {});
        }
      }
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ message: "Failed to reorder" });
  }
});
