/**
 * Repair provider logos whose stored URL has gone dead.
 *
 * Providers redesign their sites and the logo we hotlinked 404s - Asian Egg
 * Bank moved from WordPress to Webflow, so every /wp-content/uploads/ path
 * they had went with it. The UI degrades to initials now, but the record is
 * still wrong.
 *
 * For each provider with a logoUrl: HEAD it. If it is dead, look for the
 * current logo on their own site and PERSIST it to our storage rather than
 * hotlinking again - a hotlink is exactly what just broke. Same treatment
 * clinic-enrichment gives logo.dev results.
 *
 * Dry run:  npx tsx scripts/repair-provider-logos.ts
 * Apply:    npx tsx scripts/repair-provider-logos.ts --apply
 */
import "dotenv/config";
import { createHash } from "crypto";
import { prisma } from "../server/db";
import { StorageService } from "../server/src/modules/storage/storage.service";

const APPLY = process.argv.includes("--apply");
/**
 * Scraping a homepage cannot reliably tell a company's own logo from a press
 * strip - a first pass proposed Logo-ABCNews.svg and then Logo-Peoples.png for
 * a clinic. So --apply alone writes nothing; you must name the provider whose
 * candidate you have actually looked at:
 *
 *   npx tsx scripts/repair-provider-logos.ts --apply --only="Asian Egg Bank"
 *
 * Everything else is reported for a human to confirm. A wrong logo is worse
 * than a missing one: it renders as if it were right.
 */
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length).toLowerCase();
const UA = "Mozilla/5.0 (compatible; GoStorkBot/1.0)";

/**
 * Anything already in our own storage is NOT a hotlink and cannot rot. The
 * bucket is private - getPhotoSrc serves it through /api/uploads/gcs - so an
 * anonymous fetch gets AccessDenied and looks dead. A first pass flagged 440
 * of 454 logos on exactly that false positive; only external URLs qualify.
 */
function isOurs(url: string): boolean {
  return /storage\.googleapis\.com\/gostork/i.test(url) || url.startsWith("/");
}

async function alive(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "GET", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    return r.ok && (r.headers.get("content-type") || "").startsWith("image");
  } catch {
    return false;
  }
}

/**
 * Logo candidates from a provider's own homepage, best first.
 *
 * "First <img> mentioning logo" is not enough: a first pass picked
 * Logo-ABCNews.svg off a clinic's press strip. Candidates are scored, and
 * anything that looks like a third-party badge is rejected outright rather
 * than ranked low - writing the wrong logo is worse than writing none.
 */
const THIRD_PARTY = /abc|nbc|cbs|fox|cnn|news|forbes|today|award|badge|partner|client|review|google|yelp|facebook|instagram|linkedin|twitter|trustpilot|sart|cdc/i;

async function findLogoOnSite(site: string, providerName: string): Promise<string[]> {
  try {
    const r = await fetch(site, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const html = await r.text();
    const host = new URL(site).hostname.replace(/^www\./, "");
    // Distinctive words from the provider's own name and domain, for matching
    // against a filename like "cfnyc-logo" or "InVia_PrimaryLogo".
    const tokens = Array.from(new Set([
      ...host.split(".")[0].split(/[^a-z0-9]+/i),
      ...providerName.toLowerCase().split(/[^a-z0-9]+/i),
    ].filter((t) => t.length >= 4)));

    const scored: { url: string; score: number }[] = [];
    for (const m of html.matchAll(/<img[^>]+>/gi)) {
      const tag = m[0];
      if (!/logo/i.test(tag)) continue;
      const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
      if (!src) continue;
      let abs: string;
      try { abs = src.startsWith("http") ? src : new URL(src, site).toString(); } catch { continue; }
      if (!/\.(png|svg|jpe?g|webp)(\?|$)/i.test(abs)) continue;
      const file = abs.split("/").pop() || "";
      if (THIRD_PARTY.test(file)) continue;                    // press badge, not theirs
      if (scored.some((c) => c.url === abs)) continue;

      let score = 0;
      if (tokens.some((t) => file.toLowerCase().includes(t))) score += 3;   // named after them
      try { if (new URL(abs).hostname.includes(host.split(".")[0])) score += 2; } catch { /* cdn */ }
      if (/nav|header|primary|main/i.test(tag) || /nav|header|primary|main/i.test(file)) score += 1;
      if (/footer/i.test(tag) || /footer/i.test(file)) score -= 1;
      scored.push({ url: abs, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((c) => c.url);
  } catch {
    return [];
  }
}

(async () => {
  console.log(APPLY ? "APPLYING\n" : "DRY RUN - pass --apply to write\n");
  const storage = new StorageService();
  const canPersist = storage.isConfigured();
  if (!canPersist) console.log("storage not configured - would have to hotlink; refusing to write\n");

  const providers = await prisma.provider.findMany({
    where: { logoUrl: { not: null } },
    select: { id: true, name: true, logoUrl: true, websiteUrl: true },
  });

  let dead = 0, repaired = 0, unrepairable = 0;
  for (const p of providers) {
    const url = p.logoUrl as string;
    if (isOurs(url) || await alive(url)) continue;
    dead++;
    console.log(`DEAD  ${p.name}`);
    console.log(`      ${p.logoUrl}`);

    const site = p.websiteUrl || null;
    if (!site) { console.log("      no website on file - cannot look for a replacement\n"); unrepairable++; continue; }

    const candidates = await findLogoOnSite(site.startsWith("http") ? site : `https://${site}`, p.name || "");
    let picked: { url: string; buffer: Buffer; ct: string } | null = null;
    for (const c of candidates) {
      try {
        const r = await fetch(c, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const ct = r.headers.get("content-type") || "";
        if (!ct.startsWith("image")) continue;
        const buffer = Buffer.from(await r.arrayBuffer());
        if (buffer.length < 200) continue;   // too small to be a real logo
        picked = { url: c, buffer, ct };
        break;
      } catch { /* try the next candidate */ }
    }
    if (!picked) { console.log("      no working logo found on their site\n"); unrepairable++; continue; }

    console.log(`      FOUND ${picked.url} (${picked.ct}, ${picked.buffer.length}b)`);
    const confirmed = ONLY && (p.name || "").toLowerCase().includes(ONLY);
    if (!APPLY || !canPersist || !confirmed) {
      console.log(confirmed ? "" : "      (not applied - re-run with --only=\"<name>\" once you have checked this URL)\n");
      continue;
    }

    // Persist rather than hotlink - a hotlink is what broke in the first place.
    const ext = picked.ct.includes("svg") ? ".svg"
      : picked.ct.includes("webp") ? ".webp"
      : picked.ct.includes("jpeg") || picked.ct.includes("jpg") ? ".jpg" : ".png";
    const hash = createHash("md5").update(picked.buffer).digest("hex");
    const persisted = await storage.uploadBufferPublic(picked.buffer, `provider-logos/${hash}${ext}`, picked.ct);
    await prisma.provider.update({ where: { id: p.id }, data: { logoUrl: persisted } });
    console.log(`      SAVED ${persisted}\n`);
    repaired++;
  }

  console.log(`\n${providers.length} providers with a logo, ${dead} dead.`);
  console.log(APPLY ? `${repaired} repaired, ${unrepairable} could not be.` : "Nothing written.");
  process.exit(0);
})().catch((e) => {
  console.error("THREW:", e);
  process.exit(1);
});
