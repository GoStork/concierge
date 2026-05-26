import fs from "fs";
import path from "path";

const file = fs.readFileSync(path.join(process.cwd(), "server/ai-prompt-defaults.ts"), "utf8");
const startMarker = `key: "conversation_flow"`;
const startIdx = file.indexOf(startMarker);
const contentStart = file.indexOf("content: `", startIdx);
const contentBegin = contentStart + "content: `".length;

let i = contentBegin;
let escape = false;
let depth = 0;
let contentEnd = -1;
for (; i < file.length; i++) {
  const c = file[i];
  if (escape) { escape = false; continue; }
  if (c === "\\") { escape = true; continue; }
  if (c === "`") { contentEnd = i; break; }
  if (c === "$" && file[i + 1] === "{") { depth++; i++; continue; }
  if (c === "}" && depth > 0) { depth--; continue; }
}

let content = file.slice(contentBegin, contentEnd);
content = content.replace(/\\`/g, "`").replace(/\\\$/g, "$");

// Pick a dollar-quote tag that doesn't appear in content
const tags = ["promptbody", "ppp1", "ppp2", "ppp3", "ppp4", "ppp5"];
let chosen = null;
for (const t of tags) {
  if (!content.includes(`$${t}$`)) { chosen = t; break; }
}
if (!chosen) { console.error("no safe dollar tag"); process.exit(1); }

const sql = `UPDATE "ConciergePromptSection" SET content = $${chosen}$${content}$${chosen}$, "updatedAt" = NOW() WHERE key = 'conversation_flow';`;
fs.writeFileSync(path.join(process.cwd(), "scripts/conversation_flow.sql"), sql);
console.log(`SQL written to scripts/conversation_flow.sql (${sql.length} chars, dollar-tag=${chosen})`);
console.log(`Content: ${content.length} chars`);
