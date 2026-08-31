/**
 * Provider onboarding checklist - fully DERIVED, nothing stored.
 *
 * One endpoint computes every step's status from the real artifacts (services,
 * sync configs, cost sheets, W-9, Stripe account, ...) so the checklist can
 * never drift from reality. The only writes here are the Phase C handoff
 * tasks raised onto the provider's Home queue - idempotent parentTask upserts
 * on unique systemKeys (onb*:<providerId>), modeled on raiseW9Task
 * (w9.controller.ts). Read-time closing of those tasks lives in
 * task-materializer.ts (reconcileOnboardingTasks), which owns ONLY the onb*
 * prefixes.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { prisma } from "../../../db";

type StepStatus = "done" | "pending" | "waiting_on_provider" | "optional" | "locked";

export type OnboardingStep = {
  key: string;
  group: "created" | "admin_setup" | "provider_setup" | "go_live";
  label: string;
  detail: string;
  status: StepStatus;
  /** Admin-side deep link (provider edit tab or account page). */
  deepLink: string;
  /** True when the step never counts toward percent (nice-to-have). */
  isOptional?: boolean;
  /** Admin can manually check this step off (optional steps with no hard artifact). */
  manuallyMarkable?: boolean;
  /** True when its done status came from the admin's manual mark. */
  manuallyDone?: boolean;
};

/** Optional steps the admin can check off by hand when there is nothing to
 *  do in that section. Stored as a DONE parentTask with systemKey
 *  onbmark:<stepKey>:<providerId> - created directly as DONE so it never
 *  appears on anyone's open queue, and the reconciler never touches the
 *  onbmark prefix. */
const MARKABLE_STEP_KEYS = new Set([
  "parent_form", "parent_form_provider", "partner_clinics", "knowledge",
  "playbooks", "automation", "branding", "sponsorship",
]);

export type OnboardingSummary = {
  providerId: string;
  providerName: string;
  steps: OnboardingStep[];
  /** done / required (optional steps excluded). */
  doneCount: number;
  requiredCount: number;
  percent: number;
  tasksSentAt: string | null;
};

function requireAdmin(req: Request) {
  const roles: string[] = (req.user as any)?.roles || [];
  if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
    throw new ForbiddenException("GoStork admin only");
  }
}

/** ProviderType.name -> ReferralFeeConfig.serviceType key. */
function serviceTypeKey(typeName: string): string {
  const n = typeName.toLowerCase();
  if (n.includes("surrogacy")) return "SURROGACY";
  if (n.includes("egg")) return "EGG_DONATION";
  if (n.includes("sperm")) return "SPERM_DONATION";
  if (n.includes("ivf") || n.includes("fertility")) return "IVF_CLINIC";
  return "OTHER";
}

/** Phase C handoff tasks. `reconcilable` keys are auto-closed by the
 *  task-materializer when the artifact appears; the rest the provider checks
 *  off manually on their Home queue. */
