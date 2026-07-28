/**
 * One-time backfill (scripts/merge-legacy-eva-threads.ts): fold a parent's
 * leftover private Eva threads into their one lifetime concierge thread.
 *
 * Eva is meant to be a single lifetime thread per parent account, always
 * titled "AI Concierge Chat" - /init-session reuses the most recently updated
 * non-provider-joined session and refuses to rename it (ai-router.ts). Parents
 * from before that rule can carry several private threads titled after a
 * subject ("Donor #KNG20"), and the sidebar lists EVERY private thread since
 * 43a88d9, so each one renders as its own "Ariel" row. Worse, the parent's
 * history is split across them while the AI only ever reads the most recent.
 *
 * "Private" here matches the sidebar's own isProviderThread test exactly:
 * providerJoinedAt == null AND status not in (CONSULTATION_BOOKED,
 * PROVIDER_CONNECTED). Provider threads are separate conversations and are
 * never touched.
 *
 * Survivor = the oldest thread titled "AI Concierge Chat", else the oldest
 * thread. Messages keep their own createdAt, so the merged transcript reads in
 * true chronological order rather than one thread appended to the other.
 *
 * Every table that points at a session is repointed before the empty shell is
 * deleted: AiChatMessage, SilentQuery, Agreement, Invoice, ProviderQuote,
 * CostSheetReminder, ProfileInquiry, Booking, JourneyEvent. The two carrying a
 * unique constraint that can collide on merge (ProfileInquiry per profile,
 * CostSheetReminder per booking+window) drop the loser row instead - the
 * survivor already records the same fact.
 *
 * Dry run by default. Run:
 *   npx tsx --env-file=.env scripts/merge-legacy-eva-threads.ts
 *   npx tsx --env-file=.env scripts/merge-legacy-eva-threads.ts --apply
 */
const APPLY = process.argv.includes("--apply");

async function main() {
  const { prisma } = await import("../server/db.js");

  const sessions = await prisma.aiChatSession.findMany({
    where: {
      sessionType: "PARENT",
      providerJoinedAt: null,
      status: { notIn: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] },
    },
    select: {
      id: true,
      userId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      subjectProfileId: true,
      subjectType: true,
      lastUploadedPhotoUrl: true,
      user: { select: { parentAccountId: true, email: true } },
      _count: { select: { messages: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Shared-account logins chat in the same thread, so group by account.
  const byAccount = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const key = s.user?.parentAccountId || s.userId;
    const list = byAccount.get(key) || [];
    list.push(s);
    byAccount.set(key, list);
  }

  const duplicated = [...byAccount.entries()].filter(([, list]) => list.length > 1);
  console.log(
    `${sessions.length} private Eva threads across ${byAccount.size} accounts; ` +
      `${duplicated.length} account(s) carry more than one.`,
  );
  if (duplicated.length === 0) return;

  let mergedThreads = 0;
  let movedMessages = 0;

  for (const [accountId, list] of duplicated) {
    const canonical = list.find((s) => (s.title || "").trim().toLowerCase() === "ai concierge chat") || list[0];
    const losers = list.filter((s) => s.id !== canonical.id);
    const email = canonical.user?.email || accountId;

    console.log(`\n${email}`);
    console.log(`  keep  ${canonical.id}  "${canonical.title}"  ${canonical._count.messages} msgs  (${canonical.createdAt.toISOString().slice(0, 10)})`);
    for (const l of losers) {
      console.log(`  fold  ${l.id}  "${l.title}"  ${l._count.messages} msgs  (${l.createdAt.toISOString().slice(0, 10)})`);
    }
    if (!APPLY) {
      mergedThreads += losers.length;
      movedMessages += losers.reduce((n, l) => n + l._count.messages, 0);
      continue;
    }

    for (const loser of losers) {
      await prisma.$transaction(async (tx: any) => {
        // Uniques first: a fact the survivor already carries is dropped rather
        // than moved, so the repoint below can never trip a constraint.
        const inquiries = await tx.profileInquiry.findMany({
          where: { sessionId: loser.id },
          select: { id: true, profileId: true },
        });
        for (const inq of inquiries) {
          const clash = await tx.profileInquiry.findUnique({
            where: { sessionId_profileId: { sessionId: canonical.id, profileId: inq.profileId } },
            select: { id: true },
          });
          if (clash) await tx.profileInquiry.delete({ where: { id: inq.id } });
          else await tx.profileInquiry.update({ where: { id: inq.id }, data: { sessionId: canonical.id } });
        }

        const reminders = await tx.costSheetReminder.findMany({
          where: { sessionId: loser.id },
          select: { id: true, bookingId: true, window: true },
        });
        for (const rem of reminders) {
          const clash = await tx.costSheetReminder.findUnique({
            where: {
              sessionId_bookingId_window: {
                sessionId: canonical.id,
                bookingId: rem.bookingId,
                window: rem.window,
              },
            },
            select: { id: true },
          });
          if (clash) await tx.costSheetReminder.delete({ where: { id: rem.id } });
          else await tx.costSheetReminder.update({ where: { id: rem.id }, data: { sessionId: canonical.id } });
        }

        const moved = await tx.aiChatMessage.updateMany({
          where: { sessionId: loser.id },
          data: { sessionId: canonical.id },
        });
        await tx.silentQuery.updateMany({ where: { sessionId: loser.id }, data: { sessionId: canonical.id } });
        await tx.agreement.updateMany({ where: { sessionId: loser.id }, data: { sessionId: canonical.id } });
        await tx.invoice.updateMany({ where: { sessionId: loser.id }, data: { sessionId: canonical.id } });
        await tx.providerQuote.updateMany({ where: { sessionId: loser.id }, data: { sessionId: canonical.id } });
        await tx.booking.updateMany({ where: { sessionId: loser.id }, data: { sessionId: canonical.id } });
        await tx.journeyEvent.updateMany({ where: { sessionId: loser.id }, data: { sessionId: canonical.id } });

        // Carry the subject context forward only where the survivor has none -
        // the next /init-session re-points it anyway, and guessing here would
        // mis-attribute inquiries.
        const carry: any = {};
        if (!canonical.subjectProfileId && loser.subjectProfileId) {
          carry.subjectProfileId = loser.subjectProfileId;
          carry.subjectType = loser.subjectType;
        }
        if (!canonical.lastUploadedPhotoUrl && loser.lastUploadedPhotoUrl) {
          carry.lastUploadedPhotoUrl = loser.lastUploadedPhotoUrl;
        }
        // The rolling summary described one half of a thread that just got
        // longer in the middle. Clear the watermark so it re-folds.
        await tx.aiChatSession.update({
          where: { id: canonical.id },
          data: { ...carry, title: "AI Concierge Chat", historySummary: null, summarizedThrough: null },
        });

        await tx.aiChatSession.delete({ where: { id: loser.id } });
        movedMessages += moved.count;
        mergedThreads++;
      });
      console.log(`    folded ${loser.id} -> ${canonical.id}`);
    }
  }

  console.log(
    `\n${APPLY ? "Merged" : "Would merge"} ${mergedThreads} thread(s), ` +
      `moving ${movedMessages} message(s).${APPLY ? "" : "  Re-run with --apply to write."}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
