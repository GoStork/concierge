/**
 * CLI wrapper around the sync acceptance audit (server/src/modules/providers/
 * sync-audit.ts). The same audit runs automatically when every sync finishes
 * and is stored on the SyncLog row; use this for an ad-hoc re-check.
 *
 * Run:  npx tsx -r dotenv/config scripts/audit-sync.ts <providerId|name> <egg-donor|surrogate|sperm-donor> [--store]
 * --store re-scores the provider's LATEST run and writes the verdict onto its
 * SyncLog row, so Run History reflects the current audit rules after a rule
 * change (verdicts are otherwise computed once, when the run finishes).
 * Exit code 1 when the sync is not accepted.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getMandatoryFieldChecks } from "../server/src/modules/providers/profile-sync.service";
import { auditSync, formatAuditReport, type AuditDonorType } from "../server/src/modules/providers/sync-audit";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const [providerArg, typeArg] = process.argv.slice(2);
  if (!providerArg || !typeArg || !["egg-donor", "surrogate", "sperm-donor"].includes(typeArg)) {
    console.error("usage: audit-sync.ts <providerId|providerName> <egg-donor|surrogate|sperm-donor>");
    process.exit(2);
  }
  const type = typeArg as AuditDonorType;
  const provider = await prisma.provider.findFirst({
    where: { OR: [{ id: providerArg }, { name: { contains: providerArg, mode: "insensitive" } }] },
    select: { id: true, name: true },
  });
  if (!provider) {
    console.error(`provider not found: ${providerArg}`);
    process.exit(2);
  }
  const audit = await auditSync(prisma as any, provider.id, type, getMandatoryFieldChecks(type));
  console.log(formatAuditReport(provider.name, type, audit));
  if (process.argv.includes("--store")) {
    const latest = await prisma.syncLog.findFirst({ where: { providerId: provider.id, type }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (latest) {
      await prisma.syncLog.update({ where: { id: latest.id }, data: { audit: audit as any } });
      console.log(`\nStored verdict on run ${latest.id}`);
    }
  }
  process.exitCode = audit.accepted ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
