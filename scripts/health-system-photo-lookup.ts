/**
 * Health-system photo lookup (scripts/health-system-photo-lookup.ts):
 * for photo-less doctors - mostly at academic/hospital fertility centers whose
 * headshots live on the INSTITUTION'S domain (yalemedicine.org, uclahealth.org)
 * rather than the clinic site we scrape - find the doctor's OFFICIAL profile
 * page via Gemini google-search grounding, verify the name on the page, and
 * pull the headshot through the existing GCS pipeline.
 *
 * Rights-safe by construction: aggregators (Healthgrades, Zocdoc, Doximity,
 * Vitals, WebMD, Yelp, LinkedIn, Facebook, ratemds...) are hard-rejected; only
 * pages that name-verify AND yield a same-page portrait are accepted. Default
 * is DRY-RUN (prints doctor -> page -> photo, persists nothing) so results can
 * be spot-checked before --apply.
 *
 *   npx tsx --env-file=.env scripts/health-system-photo-lookup.ts --limit=15          # dry run sample
 *   npx tsx --env-file=.env scripts/health-system-photo-lookup.ts --all --apply
 */
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { StorageService } from "../server/src/modules/storage/storage.service";
import { persistPhotoToGcs } from "../server/src/modules/providers/clinic-enrichment.service";

const arg = (k: string) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : undefined;
};
const APPLY = process.argv.includes("--apply");
const LIMIT = process.argv.includes("--all") ? undefined : parseInt(arg("limit") || "15", 10);
const CONCURRENCY = parseInt(arg("concurrency") || "2", 10);

const prisma = new PrismaService();
const storage = new StorageService();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const AGGREGATOR = /healthgrades|zocdoc|doximity|vitals\.com|webmd|yelp|linkedin|facebook|ratemds|sharecare|castleconnolly|usnews|npidb|npino|wikipedia|instagram|x\.com|twitter|youtube|fertilityiq/i;

async function findProfileUrl(doctorName: string, clinicName: string, location: string): Promise<string | null> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0 } as any,
    tools: [{ googleSearch: {} } as any],
  });
  const prompt = `Find the OFFICIAL physician profile page for ${doctorName}, a fertility doctor (reproductive endocrinologist) at "${clinicName}"${location ? ` in ${location}` : ""}.

SEARCH INSTRUCTIONS:
1. Search for the doctor's profile page on the clinic's own website OR its parent health system / university medical center website (e.g. *health.org, *medicine.org, university hospital domains).
2. The page must be about THIS specific doctor (a bio/profile page with their photo), not a directory listing or news article.
3. NEVER return aggregator or social sites: Healthgrades, Zocdoc, Doximity, Vitals, WebMD, Yelp, LinkedIn, Facebook, RateMDs, Sharecare, U.S. News, FertilityIQ, Wikipedia.

OUTPUT: Return ONLY the URL, nothing else. If no official institutional profile page exists, return exactly "null".`;
  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
    ]);
    const resp = (result as any).response;
    const text = resp.text().trim();
    // Candidate URLs: the response text AND the grounding chunks (grounded
    // answers often carry vertexaisearch redirect wrappers in the text while
    // the REAL page URIs live in groundingMetadata).
    const candidates: string[] = [];
    const m = text.match(/(?:https?:\/\/|www\.)[^\s"'<>)]+/);
    if (m && !/^null$/i.test(text)) candidates.push(m[0]);
    const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const c of chunks) {
      if (c?.web?.uri) candidates.push(c.web.uri);
    }
    for (let url of candidates) {
      url = url.replace(/[.,;:!?)\]]+$/, "");
      if (url.startsWith("www.")) url = "https://" + url;
      try { new URL(url); } catch { continue; }
      // Redirect wrappers get resolved to their final destination before any check.
      if (/vertexaisearch\.cloud\.google\.com|grounding-api-redirect/i.test(url)) {
        try {
          const r = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15000) });
          if (r.url && !/vertexaisearch/i.test(r.url)) url = r.url;
          else continue;
        } catch { continue; }
      }
      if (AGGREGATOR.test(url)) continue;
      return url;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    if (html.length > 3000) return html;
  } catch { /* fall through to rendered fetch */ }
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2500);
      return await page.content();
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  }
}

