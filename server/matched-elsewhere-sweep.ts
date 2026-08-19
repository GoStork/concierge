/**
 * Telling people about the cross-provider outcome.
 *
 * server/matched-elsewhere.ts DERIVES the outcome; this file is the only
 * place that ACTS on it. Two audiences, deliberately different:
 *
 *   - The LOSING provider hears that the family moved on, once, on the line
 *     they lost. They are never told who won - see the rules in
 *     matched-elsewhere.ts. Email + in-app only; no SMS, because "you lost a
 *     lead" is not worth a phone buzz.
 *   - GOSTORK hears about every commitment as it happens, because a paid
 *     invoice or a signed agreement is the business converting.
 *
 * The derived state is permanent but the TELLING must happen exactly once,
 * and both machines run this cron on the same tick. Every notice is claimed
 * through emitJourneyEventOnceKeyed first: the winner of that race sends, the
 * loser returns silently. No read-then-write anywhere in this file.
 */
import { emitJourneyEventOnceKeyed } from "./journey-events";
import { winnersByLine, PRE_ENGAGEMENT_STAGES, type CommitmentArtifact } from "./matched-elsewhere";
import { serviceLineOfSubject } from "./journey-timeline";

/** Human name for a service line id ("egg_donation" -> "egg donation"). */
function lineLabel(line: string): string {
  return line.replace(/_/g, " ");
}

type Db = any;

/**
 * A provider counts as having a real relationship on a line if they got past
 * browsing: a booked consultation, a connected thread, or any paperwork.
 * Mirrors PRE_ENGAGEMENT_STAGES - an agency the family only whispered at has
 * lost nothing and must never be told it did.
 */
const MATERIAL_SESSION_STATUSES = ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"];

/**
 * Don't announce ancient history.
 *
 * The outcome is derived from all time, so the first run of this sweep sees
 * every loss the platform has ever had and would mail agencies about families
 * they stopped thinking about months ago. Same guard, and the same 14 days,
 * as the win-back sweep uses for exactly this reason.
 */
const BACKLOG_CUTOFF_MS = 14 * 24 * 60 * 60 * 1000;

interface LossRow {
  accountId: string;
  line: string;
  loserProviderId: string;
  at: Date;
}

/**
 * Who lost what. Pure derivation over the whole platform, so a provider's own
 * scoped view can never hide the rival artifact that beat them.
 */
