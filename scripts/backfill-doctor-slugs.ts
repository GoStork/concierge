/**
 * One-time backfill: derive ProviderMember.slug and ProviderMember.personKey
 * for existing team members so they become addressable doctor profiles.
 *
 *   slug      - URL key, kebab-case of the name, numeric suffix on collision
 *               (e.g. "vicken-sahakian", "vicken-sahakian-2")
 *   personKey - hash of the normalized name, used to link the SAME human across
 *               multiple clinics (one doctor can appear on several Providers).
 *
 * normalizeName mirrors the logic in clinic-enrichment.service.ts (strips
 * credential suffixes, punctuation, lowercases) so the same person resolves to
 * the same key regardless of "MD"/"Dr." decoration.
 *
 * Run:     npx tsx -r dotenv/config scripts/backfill-doctor-slugs.ts
 *          npx tsx -r dotenv/config scripts/backfill-doctor-slugs.ts --dry-run
 *
 * Idempotent: only fills rows where slug IS NULL. Safe to re-run.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import crypto from "crypto";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const DRY_RUN = process.argv.includes("--dry-run");

function normalizeName(name: string): string {
  return name
    .replace(/,?\s*(LLC|Inc\.?|PC|PA|SC|LTD|LLP|Corporation|Corp\.?|PLLC|dba\b.*)/gi, "")
    .replace(/,?\s*(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP|Dr)\b\.?/gi, "")
    .replace(/[.,'"]/g, "")
    .replace(/[\-–]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(name: string): string {
  return normalizeName(name)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function personKeyOf(name: string): string {
  return crypto.createHash("sha1").update(normalizeName(name)).digest("hex").slice(0, 16);
}

async function main() {
  console.log(`[backfill] doctor slug/personKey backfill ${DRY_RUN ? "(DRY RUN)" : ""} starting`);

  const members = await prisma.providerMember.findMany({
    where: { slug: null },
    select: { id: true, name: true, providerId: true },
    orderBy: { sortOrder: "asc" },
  });

  console.log(`[backfill] ${members.length} members without a slug`);

  // Preload existing slugs to avoid collisions with already-backfilled rows.
  const taken = new Set<string>(
    (await prisma.providerMember.findMany({
      where: { slug: { not: null } },
      select: { slug: true },
    }))
      .map((m) => m.slug)
      .filter((s): s is string => !!s),
  );

  let updated = 0;
  let skipped = 0;

  for (const m of members) {
    const base = slugify(m.name);
    if (!base) {
      console.log(`[backfill]   SKIP "${m.name}" (${m.id}) - name produced empty slug`);
      skipped++;
      continue;
    }
    let slug = base;
    let n = 1;
    while (taken.has(slug)) {
      n += 1;
      slug = `${base}-${n}`;
    }
    taken.add(slug);
    const personKey = personKeyOf(m.name);

    console.log(`[backfill]   ${m.name} -> slug=${slug} personKey=${personKey}`);

    if (!DRY_RUN) {
      // updateMany (not update) so a concurrently-deleted row is a no-op rather
      // than a P2025 throw - enrichment may add/remove members while this runs.
      await prisma.providerMember.updateMany({
        where: { id: m.id, slug: null },
        data: { slug, personKey },
      });
    }
    updated++;
  }

  console.log(`[backfill] done. updated=${updated} skipped=${skipped} ${DRY_RUN ? "(NO WRITES)" : ""}`);
}

main()
  .catch((e) => {
    console.error("[backfill] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
