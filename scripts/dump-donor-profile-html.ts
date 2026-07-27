/**
 * Diagnostic: log in to a provider's donor site and dump one profile's raw HTML,
 * so a parser bug can be fixed against real markup instead of guesswork.
 * Reuses the sync engine's own login + fetch - never re-implement those here.
 *
 * Run: npx tsx -r dotenv/config scripts/dump-donor-profile-html.ts <externalId> [outFile]
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  authenticateAndGetCookies,
  fetchHtml,
  getSyncConfig,
} from "../server/src/modules/providers/profile-sync.service";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma: any = new PrismaClient({ adapter } as any);

async function main() {
  const externalId = process.argv[2];
  const out = process.argv[3] || "/tmp/donor-profile.html";
  if (!externalId) { console.log("usage: dump-donor-profile-html.ts <externalId> [outFile]"); process.exit(1); }

  const donor = await prisma.eggDonor.findFirst({
    where: { externalId },
    select: { profileUrl: true, providerId: true },
  });
  if (!donor?.profileUrl) throw new Error(`no profileUrl for externalId ${externalId}`);

  // Credentials live on the sync config; the login page is derived from the
  // donor database URL exactly as the sync engine does it.
  const cfg = await prisma.eggDonorSyncConfig.findUnique({ where: { providerId: donor.providerId } });
  const creds = await getSyncConfig(prisma as any, donor.providerId, "egg-donor" as any);
  const base = new URL(cfg?.databaseUrl || donor.profileUrl);
  const loginUrl = `${base.origin}/user/login`;
  console.log(`[dump] provider=${donor.providerId} loginUrl=${loginUrl} user=${!!(creds as any)?.username}`);

  let cookies: string | undefined;
  const password = (creds as any)?.encryptedPassword; // getSyncConfig returns this decrypted
  if ((creds as any)?.username && password) {
    const auth: any = await authenticateAndGetCookies(loginUrl, (creds as any).username, password);
    cookies = auth?.cookies;
    console.log(`[dump] authenticated=${!!cookies}`);
  }

  const html = await fetchHtml(donor.profileUrl, cookies, 30000, 900000);
  writeFileSync(out, html);
  console.log(`[dump] wrote ${html.length} bytes -> ${out}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