export async function computeLosses(prisma: Db): Promise<LossRow[]> {
  const [paidInvoices, signedAgreements, sessions] = await Promise.all([
    // No `parentUserId: { not: null }` guard here: the column is REQUIRED, and
    // Prisma rejects `not: null` on a non-nullable field outright - the whole
    // sweep threw before it read a row.
    prisma.invoice.findMany({
      where: { status: "PAID" },
      select: { parentUserId: true, providerId: true, serviceType: true, paidAt: true, createdAt: true },
    }),
    prisma.agreement.findMany({
      where: { status: "SIGNED", supersededAt: null },
      select: { parentUserId: true, providerId: true, serviceType: true, signedAt: true, createdAt: true },
    }),
    // providerId IS nullable (a parent's own Eva thread has none), so that
    // guard is valid; userId is required, so it must not be guarded.
    prisma.aiChatSession.findMany({
      where: { status: { in: MATERIAL_SESSION_STATUSES }, providerId: { not: null } },
      select: { userId: true, providerId: true, subjectType: true },
    }),
  ]);

  const userIds = Array.from(new Set([
    ...paidInvoices.map((i: any) => i.parentUserId),
    ...signedAgreements.map((a: any) => a.parentUserId),
    ...sessions.map((s: any) => s.userId),
  ].filter(Boolean))) as string[];
  if (!userIds.length) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, parentAccountId: true },
  });
  // parentAccountKey: the account is the family, not the login. A partner
  // paying from their own account still commits the household.
  const acctOf = new Map<string, string>(users.map((u: any) => [u.id, u.parentAccountId || u.id]));

  const artifactsByAccount = new Map<string, CommitmentArtifact[]>();
  const addArtifact = (userId: string, art: CommitmentArtifact) => {
    const acct = acctOf.get(userId);
    if (!acct) return;
    const list = artifactsByAccount.get(acct) || [];
    list.push(art);
    artifactsByAccount.set(acct, list);
  };
  for (const inv of paidInvoices as any[]) {
    addArtifact(inv.parentUserId, {
      providerId: inv.providerId,
      // Invoice.serviceType is display text, Agreement's is the enum; this
      // resolver is substring-based and reads both.
      serviceLine: serviceLineOfSubject(inv.serviceType),
      at: inv.paidAt || inv.createdAt,
    });
  }
  for (const agr of signedAgreements as any[]) {
    addArtifact(agr.parentUserId, {
      providerId: agr.providerId,
      serviceLine: serviceLineOfSubject(agr.serviceType),
      at: agr.signedAt || agr.createdAt,
    });
  }

  // Material relationships per (account, line): sessions past browsing, plus
  // anyone who sent paperwork at all (that is a relationship by definition).
  const materialByAccount = new Map<string, Map<string, Set<string>>>();
  const addMaterial = (userId: string, providerId: string | null, line: string | null) => {
    const acct = acctOf.get(userId);
    if (!acct || !providerId || !line) return;
    const byLine = materialByAccount.get(acct) || new Map<string, Set<string>>();
    const set = byLine.get(line) || new Set<string>();
    set.add(providerId);
    byLine.set(line, set);
    materialByAccount.set(acct, byLine);
  };
  for (const s of sessions as any[]) addMaterial(s.userId, s.providerId, serviceLineOfSubject(s.subjectType));
  for (const inv of paidInvoices as any[]) addMaterial(inv.parentUserId, inv.providerId, serviceLineOfSubject(inv.serviceType));
  for (const agr of signedAgreements as any[]) addMaterial(agr.parentUserId, agr.providerId, serviceLineOfSubject(agr.serviceType));

  const losses: LossRow[] = [];
  for (const [accountId, artifacts] of Array.from(artifactsByAccount.entries())) {
    const winners = winnersByLine(artifacts);
    const byLine = materialByAccount.get(accountId);
    if (!byLine) continue;
    for (const [line, winner] of Array.from(winners.entries())) {
      for (const providerId of Array.from(byLine.get(line) || [])) {
        if (providerId === winner.providerId) continue;
        losses.push({ accountId, line, loserProviderId: providerId, at: winner.at });
      }
    }
  }
  return losses;
}

/**
 * Tell each losing provider, once. Recipients are the lead owner for that
 * family if one is assigned, else the org's staff - a notice nobody is
 * assigned to must not evaporate.
 */
