/**
 * Standalone scraper inspector - imports ONLY scrape.service.ts (no
 * clinic-enrichment), so it can validate the SPA / per-location attribution
 * scraper changes in isolation. Pass a website URL directly.
 *
 * Run: npx tsx -r dotenv/config scripts/inspect-scrape.ts https://www.ccrmivf.com/
 */
import "dotenv/config";
import { scrapeProviderWebsite } from "../server/src/modules/providers/scrape.service";

async function main() {
  const url = process.argv[2];
  if (!url) { console.log("usage: inspect-scrape.ts <websiteUrl>"); process.exit(1); }
  const scraped = await scrapeProviderWebsite(url, { doctorsOnly: true });
  const withHints = scraped.teamMembers.filter((m: any) => m.locationHints?.length > 0).length;
  console.log(`\n[inspect] ${scraped.teamMembers.length} members, ${withHints} WITH location hints`);
  console.log(`[inspect] scraped locations: ${(scraped.locations || []).map((l: any) => `${l.city},${l.state}`).join(" | ") || "(none)"}`);
  for (const m of scraped.teamMembers as any[]) {
    console.log(`  - ${m.name} | title="${m.title || ""}" | locHints=[${(m.locationHints || []).join(", ")}]`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
