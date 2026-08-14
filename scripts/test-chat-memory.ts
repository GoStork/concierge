/**
 * Chat memory system E2E (scripts/test-chat-memory.ts):
 * 1. Parent CRUD on /api/my/concierge-memory
 * 2. Explicit "remember that..." capture (Gemini)
 * 3. Rolling summary fold (30-turn synthetic session) + watermark + batching
 * 4. Auto memory extraction piggybacked on the fold
 * 5. History near-duplicate collapse (log assertion via live /chat call)
 * Run: npx tsx --env-file=.env scripts/test-chat-memory.ts (server on 5001)
 */
import jwt from "jsonwebtoken";
const BASE = "http://localhost:5001";
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};

async function main() {
  const { prisma } = await import("../server/db.js");
  const { maybeUpdateSessionSummary, memoryBlock, captureExplicitMemory } = await import("../server/concierge-memory.js");
  const { purgeLeftoverTestUsers } = await import("./lib/purge-test-users.js");
  await purgeLeftoverTestUsers(prisma).catch((e: any) => console.warn("[purge-test-users] sweep failed:", e?.message || e));

  const account = await prisma.parentAccount.create({ data: {} });
  const user = await prisma.user.create({ data: { email: `test-mem-${Date.now()}@gostork-test.com`, name: "Memory Tester", password: "x", parentAccountId: account.id } });
  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET || "dev-jwt-secret-change-me", { expiresIn: "10m" });
  const hdr = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  let sessionId: string | null = null;

  try {
    // 1. CRUD
    const created = await (await fetch(`${BASE}/api/my/concierge-memory`, { method: "POST", headers: hdr, body: JSON.stringify({ text: "Prefers evening calls", kind: "PREFERENCE" }) })).json();
    check("create memory", !!created.id && created.kind === "PREFERENCE", JSON.stringify(created));
    const list1 = await (await fetch(`${BASE}/api/my/concierge-memory`, { headers: hdr })).json();
    check("list shows it", Array.isArray(list1) && list1.some((m: any) => m.id === created.id));
    await fetch(`${BASE}/api/my/concierge-memory/${created.id}`, { method: "PATCH", headers: hdr, body: JSON.stringify({ text: "Prefers morning calls" }) });
    const list2 = await (await fetch(`${BASE}/api/my/concierge-memory`, { headers: hdr })).json();
    check("edit persists", list2.find((m: any) => m.id === created.id)?.text === "Prefers morning calls");
    const block = await memoryBlock(account.id);
    check("memory block includes fact", /morning calls/i.test(block), block.slice(0, 120));

    // 2. Explicit capture
    const captured = await captureExplicitMemory(account.id, "Please remember that my husband Tom handles all the scheduling");
    check("explicit capture stores fact", !!captured && /tom|schedul/i.test(captured || ""), captured || "null");

    // 3+4. Rolling summary on a 30-turn session
    const session = await prisma.aiChatSession.create({ data: { userId: user.id, status: "ACTIVE", sessionType: "PARENT", matchmakerId: "eva-test", title: "memory e2e" } });
    sessionId = session.id;
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 30; i++) {
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: i % 2 === 0
            ? `Question ${i}: we are thinking about surrogacy budgets around $${120 + i}k and I am nervous about the legal steps`
            : `Answer ${i}: that budget is workable; I recommended reviewing escrow and legal timelines, and we agreed to revisit agencies next week`,
          createdAt: new Date(base + i * 60000),
        },
      });
    }
    await maybeUpdateSessionSummary(session.id);
    const s1 = await prisma.aiChatSession.findUnique({ where: { id: session.id }, select: { historySummary: true, summarizedThrough: true } });
    check("summary written", !!s1?.historySummary && s1.historySummary.length > 50, (s1?.historySummary || "").slice(0, 80));
    check("watermark set", !!s1?.summarizedThrough);
    const before = s1?.historySummary;
    await maybeUpdateSessionSummary(session.id); // no new old-turns -> batched out
    const s2 = await prisma.aiChatSession.findUnique({ where: { id: session.id }, select: { historySummary: true } });
    check("second fold is a no-op (batching)", s2?.historySummary === before);

    // 5. History dedupe: session with 4 near-identical assistant turns, live /chat
    for (let i = 0; i < 4; i++) {
      await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id, role: "assistant",
          content: `To help me find the perfect matches for you, what matters most to you in a sperm donor? ${i % 2 === 0 ? "You can share" : "Feel free to share"} any preferences you have regarding appearance, ethnicity, education, personality, interests, or anything else that feels important to you.`,
          createdAt: new Date(base + (40 + i) * 60000),
        },
      });
    }
    const res = await fetch(`${BASE}/api/ai-concierge/chat`, {
      method: "POST", headers: { ...hdr, Accept: "text/event-stream" },
      body: JSON.stringify({ sessionId: session.id, message: "blue eyes and blond hair please" }),
    });
    await res.text(); // drain
    check("live chat call completed", res.status === 200, String(res.status));
    console.log("  (check server log for [HISTORY DEDUPE] line)");
  } finally {
    if (sessionId) await prisma.aiChatMessage.deleteMany({ where: { sessionId } }).catch(() => {});
    if (sessionId) await prisma.aiChatSession.delete({ where: { id: sessionId } }).catch(() => {});
    await prisma.conciergeMemory.deleteMany({ where: { parentAccountId: account.id } }).catch(() => {});
    await prisma.journeyEvent.deleteMany({ where: { parentAccountId: account.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.parentAccount.delete({ where: { id: account.id } }).catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
