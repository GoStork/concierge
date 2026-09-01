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
  Inject,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { NotificationService } from "../notifications/notification.service";
import { getBaseUrl } from "../../lib/get-base-url";
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
  /** Short progress signal for provider-side steps ("Sent", "Opened 8/31",
   *  "Started") - shows the admin how far the provider actually got. */
  progress?: string;
  /** Inventory (scraper_*) steps only: how many profiles exist - the
   *  provider view uses it to phrase the step as Add vs Review. */
  recordCount?: number;
};

/** Optional steps the admin can check off by hand when there is nothing to
 *  do in that section. Stored as a DONE parentTask with systemKey
 *  onbmark:<stepKey>:<providerId> - created directly as DONE so it never
 *  appears on anyone's open queue, and the reconciler never touches the
 *  onbmark prefix. */
const MARKABLE_STEP_KEYS = new Set([
  "parent_form", "parent_form_provider", "partner_clinics", "knowledge", "profile_review",
  "asrm_minimums", "calendar_link", "video_room", "fees_review", "knowledge_review", "doctors_review",
  "playbooks", "automation", "branding", "sponsorship",
  // Providers without a database to scrape (they send PDFs / upload manually)
  // close these by hand.
  "scraper_egg", "scraper_surrogate", "scraper_sperm",
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
  { prefix: "onbavail", title: "Set your availability hours", notes: "Choose the days and hours parents can book you - the calendar connection blocks conflicts, your availability opens the slots.", deepLink: "/account/calendar", priority: "HIGH" },
  { prefix: "onblegal", title: "Complete your legal details", notes: "Confirm your legal entity name, tax ID, and business address - they auto-fill from your signed W-9 and are needed for payouts.", deepLink: "/account/legal-identity", priority: "HIGH" },
  { prefix: "onbcallink", title: "Review your booking link", notes: "Open your public booking page and check the times and meeting details parents will see.", deepLink: "/account/calendar", priority: "LOW" },
  { prefix: "onbvideo", title: "Review your video room", notes: "Consultations happen in your personal video room - open it once so you know where calls take place.", deepLink: "/account", priority: "LOW" },
  { prefix: "onbfees", title: "Review your GoStork fees", notes: "See the referral fee agreed with GoStork for each of your services.", deepLink: "/account/billing", priority: "LOW" },
  { prefix: "onbknow", title: "Review what Eva knows about you", notes: "Eva answers parents using your website and documents - check what she knows and add FAQs or program guides.", deepLink: "/account/knowledge", priority: "LOW" },
  { prefix: "onbstripe", title: "Connect payouts", notes: "Set up your payout account so GoStork can send you money.", deepLink: "/account/payouts", priority: "HIGH" },
  { prefix: "onbcosts", title: "Upload your cost sheet(s)", notes: "Upload a cost sheet for each service you offer. GoStork reviews and approves them before they go live.", deepLink: "/account/company", priority: "HIGH" },
  { prefix: "onbtemplates", title: "Upload your parent agreement templates", notes: "Upload the agreement(s) parents sign for each of your services and assign the signature fields.", deepLink: "/account/documents", priority: "HIGH" },
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
  const hasIvf = hasType("ivf") || hasType("in vitro");

  const [
    users, eggSync, surroSync, spermSync,
    eggCount, surroCount, spermCount,
    costSheets, referralFees, w9, pagr,
    calendarCount, bank, knowledgeCount, playbookCount, autoReplyCount,
    ipFormOverrideCount, agreementTemplates, adminActivatedCount, onbTasks,
    availCount, doctorCount, legalIdentity,
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
    db.providerW9.findUnique({ where: { providerId }, select: { status: true, guestOpenedAt: true } }),
    db.providerAgreement.findFirst({ where: { providerId }, orderBy: { createdAt: "desc" }, select: { status: true, guestOpenedAt: true } }),
    db.calendarConnection.count({ where: { connected: true, tokenValid: true, user: { providerId } } }),
    db.providerBankAccount.findUnique({ where: { providerId }, select: { payoutsEnabled: true, stripeConnectAccountId: true } }),
    db.knowledgeChunk.count({ where: { providerId } }),
    db.taskPlaybook.count({ where: { providerId } }),
    db.providerAutoReply.count({ where: { providerId } }),
    db.ipFormProviderOverride.count({ where: { providerId } }),
    db.providerAgreementTemplate.findMany({ where: { providerId }, select: { serviceType: true, agreementTemplateUrl: true } }),
    // "Activated" = used their set-password link or logged in at least once.
    db.user.count({
      where: {
        providerId, isDisabled: false, roles: { has: "PROVIDER_ADMIN" },
        OR: [{ lastLoginAt: { not: null } }, { passwordResetTokens: { some: { usedAt: { not: null } } } }],
      },
    }),
    db.parentTask.findMany({
      where: { providerId, source: "SYSTEM", systemKey: { startsWith: "onb" } },
      select: { systemKey: true, status: true, createdAt: true },
    }),
    // Booking availability: connected calendars block conflicts, but the
    // OPEN slots come from availability hours - a separate required step.
    db.availabilitySlot.count({ where: { scheduleConfig: { user: { providerId } } } }),
    // Scraped/enriched doctor profiles (IVF clinics) - the clinic reviews them.
    hasIvf ? db.providerMember.count({ where: { providerId, isPublicProfile: true } }) : 0,
    db.providerLegalIdentity.findUnique({
      where: { providerId },
      select: { legalName: true, taxId: true, businessAddressLine1: true, businessAddressCity: true },
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
  const handoffTasks = (onbTasks as any[]).filter((t) => {
    const k = String(t.systemKey || "");
    // Markers, not handoff tasks: manual check-offs + the welcome-email flag.
    return !k.startsWith("onbmark:") && !k.startsWith("onbwelcome:");
  });
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

  // ── Phase B - Admin setup ──
  // Creating the provider's admin account is the GoStork admin's action (Team
  // tab), so it leads THIS phase rather than sitting in "Created".
  const hasProviderAdmin = (users as any[]).some((u) => (u.roles || []).includes("PROVIDER_ADMIN"));
  steps.push({
    key: "admin_user", group: "admin_setup", label: "Create provider admin user",
    detail: hasProviderAdmin ? "A PROVIDER_ADMIN account exists." : "Create the provider's admin account so they can log in.",
    status: hasProviderAdmin ? "done" : "pending", deepLink: editLink("users"),
  });

  // The agreement goes out right after the admin user exists (sending needs
  // a signer member, and the provider signs BEFORE doing anything else),
  // then the W-9. Signing is the provider's part, tracked in Phase C.
  const pagrStatus = pagr?.status || "NOT_SENT";
  const pagrSent = ["SENT", "COMPLETED"].includes(pagrStatus);
  steps.push({
    key: "send_agreement", group: "admin_setup", label: "Send provider agreement",
    detail: pagrSent
      ? "Agreement sent to the provider."
      : pagrStatus === "AWAITING_GOSTORK"
        ? "GoStork signs first - fill referral fees and sign (Agreements tab)."
        : hasProviderAdmin
          ? "Send the GoStork agreement from the Agreements tab."
          : "Create the provider admin user first, then send the GoStork agreement from the Agreements tab.",
    status: pagrSent ? "done" : "pending", deepLink: editLink("agreements"),
  });
  const w9Status = w9?.status || "NOT_SENT";
  const w9Sent = ["SENT", "COMPLETED"].includes(w9Status);
  steps.push({
    key: "send_w9", group: "admin_setup", label: "Send W-9",
    detail: w9Sent ? "W-9 sent to the provider." : "Send the W-9 request from the Legal tab.",
    status: w9Sent ? "done" : "pending", deepLink: editLink("legal-identity"),
  });
  const profileComplete = Boolean(provider.logoUrl && provider.about && provider.phone && provider.locations.length > 0);
  steps.push({
    key: "profile", group: "admin_setup", label: "Profile complete",
    detail: profileComplete ? "Logo, about, phone, and at least one location are set." : "Missing: " + [
      !provider.logoUrl && "logo", !provider.about && "about", !provider.phone && "phone",
      provider.locations.length === 0 && "location",
    ].filter(Boolean).join(", ") + ".",
    status: profileComplete ? "done" : "pending", deepLink: editLink("profile"),
  });

  // The step is about PROFILES EXISTING, not about scraping per se: some
  // providers have no database to sync and upload profiles manually / via
  // PDF, which counts just the same. A configured-but-failing sync stays
  // pending even with records (it needs attention); no-database providers
  // with nothing to import can be marked done manually.
  const scraperStep = (key: string, label: string, tab: string, cfg: any, count: number) => {
    const syncHealthy = !cfg || ["SUCCESS", "PARTIAL", "COMPLETED"].includes(String(cfg?.syncStatus || "").toUpperCase());
    const ok = count > 0 && syncHealthy;
    steps.push({
      key, group: "admin_setup", label,
      detail: ok
        ? `${count} profile(s)${cfg ? " synced" : " (uploaded manually)"}.`
        : cfg
          ? count === 0
            ? "Sync configured but no records imported yet."
            : `Sync configured (${count} record(s)) - last run status: ${cfg.syncStatus}.`
          : "Set up a sync (source URL + credentials, then Sync 10 Profiles), upload profiles manually - or mark done if this provider has no database and sends PDFs instead.",
      status: ok ? "done" : "pending", deepLink: editLink(tab),
      recordCount: count,
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

  // ── Phase C - Provider setup (handoff) ──
  // Order mirrors the real flow: the agreement is signed FIRST (it activates
  // the partnership), then the W-9, then the welcome email that gives them
  // their login.
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
    deepLink: editLink("agreements"),
    progress: pagrStatus === "SENT"
      ? pagr?.guestOpenedAt ? `Opened ${new Date(pagr.guestOpenedAt).toLocaleDateString()}` : "Sent"
      : undefined,
  });
  steps.push({
    key: "w9", group: "provider_setup", label: "W-9 signed",
    detail: w9Status === "COMPLETED"
      ? "W-9 on file."
      : w9Status === "SENT"
        ? w9?.guestOpenedAt
          ? `Sent - the provider opened it on ${new Date(w9.guestOpenedAt).toLocaleDateString()}, waiting for their signature.`
          : "Sent - the provider has not opened the signing link yet."
        : "Locked until the W-9 is sent (admin step above).",
    status: w9Status === "COMPLETED" ? "done" : w9Status === "SENT" ? "waiting_on_provider" : "locked",
    deepLink: editLink("legal-identity"),
    progress: w9Status === "SENT"
      ? w9?.guestOpenedAt ? `Opened ${new Date(w9.guestOpenedAt).toLocaleDateString()}` : "Sent"
      : undefined,
  });
  // Welcome email: accounts are created silently (the admin never shares the
  // temp password), so once the agreement is signed and the W-9 is on file
  // the admin sends the welcome email - login email + set-password link -
  // and the provider can start their own setup.
  const welcomeSent = taskRaised("onbwelcome");
  const welcomeReady = pagrStatus === "COMPLETED" && w9Status === "COMPLETED";
  // The send is the ADMIN's action - last step of their phase (it still
  // unlocks only after the provider signed both documents).
  steps.push({
    key: "welcome", group: "admin_setup", label: "Send welcome email",
    detail: welcomeSent
      ? "Welcome email sent - the provider has their login and set-password link."
      : welcomeReady
        ? "Agreement signed and W-9 on file - send the provider their welcome email with a set-password link."
        : "Unlocks once the agreement is signed and the W-9 is completed.",
    status: welcomeSent ? "done" : welcomeReady ? "pending" : "locked",
    deepLink: editLink("users"),
  });
  // The provider's side of the welcome email: actually set the password and
  // get in. Done when any provider admin used their set-password link or
  // has logged in.
  steps.push({
    key: "password_reset", group: "provider_setup", label: "Admin user set their password",
    detail: adminActivatedCount > 0
      ? "The provider admin set their password and can log in."
      : welcomeSent
        ? "Waiting for the provider to use their set-password link from the welcome email."
        : "Unlocks once the welcome email is sent.",
    status: adminActivatedCount > 0 ? "done" : welcomeSent ? "waiting_on_provider" : "locked",
    deepLink: editLink("users"),
  });
  // First thing after they get their login: review the profile GoStork
  // built for them (logo, about, locations, contact details - everything on
  // the Profile tab). Closed by the provider checking off their Home task,
  // or by the admin marking it done.
  const profileReviewed = taskDone("onbprofile");
  // The lock's real meaning is "they need a login first" - so an admin who
  // is ALREADY activated (came in via an agreement set-password link before
  // any welcome send) unlocks it just as well as the welcome email does.
  const providerCanLogIn = welcomeSent || adminActivatedCount > 0;
  steps.push({
    key: "profile_review", group: "provider_setup", label: "Provider reviewed their profile",
    detail: profileReviewed
      ? "The provider reviewed and confirmed their profile."
      : providerCanLogIn
        ? taskRaised("onbprofile")
          ? "Waiting for the provider to review the profile GoStork created for them."
          : "Waiting for the provider to review the profile GoStork created for them. (task not sent yet)"
        : "Unlocks once the welcome email is sent - they need a login first.",
    status: profileReviewed ? "done" : providerCanLogIn ? "waiting_on_provider" : "locked",
    deepLink: editLink("profile"),
  });
  const partnerIds = Array.isArray(provider.partnerProviderIds) ? provider.partnerProviderIds : [];
  if (hasSurrogacy || hasEgg) {
    steps.push({
      key: "partner_clinics", group: "provider_setup", label: "Link partner IVF clinics",
      detail: partnerIds.length ? `${partnerIds.length} partner clinic(s) linked.` : "Link the IVF clinic(s) this agency works with for bundled costs and two-call booking.",
      status: partnerIds.length ? "done" : "optional", deepLink: editLink("profile"), isOptional: true,
    });
  }

  const providerStep = (key: string, prefix: string, label: string, doneWhen: boolean, doneDetail: string, waitDetail: string, tab: string, optional = false, startedWhen?: string) => {
    const done = doneWhen || taskDone(prefix);
    steps.push({
      key, group: "provider_setup", label,
      detail: done ? doneDetail : taskRaised(prefix) ? waitDetail : `${waitDetail} (task not sent yet)`,
      status: done ? "done" : optional ? "optional" : "waiting_on_provider",
      deepLink: editLink(tab), isOptional: optional,
      // Progress signal: "Started" when we can see partial work, else "Task
      // sent" once the handoff task went out. Done rows carry their own
      // green check - no chip needed.
      progress: done ? undefined : startedWhen ? startedWhen : taskRaised(prefix) ? "Task sent" : undefined,
    });
  };
  providerStep("calendar", "onbcal", "Calendar connected", calendarCount > 0, `${calendarCount} calendar connection(s).`, "Waiting for the provider to connect a calendar.", "calendar");
  // A connected calendar without availability hours means an empty booking
  // page - the hours are what actually opens slots to parents.
  providerStep("availability", "onbavail", "Availability hours set", (availCount as number) > 0, `${availCount} availability slot(s) defined.`, "Waiting for the provider to set the days and hours parents can book.", "calendar");
  providerStep("calendar_link", "onbcallink", "Booking link reviewed", false, "The provider reviewed their public booking page.", "Waiting for the provider to review their booking link.", "calendar", true);
  providerStep("video_room", "onbvideo", "Video room reviewed", false, "The provider checked their video room.", "Waiting for the provider to review their video room.", "users", true);
  // Legal identity (entity name, tax ID, business address) - auto-fills
  // from the signed W-9, and Stripe KYC needs it, so it sits before payouts.
  const legalOk = Boolean((legalIdentity as any)?.legalName && (legalIdentity as any)?.taxId && (legalIdentity as any)?.businessAddressLine1 && (legalIdentity as any)?.businessAddressCity);
  providerStep("legal_details", "onblegal", "Legal details completed", legalOk, "Legal entity, tax ID, and business address on file.", "Waiting for the provider to complete their legal details (auto-fills from the signed W-9).", "legal-identity");
  providerStep("stripe", "onbstripe", "Payouts connected", Boolean(bank?.payoutsEnabled), "Stripe payouts enabled.", bank?.stripeConnectAccountId ? "Stripe onboarding started but payouts not enabled yet." : "Waiting for the provider to set up payouts.", "payouts", false, bank?.stripeConnectAccountId && !bank?.payoutsEnabled ? "Started" : undefined);
  providerStep("costs_uploaded", "onbcosts", "Cost sheets uploaded", costSheets.length > 0, `${costSheets.length} cost sheet(s) uploaded.`, "Waiting for the provider to upload cost sheets.", "costs");
  // Parent agreement templates: one per service line (the contracts parents
  // sign). The legacy single-template fields on Provider cover the first
  // line for providers set up before per-service templates existed.
  const tplKeys = new Set(
    (agreementTemplates as any[]).filter((t) => t.agreementTemplateUrl).map((t) => t.serviceType),
  );
  const tplMissing = approvedLineKeys.filter((k, i) => !tplKeys.has(k) && !(i === 0 && provider.agreementTemplateUrl));
  providerStep(
    "agreement_templates", "onbtemplates", "Parent agreement templates uploaded",
    approvedLineKeys.length > 0 && tplMissing.length === 0,
    "Agreement template(s) uploaded for every service line.",
    tplMissing.length && tplMissing.length < approvedLineKeys.length
      ? `Waiting for templates for: ${tplMissing.join(", ")}.`
      : "Waiting for the provider to upload the agreement(s) parents sign.",
    "agreements",
    false,
    tplMissing.length && tplMissing.length < approvedLineKeys.length ? "Started" : undefined,
  );
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
  providerStep("fees_review", "onbfees", "GoStork fees reviewed", false, "The provider reviewed their GoStork referral fees.", "Waiting for the provider to review their GoStork fees.", "billing", true);
  providerStep("team", "onbteam", "Team added & roles assigned", (users as any[]).length >= 2, `${(users as any[]).length} team account(s).`, "Waiting for the provider to invite their team.", "users");
  providerStep("ai", "onbai", "AI Concierge set up", false, "Marked done by the provider.", "Waiting for the provider to review AI Concierge settings.", "ai-concierge");
  providerStep("knowledge_review", "onbknow", "Eva's knowledge reviewed by provider", false, "The provider reviewed what Eva knows about them.", "Waiting for the provider to review Eva's knowledge about their organization.", "knowledge", true);
  // IVF clinics: scraped/enriched doctor profiles exist - the clinic should
  // look them over. Only shown once there ARE doctors to review.
  if (hasIvf && (doctorCount as number) > 0) {
    steps.push({
      key: "doctors_review", group: "provider_setup", label: "Doctors reviewed by clinic",
      detail: taskDone("onbdoc")
        ? "The clinic reviewed their doctor profiles."
        : `${doctorCount} doctor profile(s) on file - waiting for the clinic to review what parents will see.`,
      status: taskDone("onbdoc") ? "done" : "optional", deepLink: editLink("doctors"),
      isOptional: true, recordCount: doctorCount as number,
    });
  }
  providerStep("parent_form_provider", "onbform", "Parent Form reviewed by provider", false, "The provider reviewed their Parent Form.", "Waiting for the provider to review their Parent Form.", "parent-form", true);
  providerStep("playbooks", "onbplaybooks", "Playbooks configured", playbookCount > 0, `${playbookCount} playbook(s).`, "Waiting for the provider to configure playbooks.", "playbooks", true);
  providerStep("automation", "onbauto", "Automations reviewed", autoReplyCount > 0, "Automation customized.", "Waiting for the provider to review automations.", "automation", true);
  providerStep("branding", "onbbrand", "Branding reviewed", false, "Marked done by the provider.", "Waiting for the provider to confirm branding.", "branding", true);
  providerStep("sponsorship", "onbsponsor", "Sponsorship", false, "Marked done by the provider.", "Optional - sponsored placement.", "sponsorship", true);

  // ── Phase D - Go-live review ──
  // ASRM minimums check (surrogacy agencies): the GoStork house provider's
  // requirements are the platform minimums; surrogates below them are
  // asrmHidden from parents. Optional admin review before publish, closed by
  // marking it done.
  if (hasSurrogacy) {
    steps.push({
      key: "asrm_minimums", group: "go_live", label: "ASRM minimums reviewed",
      detail: "Spot-check this agency's surrogates against the platform ASRM minimums (age, BMI, pregnancy history) - out-of-range profiles are hidden from parents automatically.",
      status: "optional", deepLink: editLink("surrogates"), isOptional: true,
    });
  }
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

/** Email every provider admin their login + a fresh 7-day set-password link.
 *  Shared by the checklist's Send/Re-send button and the automatic
 *  no-login-yet reminder ladder (document-reminder.scheduler).
 *  Returns the number of emails sent; -1 = no admin user exists at all. */
export async function sendProviderWelcomeEmails(notificationService: NotificationService, providerId: string): Promise<number> {
  const db = prisma as any;
  const provider = await db.provider.findUnique({ where: { id: providerId }, select: { id: true, name: true } });
  if (!provider) return -1;
  const admins = await db.user.findMany({
    where: { providerId, isDisabled: false, roles: { has: "PROVIDER_ADMIN" } },
    select: { id: true, email: true, name: true, firstName: true },
  });
  if (!admins.length) return -1;

  const { randomBytes } = await import("crypto");
  const appUrl = getBaseUrl();
  let sent = 0;
  for (const u of admins) {
    if (!u.email) continue;
    const token = randomBytes(32).toString("hex");
    await db.passwordResetToken.create({
      data: { token, userId: u.id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    });
    await notificationService.sendProviderWelcomeEmail({
      userId: u.id,
      email: u.email,
      firstName: (u.firstName || u.name || "there").split(" ")[0],
      providerName: provider.name,
      resetUrl: `${appUrl}/reset-password/${token}`,
      appUrl,
    });
    sent++;
  }
  return sent;
}

@Controller()
export class ProviderOnboardingController {
  // Explicit @Inject: the esbuild bundle emits no design:type metadata, so
  // plain constructor injection resolves to undefined at runtime.
  constructor(@Inject(NotificationService) private readonly notificationService: NotificationService) {}

  /** Send the provider admin(s) their welcome email: login email + a
   *  set-password link (7-day token). The onboarding "Send welcome email"
   *  step - accounts are created silently, so this is the moment the
   *  provider actually gets their credentials. Marked sent via the
   *  onbwelcome:<providerId> DONE task so the step stays derived. */
  @Post("api/admin/providers/:id/onboarding/send-welcome")
  @UseGuards(SessionOrJwtGuard)
  async sendWelcome(@Req() req: Request, @Param("id") id: string) {
    requireAdmin(req);
    const db = prisma as any;
    const provider = await db.provider.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!provider) throw new NotFoundException("Provider not found");
    const sent = await sendProviderWelcomeEmails(this.notificationService, id);
    if (sent === -1) throw new BadRequestException("This provider has no admin user yet - create one on the Team tab first.");
    if (!sent) throw new BadRequestException("No admin user with an email address found.");

    const userId = (req.user as any)?.id;
    const now = new Date();
    await db.parentTask.upsert({
      where: { systemKey: `onbwelcome:${id}` },
      create: {
        parentAccountId: id,
        scope: "PROVIDER",
        providerId: id,
        title: "Welcome email sent by GoStork admin",
        type: "TODO",
        priority: "LOW",
        source: "SYSTEM",
        systemKey: `onbwelcome:${id}`,
        status: "DONE",
        dueAt: now,
        completedAt: now,
        completedByUserId: userId,
        createdByUserId: userId,
      },
      update: { status: "DONE", completedAt: now, completedByUserId: userId },
    });
    // A manual (re-)send restarts the no-login reminder ladder from today.
    await db.provider.update({ where: { id }, data: { welcomeRemindCount: 0 } }).catch(() => {});
    return { sent };
  }
  /** The provider's OWN onboarding view: their Phase 3 steps in second
   *  person, derived from the same computeOnboarding - one truth, two
   *  audiences. */
  @Get("api/provider/onboarding")
  @UseGuards(SessionOrJwtGuard)
  async myOnboarding(@Req() req: Request) {
    const user = req.user as any;
    if (!user?.providerId) throw new ForbiddenException("Providers only");
    const summary = await computeOnboarding(user.providerId);
    if (!summary) throw new NotFoundException("Provider not found");

    // `where` names the exact page in the provider's own navigation.
    // `selfMarkable` steps are review-style: the page may already be fine as
    // built, so the provider confirms with "Mark as done" (closes the
    // underlying onb* task - the same mechanism the queue used).
    // `optionalOverride` relaxes an admin-required step for the provider's
    // view (inventory: some agencies genuinely have no available roster and
    // match on their agency profile instead).
    const VIEW: Record<string, { label: string; link: string; where: string; description: string; minutes: number; selfMarkable?: boolean; optionalOverride?: boolean }> = {
      agreement: { label: "Sign the GoStork agreement", link: "/account/documents", where: "Settings -> Agreements", minutes: 5,
        description: "Review and sign your GoStork service agreement - it is what lets us start sending families your way." },
      w9: { label: "Complete your W-9", link: "/account/legal-identity", where: "Settings -> Legal", minutes: 3,
        description: "Fill in your W-9 so we can pay you. It only takes a couple of minutes." },
      password_reset: { label: "Set your password", link: "/account", where: "Settings -> My Account", minutes: 1,
        description: "Create your password from the welcome email so you can sign in anytime." },
      profile_review: { label: "Review your company profile", link: "/account/company", where: "Settings -> Company", minutes: 10, selfMarkable: true,
        description: "Check the profile we built for you - description, photos, locations - and fix anything that is off. This is what parents see." },
      knowledge_review: { label: "Review what Eva knows about you", link: "/account/knowledge", where: "Settings -> Knowledge", minutes: 5, selfMarkable: true,
        description: "Eva answers parents using your website and documents - check what she knows and add your FAQs or program guides." },
      doctors_review: { label: "Review your doctors", link: "/account/doctors", where: "Settings -> Doctors", minutes: 10, selfMarkable: true,
        description: "GoStork built profiles for your doctors - look through what parents will see and flag anything that is off." },
      calendar: { label: "Connect your calendar", link: "/account/calendar", where: "Settings -> Calendar", minutes: 2,
        description: "Connect Google, Outlook, or Apple Calendar so parents can book consultations on your real availability." },
      availability: { label: "Set your availability hours", link: "/account/calendar", where: "Settings -> Calendar", minutes: 3,
        description: "Choose the days and hours parents can book you - the calendar connection blocks conflicts, your availability opens the slots." },
      calendar_link: { label: "Review your booking link", link: "/account/calendar", where: "Settings -> Calendar", minutes: 2, selfMarkable: true,
        description: "Open your public booking page and check the times and meeting details parents will see." },
      video_room: { label: "Review your video room", link: "/account", where: "Settings -> My Account", minutes: 1, selfMarkable: true,
        description: "Consultations happen in your personal video room - open it once so you know where calls take place." },
      legal_details: { label: "Complete your legal details", link: "/account/legal-identity", where: "Settings -> Legal", minutes: 3,
        description: "Confirm your legal entity name, tax ID, and business address - they auto-fill from your signed W-9 and are needed for payouts." },
      stripe: { label: "Connect payouts", link: "/account/payouts", where: "Settings -> Payouts", minutes: 5,
        description: "Connect your bank account through Stripe so parent payments reach you." },
      costs_uploaded: { label: "Upload your cost sheet(s)", link: "/account/costs", where: "Settings -> Costs", minutes: 10,
        description: "Upload a cost sheet for each program you offer - parents compare programs by cost, so this is how you show up." },
      agreement_templates: { label: "Upload your parent agreement templates", link: "/account/documents", where: "Settings -> Agreements", minutes: 5,
        description: "Upload the agreements you send to parents so signing happens right inside GoStork." },
      pay_basis: { label: "Choose how parents are invoiced", link: "/account/billing", where: "Settings -> Billing", minutes: 2,
        description: "Pick how your parent payments are structured so invoicing works the way you do." },
      fees_review: { label: "Review your GoStork fees", link: "/account/billing", where: "Settings -> Billing", minutes: 2, selfMarkable: true,
        description: "See the referral fee agreed with GoStork for each of your services - no surprises on your first invoice." },
      team: { label: "Add your team & assign roles", link: "/account/team", where: "Settings -> Team", minutes: 5, selfMarkable: true,
        description: "Invite teammates and assign their roles and service lines so the right person sees each family. Just you? Mark it done." },
      ai: { label: "Set up your AI Concierge", link: "/account/concierge", where: "Settings -> AI Concierge", minutes: 5, selfMarkable: true,
        description: "Meet your AI assistant and choose how it represents your company to parents." },
      parent_form_provider: { label: "Review your Parent Form", link: "/account/parent-form", where: "Settings -> Parent Form", minutes: 5, selfMarkable: true,
        description: "Review the intake form parents complete before a match call, and tailor it if you like." },
      playbooks: { label: "Configure playbooks", link: "/account/playbooks", where: "Settings -> Playbooks", minutes: 5, selfMarkable: true,
        description: "Set up playbooks that automate your follow-ups with families." },
      automation: { label: "Review automations", link: "/account/automation", where: "Settings -> Automation", minutes: 3, selfMarkable: true,
        description: "Review your defaults for auto-replies and invoicing cadence - sensible defaults are already on." },
      branding: { label: "Review your branding", link: "/account/branding", where: "Settings -> Branding", minutes: 3, selfMarkable: true,
        description: "Check your logo and brand colors - they appear on your parent-facing documents." },
      sponsorship: { label: "Explore sponsorship", link: "/account/sponsorship", where: "Settings -> Sponsorship", minutes: 2, selfMarkable: true,
        description: "See how sponsored placement can boost your visibility with matching families." },
    };
    // The provider's journey order - decoupled from the admin checklist's
    // phase order (the same fact can sit elsewhere in each audience's story):
    // get in -> your presence -> get bookable -> get paid -> team & tools.
    const PROVIDER_ORDER = [
      "agreement", "w9", "password_reset",
      "profile_review", "scraper_egg", "scraper_surrogate", "scraper_sperm", "doctors_review", "knowledge_review",
      "calendar", "availability", "calendar_link", "video_room",
      "legal_details", "stripe", "costs_uploaded", "agreement_templates", "pay_basis", "fees_review",
      "team", "ai",
      "parent_form_provider", "playbooks", "automation", "branding", "sponsorship",
    ];
    const orderOf = (key: string) => {
      const i = PROVIDER_ORDER.indexOf(key);
      return i === -1 ? 999 : i;
    };
    // Inventory steps are phrased by what the provider can actually do:
    // egg/sperm donors are only scraped in by GoStork, so with profiles the
    // step is "Review your X" (closed by marking) and with none it is hidden
    // (nothing they can do). Surrogates can be uploaded manually, so an
    // empty roster shows "Add your surrogates" instead.
    const INVENTORY: Record<string, { noun: string; link: string; where: string; canUpload: boolean }> = {
      scraper_egg: { noun: "egg donors", link: "/account/egg-donors", where: "Settings -> Egg Donors", canUpload: false },
      scraper_surrogate: { noun: "surrogates", link: "/account/surrogates", where: "Settings -> Surrogates", canUpload: true },
      scraper_sperm: { noun: "sperm donors", link: "/account/sperm-donors", where: "Settings -> Sperm Donors", canUpload: false },
    };
    const steps = summary.steps
      .filter((s) => VIEW[s.key] || INVENTORY[s.key])
      .map((s) => {
        const inv = INVENTORY[s.key];
        if (inv) {
          const count = s.recordCount || 0;
          if (count === 0 && !inv.canUpload) return null; // nothing synced, nothing to do
          const review = count > 0;
          return {
            key: s.key,
            label: review ? `Review your ${inv.noun}` : `Add your ${inv.noun}`,
            link: inv.link,
            where: inv.where,
            description: review
              ? `GoStork synced ${count} ${inv.noun} from your database - look through the profiles parents will see and flag anything that is off.`
              : `Upload your available ${inv.noun} so parents can browse them. No live roster right now? Mark it done - parents will match with your agency profile.`,
            minutes: review ? 10 : 15,
            selfMarkable: true,
            // Review completes on the provider's word (the mark), never on
            // the profile count the sync produced.
            status: s.manuallyDone ? ("done" as const) : ("optional" as const),
            isOptional: true,
          };
        }
        const v = VIEW[s.key];
        const isOptional = v.optionalOverride ?? !!s.isOptional;
        return {
          key: s.key,
          label: v.label,
          link: v.link,
          where: v.where,
          description: v.description,
          minutes: v.minutes,
          selfMarkable: !!v.selfMarkable,
          // "waiting on provider" IS their to-do; locked steps stay locked
          // (e.g. signing before the document is sent). A step relaxed to
          // optional for the provider also wears the optional status.
          status: s.status === "done" || s.status === "locked"
            ? s.status
            : isOptional ? "optional" : "pending",
          isOptional,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => orderOf(a.key) - orderOf(b.key));
    const required = steps.filter((s) => !s.isOptional);
    const doneCount = required.filter((s) => s.status === "done").length;
    // The recommended next action: first unlocked required step, then first
    // unlocked optional one. Free order stays - this is a suggestion.
    const nextKey =
      steps.find((s) => !s.isOptional && s.status === "pending")?.key ||
      steps.find((s) => s.status === "pending" || s.status === "optional")?.key ||
      null;
    return {
      steps,
      nextKey,
      doneCount,
      requiredCount: required.length,
      percent: required.length ? Math.round((doneCount / required.length) * 100) : 0,
    };
  }

  /** The provider confirms a review-style step themselves ("all good here").
   *  Closes the underlying onb* task - the exact mechanism the Home queue
   *  used - so the admin checklist flips too. Only steps whose completion is
   *  the provider's word (reviews/confirmations) accept this; artifact steps
   *  (calendar, payouts, costs...) only complete when the artifact exists. */
  @Post("api/provider/onboarding/steps/:key/done")
  @UseGuards(SessionOrJwtGuard)
  async selfMarkStepDone(@Req() req: Request, @Param("key") key: string) {
    const user = req.user as any;
    if (!user?.providerId) throw new ForbiddenException("Providers only");
    const SELF_MARKABLE: Record<string, string> = {
      profile_review: "onbprofile",
      team: "onbteam",
      ai: "onbai",
      parent_form_provider: "onbform",
      playbooks: "onbplaybooks",
      automation: "onbauto",
      branding: "onbbrand",
      sponsorship: "onbsponsor",
      calendar_link: "onbcallink",
      video_room: "onbvideo",
      fees_review: "onbfees",
      knowledge_review: "onbknow",
      doctors_review: "onbdoc",
    };
    // Inventory steps close via the same onbmark marker the admin's manual
    // check-off writes (the step itself derives from profile counts) - "no
    // available roster right now" is a valid state for an agency.
    const MARKER_SELF_MARKABLE = new Set(["scraper_egg", "scraper_surrogate", "scraper_sperm"]);
    if (MARKER_SELF_MARKABLE.has(key)) {
      const db = prisma as any;
      const now = new Date();
      const systemKey = `onbmark:${key}:${user.providerId}`;
      await db.parentTask.upsert({
        where: { systemKey },
        create: {
          parentAccountId: user.providerId,
          scope: "PROVIDER",
          providerId: user.providerId,
          title: `Onboarding step "${key}" marked done by the provider`,
          type: "TODO",
          priority: "LOW",
          source: "SYSTEM",
          systemKey,
          status: "DONE",
          dueAt: now,
          completedAt: now,
          completedByUserId: user.id,
          createdByUserId: user.id,
        },
        update: { status: "DONE", completedAt: now, completedByUserId: user.id },
      });
      return { marked: key };
    }
    const prefix = SELF_MARKABLE[key];
    if (!prefix) throw new BadRequestException("This step completes on its own when the work is done");
    const def = HANDOFF_TASKS.find((t) => t.prefix === prefix);
    const db = prisma as any;
    const now = new Date();
    const systemKey = `${prefix}:${user.providerId}`;
    await db.parentTask.upsert({
      where: { systemKey },
      create: {
        parentAccountId: user.providerId,
        scope: "PROVIDER",
        providerId: user.providerId,
        title: def?.title || `Onboarding step "${key}"`,
        notes: def?.notes,
        deepLink: def?.deepLink,
        type: "TODO",
        priority: "LOW",
        source: "SYSTEM",
        systemKey,
        status: "DONE",
        dueAt: now,
        completedAt: now,
        completedByUserId: user.id,
        createdByUserId: user.id,
      },
      update: { status: "DONE", completedAt: now, completedByUserId: user.id },
    });
    return { marked: key };
  }

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
        // The CDC pipeline bulk-creates hundreds of IVF clinic profiles
        // (cdcClinicId set) that nobody is actively onboarding - they must
        // NOT flood the admin Home queue. A CDC clinic only counts as "in
        // onboarding" once someone deliberately started it by creating its
        // provider admin user; manually created providers count immediately.
        OR: [
          { cdcClinicId: null },
          { users: { some: { isDisabled: false, roles: { has: "PROVIDER_ADMIN" } } } },
        ],
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
