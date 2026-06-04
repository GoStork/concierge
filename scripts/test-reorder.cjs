// Simulate the reorder path with the same parent + agencies Eva would see.
const TOKEN_USER = "8973eca4-c596-4416-9da9-a8a33a7827bb"; // egg-donor parent
const PARENT_ACCT = process.argv[2];
const AGENCIES = [
  { id: "448564e2-4e7f-42d2-9578-5197161ea0ec", name: "Eggspecting" },   // Mexico
  { id: "30a45389-77cd-4188-b7c7-637444576d0e", name: "Bioética & Derecho" }, // Colombia
];
const fetch = global.fetch;
async function tokenFor(userId) {
  const jwt = require("jsonwebtoken");
  return jwt.sign({sub:userId, email:"test@x", roles:["PARENT"]}, process.env.JWT_SECRET, {algorithm:"HS256", expiresIn:"1h"});
}
(async () => {
  const tok = await tokenFor(TOKEN_USER);
  const costs = await Promise.all(AGENCIES.map(async (a) => {
    const r = await fetch(`http://localhost:5001/api/costs/provider/${a.id}/country-program`, {
      headers: {Authorization: `Bearer ${tok}`},
    });
    const j = await r.json();
    return {id: a.id, name: a.name, country: j.country, min: j.combinedMinTotal, max: j.combinedMaxTotal};
  }));
  console.log("Unsorted:", costs.map(c=>`${c.country}=${c.min}`).join(", "));
  const sorted = [...costs].sort((a,b) => (a.min||Infinity) - (b.min||Infinity));
  console.log("Sorted (cheapest first):");
  sorted.forEach((c,i) => console.log(`  ${i+1}. ${c.country} (${c.name}) = $${c.min}`));
  console.log(sorted[0].country === "Colombia" ? "✅ Colombia is FIRST" : "❌ Colombia NOT first");
})().catch(e=>{console.error(e);process.exit(1)});