export async function runMatchedElsewhereSweep(prisma: Db, notifications: any): Promise<void> {
  const all = await computeLosses(prisma);
  // computeLosses is all-time by design (the pill and the ladder want every
  // loss, however old); only the TELLING is windowed.
  const cutoff = Date.now() - BACKLOG_CUTOFF_MS;
  const losses = all.filter((l) => l.at.getTime() >= cutoff);
  if (all.length !== losses.length) {
    console.log(`[matched-elsewhere] ${all.length - losses.length} loss(es) older than 14 days - not announced`);
  }
  if (!losses.length) return;

  const providerIds = Array.from(new Set(losses.map((l) => l.loserProviderId)));
  const accountIds = Array.from(new Set(losses.map((l) => l.accountId)));
  const [providers, owners, staff, accountUsers] = await Promise.all([
    prisma.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true } }),
    prisma.parentOwner.findMany({
      where: { parentAccountId: { in: accountIds }, scope: "PROVIDER", providerId: { in: providerIds } },
      select: { parentAccountId: true, providerId: true, ownerUserId: true },
    }),
    prisma.user.findMany({
      where: { providerId: { in: providerIds } },
      select: { id: true, email: true, name: true, providerId: true },
    }),
    prisma.user.findMany({
      where: { OR: [{ parentAccountId: { in: accountIds } }, { id: { in: accountIds } }] },
      select: { id: true, name: true, firstName: true, parentAccountId: true },
    }),
  ]);

  const providerName = new Map<string, string>(providers.map((p: any) => [p.id, p.name]));
  const ownerOf = new Map<string, string>(
    owners.map((o: any) => [`${o.parentAccountId}|${o.providerId}`, o.ownerUserId]),
  );
  const staffById = new Map<string, any>(staff.map((s: any) => [s.id, s]));
  const staffByProvider = new Map<string, any[]>();
  for (const s of staff as any[]) {
    const list = staffByProvider.get(s.providerId) || [];
    list.push(s);
    staffByProvider.set(s.providerId, list);
  }
  const familyName = new Map<string, string>();
  for (const u of accountUsers as any[]) {
    const key = u.parentAccountId || u.id;
    if (!familyName.has(key)) familyName.set(key, u.name || u.firstName || "A family");
  }

  for (const loss of losses) {
    // Claim FIRST. The row is the permission to send, so the other machine's
    // identical tick sends nothing rather than double-mailing an agency.
    const claimed = await emitJourneyEventOnceKeyed({
      eventType: "MATCHED_ELSEWHERE_NOTIFIED",
      onceKey: `${loss.accountId}|${loss.line}|${loss.loserProviderId}`,
      parentAccountId: loss.accountId,
      providerId: loss.loserProviderId,
      metadata: { line: loss.line, at: loss.at.toISOString() },
    });
    if (!claimed) continue;

    const ownerId = ownerOf.get(`${loss.accountId}|${loss.loserProviderId}`);
    const recipients = ownerId && staffById.has(ownerId)
      ? [staffById.get(ownerId)]
      : (staffByProvider.get(loss.loserProviderId) || []);
    if (!recipients.length) continue;

    const family = familyName.get(loss.accountId) || "A family";
    const org = providerName.get(loss.loserProviderId) || "your agency";

    for (const r of recipients) {
      await prisma.inAppNotification.create({
        data: {
          userId: r.id,
          eventType: "matched_elsewhere",
          payload: {
            parentAccountId: loss.accountId,
            serviceLine: loss.line,
            familyName: family,
            // NEVER the winner. This payload reaches the losing provider's
            // own browser.
            message: `${family} has moved forward with another provider for ${lineLabel(loss.line)}.`,
          } as any,
        },
      }).catch(() => {});
    }

    await notifications?.sendMatchedElsewhereNotice?.({
      recipients: recipients.map((r: any) => ({ userId: r.id, email: r.email, name: r.name })),
      providerName: org,
      familyName: family,
      serviceLine: lineLabel(loss.line),
      parentAccountId: loss.accountId,
    }).catch((e: any) => console.error(`[matched-elsewhere] notice failed: ${e?.message}`));

    console.log(`[matched-elsewhere] Told ${org} they lost ${lineLabel(loss.line)} for ${loss.accountId}`);
  }
}

/**
 * GoStork's own alert on a commitment.
 *
 * Called from the invoice-paid and agreement-signed paths so "immediate"
 * really is immediate. On a digest cadence this returns after claiming
 * nothing - the digest sweep reads the INVOICE_PAID / AGREEMENT_SIGNED
 * journey events directly, so there is no queue to keep in sync.
 */
export async function alertGoStorkCommitment(prisma: Db, notifications: any, input: {
  kind: "invoice_paid" | "agreement_signed";
  parentUserId: string | null;
  providerId: string | null;
  serviceType: string | null;
  amountCents?: number | null;
  refId: string;
}): Promise<void> {
  try {
    const cadence = await getCommitmentCadence(prisma);
    if (cadence !== "immediate") return;
    await sendCommitmentAlerts(prisma, notifications, [{
      kind: input.kind,
      parentUserId: input.parentUserId,
      providerId: input.providerId,
      serviceType: input.serviceType,
      amountCents: input.amountCents ?? null,
      refId: input.refId,
      at: new Date(),
    }]);
  } catch (e: any) {
    console.error(`[commitment-alert] ${input.kind} failed: ${e?.message}`);
  }
}

/**
 * Has this provider lost this thread's service line to someone else?
 *
 * The per-relationship question, for the automated nudges - as opposed to
 * computeLosses(), which answers it for the whole platform at once. Chasing a
 * family to rebook with an agency they have already passed over is the single
 * worst thing the automation can do, so the win-back paths ask this first.
 *
 * Runs the full winner comparison rather than "did a rival commit?": this
 * provider may hold the EARLIER commitment on the line, in which case they
 * won it and a later rival artifact changes nothing.
 */