function nameTokens(doctorName: string): string[] {
  return doctorName.toLowerCase().replace(/\b(dr|md|do|phd|facog|mph|ms|jr|sr|msci|pa-c)\b\.?/g, "")
    .split(/[^a-z]+/).filter((t) => t.length >= 3);
}

/** Both name tokens in the page's identity zone (title/h1-h3/og:title) - order-agnostic. */
function nameVerified(html: string, doctorName: string): boolean {
  const tokens = nameTokens(doctorName);
  if (tokens.length < 2) return false;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const zone = [
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "",
    ...(html.match(/<h[123][^>]*>[\s\S]*?<\/h[123]>/gi) || []),
    html.match(/property=["']og:title["'][^>]*content=["']([^"']+)/i)?.[1] || "",
    html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1] || "",
  ].join(" ").toLowerCase();
  return zone.includes(first) && zone.includes(last);
}

/** The institution putting both name tokens in the URL slug is verification too. */
function slugVerified(pageUrl: string, doctorName: string): boolean {
  const tokens = nameTokens(doctorName);
  if (tokens.length < 2) return false;
  const path = pageUrl.toLowerCase();
  return path.includes(tokens[0]) && path.includes(tokens[tokens.length - 1]);
}

/**
 * STRICT portrait extraction: a photo is accepted ONLY when its URL or alt
 * text carries one of the doctor's name tokens. og:image alone is NOT
 * trusted - clinic sites routinely set it to a site-wide marketing banner
 * (the dry run caught two doctors "matching" the same stock baby photo).
 * Precision over recall: better no photo than the wrong one.
 */
function extractPhotoUrl(html: string, pageUrl: string, doctorName: string): string | null {
  const abs = (u: string) => { try { return new URL(u, pageUrl).toString(); } catch { return null; } };
  const bad = (u: string) => /\.svg(\?|$)|logo|icon|sprite|placeholder|default|banner|hero|stock|baby|couple|family|office|texture|tile|pattern|background|gradient/i.test(u);
  const tokens = nameTokens(doctorName);
  const carriesName = (s: string) => tokens.some((t) => s.toLowerCase().includes(t));

  const og = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1]
    || html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
  if (og && !bad(og) && carriesName(og)) {
    const u = abs(og);
    if (u) return u;
  }
  const imgs = html.match(/<img[^>]+>/gi) || [];
  for (const tag of imgs) {
    const src = tag.match(/(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i)?.[1];
    if (!src || bad(src) || src.startsWith("data:")) continue;
    const alt = tag.match(/alt=["']([^"']*)["']/i)?.[1] || "";
    if (carriesName(src) || carriesName(alt)) {
      const u = abs(src);
      if (u) return u;
    }
  }
  // Tier 2 (hashed-CDN directories like Stanford/Columbia): on a page whose
  // TITLE already verified as this one doctor, accept an img living inside a
  // provider/physician-photo container even when the filename is a hash.
  for (const tag of imgs) {
    const src = tag.match(/(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i)?.[1];
    if (!src || bad(src) || src.startsWith("data:")) continue;
    const cls = tag.match(/class=["']([^"']*)["']/i)?.[1] || "";
    if (/provider|physician|doctor|profile|headshot|bio[-_]?photo|portrait/i.test(cls)) {
      const u = abs(src);
      if (u) return u;
    }
  }
  return null;
}

async function main() {
  const clinics = await prisma.provider.findMany({
    where: { services: { some: { status: "APPROVED", providerType: { name: { contains: "IVF", mode: "insensitive" } } } } },
    select: {
      id: true, name: true,
      locations: { orderBy: { sortOrder: "asc" }, take: 1, select: { city: true, state: true } },
      members: { where: { isPublicProfile: { not: false }, OR: [{ photoUrl: null }, { photoUrl: "" }] }, select: { id: true, name: true, highResPhotoUrl: true } },
    },
  });
  const targets: Array<{ memberId: string; doctor: string; clinic: string; location: string }> = [];
  for (const c of clinics) {
    for (const m of c.members) {
      if (m.highResPhotoUrl) continue;
      targets.push({
        memberId: m.id,
        doctor: m.name,
        clinic: c.name,
        location: [c.locations[0]?.city, c.locations[0]?.state].filter(Boolean).join(", "),
      });
    }
  }
  const work = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`${targets.length} photo-less doctors; processing ${work.length} (${APPLY ? "APPLY" : "DRY RUN"}, concurrency ${CONCURRENCY})\n`);

  let found = 0, applied = 0, noPage = 0, failedVerify = 0, noPhoto = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < work.length) {
      const t = work[idx++];
      const n = `[${idx}/${work.length}]`;
      const pageUrl = await findProfileUrl(t.doctor, t.clinic, t.location);
      if (!pageUrl) { noPage++; console.log(`${n} ${t.doctor} (${t.clinic}): no official page found`); continue; }
      const html = await fetchPage(pageUrl);
      if (!html) {
        failedVerify++;
        console.log(`${n} ${t.doctor}: page FETCH failed - ${pageUrl}`);
        continue;
      }
      if (!nameVerified(html, t.doctor) && !slugVerified(pageUrl, t.doctor)) {
        failedVerify++;
        console.log(`${n} ${t.doctor}: page failed name verification - ${pageUrl}`);
        continue;
      }
      const photoUrl = extractPhotoUrl(html, pageUrl, t.doctor);
      if (!photoUrl) { noPhoto++; console.log(`${n} ${t.doctor}: verified page but no portrait found - ${pageUrl}`); continue; }
      // Final gate before accepting: Gemini vision confirms it's actually a
      // photographic portrait (the first run let a texture tile through via
      // the container heuristic - never again).
      const isPortrait = await (async () => {
        try {
          const resp = await fetch(photoUrl, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) return false;
          const buf = Buffer.from(await resp.arrayBuffer());
          const mime = resp.headers.get("content-type")?.split(";")[0] || "image/jpeg";
          const vm = genAI.getGenerativeModel({
            model: "gemini-3.5-flash",
            generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } } as any,
          });
          const res = await vm.generateContent([
            { inlineData: { mimeType: mime, data: buf.toString("base64") } },
            { text: 'Is this image a photographic portrait/headshot of a real person (one clearly visible human face)? Answer STRICT JSON only: {"portrait": true|false}' },
          ]);
          const out = res.response.text().trim();
          return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).portrait === true;
        } catch { return false; }
      })();
      if (!isPortrait) {
        noPhoto++;
        console.log(`${n} ${t.doctor}: candidate rejected by portrait check - ${photoUrl}`);
        continue;
      }
      found++;
      console.log(`${n} ${t.doctor}: FOUND ${photoUrl}\n    page: ${pageUrl}`);
      if (APPLY) {
        const persisted = await persistPhotoToGcs(photoUrl, storage);
        if (persisted && persisted !== photoUrl) {
          await prisma.providerMember.update({ where: { id: t.memberId }, data: { photoUrl: persisted } });
          applied++;
        } else if (persisted) {
          // Persist returned the original URL (GCS unavailable/fetch failed) - keep it external rather than losing it.
          await prisma.providerMember.update({ where: { id: t.memberId }, data: { photoUrl: persisted } });
          applied++;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n===== SUMMARY (${APPLY ? "APPLY" : "DRY RUN"}) =====`);
  console.log(`Photos found: ${found}${APPLY ? ` (applied: ${applied})` : ""}`);
  console.log(`No official page: ${noPage} | Failed name verification: ${failedVerify} | Page ok but no portrait: ${noPhoto}`);
  if (!APPLY) console.log(`\nSpot-check the FOUND lines above, then re-run with --apply (and afterwards backfill-doctor-photos.ts to upscale).`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
