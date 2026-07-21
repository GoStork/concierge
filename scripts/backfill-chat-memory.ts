/**
 * One-time backfill (scripts/backfill-chat-memory.ts): run the rolling-summary
 * fold over every EXISTING parent session that already outgrew the model's
 * recent-history window. Each fold also feeds the cross-thread memory
 * extraction, so long-standing parents get both a summary and starter
 * memories from their history. Idempotent: the summarizedThrough watermark
 * makes re-runs no-ops, and sessions still inside the window are skipped.
 * Run: npx tsx --env-file=.env scripts/backfill-chat-memory.ts
 */
async function main() {
  const { prisma } = await import("../server/db.js");
  const { maybeUpdateSessionSummary, CHAT_HISTORY_WINDOW } = await import("../server/concierge-memory.js");

  const sessions = await prisma.aiChatSession.findMany({
    where: { sessionType: "PARENT", summarizedThrough: null },
    select: { id: true, title: true, _count: { select: { messages: { where: { role: { in: ["user", "assistant"] } } } } } },
  });
  const eligible = sessions.filter((s: any) => s._count.messages >= CHAT_HISTORY_WINDOW + 8);
  console.log(`${sessions.length} un-summarized parent sessions, ${eligible.length} outgrew the window - folding those...`);

  let done = 0, failed = 0;
  for (const s of eligible) {
    try {
      await maybeUpdateSessionSummary(s.id);
      done++;
      console.log(`  [${done}/${eligible.length}] ${s.title || s.id} (${(s as any)._count.messages} msgs)`);
    } catch (e: any) {
      failed++;
      console.error(`  FAILED ${s.id}: ${e?.message}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // be gentle on the Gemini quota
  }
  const withSummary = await prisma.aiChatSession.count({ where: { historySummary: { not: null } } });
  const memories = await prisma.conciergeMemory.count();
  console.log(`\nDone: ${done} folded, ${failed} failed. Sessions with summaries: ${withSummary}. Total memories: ${memories}.`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