const HANDOFF_TASKS: Array<{
  prefix: string;
  title: string;
  notes: string;
  deepLink: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
}> = [
  { prefix: "onbcal", title: "Connect your calendar", notes: "Connect Google, Outlook, or Apple Calendar so parents can book consultations with your team.", deepLink: "/account/calendar", priority: "HIGH" },
  { prefix: "onbstripe", title: "Connect payouts", notes: "Set up your payout account so GoStork can send you money.", deepLink: "/account/payouts", priority: "HIGH" },
  { prefix: "onbcosts", title: "Upload your cost sheet(s)", notes: "Upload a cost sheet for each service you offer. GoStork reviews and approves them before they go live.", deepLink: "/account/company", priority: "HIGH" },
  { prefix: "onbpaybasis", title: "Choose how parents are invoiced", notes: "On the Billing page, pick your Parent Pays Basis for each service: the full quoted total, or a default first payment amount.", deepLink: "/account/billing", priority: "HIGH" },
  { prefix: "onbprofile", title: "Review your company profile", notes: "Check your logo, about text, locations, and contact details - parents see these on your marketplace profile.", deepLink: "/account/company", priority: "MEDIUM" },
  { prefix: "onbteam", title: "Add your team members and assign roles", notes: "Invite your staff and assign their roles and locations so the right people get the right work.", deepLink: "/account/team", priority: "MEDIUM" },
  { prefix: "onbai", title: "Set up your AI Concierge", notes: "Review your AI Concierge settings and knowledge so it answers parents accurately about your organization.", deepLink: "/account/concierge", priority: "MEDIUM" },
  { prefix: "onbform", title: "Review your Parent Form", notes: "Review the intake form parents fill out for you and flag any question that needs adjusting.", deepLink: "/account/parent-form", priority: "MEDIUM" },
  { prefix: "onbplaybooks", title: "Configure your playbooks", notes: "Set up task playbooks that fire as parents move through their journey.", deepLink: "/account/playbooks", priority: "LOW" },
  { prefix: "onbauto", title: "Review your automations", notes: "Review auto-replies, billing automation, and silence rules. Defaults apply until you customize them.", deepLink: "/account/automation", priority: "LOW" },
  { prefix: "onbbrand", title: "Review your branding", notes: "Your logo and brand were pre-filled from your website - confirm or adjust them.", deepLink: "/account/branding", priority: "LOW" },
  { prefix: "onbsponsor", title: "Explore sponsorship (optional)", notes: "Sponsored placement boosts your visibility with matching parents.", deepLink: "/account/sponsorship", priority: "LOW" },
];

