#!/usr/bin/env node
// Regenerates the AUTO-GENERATED dependency inventory inside docs/tech-stack.md
// from package.json. Run via `npm run tech-stack` or automatically by the
// pre-commit hook when package.json changes. The curated prose above the markers
// is never touched. Any dependency that does not match a known category lands in
// "Other (review & categorize)" so new tech is never silently missed.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const DOC = join(root, "docs", "tech-stack.md");
const START = "<!-- AUTO-GENERATED:DEPS START -->";
const END = "<!-- AUTO-GENERATED:DEPS END -->";

// Ordered: first matching category wins. Keep these patterns in sync as the
// stack evolves; uncategorized packages fall through to "Other".
const CATEGORIES = [
  ["AI / ML", /^(@google\/generative-ai|@google\/genai|@anthropic-ai|@aws-sdk\/client-rekognition|@google-cloud\/speech|openai|@modelcontextprotocol)/],
  ["Frontend / UI", /^(react|react-dom|react-router|@reduxjs|react-redux|@tanstack|@radix-ui|@hookform|tailwind|@tailwindcss\/typography|tw-animate|lucide|react-icons|framer-motion|embla|react-hook-form|react-day-picker|react-big-calendar|react-easy-crop|react-resizable-panels|@dnd-kit|class-variance-authority|clsx|cmdk|vaul|sonner|recharts|input-otp|next-themes|@stripe\/react)/],
  ["Backend (server)", /^(@nestjs|express|passport|connect-pg-simple|express-session|memorystore|multer|helmet|cors|reflect-metadata|rxjs|cookie|body-parser|node-cron|ws|dotenv|zod|class-validator|class-transformer|jsonrepair)/],
  ["Database / ORM", /^(@prisma|prisma|^pg$|pg-|drizzle|postgres)/],
  ["Scraping & automation", /^(playwright|cheerio)/],
  ["Document processing", /^(pdf-parse|pdfjs-dist|pdfkit|mammoth|exceljs|sharp)/],
  ["Integrations", /^(@sendgrid|twilio|@daily-co|stripe|@stripe\/stripe|googleapis|@microsoft|@azure|tsdav|pandadoc|2captcha|ical|node-ical|@google-cloud\/storage)/],
  ["Utilities", /^(date-fns|geoip-lite|libphonenumber-js|zod-validation-error|@jridgewell)/],
  ["Build / tooling", /^(esbuild|tsx|typescript|vite|@vitejs|@tailwindcss\/vite|@replit|rollup|postcss|autoprefixer|drizzle-kit|@types\/|ts-node|tslib)/],
];

function categorize(deps) {
  const buckets = new Map(CATEGORIES.map(([name]) => [name, []]));
  const other = [];
  for (const [name, version] of Object.entries(deps).sort()) {
    const hit = CATEGORIES.find(([, re]) => re.test(name));
    (hit ? buckets.get(hit[0]) : other).push(`${name}@${version}`);
  }
  return { buckets, other };
}

function render(title, deps) {
  if (!Object.keys(deps).length) return "";
  const { buckets, other } = categorize(deps);
  let out = `\n### ${title}\n`;
  for (const [name, list] of buckets) {
    if (list.length) out += `\n**${name}**\n${list.map((d) => `- \`${d}\``).join("\n")}\n`;
  }
  if (other.length) out += `\n**Other (review & categorize)**\n${other.map((d) => `- \`${d}\``).join("\n")}\n`;
  return out;
}

const body =
  `_Auto-generated from package.json by \`npm run tech-stack\` - do not edit between the AUTO markers._\n` +
  render("Runtime dependencies", pkg.dependencies || {}) +
  render("Dev / build dependencies", pkg.devDependencies || {});

const doc = readFileSync(DOC, "utf8");
const s = doc.indexOf(START);
const e = doc.indexOf(END);
if (s === -1 || e === -1) {
  console.error(`[tech-stack] markers not found in ${DOC}. Expected ${START} ... ${END}`);
  process.exit(1);
}
const updated = doc.slice(0, s + START.length) + "\n" + body + "\n" + doc.slice(e);
writeFileSync(DOC, updated);
console.log(`[tech-stack] regenerated dependency inventory in docs/tech-stack.md`);
