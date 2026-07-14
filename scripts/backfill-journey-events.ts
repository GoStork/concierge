/**
 * One-time backfill (safe to re-run): synthesize JourneyEvent rows for
 * everything that happened BEFORE the Phase 7A event emitters shipped.
 * The append-only event log only captures live flows from deploy day
 * onward, so the "Recent activity" feed showed journeys starting mid-way
 * (e.g. only the outcome-sweep completions) with nothing before or after.
 *
 * Sources mirror the journey-timeline deriver's evidence:
 *  - Booking rows      -> CONSULTATION_/MATCH_CALL_ SCHEDULED / CANCELED /
 *                         COMPLETED / NO_SHOW_* (outcome + outcomeAt)
 *  - Invoice rows      -> INVOICE_SENT / INVOICE_PAID / BANK_CHECKOUT_STARTED
 *  - Agreement rows    -> AGREEMENT_SENT / AGREEMENT_SIGNED
 *  - AiChatSession     -> HANDOFF_COMPLETED (handoffCompletedAt stamp)
 *
 * Each event is written with its HISTORICAL timestamp (createdAt override)
 * and deduped against existing rows (bookingId / metadata.invoiceId /
 * metadata.agreementId / sessionId + eventType), so re-running or running
 * after live emitters already fired never duplicates.
 *
 * Run: npx tsx -r dotenv/config scripts/backfill-journey-events.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const accountCache = new Map<string, string>();
async function accountIdFor(parentUserId: string): Promise<string> {
  const hit = accountCache.get(parentUserId);
  if (hit) return hit;
  const u = await prisma.user.findUnique({ where: { id: parentUserId }, select: { parentAccountId: true } });
  const acc = u?.parentAccountId || parentUserId;
  accountCache.set(parentUserId, acc);
  return acc;
}

let created = 0;
let skipped = 0;

async function insertOnce(input: {
  eventType: string;
  parentAccountId: string;
  providerId?: string | null;
  sessionId?: string | null;
  bookingId?: string | null;
  actorRole?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  dedupe: { bookingId?: string; invoiceId?: string; agreementId?: string; sessionId?: string };
}) {
  const where: any = { eventType: input.eventType };
  if (input.dedupe.bookingId) where.bookingId = input.dedupe.bookingId;
  else if (input.dedupe.invoiceId) where.metadata = { path: ["invoiceId"], equals: input.dedupe.invoiceId };
  else if (input.dedupe.agreementId) where.metadata = { path: ["agreementId"], equals: input.dedupe.agreementId };
  else if (input.dedupe.sessionId) where.sessionId = input.dedupe.sessionId;
  const prior = await prisma.journeyEvent.findFirst({ where, select: { id: true } });
  if (prior) { skipped++; return; }

  await prisma.journeyEvent.create({
    data: {
      parentAccountId: input.parentAccountId,
      providerId: input.providerId || null,
      sessionId: input.sessionId || null,
      bookingId: input.bookingId || null,
      eventType: input.eventType,
      actorRole: input.actorRole || "system",
      metadata: { ...(input.metadata || {}), backfilled: true } as any,
      createdAt: input.createdAt,
    },
  });
  created++;
}

async function backfillBookings() {
  const bookings = await prisma.booking.findMany({
    where: { parentUserId: { not: null } },
    select: {
      id: true, parentUserId: true, status: true, outcome: true, outcomeAt: true,
      scheduledAt: true, createdAt: true, cancelledAt: true, meetingSubtype: true,
      providerUser: { select: { providerId: true, roles: true, provider: { select: { name: true } } } },
    },
  });
  for (const bk of bookings) {
    const providerId = bk.providerUser?.providerId;
    if (!providerId || !bk.parentUserId) continue;
    const provName = (bk.providerUser?.provider?.name || "").trim().toLowerCase();
    if (provName === "gostork" || (bk.providerUser?.roles || []).some((r: any) => String(r).startsWith("GOSTORK"))) continue;

    const family = bk.meetingSubtype === "MATCH_CALL" ? "MATCH_CALL" : "CONSULTATION";
    const acc = await accountIdFor(bk.parentUserId);
    const base = { parentAccountId: acc, providerId, bookingId: bk.id, metadata: { scheduledAt: bk.scheduledAt, meetingSubtype: bk.meetingSubtype || null } };

    await insertOnce({ ...base, eventType: `${family}_SCHEDULED`, actorRole: "parent", createdAt: bk.createdAt, dedupe: { bookingId: bk.id } });
    if (bk.status === "CANCELLED" && bk.cancelledAt) {
      await insertOnce({ ...base, eventType: `${family}_CANCELED`, createdAt: bk.cancelledAt, dedupe: { bookingId: bk.id } });
    }
    if (bk.outcome && bk.outcome !== "UNVERIFIED" && bk.outcomeAt) {
      const suffix = bk.outcome === "COMPLETED" ? "COMPLETED" : bk.outcome; // NO_SHOW_* pass through
      // The call itself happened (or was missed) at the SLOT time - the
      // sweep only verified it later. Use scheduledAt for the feed date.
      await insertOnce({ ...base, eventType: `${family}_${suffix}`, createdAt: bk.scheduledAt || bk.outcomeAt, dedupe: { bookingId: bk.id } });
    }
  }
}

async function backfillInvoices() {
  const invoices = await prisma.invoice.findMany({
    select: {
      id: true, parentUserId: true, providerId: true, sessionId: true, status: true,
      createdAt: true, paidAt: true, triggerSource: true, serviceAmount: true,
    },
  });
  for (const inv of invoices) {
    if (!inv.parentUserId || !inv.providerId) continue;
    const acc = await accountIdFor(inv.parentUserId);
    const base = {
      parentAccountId: acc, providerId: inv.providerId, sessionId: inv.sessionId,
      metadata: { invoiceId: inv.id, amountCents: inv.serviceAmount, triggerSource: inv.triggerSource },
    };
    if (inv.triggerSource === "BANK_CHECKOUT") {
      await insertOnce({ ...base, eventType: "BANK_CHECKOUT_STARTED", actorRole: "parent", createdAt: inv.createdAt, dedupe: { invoiceId: inv.id } });
    } else {
      await insertOnce({ ...base, eventType: "INVOICE_SENT", actorRole: "provider", createdAt: inv.createdAt, dedupe: { invoiceId: inv.id } });
    }
    if (inv.status === "PAID" && inv.paidAt) {
      await insertOnce({ ...base, eventType: "INVOICE_PAID", actorRole: "parent", createdAt: inv.paidAt, dedupe: { invoiceId: inv.id } });
    }
  }
}

async function backfillAgreements() {
  const agreements = await prisma.agreement.findMany({
    select: { id: true, parentUserId: true, providerId: true, sessionId: true, status: true, createdAt: true, signedAt: true },
  });
  for (const agr of agreements) {
    if (!agr.parentUserId || !agr.providerId) continue;
    const acc = await accountIdFor(agr.parentUserId);
    const base = { parentAccountId: acc, providerId: agr.providerId, sessionId: agr.sessionId, metadata: { agreementId: agr.id } };
    if (["SENT", "SIGNED", "REJECTED", "EXPIRED"].includes(agr.status)) {
      await insertOnce({ ...base, eventType: "AGREEMENT_SENT", actorRole: "provider", createdAt: agr.createdAt, dedupe: { agreementId: agr.id } });
    }
    if (agr.status === "SIGNED") {
      await insertOnce({ ...base, eventType: "AGREEMENT_SIGNED", actorRole: "parent", createdAt: agr.signedAt || agr.createdAt, dedupe: { agreementId: agr.id } });
    }
  }
}

async function backfillHandoffs() {
  const sessions = await prisma.aiChatSession.findMany({
    where: { handoffCompletedAt: { not: null }, providerId: { not: null } },
    select: { id: true, userId: true, providerId: true, handoffCompletedAt: true },
  });
  for (const s of sessions) {
    if (!s.userId) continue;
    const acc = await accountIdFor(s.userId);
    await insertOnce({
      parentAccountId: acc, providerId: s.providerId, sessionId: s.id,
      eventType: "HANDOFF_COMPLETED", createdAt: s.handoffCompletedAt!,
      dedupe: { sessionId: s.id },
    });
  }
}

async function main() {
  await backfillBookings();
  await backfillInvoices();
  await backfillAgreements();
  await backfillHandoffs();
  console.log(`Done. created=${created} skipped(existing)=${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
