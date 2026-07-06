// Auto-draft matrix test: exercises the Phase 2 cost-sheet auto-draft for
// EVERY provider/subject type against real cost-sheet data in the dev DB.
// For each scenario it synthesizes a chat session + booking (isTestData),
// temporarily enables the provider's autoCostSheetDraft flag, runs the real
// CostSheetAutoDraftService, reports the outcome, then deletes everything
// it created and restores the flag.
//
// Usage: npx tsx scripts/test-auto-draft-matrix.ts
import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../server/src/app.module";
import { PrismaService } from "../server/src/modules/prisma/prisma.service";
import { CostSheetAutoDraftService } from "../server/src/modules/billing/cost-sheet-auto-draft.service";

const TEST_PARENT_USER_ID = "7a618376-d9d9-4bfd-9acb-5ea048927352"; // natan123+bdbdbddwbb@gmail.com

interface Scenario {
  name: string;
  providerId: string;
  providerUserId: string;
  subjectType: string | null;
  // Loads the subject profile id + expected compensation for this scenario.
  // May synthesize a row; return cleanup() to remove it afterwards.
  loadSubject?: (prisma: PrismaService, providerId: string) => Promise<{ id: string; comp: number | null; note: string; cleanup?: () => Promise<void> } | null>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "Egg Donor (fresh) - Asian Egg Bank",
    providerId: "130506a2-3137-4ed9-b5c7-1f16c0703c78",
    providerUserId: "453503a4-7000-4e44-9f8e-361e80de0ea6",
    subjectType: "Egg Donor",
    loadSubject: async (prisma, providerId) => {
      const d = await prisma.eggDonor.findFirst({
        where: { providerId, donorType: { contains: "fresh", mode: "insensitive" }, donorCompensation: { not: null } },
        select: { id: true, donorCompensation: true },
      });
      return d ? { id: d.id, comp: Number(d.donorCompensation), note: `donorCompensation=$${d.donorCompensation}` } : null;
    },
  },
  {
    name: "Egg Donor (frozen, synthetic donor) - PFCLA",
    providerId: "18d22649-23cf-498c-9a48-a43babd79726",
    providerUserId: "313473a8-4df1-4a47-9c6c-4eb14fe92426",
    subjectType: "Egg Donor",
    loadSubject: async (prisma, providerId) => {
      // No frozen donors exist in the dev DB - synthesize one so the
      // frozen leaf-derivation branch is exercised end-to-end.
      const d = await prisma.eggDonor.create({
        data: {
          providerId,
          externalId: `matrix-test-frozen-${Date.now()}`,
          firstName: "MatrixTest",
          donorType: "Frozen",
        },
      });
      return {
        id: d.id,
        comp: null,
        note: "synthetic frozen donor (no comp - sheet values used)",
        cleanup: async () => { await prisma.eggDonor.delete({ where: { id: d.id } }); },
      };
    },
  },
  {
    name: "Surrogacy Agency, NO specific surrogate (international archetype) - Family Creations",
    providerId: "d0af900d-41bf-43cb-9051-d52c8cda3f24",
    providerUserId: "84c3e5d8-07b8-494b-92ae-3a5d4e8c415c",
    subjectType: "SurrogacyAgency",
    // No loadSubject: session carries subjectType but no subjectProfileId,
    // like agencies with no listed surrogates / international programs.
    // Comp must fall back to the sheet's own base-comp line.
  },
  {
    name: "Surrogate - Family Creations (known-good baseline)",
    providerId: "d0af900d-41bf-43cb-9051-d52c8cda3f24",
    providerUserId: "84c3e5d8-07b8-494b-92ae-3a5d4e8c415c",
    subjectType: "Surrogate",
    loadSubject: async (prisma, providerId) => {
      const s = await prisma.surrogate.findFirst({
        where: { providerId, baseCompensation: { not: null } },
        select: { id: true, baseCompensation: true },
      });
      return s ? { id: s.id, comp: Number(s.baseCompensation), note: `baseCompensation=$${s.baseCompensation}` } : null;
    },
  },
  {
    name: "Sperm Donor - Sperm Bank California",
    providerId: "25dacdbf-e1d6-4189-987b-934b12d99022",
    providerUserId: "718b37d9-a4f4-4ef4-8941-b39eeb32d9ac",
    subjectType: "Sperm Donor",
    loadSubject: async (prisma, providerId) => {
      // Prefer a donor WITH vialTypes so the per-vial sheet filter is
      // exercised; fall back to any donor.
      const withVials = await prisma.spermDonor.findFirst({
        where: { providerId, NOT: { vialTypes: { isEmpty: true } } },
        select: { id: true, compensation: true, vialTypes: true },
      });
      const d = withVials || await prisma.spermDonor.findFirst({
        where: { providerId },
        select: { id: true, compensation: true, vialTypes: true },
      });
      return d ? {
        id: d.id,
        comp: d.compensation != null ? Number(d.compensation) : null,
        note: `compensation=${d.compensation ?? "none"} vialTypes=[${(d.vialTypes || []).join(",")}]`,
      } : null;
    },
  },
  {
    name: "IVF Clinic (no subject, profile fallback) - CNY Fertility",
    providerId: "a418a7e3-3c41-495a-90f0-c6775c38c3a3",
    providerUserId: "b4cde5b3-8e2e-4342-a830-002402879cf8",
    subjectType: null,
  },
];

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const prisma = app.get(PrismaService);
  const svc = app.get(CostSheetAutoDraftService);
  const results: string[] = [];

  for (const sc of SCENARIOS) {
    let sessionId: string | null = null;
    let bookingId: string | null = null;
    let savedFlags: any = undefined;
    let subjectCleanupFn: (() => Promise<void>) | undefined;
    try {
      // Subject
      let subjectId: string | null = null;
      let subjectNote = sc.subjectType ? `${sc.subjectType} with no profile id` : "no subject (profile fallback)";
      let expectedComp: number | null = null;
      if (sc.loadSubject) {
        const subject = await sc.loadSubject(prisma, sc.providerId);
        if (!subject) {
          results.push(`SKIP  ${sc.name}: no subject profile found in DB`);
          continue;
        }
        subjectId = subject.id;
        subjectNote = subject.note;
        expectedComp = subject.comp;
        subjectCleanupFn = subject.cleanup;
      }

      // Enable gate 2, remembering the prior value.
      const prov = await prisma.provider.findUnique({ where: { id: sc.providerId }, select: { autoFeaturesEnabled: true } });
      savedFlags = prov?.autoFeaturesEnabled ?? null;
      await prisma.provider.update({
        where: { id: sc.providerId },
        data: { autoFeaturesEnabled: { ...(savedFlags || {}), autoCostSheetDraft: true } },
      });

      // Synthetic session + booking (marked test data).
      const session = await prisma.aiChatSession.create({
        data: {
          userId: TEST_PARENT_USER_ID,
          providerId: sc.providerId,
          status: "CONSULTATION_BOOKED",
          title: `[matrix-test] ${sc.name}`,
          subjectType: sc.subjectType,
          subjectProfileId: subjectId,
          isTestData: true,
        },
      });
      sessionId = session.id;
      const booking = await prisma.booking.create({
        data: {
          providerUserId: sc.providerUserId,
          parentUserId: TEST_PARENT_USER_ID,
          scheduledAt: new Date(Date.now() + 24 * 3600 * 1000),
          duration: 30,
          status: "CONFIRMED",
          subject: `[matrix-test] ${sc.name}`,
        },
      });
      bookingId = booking.id;

      // Run the real service.
      const result = await svc.tryAutoDraftForBooking(booking.id);

      // Inspect what got drafted.
      const cards = await prisma.aiChatMessage.findMany({
        where: { sessionId: session.id, uiCardType: "cost_sheet_draft_approval" },
        select: { uiCardData: true },
      });
      const cardSummaries = cards.map(c => {
        const d = (c.uiCardData as any) || {};
        const compLine = (d.lineItems || []).find((li: any) => li.source === "subject_profile_compensation");
        return `${d.programName || d.sourceCostSheetCategory || d.sourceCostSheetId} [${d.sourceCostSheetSubTypeLabel || d.sourceCostSheetSubType}] total=$${(d.totalCostCents / 100).toLocaleString()}${compLine ? ` compSubstituted=$${(compLine.amountCents / 100).toLocaleString()}` : ""}`;
      });

      const compCheck = expectedComp != null
        ? cards.some(c => ((c.uiCardData as any)?.lineItems || []).some((li: any) => li.source === "subject_profile_compensation" && li.amountCents === Math.round(expectedComp! * 100)))
          ? " COMP-OK" : " COMP-MISSING!"
        : "";

      results.push(
        `${result.status === "drafted" ? "PASS " : "INFO "} ${sc.name}\n` +
        `        subject: ${subjectNote}\n` +
        `        result: ${result.status}${result.reason ? ` (${result.reason})` : ""}${compCheck}\n` +
        (cardSummaries.length ? cardSummaries.map(s => `        card: ${s}`).join("\n") : "        (no cards)"),
      );
    } catch (err: any) {
      results.push(`FAIL  ${sc.name}: ${err.message}`);
    } finally {
      // Cleanup: cards + session + booking, restore flag.
      try {
        if (sessionId) {
          await prisma.aiChatMessage.deleteMany({ where: { sessionId } });
          await prisma.aiChatSession.delete({ where: { id: sessionId } });
        }
        if (bookingId) await prisma.booking.delete({ where: { id: bookingId } });
        if (savedFlags !== undefined) {
          await prisma.provider.update({ where: { id: sc.providerId }, data: { autoFeaturesEnabled: savedFlags } });
        }
        if (subjectCleanupFn) await subjectCleanupFn();
      } catch (cleanupErr: any) {
        results.push(`WARN  cleanup for ${sc.name}: ${cleanupErr.message}`);
      }
    }
  }

  console.log("\n===== AUTO-DRAFT MATRIX RESULTS =====\n");
  console.log(results.join("\n\n"));
  console.log("\n=====================================\n");
  await app.close();
  process.exit(0);
})();
