/**
 * One-off logo link-rot checker (safe to re-run): fetches every external
 * Provider.logoUrl and ProviderBrandSettings.logoUrl and reports any that are
 * dead (non-200) or no longer serve an image. For each dead logo it proposes a
 * replacement by trying, in order:
 *   (a) the provider's website homepage - first plausible logo <img>
 *   (b) logo.dev by domain with fallback=404 (same pattern as
 *       clinic-enrichment.service.ts, so only REAL logos, never monograms)
 *
 * GCS-hosted logos (storage.googleapis.com) are private-bucket objects served
 * through our own proxy - they are NOT rot candidates and are skipped, as are
 * relative /uploads/ paths served by our own server.
 *
 * Report-only by default. Run with --apply to write the proposed replacements
 * to the DB (only do this after reviewing the report).
 *
 * Run: npx tsx -r dotenv/config scripts/check-provider-logo-rot.ts
 *      npx tsx -r dotenv/config scripts/check-provider-logo-rot.ts --apply
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 8;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type Row = {
  table: "Provider" | "ProviderBrandSettings";
  rowId: string; // PK of the row holding the logoUrl
  providerName: string;
  websiteUrl: string | null;
  logoUrl: string;
};

type CheckResult = Row & {
  status: "OK" | "DEAD" | "SKIPPED";
  detail: string; // HTTP status / content-type / skip reason
  proposedUrl?: string;
  proposedSource?: "website-scrape" | "logo.dev";
};

function isSkippable(url: string): string | null {
  if (url.includes("storage.googleapis.com")) return "GCS private bucket (not a rot candidate)";
  if (!/^https?:\/\//i.test(url)) return "relative/local path (served by our own server)";
  return null;
}

/** HEAD first (cheap), falling back to GET when HEAD is rejected (405/403/network). */
async function probeUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const resp = await fetch(url, {
        method,
        headers: { "user-agent": UA, accept: "image/*,*/*;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      // Some servers misbehave on HEAD - retry the same URL with GET.
      if (method === "HEAD" && (resp.status === 405 || resp.status === 403 || resp.status === 400)) continue;
      if (!resp.ok) return { ok: false, detail: `HTTP ${resp.status}` };
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      // 200 + an HTML body is the classic soft-404 (WordPress "page not found").
      if (ct && !ct.startsWith("image/") && !ct.includes("octet-stream")) {
        return { ok: false, detail: `HTTP ${resp.status} but content-type ${ct}` };
      }
      return { ok: true, detail: `HTTP ${resp.status} ${ct || "(no content-type)"}` };
    } catch (err: any) {
      if (method === "GET") return { ok: false, detail: `fetch error: ${err?.cause?.code || err.message}` };
    }
  }
  return { ok: false, detail: "unreachable" };
}

/** Verify a candidate replacement actually serves an image before proposing it. */
async function verifiesAsImage(url: string): Promise<boolean> {
  const probe = await probeUrl(url);
  return probe.ok;
}

/**
 * Scrape the provider homepage for a plausible logo <img>. Never assumes
 * attribute order (scraper rule 5) - matches the whole tag then pulls src.
 */
