/**
 * Lifecycle sweeps for profile holds (egg donors + surrogates) and
 * stranded agreement drafts.
 *
 * HOLD DECISION FLOW (no silent auto-release - user decision, 7B):
 * A fresh egg donor goes ON_HOLD when the parent confirms readiness (the
 * AUTO_READINESS deposit invoice is created); a surrogate goes MATCHED
 * with a reservation expiry at the double-yes moment. If the deposit
 * invoice is still unpaid past its due date:
 *   1. The PROVIDER gets a decision card in the chat: "Keep holding her"
 *      or "Release her" (donor_hold_decision - hidden from parents).
 *   2. "Release her" posts a warning card to the PARENT with a countdown:
 *      "Ok, release her" or "I will pay soon" (donor_release_warning).
 *   3. "I will pay soon" extends the countdown once; paying the invoice
 *      resolves everything (she flips IN_CYCLE via the payment hook).
 *   4. Parent-release, or countdown expiry with the invoice still unpaid,
 *      releases her: status back to AVAILABLE, invoice canceled, both
 *      sides notified in chat + in-app.
 *
 * STRANDED AGREEMENTS: a server restart mid-send leaves an Agreement in
 * DRAFT with a PandaDoc document id and no chat card - invisible to
 * everyone. The sweep marks those ERROR and tells the provider to re-send
 * (loud failure; no auto-resume of a half-built signature request).
 */

const HOUR_MS = 60 * 60 * 1000;
/** Invoice with no dueAt counts as overdue this long after creation. */
const HOLD_OVERDUE_FALLBACK_MS = 24 * HOUR_MS;
/** Parent's window to pay/decide after the provider chooses "release". */
export const RELEASE_COUNTDOWN_MS = 24 * HOUR_MS;
/** One-time extension when the parent answers "I will pay soon". */
export const PAY_SOON_EXTENSION_MS = 48 * HOUR_MS;
/** After "keep holding her", don't re-ask the provider for this long. */
const KEEP_REASK_MS = 72 * HOUR_MS;
/** A DRAFT agreement with a PandaDoc doc older than this is stranded. */
const STRANDED_DRAFT_MS = 15 * 60 * 1000;

export function fmtHoldDeadline(d: Date): string {
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function notifyUsers(prisma: any, userIds: string[], eventType: string, payload: Record<string, unknown>) {
  for (const userId of userIds) {
    await prisma.inAppNotification.create({ data: { userId, eventType, payload } }).catch(() => {});
  }
}

async function parentAccountUserIds(prisma: any, parentUserId: string): Promise<string[]> {
  const u = await prisma.user.findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } });
  if (!u?.parentAccountId) return [parentUserId];
  const members = await prisma.user.findMany({ where: { parentAccountId: u.parentAccountId }, select: { id: true } });
  return members.map((m: any) => m.id);
}

async function providerUserIds(prisma: any, providerId: string): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { providerId }, select: { id: true } });
  return users.map((u: any) => u.id);
}

/** Resolve every open hold card on a session (both types) with one outcome. */
async function resolveOpenHoldCards(prisma: any, sessionId: string, resolvedAs: string) {
  const cards = await prisma.aiChatMessage.findMany({
    where: { sessionId, uiCardType: { in: ["donor_hold_decision", "donor_release_warning"] } },
    select: { id: true, uiCardData: true },
  });
  for (const c of cards) {
    const d = (c.uiCardData as any) || {};
    if (d.resolvedAt) continue;
    await prisma.aiChatMessage.update({
      where: { id: c.id },
      data: { uiCardData: { ...d, resolvedAt: new Date().toISOString(), resolvedAs } },
    }).catch(() => {});
  }
}

/**
 * Release a held profile: back to AVAILABLE (surrogates also drop their
 * reservation), cancel the unpaid deposit invoice, resolve open cards,
 * announce dual-audience, notify both sides. Shared by the parent's
 * "Ok, release her" and the countdown expiry.
 */
