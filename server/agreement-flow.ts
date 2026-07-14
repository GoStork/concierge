import { prisma } from "./db";
import {
  generateAgreementFromTemplate,
  resolveAgreementTemplate,
  agreementDocumentType,
} from "./pandadoc-service";
import { getBaseUrl as getAppBaseUrl } from "./src/lib/get-base-url";

// Shared agreement generation + announcement flow, used by:
//  - the manual provider route (POST /api/agreements/generate-from-template)
//  - the Phase 5 approval-card Approve endpoint (billing.controller)
//  - the Phase 5 fully-automated send on invoice PAID (billing.service)
// One implementation so signer emails, chat cards, and dual-voice copy never
// drift between the manual and automated paths.

export class PaymentRequiredError extends Error {
  code = "PAYMENT_REQUIRED" as const;
  constructor() {
    super("Payment must be completed before the agreement can be sent for signature. Please complete your GoStork payment first.");
  }
}

/**
 * Effective agreement-automation mode for a provider. The provider's own
 * setting (agreementAutomation) overrides the GoStork-admin rollout toggle
 * (autoFeaturesEnabled.autoAgreementDraft); when the provider never chose,
 * the admin toggle maps on -> "approval", off -> "off".
 */
export function effectiveAgreementMode(provider: {
  agreementAutomation?: string | null;
  autoFeaturesEnabled?: unknown;
}): "off" | "approval" | "auto_send" {
  const own = provider.agreementAutomation;
  if (own === "off" || own === "approval" || own === "auto_send") return own;
  const auto = (provider.autoFeaturesEnabled as { autoAgreementDraft?: boolean } | null)?.autoAgreementDraft;
  return auto === true ? "approval" : "off";
}

// Maps an AiChatSession.subjectType to the agreement service type; falls back
// to the provider's single approved service when the session has no subject.
export async function agreementServiceTypeForSession(sessionId: string): Promise<string | null> {
  const session = await prisma.aiChatSession.findUnique({
    where: { id: sessionId },
    select: { subjectType: true, providerId: true },
  });
  if (!session) return null;
  const s = (session.subjectType || "").toLowerCase();
  if (s.includes("egg")) return "EGG_DONATION";
  if (s.includes("surrog")) return "SURROGACY";
  if (s.includes("sperm")) return "SPERM_DONATION";
  if (s.includes("ivf") || s.includes("clinic") || s.includes("doctor")) return "IVF_CLINIC";
  if (!session.providerId) return null;
  const services = await prisma.providerService.findMany({
    where: { providerId: session.providerId, status: "APPROVED" },
    select: { providerType: { select: { name: true } } },
  });
  const names = services.map((x) => (x.providerType?.name || "").toLowerCase());
  const mapped = new Set<string>();
  for (const n of names) {
    if (n.includes("surrog")) mapped.add("SURROGACY");
    else if (n.includes("egg")) mapped.add("EGG_DONATION");
    else if (n.includes("sperm")) mapped.add("SPERM_DONATION");
    else if (n.includes("ivf") || n.includes("clinic")) mapped.add("IVF_CLINIC");
  }
  return mapped.size === 1 ? Array.from(mapped)[0] : null;
}

export interface GenerateAndAnnounceOpts {
  sessionId: string;
  providerId: string;
  generatedByUserId?: string;
  partnerOverride?: { firstName: string; lastName: string; email: string };
  skipPartner?: boolean;
  /** "manual" = provider clicked the button; "approval" = approved the draft card; "auto" = fully automated on PAID */
  trigger: "manual" | "approval" | "auto";
}

/**
 * Payment gate + generation + agreement chat card (dual-voice) + first-signer
 * email + signerOrder persistence. Throws PaymentRequiredError (code
 * PAYMENT_REQUIRED) and passes through PARTNER_INFO_REQUIRED errors from
 * generateAgreementFromTemplate.
 */