async function scrapeWebsiteLogo(websiteUrl: string): Promise<string | null> {
  let html: string;
  let finalUrl: string;
  try {
    const resp = await fetch(websiteUrl, {
      headers: { "user-agent": UA, accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return null;
    finalUrl = resp.url || websiteUrl;
    html = await resp.text();
  } catch {
    return null;
  }

  const candidates: string[] = [];
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || tag.match(/\bdata-src\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const src = srcMatch[1];
    if (src.startsWith("data:")) continue;
    // "logo" anywhere in the tag (src path, class, alt, id) marks a candidate.
    if (/logo/i.test(tag)) candidates.push(src);
  }
  // Also try og:image as a last resort (often the logo for small agency sites).
  const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i)?.[0];
  if (og) {
    const content = og.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
    if (content && /logo/i.test(content[1])) candidates.push(content[1]);
  }

  for (const raw of candidates) {
    let abs: string;
    try {
      abs = new URL(raw, finalUrl).toString();
    } catch {
      continue;
    }
    // PatientPop homepages embed tiny optimizer thumbnails (e.g. /50x/) - the
    // same asset is served at larger sizes, so prefer a 600px variant.
    const upsized = abs.replace(/(sa1s3optim\.patientpop\.com\/)\d+x\//i, "$1600x/");
    if (upsized !== abs && (await verifiesAsImage(upsized))) return upsized;
    if (await verifiesAsImage(abs)) return abs;
  }
  return null;
}

/** logo.dev fallback - same URL pattern as clinic-enrichment.service.ts. */
function logoDevUrl(websiteUrl: string): string | null {
  const token = process.env.VITE_LOGODEV_TOKEN;
  if (!token) return null;
  let domain: string;
  try {
    domain = new URL(websiteUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
  if (!domain) return null;
  return `https://img.logo.dev/${encodeURIComponent(domain)}?token=${token}&format=png&size=256&fallback=404`;
}

async function checkRow(row: Row): Promise<CheckResult> {
  const skip = isSkippable(row.logoUrl);
  if (skip) return { ...row, status: "SKIPPED", detail: skip };

  const probe = await probeUrl(row.logoUrl);
  if (probe.ok) return { ...row, status: "OK", detail: probe.detail };

  const result: CheckResult = { ...row, status: "DEAD", detail: probe.detail };

  if (row.websiteUrl) {
    const scraped = await scrapeWebsiteLogo(row.websiteUrl);
    if (scraped) {
      result.proposedUrl = scraped;
      result.proposedSource = "website-scrape";
      return result;
    }
    const ld = logoDevUrl(row.websiteUrl);
    if (ld && (await verifiesAsImage(ld))) {
      result.proposedUrl = ld;
      result.proposedSource = "logo.dev";
    }
  }
  return result;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const providers = await prisma.provider.findMany({
    where: { logoUrl: { not: null } },
    select: { id: true, name: true, logoUrl: true, websiteUrl: true },
  });
  const brandSettings = await prisma.providerBrandSettings.findMany({
    where: { logoUrl: { not: null } },
    select: { id: true, logoUrl: true, provider: { select: { name: true, websiteUrl: true } } },
  });

  const rows: Row[] = [
    ...providers.map((p) => ({
      table: "Provider" as const,
      rowId: p.id,
      providerName: p.name,
      websiteUrl: p.websiteUrl,
      logoUrl: p.logoUrl!,
    })),
    ...brandSettings.map((b) => ({
      table: "ProviderBrandSettings" as const,
      rowId: b.id,
      providerName: b.provider?.name ?? "(unknown provider)",
      websiteUrl: b.provider?.websiteUrl ?? null,
      logoUrl: b.logoUrl!,
    })),
  ];

  console.log(`Checking ${rows.length} logo URLs (${providers.length} Provider + ${brandSettings.length} ProviderBrandSettings)...\n`);

  const results = await mapWithConcurrency(rows, CONCURRENCY, checkRow);

  const ok = results.filter((r) => r.status === "OK");
  const skipped = results.filter((r) => r.status === "SKIPPED");
  const dead = results.filter((r) => r.status === "DEAD");

  console.log(`OK:      ${ok.length}`);
  console.log(`Skipped: ${skipped.length} (GCS / local paths)`);
  console.log(`DEAD:    ${dead.length}\n`);

  if (skipped.length) {
    console.log("--- Skipped ---");
    for (const r of skipped) console.log(`  [${r.table}] ${r.providerName}: ${r.detail}`);
    console.log();
  }

  if (!dead.length) {
    console.log("No dead logos found.");
    return;
  }

  console.log("--- DEAD logos ---");
  for (const r of dead) {
    console.log(`\n[${r.table}] ${r.providerName} (row ${r.rowId})`);
    console.log(`  current:  ${r.logoUrl}`);
    console.log(`  problem:  ${r.detail}`);
    console.log(`  website:  ${r.websiteUrl || "(none on file)"}`);
    if (r.proposedUrl) {
      console.log(`  proposed: ${r.proposedUrl}  (via ${r.proposedSource})`);
    } else {
      console.log(`  proposed: NONE FOUND - needs manual fix`);
    }
  }

  const fixable = dead.filter((r) => r.proposedUrl);
  if (!APPLY) {
    console.log(
      `\nReport only - no DB changes made. ${fixable.length}/${dead.length} dead logos have a verified replacement.` +
        (fixable.length ? ` Re-run with --apply to write them.` : ""),
    );
    return;
  }

  console.log(`\nApplying ${fixable.length} replacements...`);
  for (const r of fixable) {
    if (r.table === "Provider") {
      await prisma.provider.update({ where: { id: r.rowId }, data: { logoUrl: r.proposedUrl } });
    } else {
      await prisma.providerBrandSettings.update({ where: { id: r.rowId }, data: { logoUrl: r.proposedUrl } });
    }
    console.log(`  updated [${r.table}] ${r.providerName}`);
  }
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