export async function isLineLostToRival(prisma: Db, opts: {
  parentUserId: string;
  providerId: string | null;
  sessionId?: string | null;
}): Promise<boolean> {
  try {
    if (!opts.providerId || !opts.sessionId) return false;
    const session = await prisma.aiChatSession.findUnique({
      where: { id: opts.sessionId },
      select: { subjectType: true },
    });
    const line = serviceLineOfSubject(session?.subjectType);
    if (!line) return false;

    const me = await prisma.user.findUnique({
      where: { id: opts.parentUserId },
      select: { parentAccountId: true },
    });
    const memberIds: string[] = me?.parentAccountId
      ? (await prisma.user.findMany({
          where: { parentAccountId: me.parentAccountId },
          select: { id: true },
        })).map((u: any) => u.id)
      : [opts.parentUserId];

    const [invs, agrs] = await Promise.all([
      prisma.invoice.findMany({
        where: { parentUserId: { in: memberIds }, status: "PAID" },
        select: { providerId: true, serviceType: true, paidAt: true, createdAt: true },
      }),
      prisma.agreement.findMany({
        where: { parentUserId: { in: memberIds }, status: "SIGNED", supersededAt: null },
        select: { providerId: true, serviceType: true, signedAt: true, createdAt: true },
      }),
    ]);
    const winners = winnersByLine([
      ...invs.map((i: any) => ({
        providerId: i.providerId, serviceLine: serviceLineOfSubject(i.serviceType), at: i.paidAt || i.createdAt,
      })),
      ...agrs.map((a: any) => ({
        providerId: a.providerId, serviceLine: serviceLineOfSubject(a.serviceType), at: a.signedAt || a.createdAt,
      })),
    ]);
    const winner = winners.get(line);
    return !!winner && winner.providerId !== opts.providerId;
  } catch (e: any) {
    // Never block a nudge on this check failing - a missed suppression is a
    // wasted message, but a thrown error here would kill the whole sweep.
    console.error(`[matched-elsewhere] suppression check failed: ${e?.message}`);
    return false;
  }
}

/**
 * Fired for EVERY INVOICE_PAID / AGREEMENT_SIGNED journey event, from
 * emitJourneyEvent itself rather than from the five call sites that raise
 * them. Hooking the sites would have meant remembering to hook the sixth.
 *
 * Fire-and-forget and completely swallowed: an alert must never be able to
 * fail the payment or signature path that triggered it.
 */
export async function onCommitmentEmitted(
  eventType: "INVOICE_PAID" | "AGREEMENT_SIGNED",
  input: { parentUserId?: string | null; providerId?: string | null; metadata?: Record<string, unknown> | null },
): Promise<void> {
  try {
    const { prisma } = await import("./db");
    if ((await getCommitmentCadence(prisma)) !== "immediate") return;
    const { getNestApp } = await import("./nest-app-ref");
    const nestApp = getNestApp();
    if (!nestApp) return;
    const { NotificationService } = await import("./src/modules/notifications/notification.service");
    const notifications = nestApp.get(NotificationService);
    const meta = (input.metadata || {}) as any;
    await sendCommitmentAlerts(prisma, notifications, [{
      kind: eventType === "INVOICE_PAID" ? "invoice_paid" : "agreement_signed",
      parentUserId: input.parentUserId ?? null,
      providerId: input.providerId ?? null,
      serviceType: meta.serviceType ?? meta.documentType ?? null,
      amountCents: meta.amountCents ?? null,
      refId: meta.invoiceId || meta.agreementId || "",
      at: new Date(),
    }]);
  } catch (e: any) {
    console.error(`[commitment-alert] ${eventType} hook failed: ${e?.message}`);
  }
}

export type CommitmentCadence = "immediate" | "daily" | "weekly";

export async function getCommitmentCadence(prisma: Db): Promise<CommitmentCadence> {
  const s = await prisma.siteSettings.findFirst({ select: { commitmentAlertCadence: true } }).catch(() => null);
  const v = (s?.commitmentAlertCadence || "immediate") as CommitmentCadence;
  return v === "daily" || v === "weekly" ? v : "immediate";
}

interface CommitmentItem {
  kind: "invoice_paid" | "agreement_signed";
  parentUserId: string | null;
  providerId: string | null;
  serviceType: string | null;
  amountCents: number | null;
  refId: string;
  at: Date;
}