export async function computeOnboarding(providerId: string): Promise<OnboardingSummary | null> {
  const db = prisma as any;
  const provider = await db.provider.findUnique({
    where: { id: providerId },
    include: {
      services: { include: { providerType: true } },
      locations: { select: { id: true } },
    },
  });
  if (!provider) return null;

  const typeNames: string[] = provider.services.map((s: any) => s.providerType?.name || "");
  const hasType = (frag: string) => typeNames.some((n) => n.toLowerCase().includes(frag));
  const hasEgg = hasType("egg");
  const hasSurrogacy = hasType("surrogacy");
  const hasSperm = hasType("sperm");

  const [
    users, eggSync, surroSync, spermSync,
    eggCount, surroCount, spermCount,
    costSheets, referralFees, w9, pagr,
    calendarCount, bank, knowledgeCount, playbookCount, autoReplyCount,
    ipFormOverrideCount, onbTasks,
  ] = await Promise.all([
    db.user.findMany({ where: { providerId }, select: { id: true, roles: true } }),
    hasEgg ? db.eggDonorSyncConfig.findUnique({ where: { providerId } }) : null,
    hasSurrogacy ? db.surrogateSyncConfig.findUnique({ where: { providerId } }) : null,
    hasSperm ? db.spermDonorSyncConfig.findUnique({ where: { providerId } }) : null,
    hasEgg ? db.eggDonor.count({ where: { providerId } }) : 0,
    hasSurrogacy ? db.surrogate.count({ where: { providerId } }) : 0,
    hasSperm ? db.spermDonor.count({ where: { providerId } }) : 0,
    db.providerCostSheet.findMany({ where: { providerId }, select: { status: true } }),
    db.referralFeeConfig.findMany({ where: { providerId, isActive: true }, select: { serviceType: true, feeType: true, flatAmount: true, percentage: true, parentPaysBasis: true, defaultServiceAmount: true } }),
    db.providerW9.findUnique({ where: { providerId }, select: { status: true } }),
    db.providerAgreement.findFirst({ where: { providerId }, orderBy: { createdAt: "desc" }, select: { status: true, guestOpenedAt: true } }),
    db.calendarConnection.count({ where: { connected: true, tokenValid: true, user: { providerId } } }),
    db.providerBankAccount.findUnique({ where: { providerId }, select: { payoutsEnabled: true, stripeConnectAccountId: true } }),
    db.knowledgeChunk.count({ where: { providerId } }),
    db.taskPlaybook.count({ where: { providerId } }),
    db.providerAutoReply.count({ where: { providerId } }),
    db.ipFormProviderOverride.count({ where: { providerId } }),
    db.parentTask.findMany({
      where: { providerId, source: "SYSTEM", systemKey: { startsWith: "onb" } },
      select: { systemKey: true, status: true, createdAt: true },
    }),
  ]);

  const taskByPrefix = new Map<string, any>();
  // Admin manual check-offs: systemKey onbmark:<stepKey>:<providerId>.
  const markedKeys = new Set<string>();
  for (const t of onbTasks as any[]) {
    const parts = String(t.systemKey || "").split(":");
    if (parts[0] === "onbmark") {
      if (parts[1]) markedKeys.add(parts[1]);
      continue;
    }
    if (parts[0]) taskByPrefix.set(parts[0], t);
  }
  const handoffTasks = (onbTasks as any[]).filter((t) => !String(t.systemKey || "").startsWith("onbmark:"));
  const tasksSentAt: string | null = handoffTasks.length
    ? new Date(Math.min(...handoffTasks.map((t) => new Date(t.createdAt).getTime()))).toISOString()
    : null;
  const taskDone = (prefix: string) => taskByPrefix.get(prefix)?.status === "DONE";
  const taskRaised = (prefix: string) => taskByPrefix.has(prefix);

  const editLink = (tab: string) => `/admin/providers/${providerId}?tab=${tab}`;
  const steps: OnboardingStep[] = [];

  // ── Phase A - Created ──
  steps.push({
    key: "created", group: "created", label: "Provider created",
    detail: "Profile scraped from the website and approved.",
    status: "done", deepLink: editLink("profile"),
  });
  const hasProviderAdmin = (users as any[]).some((u) => (u.roles || []).includes("PROVIDER_ADMIN"));
  steps.push({
    key: "admin_user", group: "created", label: "Provider admin user created",
    detail: hasProviderAdmin ? "A PROVIDER_ADMIN account exists." : "Create the provider's admin account so they can log in.",
    status: hasProviderAdmin ? "done" : "pending", deepLink: editLink("users"),
  });

  // ── Phase B - Admin setup ──
  const profileComplete = Boolean(provider.logoUrl && provider.about && provider.phone && provider.locations.length > 0);
  steps.push({
    key: "profile", group: "admin_setup", label: "Profile complete",
    detail: profileComplete ? "Logo, about, phone, and at least one location are set." : "Missing: " + [
      !provider.logoUrl && "logo", !provider.about && "about", !provider.phone && "phone",
      provider.locations.length === 0 && "location",
    ].filter(Boolean).join(", ") + ".",
    status: profileComplete ? "done" : "pending", deepLink: editLink("profile"),
  });

  const scraperStep = (key: string, label: string, tab: string, cfg: any, count: number) => {
    const ok = Boolean(cfg) && ["SUCCESS", "PARTIAL", "COMPLETED"].includes(String(cfg?.syncStatus || "").toUpperCase()) && count > 0;
    steps.push({
      key, group: "admin_setup", label,
      detail: !cfg
        ? "No sync configured - set the source URL and credentials, then run Sync 10 Profiles."
        : count === 0
          ? "Sync configured but no records imported yet."
          : ok
            ? `${count} profile(s) synced.`
            : `Sync configured (${count} record(s)) - last run status: ${cfg.syncStatus}.`,
      status: ok ? "done" : "pending", deepLink: editLink(tab),
    });
  };
  if (hasEgg) scraperStep("scraper_egg", "Egg donor scraper", "egg-donors", eggSync, eggCount);
  if (hasSurrogacy) scraperStep("scraper_surrogate", "Surrogate scraper", "surrogates", surroSync, surroCount);
  if (hasSperm) scraperStep("scraper_sperm", "Sperm donor scraper", "sperm-donors", spermSync, spermCount);

  // Billing: a negotiated referral fee config per approved service line.
  const approvedLineKeys = Array.from(new Set(
    (provider.services as any[])
      .filter((s) => s.status !== "DECLINED")
      .map((s) => serviceTypeKey(s.providerType?.name || "")),
  ));
  // A fee config only counts once its economics are actually set (a flat
  // amount or a percentage) - a bare row is not a negotiated fee.
  const feeKeys = new Set(
    (referralFees as any[])
      .filter((f) => (f.feeType === "FLAT" ? f.flatAmount != null : f.percentage != null))
      .map((f) => f.serviceType),
  );
  const missingFeeLines = approvedLineKeys.filter((k) => !feeKeys.has(k));
  steps.push({
    key: "billing", group: "admin_setup", label: "Set billing & referral fees",
    detail: approvedLineKeys.length === 0
      ? "Add the provider's services first (Profile tab), then set the referral fee for each service line."
      : missingFeeLines.length
        ? `Referral fee not configured for: ${missingFeeLines.join(", ")}.`
        : "Referral fees configured for every service line.",
    status: approvedLineKeys.length > 0 && missingFeeLines.length === 0 ? "done" : "pending",
    deepLink: editLink("billing"),
  });

  steps.push({
    key: "parent_form", group: "admin_setup", label: "Review Parent Form",
    detail: ipFormOverrideCount > 0 ? "Per-provider form adjustments exist." : "Default template applies - adjust per-provider questions if this provider needs them.",
    status: ipFormOverrideCount > 0 ? "done" : "optional", deepLink: editLink("parent-form"), isOptional: true,
  });
  steps.push({
    key: "knowledge", group: "admin_setup", label: "Seed knowledge base",
    detail: knowledgeCount > 0 ? `${knowledgeCount} knowledge chunk(s) indexed.` : "Sync their website or upload documents so the AI answers from their real content.",
    status: knowledgeCount > 0 ? "done" : "optional", deepLink: editLink("knowledge"), isOptional: true,
  });

  // Sending the compliance documents is the ADMIN's action - the signing is
  // the provider's (tracked in Phase C, locked until these are sent).
  const w9Status = w9?.status || "NOT_SENT";
  const w9Sent = ["SENT", "COMPLETED"].includes(w9Status);
  steps.push({
    key: "send_w9", group: "admin_setup", label: "Send W-9",
    detail: w9Sent ? "W-9 sent to the provider." : "Send the W-9 request from the Legal tab.",
    status: w9Sent ? "done" : "pending", deepLink: editLink("legal-identity"),
  });
  const pagrStatus = pagr?.status || "NOT_SENT";
  const pagrSent = ["SENT", "COMPLETED"].includes(pagrStatus);
  steps.push({
    key: "send_agreement", group: "admin_setup", label: "Send provider agreement",
    detail: pagrSent
      ? "Agreement sent to the provider."
      : pagrStatus === "AWAITING_GOSTORK"
        ? "GoStork signs first - fill referral fees and sign on the Legal tab."
        : "Send the GoStork agreement from the Legal tab.",
    status: pagrSent ? "done" : "pending", deepLink: editLink("legal-identity"),
  });

  // ── Phase C - Provider setup (handoff) ──
  steps.push({
    key: "w9", group: "provider_setup", label: "W-9 signed",
    detail: w9Status === "COMPLETED" ? "W-9 on file." : w9Status === "SENT" ? "Sent - waiting for the provider to sign." : "Locked until the W-9 is sent (admin step above).",
    status: w9Status === "COMPLETED" ? "done" : w9Status === "SENT" ? "waiting_on_provider" : "locked",
    deepLink: editLink("legal-identity"),
  });
  steps.push({
    key: "agreement", group: "provider_setup", label: "Provider agreement signed",
    detail: pagrStatus === "COMPLETED"
      ? "Agreement signed."
      : pagrStatus === "SENT"
        ? pagr?.guestOpenedAt
          ? `Sent - the provider opened it on ${new Date(pagr.guestOpenedAt).toLocaleDateString()}, waiting for their signature.`
          : "Sent - the provider has not opened the signing link yet."
        : "Locked until the agreement is sent (admin step above).",
    status: pagrStatus === "COMPLETED" ? "done" : pagrStatus === "SENT" ? "waiting_on_provider" : "locked",
    deepLink: editLink("legal-identity"),
  });
  const partnerIds = Array.isArray(provider.partnerProviderIds) ? provider.partnerProviderIds : [];
  if (hasSurrogacy || hasEgg) {
    steps.push({
      key: "partner_clinics", group: "provider_setup", label: "Link partner IVF clinics",
      detail: partnerIds.length ? `${partnerIds.length} partner clinic(s) linked.` : "Link the IVF clinic(s) this agency works with for bundled costs and two-call booking.",
      status: partnerIds.length ? "done" : "optional", deepLink: editLink("profile"), isOptional: true,
    });
  }

  const providerStep = (key: string, prefix: string, label: string, doneWhen: boolean, doneDetail: string, waitDetail: string, tab: string, optional = false) => {
    const done = doneWhen || taskDone(prefix);
    steps.push({
      key, group: "provider_setup", label,
      detail: done ? doneDetail : taskRaised(prefix) ? waitDetail : `${waitDetail} (task not sent yet)`,
      status: done ? "done" : optional ? "optional" : "waiting_on_provider",
      deepLink: editLink(tab), isOptional: optional,
    });
  };
  providerStep("calendar", "onbcal", "Calendar connected", calendarCount > 0, `${calendarCount} calendar connection(s).`, "Waiting for the provider to connect a calendar.", "calendar");
  providerStep("stripe", "onbstripe", "Payouts connected", Boolean(bank?.payoutsEnabled), "Stripe payouts enabled.", bank?.stripeConnectAccountId ? "Stripe onboarding started but payouts not enabled yet." : "Waiting for the provider to set up payouts.", "payouts");
  providerStep("costs_uploaded", "onbcosts", "Cost sheets uploaded", costSheets.length > 0, `${costSheets.length} cost sheet(s) uploaded.`, "Waiting for the provider to upload cost sheets.", "costs");
  // Parent Pays Basis is decided by the provider on their Billing page. A
  // line counts as decided once its config says TOTAL_COST or carries a
  // default first-payment amount - DEFAULT_FIRST_PAYMENT with no amount is
  // just the DB default, not a choice.
  const basisByKey = new Map((referralFees as any[]).map((f) => [f.serviceType, f]));
  const undecidedBasisLines = approvedLineKeys.filter((k) => {
    const f = basisByKey.get(k);
    return !f || (f.parentPaysBasis !== "TOTAL_COST" && f.defaultServiceAmount == null);
  });
  providerStep(
    "pay_basis", "onbpaybasis", "Parent Pays Basis chosen",
    approvedLineKeys.length > 0 && undecidedBasisLines.length === 0,
    "The provider chose how parents are invoiced for every service line.",
    undecidedBasisLines.length ? `Waiting for the provider to choose the invoicing basis for: ${undecidedBasisLines.join(", ")}.` : "Waiting for the provider to choose how parents are invoiced.",
    "billing",
  );
  providerStep("team", "onbteam", "Team added & roles assigned", (users as any[]).length >= 2, `${(users as any[]).length} team account(s).`, "Waiting for the provider to invite their team.", "users");
  providerStep("ai", "onbai", "AI Concierge set up", false, "Marked done by the provider.", "Waiting for the provider to review AI Concierge settings.", "ai-concierge");
  providerStep("parent_form_provider", "onbform", "Parent Form reviewed by provider", false, "The provider reviewed their Parent Form.", "Waiting for the provider to review their Parent Form.", "parent-form", true);
  providerStep("playbooks", "onbplaybooks", "Playbooks configured", playbookCount > 0, `${playbookCount} playbook(s).`, "Waiting for the provider to configure playbooks.", "playbooks", true);
  providerStep("automation", "onbauto", "Automations reviewed", autoReplyCount > 0, "Automation customized.", "Waiting for the provider to review automations.", "automation", true);
  providerStep("branding", "onbbrand", "Branding reviewed", false, "Marked done by the provider.", "Waiting for the provider to confirm branding.", "branding", true);
  providerStep("sponsorship", "onbsponsor", "Sponsorship", false, "Marked done by the provider.", "Optional - sponsored placement.", "sponsorship", true);

  // ── Phase D - Go-live review ──
  const pendingSheets = (costSheets as any[]).filter((s) => s.status === "PENDING").length;
  const approvedSheets = (costSheets as any[]).filter((s) => s.status === "APPROVED").length;
  const costApprovalStatus: StepStatus = costSheets.length === 0
    ? "locked"
    : pendingSheets > 0
      ? "pending"
      : approvedSheets > 0 ? "done" : "locked";
  steps.push({
    key: "approve_costs", group: "go_live", label: "Approve cost sheets",
    detail: costSheets.length === 0
      ? "Locked until the provider uploads cost sheets."
      : pendingSheets > 0
        ? `${pendingSheets} sheet(s) awaiting your approval.`
        : `${approvedSheets} sheet(s) approved.`,
    status: costApprovalStatus, deepLink: editLink("costs"),
  });

  // Apply the admin's manual check-offs to the markable steps: a marked step
  // is done even when no artifact exists (there was simply nothing to do).
  for (const s of steps) {
    if (!MARKABLE_STEP_KEYS.has(s.key)) continue;
    s.manuallyMarkable = true;
    if (s.status !== "done" && markedKeys.has(s.key)) {
      s.status = "done";
      s.manuallyDone = true;
      s.detail = "Marked done by GoStork admin - nothing to set up here.";
    } else if (s.status === "done" && markedKeys.has(s.key)) {
      s.manuallyDone = true;
    }
  }

  const required = steps.filter((s) => !s.isOptional && s.key !== "go_live");
  const doneCount = required.filter((s) => s.status === "done").length;
  const allDone = doneCount === required.length;

  // Go live = approve the services. Approval IS the publish switch (every
  // marketplace and Eva query filters ProviderService.status === "APPROVED"),
  // so the very last step of onboarding is the approval itself: locked while
  // prerequisite steps remain, "your turn" once everything else is done, and
  // done the moment every service line is approved - configuration (fees,
  // scrapers, cost sheets) never required approval.
  const unapprovedServices = (provider.services as any[]).filter((s) => s.status !== "APPROVED" && s.status !== "DECLINED");
  const published = provider.services.length > 0 && unapprovedServices.length === 0;
  steps.push({
    key: "go_live", group: "go_live", label: "Go live - approve services (publish)",
    detail: published
      ? "All services approved - this provider is live in the marketplace and Eva."
      : provider.services.length === 0
        ? "No services yet - add the services this provider offers on the Profile tab."
        : allDone
          ? `Everything is ready - approve the services on the Profile tab to publish. Awaiting approval: ${unapprovedServices.map((s: any) => s.providerType?.name).filter(Boolean).join(", ")}.`
          : "Unlocks when every required step above is done; approving the services then publishes this provider in the marketplace and to Eva.",
    status: published ? "done" : allDone ? "pending" : "locked",
    deepLink: editLink("profile"),
  });

  const requiredCount = required.length;
  return {
    providerId, providerName: provider.name, steps,
    doneCount, requiredCount,
    percent: requiredCount ? Math.round((doneCount / requiredCount) * 100) : 0,
    tasksSentAt,
  };
}