export async function generateAndAnnounceAgreement(opts: GenerateAndAnnounceOpts) {
  const session = await prisma.aiChatSession.findUnique({
    where: { id: opts.sessionId },
    select: { id: true, userId: true, providerId: true },
  });
  if (!session) throw new Error("Session not found");
  if (session.providerId !== opts.providerId) throw new Error("Not authorized for this session");

  const serviceType = await agreementServiceTypeForSession(session.id);
  const tpl = await resolveAgreementTemplate(opts.providerId, serviceType);

  // GoStork payment gate: if this provider uses PandaDoc agreements, a paid
  // invoice is required first - GoStork collects its referral fee before the
  // legal contract is executed.
  if (tpl.pandaDocTemplateId) {
    const paidInvoice = await prisma.invoice.findFirst({
      where: {
        sessionId: session.id,
        status: { in: ["PAID", "AUTHORIZED"] }, // AUTHORIZED = AT_CLEARANCE pre-auth placed
      },
    });
    if (!paidInvoice) throw new PaymentRequiredError();
  }

  const agreement = await generateAgreementFromTemplate({
    providerId: opts.providerId,
    parentUserId: session.userId,
    sessionId: session.id,
    generatedByUserId: opts.generatedByUserId,
    partnerOverride: opts.partnerOverride,
    skipPartner: opts.skipPartner === true,
    serviceType,
    // Capture which environment created this agreement so the PandaDoc
    // webhook handler (which may run on a DIFFERENT environment because
    // PandaDoc fans out events to every subscribed webhook URL) emails
    // subsequent signers with a link to the right place.
    originAppUrl: getAppBaseUrl(),
  });

  const agr = agreement as any;
  const docTitle = agreementDocumentType(serviceType);
  const { resolveSessionSenderName } = await import("./chat-router");
  const providerRecord = await prisma.provider.findUnique({
    where: { id: opts.providerId },
    select: { name: true },
  });
  const providerName = providerRecord?.name || "Your Agency";
  const parentUser = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { name: true, firstName: true, email: true },
  });
  const parentName = parentUser?.firstName || parentUser?.name || "the parent";

  const parentCopy =
    opts.trigger === "auto"
      ? `Great news - your payment cleared, so ${providerName} sent your official ${docTitle} right away. Please review and sign it using the button below. You'll also receive it via email.`
      : `${providerName} has generated your official ${docTitle}. Please review and sign it using the button below. You'll also receive it via email.`;
  const providerCopy =
    opts.trigger === "auto"
      ? `The ${docTitle} was generated and sent to ${parentName} for signature automatically after their payment. You'll be notified as each signer completes it.`
      : `The ${docTitle} was sent to ${parentName} for signature. You'll be notified as each signer completes it.`;

  await prisma.aiChatMessage.create({
    data: {
      sessionId: session.id,
      role: "assistant",
      content: parentCopy,
      senderType: "system",
      senderName: await resolveSessionSenderName(session.id),
      uiCardType: "agreement",
      uiCardData: {
        providerContent: providerCopy,
        agreementCard: {
          agreementId: agr.id,
          status: agr.status,
          viewUrl: agr.pandaDocViewUrl || null,
        },
      },
    },
  });

  // Send email only to the first signer (lowest signingOrder). Subsequent
  // signers are notified sequentially via the recipient_completed webhook.
  try {
    const { getNestApp } = await import("./nest-app-ref");
    const nestApp = getNestApp();
    if (nestApp) {
      const { NotificationService } = await import("./src/modules/notifications/notification.service");
      const notifService = nestApp.get(NotificationService);
      const appBase = getAppBaseUrl();
      const goStorkSigningUrl = agr.id ? `${appBase}/agreements/${agr.id}` : null;

      type SignerEntry = { name: string; email: string; userId: string | null; guestToken: string | null; signingOrder: number; notified: boolean; signed: boolean };
      console.log(`[Agreement signers] parentSigners count: ${(agr.parentSigners ?? []).length}, agreementId: ${agr.id}, emails: ${(agr.parentSigners ?? []).map((s: any) => s.email).join(", ")}`);
      let signers: SignerEntry[] = (agr.parentSigners ?? []).map((s: any) => ({
        name: s.name,
        email: s.email,
        userId: s.userId ?? null,
        guestToken: s.guestToken ?? null,
        signingOrder: s.signingOrder ?? 1,
        notified: false,
        signed: false,
      }));

      // Fallback: if parentSigners not populated, email the primary parent
      if (signers.length === 0 && parentUser?.email) {
        signers.push({ name: parentUser.name || parentUser.email, email: parentUser.email, userId: session.userId, guestToken: null, signingOrder: 1, notified: false, signed: false });
      }

      // Sort by signing order, then persist the full ordered list on the agreement
      signers.sort((a, b) => a.signingOrder - b.signingOrder);
      await (prisma.agreement as any).update({ where: { id: agr.id }, data: { signerOrder: signers } });

      // Only notify the first signer now
      const firstSigner = signers[0];
      if (firstSigner?.email) {
        const signerUserIds = firstSigner.userId ? [firstSigner.userId] : [];
        const signerUsers = signerUserIds.length > 0
          ? await prisma.user.findMany({ where: { id: { in: signerUserIds } }, select: { id: true, mobileNumber: true } })
          : [];
        const phone = signerUsers.find((u) => u.id === firstSigner.userId)?.mobileNumber ?? null;
        const emailSigningUrl = firstSigner.userId
          ? goStorkSigningUrl
          : firstSigner.guestToken ? `${appBase}/agreements/guest/${firstSigner.guestToken}` : null;

        console.log(`[Agreement notify] ${opts.trigger} -> sending to ${firstSigner.email}, isGoStorkMember: ${!!firstSigner.userId && !firstSigner.guestToken}`);
        await notifService.sendAgreementReadyNotification({
          parentUserId: firstSigner.userId || session.userId,
          parentName: firstSigner.name || firstSigner.email,
          parentEmail: firstSigner.email,
          parentPhone: phone,
          providerName,
          providerId: opts.providerId,
          signingUrl: emailSigningUrl,
          sessionId: session.id,
          isGoStorkMember: !!firstSigner.userId && !firstSigner.guestToken,
        });

        // Mark first signer as notified in signerOrder
        signers[0] = { ...firstSigner, notified: true };
        await (prisma.agreement as any).update({ where: { id: agr.id }, data: { signerOrder: signers } });
      }
    }
  } catch (notifErr: any) {
    console.error("[Agreement] Notification send failed:", notifErr?.message);
  }

  return agr;
}

