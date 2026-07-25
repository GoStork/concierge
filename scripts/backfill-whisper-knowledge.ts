/**
 * Backfill: ingest existing answered whispers into the knowledge base.
 *
 * Going forward, chat-router ingests agency-level answers at relay time. This
 * catches everything answered BEFORE that shipped. Person-specific answers are
 * rejected by the shared classifier and stay bound to their own profile.
 *
 * Usage:
 *   npx tsx scripts/backfill-whisper-knowledge.ts            # dry run
 *   npx tsx scripts/backfill-whisper-knowledge.ts --apply    # write
 */

import * as fs from "fs";
import * as path from "path";

// Load env before importing anything that reads it at module scope.
(function ensureEnv() {
  const content = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  for (const key of ["DATABASE_URL", "DIRECT_URL", "GEMINI_API_KEY"]) {
    if (process.env[key]) continue;
    const m = content.match(new RegExp(`^${key}="?([^"\\n]+)"?`, "m"));
    if (m) process.env[key] = m[1];
  }
})();

const APPLY = process.argv.includes("--apply");

(async () => {
  const { prisma } = await import("../server/db");
  const { ingestAgencyAnswerToKnowledgeBase, sanitizeReusableQuestion, isAgencyLevelPair, ASKER_IDENTITY_IN_ANSWER } =
    await import("../server/whisper-knowledge");

  const rows = await prisma.silentQuery.findMany({
    where: { status: { in: ["ANSWERED", "RELAYED"] }, answerText: { not: null } },
    select: { id: true, providerId: true, questionText: true, answerText: true },
    orderBy: { updatedAt: "desc" },
  });
  console.log(`Found ${rows.length} answered whisper(s).${APPLY ? "" : "  (dry run - pass --apply to write)"}\n`);

  const tally: Record<string, number> = {};
  for (const r of rows) {
    const answer = (r.answerText || "").trim();
    const q = sanitizeReusableQuestion(r.questionText);
    const agencyLevel = !!q && !ASKER_IDENTITY_IN_ANSWER.test(answer) && isAgencyLevelPair(q, answer);
    const verdict = !q ? "skipped_unsafe_question" : agencyLevel ? "agency_level" : "person_specific";

    if (!APPLY) {
      tally[verdict] = (tally[verdict] || 0) + 1;
      console.log(`  [${verdict}] "${r.questionText.slice(0, 70)}"`);
      continue;
    }
    const result = await ingestAgencyAnswerToKnowledgeBase({
      silentQueryId: r.id,
      providerId: r.providerId,
      questionText: r.questionText,
      answerText: answer,
    });
    tally[result] = (tally[result] || 0) + 1;
    console.log(`  [${result}] "${r.questionText.slice(0, 70)}"`);
  }

  console.log(`\nSummary: ${JSON.stringify(tally)}`);
  console.log("Only agency-level answers are ingested; person-specific ones stay bound to their profile by design.");
  await prisma.$disconnect();
})();
