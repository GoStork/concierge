// Fills in the stored pull-quote for donors and surrogates who already exist.
// New and re-synced profiles get theirs from the sync itself
// (refreshHighlightQuote in profile-sync.service.ts); this is only for the
// back catalogue.
//
// Usage:
//   npx tsx scripts/backfill-highlight-quotes.ts                 # everyone missing one
//   npx tsx scripts/backfill-highlight-quotes.ts --limit 50      # a sample first
//   npx tsx scripts/backfill-highlight-quotes.ts --provider <id> # one agency
//
// Safe to re-run: it only touches rows where highlightQuote is null, and a
// profile the model declines to quote is simply left alone (and re-tried on a
// later run, which is cheap compared with quoting her badly).
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { selectHighlightQuote } from "../server/src/modules/providers/highlight-quote";

const MODELS = ["eggDonor", "surrogate", "spermDonor"] as const;
const CONCURRENCY = 6;

(async () => {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const providerId = arg("provider");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const prisma = app.get(PrismaService);

  let quoted = 0, skipped = 0;

  for (const model of MODELS) {
    const rows = await (prisma as any)[model].findMany({
      where: { highlightQuote: null, ...(providerId ? { providerId } : {}) },
      select: { id: true, profileData: true },
      ...(limit ? { take: limit } : {}),
    });
    console.log(`[backfill] ${model}: ${rows.length} without a quote`);

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row: any) => {
        const quote = await selectHighlightQuote(row.profileData);
        if (!quote) { skipped++; return; }
        await (prisma as any)[model].update({ where: { id: row.id }, data: { highlightQuote: quote } });
        quoted++;
        console.log(`  ${model} ${row.id}: "${quote}"`);
      }));
      if (i % 60 === 0 && i > 0) console.log(`  ...${i}/${rows.length}`);
    }
  }

  console.log(`[backfill] done - ${quoted} quoted, ${skipped} left without one`);
  await app.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
