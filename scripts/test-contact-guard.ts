/**
 * End-to-end check that the contact guard is actually wired into the running
 * server, not just unit-green.
 *
 * The unit suite (UT-11/UT-12) proves the RULES. This proves the PLUMBING: that
 * each guarded endpoint returns 422 CONTACT_INFO_BLOCKED, that the Eva
 * exception really does let a parent give Eva their own phone number in their
 * private thread, and that an ordinary cost sentence still goes through.
 *
 *   npx tsx scripts/verify-contact-guard.ts
 */

import "dotenv/config";

const BASE = process.env.TEST_BASE_URL || "http://localhost:5001";
const PW = "TestPass123!";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail && !ok ? ` :: ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function getDB() {
  const mod = await import("../server/db.js");
  return mod.prisma;
}

async function makeParent(tag: string) {
  const email = `test-guard-${tag}-${Date.now()}@gostork-test.com`;
  const reg = await fetch(`${BASE}/api/users`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, name: `Guard Tester ${tag}` }),
  });
  if (!reg.ok) throw new Error(`register failed: ${await reg.text()}`);
  const user = await reg.json();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  const body = await login.json();
  const auth = body?.token ? `Bearer ${body.token}` : "";
  if (!auth) throw new Error("no JWT");
  return { id: user.id, email, auth };
}

async function main() {
  const prisma = await getDB();
  const cleanup: { userIds: string[]; sessionIds: string[] } = { userIds: [], sessionIds: [] };

  try {
    const parent = await makeParent("p1");
    cleanup.userIds.push(parent.id);
    const hdr = { "Content-Type": "application/json", Authorization: parent.auth };

    // A SHARED thread: status CONSULTATION_BOOKED is what isSharedWithProvider keys on.
    const providerRow = await prisma.provider.findFirst({ select: { id: true, name: true } });
    const shared = await prisma.aiChatSession.create({
      data: {
        userId: parent.id, title: "Guard test - shared", sessionType: "PARENT",
        status: "CONSULTATION_BOOKED", providerId: providerRow?.id || null,
        providerName: providerRow?.name || null, providerJoinedAt: new Date(),
      },
    });
    // A PRIVATE Eva thread, deliberately STAMPED with providerId - this is the
    // trap: providerId alone must NOT make the guard think it is shared.
    const priv = await prisma.aiChatSession.create({
      data: {
        userId: parent.id, title: "Guard test - private Eva", sessionType: "PARENT",
        status: "ACTIVE", providerId: providerRow?.id || null, providerJoinedAt: null,
      },
    });
    cleanup.sessionIds.push(shared.id, priv.id);

    const post = async (sessionId: string, content: string) => {
      const res = await fetch(`${BASE}/api/chat-session/${sessionId}/message`, {
        method: "POST", headers: hdr, body: JSON.stringify({ content }),
      });
      return { status: res.status, body: await res.json().catch(() => ({} as any)) };
    };

    console.log("\n── parent -> provider direct message (guarded) ──");
    for (const [label, text] of [
      ["phone", "here is my cell 917-224-7761"],
      ["spaced email", "email me: e r a n @ g o s t o r k . c o m"],
      ["bracketed email", "eran (at) gostork dot com"],
      ["zoom link", "let's meet on us02web.zoom.us/j/98765432101"],
      ["whatsapp move", "let us move this over to WhatsApp"],
    ] as const) {
      const r = await post(shared.id, text);
      check(`blocks ${label} with 422 CONTACT_INFO_BLOCKED`,
        r.status === 422 && r.body?.code === "CONTACT_INFO_BLOCKED",
        `status=${r.status} code=${r.body?.code}`);
    }

    const okMsg = await post(shared.id, "Thanks. Our budget is around $145,000 and her AMH was 1.2 - can we talk Friday at 9:30?");
    check("lets an ordinary cost + clinical message through", okMsg.status === 200, `status=${okMsg.status} ${JSON.stringify(okMsg.body).slice(0, 120)}`);

    const blockedCount = await prisma.aiChatMessage.count({
      where: { sessionId: shared.id, content: { contains: "224-7761" } },
    });
    check("a blocked message is never persisted", blockedCount === 0, `found ${blockedCount} rows`);

    console.log("\n── the message body explains itself ──");
    const sample = await post(shared.id, "call me at 917-224-7761");
    const msg = String(sample.body?.message || "");
    check("422 body carries user-facing copy", msg.length > 40, msg);
    check("copy names what was found", /phone number/i.test(msg), msg);
    check("copy says GoStork is free", /free/i.test(msg), msg);
    check("copy contains no em dash", !/[—–]/.test(msg), msg);
    check("body does not leak the matched text back", !JSON.stringify(sample.body).includes("224-7761"), JSON.stringify(sample.body).slice(0, 160));

    console.log("\n── THE EVA EXCEPTION: private thread, providerId stamped ──");
    const evaRes = await fetch(`${BASE}/api/ai-concierge/chat`, {
      method: "POST", headers: hdr,
      body: JSON.stringify({ message: "sure, my number is 917-224-7761 and my email is eran@gostork.com", sessionId: priv.id }),
    });
    check("parent CAN give Eva their own contact details in the private thread",
      evaRes.status !== 422, `status=${evaRes.status}`);
    try { await evaRes.body?.cancel(); } catch { /* streaming response */ }

    const sharedEva = await fetch(`${BASE}/api/ai-concierge/chat`, {
      method: "POST", headers: hdr,
      body: JSON.stringify({ message: "my number is 917-224-7761", sessionId: shared.id }),
    });
    const sharedBody = await sharedEva.json().catch(() => ({} as any));
    check("the SAME text is blocked on a shared thread",
      sharedEva.status === 422 && sharedBody?.code === "CONTACT_INFO_BLOCKED",
      `status=${sharedEva.status} code=${sharedBody?.code}`);

    console.log(`\n${"─".repeat(46)}\n${pass} passed, ${fail} failed`);

    await prisma.aiChatMessage.deleteMany({ where: { sessionId: { in: cleanup.sessionIds } } });
    await prisma.aiChatSession.deleteMany({ where: { id: { in: cleanup.sessionIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } });
    process.exit(fail ? 1 : 0);
  } catch (e: any) {
    console.error("verify crashed:", e?.message || e);
    await prisma.aiChatMessage.deleteMany({ where: { sessionId: { in: cleanup.sessionIds } } }).catch(() => {});
    await prisma.aiChatSession.deleteMany({ where: { id: { in: cleanup.sessionIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } }).catch(() => {});
    process.exit(1);
  }
}

main();