export async function releaseSubjectHold(prisma: any, opts: {
  donorId: string;
  donorLabel: string;
  sessionId: string;
  subjectType?: "egg_donor" | "surrogate";
  invoiceId?: string | null;
  parentUserId?: string | null;
  providerId?: string | null;
  parentName?: string | null;
  reason: "released_by_parent" | "released_timeout";
}): Promise<void> {
  const { donorId, donorLabel, sessionId, invoiceId, parentUserId, providerId, reason } = opts;
  const parentName = opts.parentName || "The parent";

  if (opts.subjectType === "surrogate") {
    await prisma.surrogate.updateMany({
      where: { id: donorId },
      data: { reservedByParentId: null, reservationExpiresAt: null, status: "AVAILABLE" },
    });
  } else {
    await prisma.eggDonor.updateMany({ where: { id: donorId, status: "ON_HOLD" }, data: { status: "AVAILABLE" } });
  }
  if (invoiceId) {
    await prisma.invoice.updateMany({ where: { id: invoiceId, status: "AWAITING_PAYMENT" }, data: { status: "CANCELED" } }).catch(() => {});
  }
  await resolveOpenHoldCards(prisma, sessionId, reason);

  const content = reason === "released_by_parent"
    ? `Done - I've released ${donorLabel} and canceled the pending deposit invoice. Whenever you're ready to explore other donors, I'm right here.`
    : `The hold on ${donorLabel} has ended - the deposit wasn't completed in time, so she's available to other families again. If you'd still like to move forward, message me and I'll check her availability right away.`;
  const providerContent = reason === "released_by_parent"
    ? `${parentName} chose to release ${donorLabel} - the hold is off, she's back in the marketplace, and the pending deposit invoice was canceled.`
    : `${parentName}'s hold on ${donorLabel} expired without payment - she's back in the marketplace and the pending deposit invoice was canceled.`;

  await prisma.aiChatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
      senderType: "system",
      senderName: "GoStork",
      uiCardData: { providerContent },
    },
  }).catch(() => {});

  if (providerId) {
    await notifyUsers(prisma, await providerUserIds(prisma, providerId), "DONOR_HOLD_RELEASED", {
      sessionId, donorId, donorLabel, reason, message: providerContent,
    });
  }
  if (parentUserId) {
    await notifyUsers(prisma, await parentAccountUserIds(prisma, parentUserId), "DONOR_HOLD_RELEASED", {
      sessionId, donorId, donorLabel, reason, message: content,
    });
  }
  console.log(`[donor-hold] Released ${donorLabel} (${donorId}) - ${reason}`);
}