/**
 * Stage 13 journey handoff: once the session has BOTH a fully signed
 * agreement AND a PAID invoice, stamp AiChatSession.handoffCompletedAt once
 * and post a dual-voice celebration message. Called from the PandaDoc
 * webhook (document.completed) and from the invoice PAID transitions -
 * whichever condition completes last wins, order-independent.
 */
export async function maybeCompleteHandoff(sessionId: string): Promise<boolean> {
  const session = await prisma.aiChatSession.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, providerId: true, subjectType: true, handoffCompletedAt: true, provider: { select: { name: true, services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } } }, user: { select: { firstName: true, name: true } } },
  });
  if (!session || session.handoffCompletedAt) return false;

  const [signedAgreement, paidInvoice] = await Promise.all([
    prisma.agreement.findFirst({ where: { sessionId, status: "SIGNED" }, select: { id: true, documentType: true } }),
    prisma.invoice.findFirst({ where: { sessionId, status: "PAID" }, select: { id: true } }),
  ]);
  if (!signedAgreement || !paidInvoice) return false;

  // Atomic claim - only one caller posts the celebration even if the webhook
  // and the payment path race.
  const claimed = await prisma.aiChatSession.updateMany({
    where: { id: sessionId, handoffCompletedAt: null },
    data: { handoffCompletedAt: new Date() },
  });
  if (claimed.count === 0) return false;

  {
    const { emitJourneyEvent } = await import("./journey-events");
    void emitJourneyEvent({ eventType: "HANDOFF_COMPLETED", parentUserId: session.userId, providerId: (session as any).providerId || null, sessionId });
  }

  const { advanceJourneyStage } = await import("./journey-stage");
  await advanceJourneyStage(session.userId, "Agreement Signed");

  const providerName = session.provider?.name || "your provider";
  const parentName = session.user?.firstName || session.user?.name || "The parent";

  // Phase 7B: per-journey-type "what happens next" bullets, editable in the
  // admin concierge UI (handoff_wrapup_* sections). Appended to the
  // congratulations so the parent knows exactly what the provider drives
  // from here. Missing/blank section -> congratulations only.
  let wrapupText = "";
  try {
    const { classifyJourneyType } = await import("./journey-timeline");
    const serviceNames = (session.provider?.services || []).map((sv: any) => sv.providerType?.name || "").filter(Boolean);
    const journeyType = classifyJourneyType(serviceNames, [session.subjectType || ""]);
    const section = await prisma.conciergePromptSection.findUnique({ where: { key: `handoff_wrapup_${journeyType}` } });
    if (section?.content?.trim()) {
      wrapupText = `\n\n${section.content.trim().replace(/\{providerName\}/g, providerName)}`;
    }
  } catch (e: any) {
    console.warn(`[handoff] wrap-up section lookup failed: ${e?.message}`);
  }

  const { resolveSessionSenderName } = await import("./chat-router");
  await prisma.aiChatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content: `Congratulations! Your ${signedAgreement.documentType.toLowerCase()} with ${providerName} is fully signed and your payment is complete. Your journey together officially begins - ${providerName} will guide you through the next steps from here, and I'm always around if you need anything.${wrapupText}`,
      senderType: "system",
      senderName: await resolveSessionSenderName(sessionId),
      uiCardData: {
        celebration: true,
        providerContent: `${parentName}'s ${signedAgreement.documentType.toLowerCase()} is fully signed and their payment is complete - the engagement is official. Time to kick off your onboarding process!`,
      },
    },
  });
  console.log(`[Handoff] Stage 13 complete for session ${sessionId}`);
  return true;
}

