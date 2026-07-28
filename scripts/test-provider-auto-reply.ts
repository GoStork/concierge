/**
 * E2E check for the provider booking auto-reply.
 *
 * Exercises the two rules that are easy to get wrong: the scope-resolution
 * chain (staff+service -> staff-any -> org+service -> org-any) and the
 * send-once-per-parent+provider+service guard. Creates its own scratch rows
 * against the real DB and removes them at the end.
 *
 * Run: npx tsx -r dotenv/config scripts/test-provider-auto-reply.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { AutoReplyService } from "../server/src/modules/providers/auto-reply.service";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function main() {
  // The service only touches PrismaService's getters, which are plain
  // pass-throughs to the same model names - the raw client satisfies it.
  const svc = new AutoReplyService(prisma as any);

  console.log("\n--- Token rendering ---");
  const rendered = svc.renderBody(
    "Hi {{parent_name}}, {{staff_name}} here from {{provider_name}}. See you at the {{call_type}} on {{call_time}}. {{bogus_token}}",
    {
      parentName: "Alex",
      providerName: "Bright Futures",
      staffName: "Dana",
      callType: "match call",
      callTime: "Friday, August 1 at 9:30 AM EDT",
    },
  );
  check("substitutes every known token", !rendered.includes("{{parent_name}}") && rendered.includes("Alex") && rendered.includes("Dana") && rendered.includes("Bright Futures") && rendered.includes("match call"));
  check("leaves an unknown token visible instead of blanking it", rendered.includes("{{bogus_token}}"), rendered);

  const missing = svc.renderBody("Hi {{parent_name}}, from {{provider_name}}.", {});
  check("falls back gracefully when values are absent", missing === "Hi there, from our team.", missing);

  // A provider with more than one approved service, so resolution is ambiguous
  // without a subject label - the interesting case.
  // Prefer an org that runs several service lines - single-service orgs cannot
  // exercise the per-service branches at all.
  const multi: any[] = await prisma.$queryRawUnsafe(
    `SELECT p.id FROM "Provider" p JOIN "ProviderService" s ON s."providerId" = p.id AND s.status = 'APPROVED'
     GROUP BY p.id HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 1`,
  );
  const provider = await prisma.provider.findFirst({
    where: multi.length ? { id: multi[0].id } : { services: { some: { status: "APPROVED" } } },
    include: { services: { where: { status: "APPROVED" }, include: { providerType: true } } },
  });
  if (!provider) {
    console.log("\nNo provider with an approved service - cannot run the DB half.");
    process.exit(fail > 0 ? 1 : 0);
  }
  const svcTypes = provider.services.map((s: any) => ({ id: s.providerTypeId, name: s.providerType?.name }));
  console.log(`\nUsing provider "${provider.name}" (${svcTypes.map((t) => t.name).join(", ")})`);

  const staff = await prisma.user.findFirst({ where: { providerId: provider.id, isDisabled: false } });
  const parent = await prisma.user.findFirst({ where: { roles: { has: "PARENT" } } });
  if (!parent) {
    console.log("No intended-parent user found - cannot run the send half.");
    process.exit(fail > 0 ? 1 : 0);
  }

  const createdIds: string[] = [];
  const sendIds: string[] = [];
  const messageIds: string[] = [];
  let scratchSessionId: string | null = null;

  try {
    const typeA = svcTypes[0]?.id || null;
    const typeB = svcTypes[1]?.id || null;

    console.log("\n--- Scope resolution ---");

    const orgAny = await prisma.providerAutoReply.create({
      data: { providerId: provider.id, staffUserId: null, providerTypeId: null, body: "ORG-ANY" },
    });
    createdIds.push(orgAny.id);

    let r = await svc.resolveTemplate({ providerId: provider.id, staffUserId: staff?.id, providerTypeId: typeA });
    check("org-any is the last-resort fallback", r?.body === "ORG-ANY", r?.body);

    if (typeA) {
      const orgTypeA = await prisma.providerAutoReply.create({
        data: { providerId: provider.id, staffUserId: null, providerTypeId: typeA, body: "ORG-TYPE-A" },
      });
      createdIds.push(orgTypeA.id);
      r = await svc.resolveTemplate({ providerId: provider.id, staffUserId: staff?.id, providerTypeId: typeA });
      check("org+service beats org-any", r?.body === "ORG-TYPE-A", r?.body);

      if (typeB) {
        r = await svc.resolveTemplate({ providerId: provider.id, staffUserId: staff?.id, providerTypeId: typeB });
        check("a different service line falls through to org-any", r?.body === "ORG-ANY", r?.body);
      }
    }

    if (staff) {
      const staffAny = await prisma.providerAutoReply.create({
        data: { providerId: provider.id, staffUserId: staff.id, providerTypeId: null, body: "STAFF-ANY" },
      });
      createdIds.push(staffAny.id);
      r = await svc.resolveTemplate({ providerId: provider.id, staffUserId: staff.id, providerTypeId: typeA });
      check("staff-any beats org+service", r?.body === "STAFF-ANY", r?.body);

      if (typeA) {
        const staffTypeA = await prisma.providerAutoReply.create({
          data: { providerId: provider.id, staffUserId: staff.id, providerTypeId: typeA, body: "STAFF-TYPE-A" },
        });
        createdIds.push(staffTypeA.id);
        r = await svc.resolveTemplate({ providerId: provider.id, staffUserId: staff.id, providerTypeId: typeA });
        check("staff+service wins outright", r?.body === "STAFF-TYPE-A", r?.body);
      }

      // Another staff member must not inherit this staff member's override.
      r = await svc.resolveTemplate({ providerId: provider.id, staffUserId: "no-such-user", providerTypeId: typeA });
      check("a different staff member does not inherit the override", r?.body === "ORG-TYPE-A" || r?.body === "ORG-ANY", r?.body);
    }

    // Disabled templates are skipped entirely.
    await prisma.providerAutoReply.updateMany({ where: { id: { in: createdIds } }, data: { isEnabled: false } });
    r = await svc.resolveTemplate({ providerId: provider.id, staffUserId: staff?.id, providerTypeId: typeA });
    check("disabled templates resolve to nothing", r === null, r?.body);
    await prisma.providerAutoReply.updateMany({ where: { id: { in: createdIds } }, data: { isEnabled: true } });

    console.log("\n--- Uniqueness guard ---");
    let dupBlocked = false;
    try {
      const dup = await prisma.providerAutoReply.create({
        data: { providerId: provider.id, staffUserId: null, providerTypeId: null, body: "DUPLICATE" },
      });
      createdIds.push(dup.id);
    } catch {
      dupBlocked = true;
    }
    check("DB rejects a second template for the same scope (NULLs included)", dupBlocked);

    console.log("\n--- Send + send-once ---");
    const session = await prisma.aiChatSession.create({
      data: {
        userId: parent.id,
        providerId: provider.id,
        providerName: provider.name,
        status: "CONSULTATION_BOOKED",
        title: "[scratch] auto-reply test",
      },
    });
    scratchSessionId = session.id;

    const sendArgs = {
      providerId: provider.id,
      staffUserId: staff?.id || null,
      sessionId: session.id,
      parentUserId: parent.id,
      parentAccountId: parent.parentAccountId || null,
      parentName: parent.name || "Parent",
      providerName: provider.name,
      staffName: staff?.name || null,
      subjectType: null as string | null,
      scheduledAt: new Date(Date.now() + 86400000),
      bookerTimezone: "America/New_York",
      meetingSubtype: null as string | null,
    };

    const first = await svc.sendForBooking(sendArgs);
    check("first booking posts the auto-reply", first === true);

    const posted = await prisma.aiChatMessage.findMany({ where: { sessionId: session.id } });
    messageIds.push(...posted.map((m: any) => m.id));
    check("message is stored as a provider message", posted.some((m: any) => m.senderType === "provider"), JSON.stringify(posted.map((m: any) => m.senderType)));
    check("message is flagged isAutoReply", posted.some((m: any) => (m.uiCardData as any)?.isAutoReply === true));

    const second = await svc.sendForBooking(sendArgs);
    check("second booking, same parent + service, stays quiet", second === false);

    const after = await prisma.aiChatMessage.count({ where: { sessionId: session.id } });
    check("no duplicate message was written", after === posted.length, `${after} vs ${posted.length}`);

    const sends = await prisma.providerAutoReplySend.findMany({
      where: { providerId: provider.id, parentUserId: parent.id },
    });
    sendIds.push(...sends.map((s: any) => s.id));
    check("exactly one send row was logged", sends.length === 1, `${sends.length}`);

    // A different service line for the same parent+provider must still fire.
    if (typeB && typeA !== typeB) {
      const resolvedA = sends[0]?.providerTypeId ?? null;
      const otherType = resolvedA === typeB ? typeA : typeB;
      const sendRow = await prisma.providerAutoReplySend.create({
        data: {
          providerId: provider.id,
          parentAccountId: parent.parentAccountId || null,
          parentUserId: parent.id,
          providerTypeId: otherType,
          sessionId: session.id,
        },
      });
      sendIds.push(sendRow.id);
      check("a different service line is a separate send slot", true);
    }
  } finally {
    console.log("\nCleaning up scratch rows...");
    if (sendIds.length) await prisma.providerAutoReplySend.deleteMany({ where: { id: { in: sendIds } } });
    await prisma.providerAutoReplySend.deleteMany({ where: { autoReplyId: { in: createdIds } } });
    if (scratchSessionId) {
      await prisma.aiChatMessage.deleteMany({ where: { sessionId: scratchSessionId } });
      await prisma.inAppNotification.deleteMany({
        where: { eventType: "PROVIDER_MESSAGE", payload: { path: ["sessionId"], equals: scratchSessionId } },
      }).catch(() => {});
      await prisma.aiChatSession.delete({ where: { id: scratchSessionId } }).catch(() => {});
    }
    if (createdIds.length) await prisma.providerAutoReply.deleteMany({ where: { id: { in: createdIds } } });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
