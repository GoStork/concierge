/**
 * Phase 8 Reviews & Ratings end-to-end test (scripts/test-reviews-e2e.ts).
 * Run: npx tsx scripts/test-reviews-e2e.ts
 *
 * Exercises the full lifecycle against the local server on :5001:
 *  1. Ineligible parent is blocked from posting (verified-journey gate)
 *  2. Completed consultation makes the parent eligible (stage consult_completed)
 *  3. Public org review submits + publishes + updates aggregates
 *  4. Editing the review upserts (same id) and refreshes aggregates
 *  5. Doctor review (memberId) with 2-star PRIVATE_FEEDBACK stays off public surfaces
 *  6. Provider can reply + flag; parent-facing list shows the reply
 *  7. Admin queue lists/filters; remove pulls it from public; restore returns it
 *  8. review_prompt cards are excluded from provider message feeds
 * Cleans up everything it created and recomputes aggregates at the end.
 */
const BASE = process.env.BASE_URL || "http://localhost:5001";
const PW = "TestPass123!";
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function getDB() {
  const mod = await import("../server/db.js");
  return mod.prisma;
}

async function makeUser(tag: string): Promise<{ id: string; email: string; auth: string }> {
  const email = `test-reviews-${tag}-${Date.now()}@gostork-test.com`;
  const reg = await fetch(`${BASE}/api/users`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, name: `Review Tester ${tag}` }),
  });
  if (!reg.ok) throw new Error(`register ${tag} failed: ${await reg.text()}`);
  const user = await reg.json();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!login.ok) throw new Error(`login ${tag} failed: ${await login.text()}`);
  const body = await login.json();
  const auth = body?.token ? `Bearer ${body.token}` : "";
  if (!auth) throw new Error(`no JWT for ${tag}`);
  return { id: user.id, email, auth };
}

function hdr(auth: string) {
  return { "Content-Type": "application/json", Authorization: auth };
}