/**
 * Phase 5: parent asked Eva to see the contract ([[AGREEMENT_PREVIEW]]).
 * If a live agreement exists, re-share its card; otherwise share the
 * provider's template document as a read-only preview; if no template is
 * configured, tell the parent honestly and nudge the provider - never
 * fabricate a document.
 */
export async function postAgreementPreview(sessionId: string): Promise<void> {
  const session = await prisma.aiChatSession.findUnique({
    where: { id: sessionId },
    select: { id: true, providerId: true, provider: { select: { id: true, name: true } }, user: { select: { firstName: true, name: true } } },
  });
  if (!session?.providerId || !session.provider) {
    console.log(`[AGREEMENT_PREVIEW] Session ${sessionId} has no provider - skipping`);
    return;
  }
  const providerName = session.provider.name || "the provider";
  const parentName = session.user?.firstName || session.user?.name || "the parent";
  const { resolveSessionSenderName } = await import("./chat-router");
  const senderName = await resolveSessionSenderName(sessionId);

  const existing = await prisma.agreement.findFirst({
    where: { sessionId, status: { notIn: ["REJECTED", "EXPIRED", "ERROR"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, pandaDocViewUrl: true, documentType: true },
  });
  if (existing) {
    await prisma.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: `Here's your ${existing.documentType.toLowerCase()} - you can review${existing.status === "SIGNED" ? " and download" : " and sign"} it below.`,
        senderType: "system",
        senderName,
        uiCardType: "agreement",
        uiCardData: {
          providerContent: `Eva re-shared the ${existing.documentType.toLowerCase()} link with ${parentName}.`,
          agreementCard: { agreementId: existing.id, status: existing.status, viewUrl: existing.pandaDocViewUrl || null },
        },
      },
    });
    return;
  }

  const serviceType = await agreementServiceTypeForSession(sessionId);
  const tpl = await resolveAgreementTemplate(session.providerId, serviceType);
  const docTitle = agreementDocumentType(serviceType);
  if (tpl.agreementTemplateUrl) {
    const originalName = tpl.agreementTemplateOriginalName || `${docTitle}.pdf`;
    const mimeType = originalName.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : originalName.toLowerCase().endsWith(".docx")
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/msword";
    await prisma.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: `Here's ${providerName}'s standard ${docTitle.toLowerCase()} so you can review what you'd be signing. Your official personalized version is prepared after your deposit payment.`,
        senderType: "system",
        senderName,
        uiCardType: "attachment",
        uiCardData: {
          providerContent: `Eva shared your standard ${docTitle.toLowerCase()} template with ${parentName} as a read-only preview.`,
          url: `/api/agreements/template-preview/${sessionId}`,
          originalName,
          mimeType,
        },
      },
    });
    return;
  }

  await prisma.aiChatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content: `${providerName} hasn't uploaded their ${docTitle.toLowerCase()} document to GoStork yet - I've asked them to share it so you can review it here.`,
      senderType: "system",
      senderName,
    },
  });
  await prisma.aiChatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content: `${parentName} asked to preview your ${docTitle.toLowerCase()}, but no agreement template is uploaded. Add it in Settings > Documents so Eva can share it with parents who ask.`,
      senderType: "system",
      senderName: "GoStork",
      uiCardType: "provider_only",
    },
  });
}
