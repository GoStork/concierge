// Re-checks every stored pull-quote against the CURRENT rule and clears any that
// no longer verify, so the backfill can re-select one properly.
//
// Needed because the source a quote is checked against can legitimately narrow:
// collectOwnWords used to sweep up photo URLs and short attribute answers, and
// tightening it left some already-stored quotes unprovable. A quote we cannot
// prove is hers must not stay on her profile - clearing it costs a blank space,
// keeping it costs her words.
//
// Usage: npx tsx scripts/revalidate-highlight-quotes.ts [--dry]
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { collectOwnWords, validateQuote } from "../server/src/modules/providers/highlight-quote";

const MODELS = ["eggDonor", "surrogate", "spermDonor"] as const;

(async () => {
  const dry = process.argv.includes("--dry");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  let kept = 0, cleared = 0;

  for (const model of MODELS) {
    const rows: any[] = await (prisma as any)[model].findMany({
      where: { highlightQuote: { not: null } },
      select: { id: true, highlightQuote: true, profileData: true },
    });
    for (const row of rows) {
      const quote = String(row.highlightQuote);
      if (validateQuote(collectOwnWords(row.profileData), quote) === quote) { kept++; continue; }
      cleared++;
      console.log(`  clear ${model} ${row.id}: ${quote.slice(0, 70)}`);
      if (!dry) await (prisma as any)[model].update({ where: { id: row.id }, data: { highlightQuote: null } });
    }
  }
  console.log(`${dry ? "[dry] " : ""}${kept} still verify, ${cleared} cleared`);
  await prisma.$disconnect(); await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
