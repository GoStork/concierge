import pkg from "pg";
import fs from "fs";
const { Client } = pkg;
const env = fs.readFileSync(".env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sql = fs.readFileSync("prisma/migrations/20260526_search_perf_indexes/migration.sql", "utf8");
const client = new Client({ connectionString: process.env.DIRECT_URL });
await client.connect();
const start = Date.now();
const result = await client.query(sql);
console.log(`Applied indexes in ${Date.now() - start}ms`);
// Show the new indexes
const idx = await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('ProviderLocation','ProviderService','IvfSuccessRate') AND indexname LIKE '%lower%' OR indexname IN ('ProviderLocation_providerId_idx','ProviderService_providerTypeId_status_idx','IvfSuccessRate_providerId_metricCode_idx') ORDER BY tablename, indexname;`);
console.log("New indexes:");
for (const r of idx.rows) console.log(`  ${r.indexname}`);
await client.end();
