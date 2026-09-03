import { createHash } from "crypto";
import type { PrismaService } from "../prisma/prisma.service";

// Doctor / team-member identity - the ONE place that derives a ProviderMember's
// public `slug` (URL key, e.g. "vicken-sahakian") and `personKey` (hash of the
// normalized name that links the same human across several clinics).
//
// Used by the clinic enrichment pipeline (CDC/SART-sourced members) AND the
// admin / provider team editor (hand-created members). The marketplace Doctors
// tab, the [[DOCTOR_CARD]] resolver and /doctors/:slug all require a slug, so a
// member created without one is invisible to parents no matter how complete
// their profile is. scripts/backfill-doctor-slugs.ts mirrors this logic.

export function normalizeName(name: string): string {
  return name
    .replace(/^\s*(?:Dr|Doctor)\b\.?\s*/i, "") // strip leading "Dr."/"Doctor" so "Dr. X" and "X" match
    // Drop punctuation FIRST so dotted credentials collapse ("M.D." -> "MD",
    // "Ph.D." -> "PhD") and then get stripped as whole words below. Doing this
    // after the credential strip left "M.D." intact -> "...md", a DIFFERENT
    // personKey from the plain name, which spawned duplicate doctor members.
    .replace(/[.,'"]/g, "")
    // Strip "dba ..." (everything from the dba onward).
    .replace(/\s*\bdba\b.*/gi, "")
    // Legal-entity + credential suffixes - matched ONLY as whole words (leading \b).
    // Without the leading \b these eat substrings out of real words ("Colora[do]",
    // "[Pa]cific", "Fertility [Pa]rtners", "[Sc]ience"), which silently corrupted
    // SART clinic matching AND doctor personKeys/slugs.
    .replace(/\s*\b(LLC|Inc|PC|PA|SC|LTD|LLP|Corporation|Corp|PLLC)\b/gi, "")
    .replace(/\s*\b(MD|DO|PhD|FACOG|FACS|MBA|MSc|RN|NP)\b/gi, "")
    .replace(/[\-\u2013]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function slugifyName(name: string): string {
  return normalizeName(name)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function personKeyOf(name: string): string {
  return createHash("sha1").update(normalizeName(name)).digest("hex").slice(0, 16);
}

type MemberCreateData = { providerId: string; name: string } & Record<string, unknown>;

// Create a ProviderMember with a globally-unique slug + personKey. Enrichment
// deletes+recreates a clinic's members on every run, so without this the
// backfilled slugs would be lost. Retries with a numeric suffix on slug
// collision; falls back to no slug only for pathological (empty/colliding) names.
export async function createMemberWithSlug(prisma: PrismaService, data: MemberCreateData) {
  const base = slugifyName(data.name);
  const personKey = personKeyOf(data.name);
  if (!base) {
    return prisma.providerMember.create({ data: { ...(data as any), personKey } });
  }
  for (let attempt = 1; attempt <= 100; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      return await prisma.providerMember.create({ data: { ...(data as any), slug, personKey } });
    } catch (e: any) {
      if (e?.code === "P2002") continue; // slug already taken - try next suffix
      throw e;
    }
  }
  return prisma.providerMember.create({ data: { ...(data as any), personKey } });
}

// Bring an EXISTING member's identity up to date after an edit: fill a missing
// slug, and keep personKey in sync with the (possibly renamed) name. An existing
// slug is never rewritten - parents save doctors by slug and /doctors/:slug is a
// shareable URL, so a rename must not orphan them.
export async function ensureMemberIdentity(prisma: PrismaService, memberId: string): Promise<void> {
  const m = await prisma.providerMember.findUnique({
    where: { id: memberId },
    select: { name: true, slug: true, personKey: true },
  });
  if (!m || !m.name?.trim()) return;
  const personKey = personKeyOf(m.name);
  const patch: Record<string, string> = {};
  if (m.personKey !== personKey) patch.personKey = personKey;
  if (!m.slug) {
    const base = slugifyName(m.name);
    if (base) {
      for (let attempt = 1; attempt <= 100; attempt++) {
        const slug = attempt === 1 ? base : `${base}-${attempt}`;
        const taken = await prisma.providerMember.findUnique({ where: { slug }, select: { id: true } });
        if (!taken) { patch.slug = slug; break; }
      }
    }
  }
  if (Object.keys(patch).length) {
    await prisma.providerMember.update({ where: { id: memberId }, data: patch });
  }
}