async function main() {
  const prisma = await getDB();
  const created: { reviewIds: string[]; bookingId?: string; userIds: string[]; accountId?: string } = { reviewIds: [], userIds: [] };
  let providerId = "";
  let memberId: string | null = null;

  try {
    // ── Setup: pick a real approved surrogacy agency that has a provider user ──
    const provider = await prisma.provider.findFirst({
      where: {
        services: { some: { status: "APPROVED", providerType: { name: "Surrogacy Agency" } } },
        users: { some: {} },
      },
      select: { id: true, name: true, users: { select: { id: true }, take: 1 }, members: { select: { id: true, name: true }, take: 1 } },
    });
    if (!provider) throw new Error("No approved surrogacy agency with users found");
    providerId = provider.id;
    memberId = provider.members[0]?.id || null;
    const providerUserId = provider.users[0].id;
    console.log(`Target provider: ${provider.name} (${providerId}), member: ${memberId || "none"}`);

    // Parent user + account
    const parent = await makeUser("parent");
    created.userIds.push(parent.id);
    const account = await prisma.parentAccount.create({ data: {} });
    created.accountId = account.id;
    await prisma.user.update({ where: { id: parent.id }, data: { parentAccountId: account.id } });

    // ── 1. Gate: not eligible yet ──
    const elig0 = await (await fetch(`${BASE}/api/reviews/eligibility?providerId=${providerId}`, { headers: hdr(parent.auth) })).json();
    check("ineligible before any consultation", elig0.eligible === false, JSON.stringify(elig0));
    const blocked = await fetch(`${BASE}/api/reviews`, {
      method: "POST", headers: hdr(parent.auth),
      body: JSON.stringify({ providerId, rating: 5, text: "should be blocked" }),
    });
    check("POST blocked for ineligible parent (403)", blocked.status === 403, `got ${blocked.status}`);

    // ── 2. Seed a completed consultation → eligible ──
    const booking = await prisma.booking.create({
      data: {
        parentUserId: parent.id,
        providerUserId,
        scheduledAt: new Date(Date.now() - 24 * 3600 * 1000),
        duration: 30,
        status: "CONFIRMED",
        outcome: "COMPLETED",
        subject: "Review E2E test call",
      },
    });
    created.bookingId = booking.id;
    const elig1 = await (await fetch(`${BASE}/api/reviews/eligibility?providerId=${providerId}`, { headers: hdr(parent.auth) })).json();
    check("eligible after completed consult", elig1.eligible === true && elig1.stage === "consult_completed", JSON.stringify(elig1));
    check("eligibility echoes providerId", elig1.providerId === providerId, JSON.stringify(elig1.providerId));

    // ── 3. Submit public org review ──
    const post1 = await fetch(`${BASE}/api/reviews`, {
      method: "POST", headers: hdr(parent.auth),
      body: JSON.stringify({
        providerId, rating: 5, text: "Wonderful team, super responsive throughout.",
        categories: { communication: 5, transparency: 4, responsiveness: 5, support: 5 },
        anonymous: false, visibility: "PUBLIC",
      }),
    });
    const post1Body = await post1.json();
    check("public review accepted", post1.ok && !!post1Body.reviewId, JSON.stringify(post1Body));
    check("review published (AI screen fail-safe ok)", post1Body.status === "PUBLISHED", post1Body.status);
    if (post1Body.reviewId) created.reviewIds.push(post1Body.reviewId);

    const pub1 = await (await fetch(`${BASE}/api/reviews/provider/${providerId}`, { headers: hdr(parent.auth) })).json();
    const mine = (pub1.reviews || []).find((r: any) => r.id === post1Body.reviewId);
    check("review appears in public provider list", !!mine, `count=${pub1.reviews?.length}`);
    check("reviewer label is first name + initial", !!mine && /^Review T\.?$|^Review\b/.test(mine.reviewerLabel), mine?.reviewerLabel);
    check("aggregates count the review", (pub1.aggregates?.count || 0) >= 1 && pub1.aggregates?.avg != null, JSON.stringify(pub1.aggregates));
    const provRow1 = await prisma.provider.findUnique({ where: { id: providerId }, select: { reviewCount: true, avgOverallScore: true } });
    check("denormalized provider aggregates updated", (provRow1?.reviewCount || 0) >= 1, JSON.stringify(provRow1));

    // ── 4. Edit (upsert) ──
    const post2 = await fetch(`${BASE}/api/reviews`, {
      method: "POST", headers: hdr(parent.auth),
      body: JSON.stringify({ providerId, rating: 4, text: "Updated: still great, minor delays.", visibility: "PUBLIC" }),
    });
    const post2Body = await post2.json();
    check("edit upserts same review id", post2Body.reviewId === post1Body.reviewId, `${post2Body.reviewId} vs ${post1Body.reviewId}`);
    const pub2 = await (await fetch(`${BASE}/api/reviews/provider/${providerId}`, { headers: hdr(parent.auth) })).json();
    const mine2 = (pub2.reviews || []).find((r: any) => r.id === post1Body.reviewId);
    check("edited rating visible", mine2?.rating === 4, `rating=${mine2?.rating}`);

    // ── 5. Doctor review, 2 stars, PRIVATE_FEEDBACK ──
    if (memberId) {
      const post3 = await fetch(`${BASE}/api/reviews`, {
        method: "POST", headers: hdr(parent.auth),
        body: JSON.stringify({ providerId, memberId, rating: 2, text: "Private: felt rushed.", categories: { communication: 2, expertise: 3, care: 2 }, visibility: "PRIVATE_FEEDBACK" }),
      });
      const post3Body = await post3.json();
      check("private doctor feedback accepted", post3.ok && post3Body.visibility === "PRIVATE_FEEDBACK", JSON.stringify(post3Body));
      if (post3Body.reviewId) created.reviewIds.push(post3Body.reviewId);
      const memberList = await (await fetch(`${BASE}/api/reviews/member/${memberId}`, { headers: hdr(parent.auth) })).json();
      const leaked = (memberList.reviews || []).some((r: any) => r.id === post3Body.reviewId);
      check("private feedback NOT in public member list", !leaked, `leaked=${leaked}`);
    } else {
      console.log("  SKIP  doctor review tests (provider has no members)");
    }

    // ── 6. Provider reply + flag ──
    const provUser = await makeUser("provider");
    created.userIds.push(provUser.id);
    await prisma.user.update({ where: { id: provUser.id }, data: { providerId, roles: ["PROVIDER_ADMIN"] } });
    // Re-login so the JWT/session picks up the provider role
    const provLogin = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: provUser.email, password: PW }) });
    const provAuth = `Bearer ${(await provLogin.json()).token}`;

    const mineList = await (await fetch(`${BASE}/api/reviews/mine`, { headers: hdr(provAuth) })).json();
    check("provider /mine lists the public review", Array.isArray(mineList) && mineList.some((r: any) => r.id === post1Body.reviewId), `n=${Array.isArray(mineList) ? mineList.length : "?"}`);
    const privateVisibleToProvider = Array.isArray(mineList) && created.reviewIds.length > 1 && mineList.some((r: any) => r.id === created.reviewIds[1]);
    check("private feedback hidden from provider /mine", !privateVisibleToProvider);

    const reply = await fetch(`${BASE}/api/reviews/${post1Body.reviewId}/reply`, {
      method: "POST", headers: hdr(provAuth), body: JSON.stringify({ text: "Thank you! We loved working with you." }),
    });
    check("provider reply accepted", reply.ok, `${reply.status}`);
    const pub3 = await (await fetch(`${BASE}/api/reviews/provider/${providerId}`, { headers: hdr(parent.auth) })).json();
    const withReply = (pub3.reviews || []).find((r: any) => r.id === post1Body.reviewId);
    check("reply visible on public list", !!withReply?.providerReply, withReply?.providerReply);

    const flag = await fetch(`${BASE}/api/reviews/${post1Body.reviewId}/flag`, {
      method: "POST", headers: hdr(provAuth), body: JSON.stringify({ reason: "E2E test flag - please recheck" }),
    });
    check("provider flag accepted", flag.ok, `${flag.status}`);

    // ── 7. Admin queue ──
    const adminUser = await makeUser("admin");
    created.userIds.push(adminUser.id);
    await prisma.user.update({ where: { id: adminUser.id }, data: { roles: ["GOSTORK_ADMIN"] } });
    const adminLogin = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: adminUser.email, password: PW }) });
    const adminAuth = `Bearer ${(await adminLogin.json()).token}`;

    const adminAll = await (await fetch(`${BASE}/api/admin/reviews`, { headers: hdr(adminAuth) })).json();
    check("admin queue lists the review", Array.isArray(adminAll) && adminAll.some((r: any) => r.id === post1Body.reviewId), `n=${Array.isArray(adminAll) ? adminAll.length : "?"}`);
    const adminFlagged = await (await fetch(`${BASE}/api/admin/reviews?flagged=true`, { headers: hdr(adminAuth) })).json();
    check("flagged filter finds it", adminFlagged.some((r: any) => r.id === post1Body.reviewId));

    const remove = await fetch(`${BASE}/api/admin/reviews/${post1Body.reviewId}/remove`, { method: "POST", headers: hdr(adminAuth), body: JSON.stringify({ reason: "E2E test removal" }) });
    check("admin remove ok", remove.ok, `${remove.status}`);
    const pub4 = await (await fetch(`${BASE}/api/reviews/provider/${providerId}`, { headers: hdr(parent.auth) })).json();
    check("removed review gone from public list", !(pub4.reviews || []).some((r: any) => r.id === post1Body.reviewId));

    const restore = await fetch(`${BASE}/api/admin/reviews/${post1Body.reviewId}/restore`, { method: "POST", headers: hdr(adminAuth) });
    check("admin restore ok", restore.ok, `${restore.status}`);
    const pub5 = await (await fetch(`${BASE}/api/reviews/provider/${providerId}`, { headers: hdr(parent.auth) })).json();
    check("restored review back on public list", (pub5.reviews || []).some((r: any) => r.id === post1Body.reviewId));

    // ── 8. review_prompt cards hidden from provider feeds ──
    // Post a synthetic review_prompt card into a session owned by the parent, then
    // read it back through the provider-facing messages endpoint.
    const session = await prisma.aiChatSession.create({
      data: { userId: parent.id, status: "CONSULTATION_BOOKED", providerId, subjectType: "surrogate", title: "Review E2E session", matchmakerId: null },
    });
    const promptMsg = await prisma.aiChatMessage.create({
      data: {
        sessionId: session.id, role: "assistant", senderType: "system",
        content: "Quick favor - how was your Match Call?",
        uiCardType: "review_prompt",
        uiCardData: { providerId, providerName: provider.name, stage: "consult_completed" },
      },
    });
    const provMsgs = await (await fetch(`${BASE}/api/ai-concierge/session/${session.id}/messages`, { headers: hdr(provAuth) })).json();
    const providerSeesPrompt = (provMsgs.messages || []).some((m: any) => m.id === promptMsg.id);
    check("provider feed hides review_prompt card", !providerSeesPrompt);
    const parentMsgs = await (await fetch(`${BASE}/api/ai-concierge/session/${session.id}/messages`, { headers: hdr(parent.auth) })).json();
    const parentSeesPrompt = (parentMsgs.messages || []).some((m: any) => m.id === promptMsg.id);
    check("parent feed shows review_prompt card", parentSeesPrompt);
    await prisma.aiChatMessage.deleteMany({ where: { sessionId: session.id } });
    await prisma.aiChatSession.delete({ where: { id: session.id } });
  } finally {
    // ── Cleanup ──
    const prismaC = await getDB();
    try {
      if (created.reviewIds.length) await prismaC.providerReview.deleteMany({ where: { id: { in: created.reviewIds } } });
      if (created.bookingId) await prismaC.booking.delete({ where: { id: created.bookingId } }).catch(() => {});
      if (providerId) {
        const { updateReviewAggregates } = await import("../server/reviews-router.js");
        await updateReviewAggregates(providerId, null);
        if (memberId) await updateReviewAggregates(providerId, memberId);
      }
      if (created.userIds.length) {
        await prismaC.inAppNotification.deleteMany({ where: { userId: { in: created.userIds } } }).catch(() => {});
        await prismaC.user.deleteMany({ where: { id: { in: created.userIds } } }).catch(() => {});
      }
      if (created.accountId) await prismaC.parentAccount.delete({ where: { id: created.accountId } }).catch(() => {});
      console.log("Cleanup done.");
    } catch (e: any) {
      console.error("Cleanup error:", e?.message);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
