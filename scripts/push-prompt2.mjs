import pkg from "pg";
const { Client } = pkg;
import fs from "fs";
import path from "path";

// load .env manually
const env = fs.readFileSync(".env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

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

const client = new Client({ connectionString: process.env.DIRECT_URL });
await client.connect();
const result = await client.query(
  `UPDATE "ConciergePromptSection" SET content = $1, "updatedAt" = NOW() WHERE key = 'conversation_flow' RETURNING id, LENGTH(content) AS len;`,
  [content]
);
console.log("Updated:", result.rows[0]);
await client.end();
