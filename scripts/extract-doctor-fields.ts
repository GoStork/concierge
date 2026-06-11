/**
 * Phase 4a: populate doctor profile fields from existing ProviderMember bios.
 *
 * Many team members already have a bio scraped from the clinic's own website.
 * This pass uses Gemini to extract STRUCTURED fields from that bio - specialties,
 * languages, board certifications, education/training, professional memberships,
 * years of experience, gender - and writes them onto the member so the doctor
 * profile page fills out (like the ZocDoc / FertilityIQ "Education & background"
 * section).
 *
 * Strictly extractive: the prompt forbids inferring anything not in the bio, so
 * we never fabricate credentials (per the project's "no hardcoded fallbacks"
 * rule). A field with nothing in the bio comes back empty and is left blank.
 *
 * Run:
 *   npx tsx -r dotenv/config scripts/extract-doctor-fields.ts --provider-name "Pacific Fertility"
 *   npx tsx -r dotenv/config scripts/extract-doctor-fields.ts --provider <providerId>
 *   npx tsx -r dotenv/config scripts/extract-doctor-fields.ts --limit 200
 *   npx tsx -r dotenv/config scripts/extract-doctor-fields.ts --dry-run --provider-name "CCRM"
 *
 * Idempotent: only processes members with a bio and no specialties yet.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Use the DIRECT (session-mode, 5432) connection for one-off scripts; the
// pgbouncer transaction pooler (DATABASE_URL, 6543) makes Prisma writes
// unreliable in batch scripts.
const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const providerId = argVal("--provider");
const providerName = argVal("--provider-name");
const limit = argVal("--limit") ? parseInt(argVal("--limit")!, 10) : undefined;
const CONCURRENCY = 4;

const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash",
  generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: "application/json" } as any,
});

interface Extracted {
  specialties: string[];
  languagesSpoken: string[];
  boardCertifications: string[];
  education: string[];
  professionalMemberships: string[];
  yearsExperience: number | null;
  providerGender: "Male" | "Female" | null;
}

function buildPrompt(name: string, bio: string): string {
  return `You are extracting structured facts from a fertility doctor's professional bio. Extract ONLY facts explicitly stated in the bio. Do NOT infer, guess, generalize, or add anything that is not literally present. If a field is not mentioned, return an empty array or null.

Doctor name: ${name}
Bio:
"""${bio}"""

Return STRICT JSON with exactly this shape:
{
  "specialties": string[],          // clinical focus areas explicitly mentioned. Title Case. Examples of canonical labels to use when present: "Male Factor Infertility","LGBTQ+ Family Building","PCOS","Recurrent Pregnancy Loss","Egg Freezing","Fertility Preservation","Advanced Maternal Age","Endometriosis","Diminished Ovarian Reserve","Social Infertility","Third Party Reproduction". [] if none.
  "languagesSpoken": string[],      // languages the doctor is explicitly stated to speak. [] if none stated.
  "boardCertifications": string[],  // e.g. "American Board of Obstetrics and Gynecology","Reproductive Endocrinology and Infertility". [] if none.
  "education": string[],            // training explicitly mentioned, each formatted as "Medical School - <inst>","Residency - <inst>","Fellowship - <inst>". [] if none.
  "professionalMemberships": string[], // e.g. "American Society for Reproductive Medicine". [] if none.
  "yearsExperience": number,        // integer ONLY if explicitly stated (e.g. "over 20 years of experience" -> 20). null if not stated.
  "providerGender": string          // "Male" or "Female" ONLY if clearly indicated by he/him or she/her pronouns in the bio. null otherwise.
}
Return ONLY the JSON object, nothing else.`;
}

function parseExtracted(text: string): Extracted | null {
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const o = JSON.parse(cleaned);
    const arr = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
    const gender = o.providerGender === "Male" || o.providerGender === "Female" ? o.providerGender : null;
    const yrs = typeof o.yearsExperience === "number" && Number.isFinite(o.yearsExperience) ? Math.round(o.yearsExperience) : null;
    return {
      specialties: arr(o.specialties),
      languagesSpoken: arr(o.languagesSpoken),
      boardCertifications: arr(o.boardCertifications),
      education: arr(o.education),
      professionalMemberships: arr(o.professionalMemberships),
      yearsExperience: yrs,
      providerGender: gender,
    };
  } catch {
    return null;
  }
}

async function extractOne(member: { id: string; name: string; bio: string }): Promise<void> {
  let text: string;
  try {
    const result = await model.generateContent(buildPrompt(member.name, member.bio));
    text = result.response.text();
  } catch (e: any) {
    console.log(`[extract]   ${member.name}: Gemini error - ${e.message} (skipped)`);
    return;
  }
  const data = parseExtracted(text);
  if (!data) {
    console.log(`[extract]   ${member.name}: unparseable response (skipped)`);
    return;
  }
  const summary = `spec=${data.specialties.length} lang=${data.languagesSpoken.length} cert=${data.boardCertifications.length} edu=${data.education.length} mem=${data.professionalMemberships.length} yrs=${data.yearsExperience ?? "-"} gender=${data.providerGender ?? "-"}`;
  console.log(`[extract]   ${member.name}: ${summary}`);
  if (!DRY_RUN) {
    await prisma.providerMember.updateMany({
      where: { id: member.id },
      data: {
        specialties: data.specialties,
        languagesSpoken: data.languagesSpoken,
        boardCertifications: data.boardCertifications,
        education: data.education,
        professionalMemberships: data.professionalMemberships,
        yearsExperience: data.yearsExperience,
        providerGender: data.providerGender,
      },
    });
  }
}

async function main() {
  console.log(`[extract] doctor-field extraction ${DRY_RUN ? "(DRY RUN)" : ""} starting`);

  const where: any = { bio: { not: null }, specialties: { isEmpty: true } };
  if (providerId) where.providerId = providerId;
  if (providerName) where.provider = { name: { contains: providerName, mode: "insensitive" } };

  const members = await prisma.providerMember.findMany({
    where,
    select: { id: true, name: true, bio: true },
    take: limit,
    orderBy: { sortOrder: "asc" },
  });

  const withBio = members.filter((m) => (m.bio || "").trim().length >= 60) as { id: string; name: string; bio: string }[];
  console.log(`[extract] ${withBio.length} members with a usable bio to process (${members.length} matched before bio-length filter)`);

  let done = 0;
  for (let i = 0; i < withBio.length; i += CONCURRENCY) {
    const batch = withBio.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(extractOne));
    done += batch.length;
    if (done % 20 === 0 || done === withBio.length) console.log(`[extract] progress ${done}/${withBio.length}`);
  }

  console.log(`[extract] done. processed=${withBio.length} ${DRY_RUN ? "(NO WRITES)" : ""}`);
}

main()
  .catch((e) => {
    console.error("[extract] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