/** Every 10 min: drive the hold-decision conversation forward. */
export async function runDonorHoldSweep(prisma: any): Promise<void> {
  // Egg donors: ON_HOLD from the readiness confirmation.
  const eggHolds = await prisma.eggDonor.findMany({
    where: { status: "ON_HOLD" },
    select: { id: true, externalId: true },
  });
  // Surrogates: MATCHED with a live reservation = the post-double-yes
  // payment window (the plain 24h decision hold auto-releases elsewhere).
  const surrHolds = await prisma.surrogate.findMany({
    where: { status: "MATCHED", reservedByParentId: { not: null }, reservationExpiresAt: { not: null } },
    select: { id: true, externalId: true },
  });
  const holds = [
    ...eggHolds.map((d: any) => ({ id: d.id, externalId: d.externalId, subjectType: "egg_donor" as const })),
    ...surrHolds.map((s: any) => ({ id: s.id, externalId: s.externalId, subjectType: "surrogate" as const })),
  ];
  if (holds.length === 0) return;
  const now = Date.now();

  const invoices = await prisma.invoice.findMany({
    where: { triggerSource: "AUTO_READINESS", session: { subjectProfileId: { in: holds.map((h: any) => h.id) } } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, sessionId: true, status: true, dueAt: true, createdAt: true, parentUserId: true, providerId: true,
      session: { select: { subjectProfileId: true } },
      parentUser: { select: { firstName: true, name: true } },
    },
  });

  for (const donor of holds) {
    const inv = invoices.find((i: any) => i.session?.subjectProfileId === donor.id);
    if (!inv) continue; // no committing invoice - nothing to police
    const donorLabel = donor.subjectType === "surrogate"
      ? `Surrogate #${donor.externalId || donor.id.slice(0, 6)}`
      : `Egg Donor #${donor.externalId || donor.id.slice(0, 6)}`;
    const parentName = inv.parentUser?.firstName || inv.parentUser?.name || "The parent";

    if (inv.status === "PAID") {
      // Payment hook flips her IN_CYCLE; just tidy any open cards.
      await resolveOpenHoldCards(prisma, inv.sessionId, "paid");
      continue;
    }
    if (inv.status !== "AWAITING_PAYMENT") continue; // canceled / processing / authorized

    const due = inv.dueAt ? new Date(inv.dueAt).getTime() : new Date(inv.createdAt).getTime() + HOLD_OVERDUE_FALLBACK_MS;
    if (due > now) continue; // not overdue yet

    const cards = await prisma.aiChatMessage.findMany({
      where: { sessionId: inv.sessionId, uiCardType: { in: ["donor_hold_decision", "donor_release_warning"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, uiCardType: true, uiCardData: true },
    });

    // 1. A live parent countdown: enforce its deadline.
    const openWarning = cards.find((c: any) => c.uiCardType === "donor_release_warning" && !((c.uiCardData as any) || {}).resolvedAt);
    if (openWarning) {
      const releaseAtRaw = ((openWarning.uiCardData as any) || {}).releaseAt;
      const releaseAt = releaseAtRaw ? new Date(releaseAtRaw).getTime() : 0;
      if (releaseAt && releaseAt <= now) {
        await releaseSubjectHold(prisma, {
          donorId: donor.id, donorLabel, sessionId: inv.sessionId, subjectType: donor.subjectType,
          invoiceId: inv.id, parentUserId: inv.parentUserId, providerId: inv.providerId, parentName,
          reason: "released_timeout",
        });
      }
      continue;
    }

    // 2. Waiting on the provider's decision - nothing to do.
    const openDecision = cards.find((c: any) => c.uiCardType === "donor_hold_decision" && !((c.uiCardData as any) || {}).resolvedAt);
    if (openDecision) continue;

    // 3. Provider chose "keep holding" recently - snooze the re-ask.
    const lastKeep = cards.find((c: any) => c.uiCardType === "donor_hold_decision" && ((c.uiCardData as any) || {}).resolvedAs === "keep_holding");
    if (lastKeep) {
      const keptAt = new Date(((lastKeep.uiCardData as any) || {}).resolvedAt || 0).getTime();
      if (keptAt && now - keptAt < KEEP_REASK_MS) continue;
    }

    // 4. Ask the provider what to do (card is hidden from parents).
    await prisma.aiChatMessage.create({
      data: {
        sessionId: inv.sessionId,
        role: "assistant",
        content: `${parentName}'s deposit for ${donorLabel} is still unpaid and past its due date, so she's been sitting on hold. Should I keep holding her, or release her back to the marketplace? If you choose release, I'll give ${parentName} a heads-up and a final window to pay first.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "donor_hold_decision",
        uiCardData: {
          donorId: donor.id,
          donorLabel,
          subjectType: donor.subjectType,
          invoiceId: inv.id,
          parentName,
          resolvedAt: null,
          resolvedAs: null,
        },
      },
    }).catch(() => {});
    if (inv.providerId) {
      await notifyUsers(prisma, await providerUserIds(prisma, inv.providerId), "DONOR_HOLD_DECISION", {
        sessionId: inv.sessionId, donorId: donor.id, donorLabel, parentName,
        message: `${parentName}'s deposit for ${donorLabel} is overdue - decide whether to keep holding her or release her.`,
      });
    }
    console.log(`[donor-hold] Asked provider about ${donorLabel} (invoice ${inv.id} overdue)`);
  }
}

/** Every 10 min: fail agreements stranded in DRAFT by a mid-send restart. */
export async function runStrandedAgreementSweep(prisma: any): Promise<void> {
  const cutoff = new Date(Date.now() - STRANDED_DRAFT_MS);
  const stranded = await prisma.agreement.findMany({
    where: { status: "DRAFT", pandaDocDocumentId: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, sessionId: true, providerId: true, documentType: true },
  });
  for (const agr of stranded) {
    await prisma.agreement.update({ where: { id: agr.id }, data: { status: "ERROR" } }).catch(() => {});
    const docTitle = agr.documentType || "agreement";
    await prisma.aiChatMessage.create({
      data: {
        sessionId: agr.sessionId,
        role: "assistant",
        content: `The ${docTitle} draft was interrupted before it could be sent (most likely a restart mid-send). I've marked it failed - please send the agreement again from the + menu here.`,
        senderType: "system",
        senderName: "GoStork",
        uiCardType: "provider_only",
      },
    }).catch(() => {});
    if (agr.providerId) {
      await notifyUsers(prisma, await providerUserIds(prisma, agr.providerId), "AGREEMENT_DRAFT_STRANDED", {
        sessionId: agr.sessionId, agreementId: agr.id,
        message: `A ${docTitle} draft was interrupted before sending - re-send it from the chat's + menu.`,
      });
    }
    console.log(`[stranded-agreement] Marked agreement ${agr.id} ERROR (draft never sent)`);
  }
}
