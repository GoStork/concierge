/**
 * Intended Parent Form flow triggers (pattern: review-prompts.ts).
 *
 * maybePromptIpForm - called from the call-outcome sweep when a consultation
 * with a SURROGACY agency completes. Posts Eva's ip_form_prompt card into
 * the parent's concierge chat (parent-private, like review_prompt), stamps
 * IpFormResponse.promptedAt (the reminder anchor), notifies in-app, and
 * sends the kickoff email. Advisory-locked: the sweep runs on more than one
 * machine against the shared DB.
 *
 * runIpFormReminderSweep - every 10 min, walks DRAFT responses with a
 * promptedAt and delivers the reminder ladder (day3 email+inapp, day7
 * email+SMS+inapp, day14 email+inapp, day28/42/56 email), capped at 60
 * days. Dedupe is the IpFormReminder unique constraint - safe cross-process.
 */
import { prisma } from "./db";
import { emitJourneyEvent } from "./journey-events";
import { sendIpFormParentNudge } from "./notify-ip-form";

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_MAX_AGE_MS = 60 * DAY_MS;

/** Ladder: type -> { afterDays, channels }. Later rungs supersede earlier unsent ones. */
const REMINDER_LADDER: { type: string; afterDays: number; channels: ("email" | "sms" | "inapp")[] }[] = [
  { type: "day3", afterDays: 3, channels: ["email", "inapp"] },
  { type: "day7", afterDays: 7, channels: ["email", "sms", "inapp"] },
  { type: "day14", afterDays: 14, channels: ["email", "inapp"] },
  { type: "day28", afterDays: 28, channels: ["email"] },
  { type: "day42", afterDays: 42, channels: ["email"] },
  { type: "day56", afterDays: 56, channels: ["email"] },
];

async function accountIdsFor(parentUserId: string): Promise<{ accountId: string; memberIds: string[] }> {
  const u = await prisma.user.findUnique({ where: { id: parentUserId }, select: { id: true, parentAccountId: true } });
  if (!u) return { accountId: parentUserId, memberIds: [parentUserId] };
  const accountId = u.parentAccountId || u.id;
  const members = u.parentAccountId
    ? await prisma.user.findMany({ where: { parentAccountId: u.parentAccountId }, select: { id: true } })
    : [{ id: u.id }];
  return { accountId, memberIds: members.map((m) => m.id) };
}

/** The parent's primary concierge chat - where the prompt card lives. */
async function findEvaSession(memberIds: string[]): Promise<string | null> {
  const s = await prisma.aiChatSession.findFirst({
    where: { userId: { in: memberIds }, status: "ACTIVE", sessionType: "PARENT", matchmakerId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return s?.id || null;
}

/**
 * Post the "please fill your Intended Parent Form" prompt once per account.
 * Fire-and-forget safe. Gated to providers with an APPROVED surrogacy
 * service; the GoStork house provider never triggers it.
 */
export async function maybePromptIpForm(opts: { parentUserId: string; providerId: string }): Promise<void> {
  try {
    const provider = await prisma.provider.findUnique({
      where: { id: opts.providerId },
      select: {
        id: true,
        name: true,
        services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } },
      },
    });
    if (!provider) return;
    if ((provider.name || "").trim().toLowerCase() === "gostork") return;
    const isSurrogacy = provider.services.some((s) => (s.providerType?.name || "").toLowerCase().includes("surrogacy"));
    if (!isSurrogacy) return;

    const { accountId, memberIds } = await accountIdsFor(opts.parentUserId);
    const existing = await prisma.ipFormResponse.findUnique({ where: { parentAccountId: accountId } });
    if (existing?.promptedAt || existing?.status === "SUBMITTED") return;

    const sessionId = await findEvaSession(memberIds);

    // Claim under an advisory lock - two machines' sweeps fire in the same
    // second (same failure mode the review prompts hit).
    const lockKey = `ip-form-prompt:${accountId}`;
    let claimed = false;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const fresh = await tx.ipFormResponse.findUnique({ where: { parentAccountId: accountId } });
      if (fresh?.promptedAt || fresh?.status === "SUBMITTED") return;
      if (fresh) {
        await tx.ipFormResponse.update({ where: { id: fresh.id }, data: { promptedAt: new Date() } });
      } else {
        await tx.ipFormResponse.create({ data: { parentAccountId: accountId, promptedAt: new Date() } });
      }
      claimed = true;
    });
    if (!claimed) return;

    const response = await prisma.ipFormResponse.findUnique({ where: { parentAccountId: accountId } });

    if (sessionId) {
      await prisma.aiChatMessage.create({
        data: {
          sessionId,
          role: "assistant",
          // Keep this narrative in sync with the kickoff email in
          // notify-ip-form.ts - the parent should hear ONE story everywhere.
          content:
            `What a milestone - your first call with ${provider.name} is done! Here's what comes next on your journey: your Match Call, a video call with a surrogate who could be carrying for your family.\n\n` +
            `Before that call can be scheduled, ${provider.name} needs your Intended Parent Form. This is how a potential surrogate gets to know you - your story, your photos, and a personal letter from you to her. She reads it and decides whether she'd like to meet you, so this form is what unlocks your match call.\n\n` +
            `It takes about 20-30 minutes, saves as you go, and both partners can fill their parts in parallel. I'm right here if you'd like help with any question - especially the letter, that one deserves a little love!`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "ip_form_prompt",
          uiCardData: {
            providerId: provider.id,
            providerName: provider.name,
            responseId: response?.id || null,
            submitted: false,
          },
        },
      });
    }

    void emitJourneyEvent({
      eventType: "IP_FORM_PROMPTED",
      parentAccountId: accountId,
      providerId: provider.id,
      sessionId: sessionId || undefined,
      metadata: { responseId: response?.id },
    });

    if (response) {
      void sendIpFormParentNudge({
        responseId: response.id,
        reminderType: null,
        channels: ["email", "inapp"],
        providerName: provider.name,
      }).catch((e: any) => console.error(`[ip-form] kickoff nudge failed: ${e?.message}`));
    }
    console.log(`[ip-form] Prompted account ${accountId} to fill the IP form (after call with ${provider.name})`);
  } catch (e: any) {
    console.error(`[ip-form] maybePromptIpForm failed: ${e?.message}`);
  }
}

/** Every 10 min: deliver the reminder ladder for unfinished prompted forms. */
export async function runIpFormReminderSweep(): Promise<void> {
  const now = Date.now();
  const responses = await prisma.ipFormResponse.findMany({
    where: {
      status: "DRAFT",
      promptedAt: { not: null, gte: new Date(now - REMINDER_MAX_AGE_MS), lte: new Date(now - 3 * DAY_MS) },
    },
    select: { id: true, promptedAt: true },
  });
  for (const r of responses) {
    const elapsedDays = (now - r.promptedAt!.getTime()) / DAY_MS;
    // Only the LATEST due rung fires; the ledger unique constraint dedupes
    // across processes and re-runs.
    const due = [...REMINDER_LADDER].reverse().find((l) => elapsedDays >= l.afterDays);
    if (!due) continue;
    await sendIpFormParentNudge({
      responseId: r.id,
      reminderType: due.type,
      channels: due.channels,
      providerName: null,
    }).catch((e: any) => console.error(`[ip-form] reminder sweep failed for ${r.id}: ${e?.message}`));
  }
}