@Controller()
export class ProviderOnboardingController {
  @Get("api/admin/providers/:id/onboarding")
  @UseGuards(SessionOrJwtGuard)
  async getOne(@Req() req: Request, @Param("id") id: string) {
    requireAdmin(req);
    const summary = await computeOnboarding(id);
    if (!summary) throw new NotFoundException("Provider not found");
    return summary;
  }

  /** Providers still onboarding (created in the last 90 days and < 100%),
   *  for the admin Home "Needs attention" queue. */
  @Get("api/admin/onboarding/pending")
  @UseGuards(SessionOrJwtGuard)
  async listPending(@Req() req: Request) {
    requireAdmin(req);
    const db = prisma as any;
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const houseId = process.env.GOSTORK_PROVIDER_ID || null;
    const recent = await db.provider.findMany({
      where: {
        createdAt: { gte: since },
        isTestData: false,
        ...(houseId ? { id: { not: houseId } } : { NOT: { name: { equals: "gostork", mode: "insensitive" } } }),
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    const summaries = await Promise.all(recent.map((p: any) => computeOnboarding(p.id)));
    return summaries
      .filter((s): s is OnboardingSummary => Boolean(s) && s!.percent < 100)
      .map((s) => ({ providerId: s.providerId, providerName: s.providerName, doneCount: s.doneCount, requiredCount: s.requiredCount, percent: s.percent }));
  }

  /** Manually check off an optional step ("nothing to do here"). Stored as a
   *  DONE parentTask on the onbmark: systemKey so the checklist stays fully
   *  derived otherwise - never visible on any open queue. */
  @Post("api/admin/providers/:id/onboarding/steps/:key/mark-done")
  @UseGuards(SessionOrJwtGuard)
  async markStepDone(@Req() req: Request, @Param("id") id: string, @Param("key") key: string) {
    requireAdmin(req);
    if (!MARKABLE_STEP_KEYS.has(key)) throw new BadRequestException("This step cannot be marked done manually");
    const db = prisma as any;
    const provider = await db.provider.findUnique({ where: { id }, select: { id: true } });
    if (!provider) throw new NotFoundException("Provider not found");
    const userId = (req.user as any)?.id;
    const now = new Date();
    await db.parentTask.upsert({
      where: { systemKey: `onbmark:${key}:${id}` },
      create: {
        parentAccountId: id,
        scope: "PROVIDER",
        providerId: id,
        title: `Onboarding step "${key}" marked done by GoStork admin`,
        type: "TODO",
        priority: "LOW",
        source: "SYSTEM",
        systemKey: `onbmark:${key}:${id}`,
        status: "DONE",
        dueAt: now,
        completedAt: now,
        completedByUserId: userId,
        createdByUserId: userId,
      },
      update: { status: "DONE", completedAt: now, completedByUserId: userId },
    });
    return { marked: key };
  }

  /** Undo a manual check-off. */
  @Delete("api/admin/providers/:id/onboarding/steps/:key/mark-done")
  @UseGuards(SessionOrJwtGuard)
  async unmarkStepDone(@Req() req: Request, @Param("id") id: string, @Param("key") key: string) {
    requireAdmin(req);
    const db = prisma as any;
    await db.parentTask.deleteMany({ where: { systemKey: `onbmark:${key}:${id}` } });
    return { unmarked: key };
  }

  /** Raise the Phase C handoff tasks on the provider's Home queue.
   *  Idempotent: unique systemKey upserts, re-sending reopens open work but
   *  never duplicates. W-9 / agreement sends stay on the Legal tab (they
   *  create PandaDoc documents, not just tasks). */
  @Post("api/admin/providers/:id/onboarding/send-tasks")
  @UseGuards(SessionOrJwtGuard)
  async sendTasks(@Req() req: Request, @Param("id") id: string) {
    requireAdmin(req);
    const db = prisma as any;
    const provider = await db.provider.findUnique({ where: { id }, select: { id: true } });
    if (!provider) throw new NotFoundException("Provider not found");
    const createdByUserId = (req.user as any)?.id;
    const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    for (const t of HANDOFF_TASKS) {
      const systemKey = `${t.prefix}:${id}`;
      await db.parentTask.upsert({
        where: { systemKey },
        create: {
          // Provider-scoped work with no family attached (same convention as
          // w9:/pagr:): the account key slot carries the providerId so the
          // task renders only on this provider's Home queue.
          parentAccountId: id,
          scope: "PROVIDER",
          providerId: id,
          title: t.title,
          notes: t.notes,
          type: "TODO",
          priority: t.priority,
          dueAt,
          source: "SYSTEM",
          systemKey,
          deepLink: t.deepLink,
          createdByUserId,
        },
        // Re-send refreshes the due date on still-open tasks but never
        // reopens work the provider already completed.
        update: { dueAt },
      });
    }
    return { sent: HANDOFF_TASKS.length };
  }
}