async function sendCommitmentAlerts(prisma: Db, notifications: any, items: CommitmentItem[]): Promise<void> {
  if (!items.length) return;
  const admins = await prisma.user.findMany({
    where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] } },
    select: { id: true, email: true, name: true },
  });
  if (!admins.length) return;

  const providerIds = Array.from(new Set(items.map((i) => i.providerId).filter(Boolean))) as string[];
  const parentIds = Array.from(new Set(items.map((i) => i.parentUserId).filter(Boolean))) as string[];
  const [providers, parents] = await Promise.all([
    providerIds.length
      ? prisma.provider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true } })
      : [],
    parentIds.length
      ? prisma.user.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true, firstName: true } })
      : [],
  ]);
  const pName = new Map<string, string>(providers.map((p: any) => [p.id, p.name]));
  const uName = new Map<string, string>(parents.map((u: any) => [u.id, u.name || u.firstName || "A parent"]));

  const lines = items.map((i) => ({
    ...i,
    providerName: i.providerId ? pName.get(i.providerId) || "A provider" : "A provider",
    parentName: i.parentUserId ? uName.get(i.parentUserId) || "A parent" : "A parent",
    parentUserId: i.parentUserId || null,
  }));

  for (const a of admins as any[]) {
    for (const l of lines) {
      await prisma.inAppNotification.create({
        data: {
          userId: a.id,
          eventType: "commitment",
          payload: {
            kind: l.kind,
            providerName: l.providerName,
            parentName: l.parentName,
            serviceType: l.serviceType,
            amountCents: l.amountCents,
            refId: l.refId,
          } as any,
        },
      }).catch(() => {});
    }
  }

  await notifications?.sendCommitmentAlert?.({
    recipients: (admins as any[]).map((a) => ({ userId: a.id, email: a.email, name: a.name })),
    items: lines,
  }).catch((e: any) => console.error(`[commitment-alert] email failed: ${e?.message}`));
}

/**
 * Daily / weekly digest of commitments GoStork has not been told about yet.
 *
 * Reads the INVOICE_PAID and AGREEMENT_SIGNED journey events rather than a
 * queue of its own, and marks each one with a COMMITMENT_ALERTED row - so the
 * "what is still unsent" question is answered by data that already exists and
 * cannot drift out of sync with it.
 */
export async function runCommitmentDigestSweep(prisma: Db, notifications: any): Promise<void> {
  try {
    const cadence = await getCommitmentCadence(prisma);
    if (cadence === "immediate") return;

    const windowMs = (cadence === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - windowMs);
    const last = await prisma.journeyEvent.findFirst({
      where: { eventType: "COMMITMENT_ALERTED", metadata: { path: ["digest"], equals: cadence } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    // Not due yet. Anchored to the last digest, never to a rolling clock.
    if (last && Date.now() - new Date(last.createdAt).getTime() < windowMs) return;

    const events = await prisma.journeyEvent.findMany({
      where: { eventType: { in: ["INVOICE_PAID", "AGREEMENT_SIGNED"] }, createdAt: { gte: since } },
      select: { id: true, eventType: true, providerId: true, parentAccountId: true, metadata: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    if (!events.length) return;

    // One claim for the whole digest run, so two machines cannot both send it.
    const claimed = await emitJourneyEventOnceKeyed({
      eventType: "COMMITMENT_ALERTED",
      onceKey: `digest:${cadence}:${Math.floor(Date.now() / windowMs)}`,
      parentAccountId: events[0].parentAccountId,
      metadata: { digest: cadence, count: events.length },
    });
    if (!claimed) return;

    await sendCommitmentAlerts(prisma, notifications, events.map((e: any) => ({
      kind: e.eventType === "INVOICE_PAID" ? "invoice_paid" : "agreement_signed",
      parentUserId: null,
      providerId: e.providerId,
      serviceType: (e.metadata as any)?.serviceType ?? null,
      amountCents: (e.metadata as any)?.amountCents ?? null,
      refId: (e.metadata as any)?.invoiceId || (e.metadata as any)?.agreementId || e.id,
      at: e.createdAt,
    })));
    console.log(`[commitment-digest] Sent ${cadence} digest of ${events.length} commitment(s)`);
  } catch (e: any) {
    console.error(`[commitment-digest] failed: ${e?.message}`);
  }
}

