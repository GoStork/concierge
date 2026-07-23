/**
 * Intended Parent Form notifications (pattern: notify-provider-review.ts).
 *
 * Channels:
 *   Email - buildBrandedEmail on SendGrid (mock-logged without an API key).
 *   SMS   - Twilio Content Template when IP_FORM_REMINDER_CONTENT_SID is a
 *           real SID; until that template is registered it falls back to a
 *           raw-body SMS via the same Twilio account (the app's established
 *           pattern - see POST_CALL_FOLLOWUP_PARENT in notification.service).
 *   In-app- InAppNotification rows (IP_FORM_* event types).
 *
 * Test-data suppression: recipients on @gostork-test.com are logged, not
 * emailed/texted, so automated runs never spam real inboxes.
 */
import { prisma } from "./db";
import { getBaseUrl } from "./src/lib/get-base-url";
import { esc, buildBrandedEmail, fetchEmailBrandData } from "./src/modules/notifications/email-builder";

function isTestEmail(email: string | null | undefined): boolean {
  return /@gostork-test\.com$/i.test(email || "");
}

async function sendEmail(to: string[], subject: string, html: string, brandCompanyName: string): Promise<void> {
  const recipients = to.filter((e) => e && !isTestEmail(e));
  if (!recipients.length) return;
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (!sendgridKey) {
    console.log(`[IP FORM NOTIFY] [EMAIL MOCK] To: ${recipients.join(", ")} - ${subject}`);
    return;
  }
  const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${sendgridKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: recipients.map((email) => ({ to: [{ email }] })),
      from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: brandCompanyName },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });
  if (!resp.ok) {
    console.error(`[IP FORM NOTIFY] SendGrid error: ${resp.status} - ${await resp.text()}`);
  }
}

// Same convention as TWILIO_TEMPLATES in notification.service.ts: hardcoded
// content SID, PLACEHOLDER until the template is registered in Twilio - the
// raw-body fallback below keeps SMS working either way.
const IP_FORM_REMINDER_CONTENT_SID = "PLACEHOLDER"; // TODO: create Twilio Content Template; falls back to sendRawSms

/** Raw-body SMS (clone of NotificationService.sendRawSms - E.164 normalize, prefer MessagingService). */
async function sendRawSms(to: string, body: string): Promise<void> {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
  const twilioMessagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!twilioSid || !twilioToken || (!twilioFrom && !twilioMessagingServiceSid)) {
    console.log(`[IP FORM NOTIFY] [SMS MOCK] To: ${to}, Body: ${body}`);
    return;
  }
  let normalizedTo = to.replace(/[\s\-\(\)]/g, "");
  if (!normalizedTo.startsWith("+")) normalizedTo = `+1${normalizedTo}`;
  const paramsInit: Record<string, string> = { To: normalizedTo, Body: body };
  if (twilioMessagingServiceSid) paramsInit.MessagingServiceSid = twilioMessagingServiceSid;
  else paramsInit.From = twilioFrom!;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(paramsInit).toString(),
  });
  if (!resp.ok) {
    console.error(`[IP FORM NOTIFY] Twilio raw SMS error: ${resp.status} - ${await resp.text()}`);
  }
}

/** Twilio Content Template SMS (same HTTP contract as NotificationService.sendSmsWithTemplate). */
async function sendSmsTemplate(to: string, contentSid: string, contentVars: Record<string, string>): Promise<void> {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
  const twilioMessagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!twilioSid || !twilioToken || (!twilioFrom && !twilioMessagingServiceSid)) {
    console.log(`[IP FORM NOTIFY] [SMS MOCK] To: ${to}, ContentSid: ${contentSid}, Vars: ${JSON.stringify(contentVars)}`);
    return;
  }
  const paramsInit: Record<string, string> = { To: to, ContentSid: contentSid, ContentVariables: JSON.stringify(contentVars) };
  if (twilioMessagingServiceSid) paramsInit.MessagingServiceSid = twilioMessagingServiceSid;
  else paramsInit.From = twilioFrom!;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(paramsInit).toString(),
  });
  if (!resp.ok) {
    console.error(`[IP FORM NOTIFY] Twilio error: ${resp.status} - ${await resp.text()}`);
  }
}

function getFirstName(name: string | null | undefined): string {
  return (name || "").trim().split(/\s+/)[0] || "there";
}

/** Guest signing link email for parent 2 (no GoStork account). */
export async function sendIpFormGuestInvite(params: {
  email: string;
  name: string | null;
  inviterName: string;
  link: string;
}): Promise<void> {
  try {
    if (isTestEmail(params.email)) {
      console.log(`[IP FORM NOTIFY] Test-data guest invite (${params.email}) - suppressed`);
      return;
    }
    const brand = await fetchEmailBrandData(prisma);
    const html = buildBrandedEmail(brand, {
      title: "Your signature is needed on your Intended Parent Form",
      greeting: `Hi ${esc(getFirstName(params.name) === "there" ? "" : getFirstName(params.name)) || "there"},`,
      body:
        `<strong>${esc(params.inviterName)}</strong> has been filling out your family's Intended Parent Form on GoStork. ` +
        `The surrogacy agency shares this form with potential surrogates so they can get to know you before a match call - ` +
        `it needs YOUR sections and signature too before it can be submitted.<br/><br/>` +
        `Use the secure link below to review the form, complete your personal sections, and sign. No account needed - the link is private to you and expires in 30 days.`,
      buttons: [{ label: "Review and Sign the Form", url: params.link }],
      footer: "If you weren't expecting this, you can ignore this email - nothing is shared without your signature.",
    });
    await sendEmail([params.email], "Action needed: sign your Intended Parent Form", html, brand.companyName);
  } catch (e: any) {
    console.error(`[IP FORM NOTIFY] guest invite failed: ${e?.message}`);
  }
}

/**
 * On submission: in-app + email every connected provider org that has an
 * APPROVED surrogacy service, linking to their forms page.
 */
export async function notifyProvidersIpFormSubmitted(responseId: string): Promise<void> {
  const response = await prisma.ipFormResponse.findUnique({ where: { id: responseId } });
  if (!response) return;
  const memberUsers = await prisma.user.findMany({
    where: { OR: [{ parentAccountId: response.parentAccountId }, { id: response.parentAccountId }] },
    select: { id: true, name: true, email: true },
  });
  const memberIds = memberUsers.map((m) => m.id);
  const isTestData = memberUsers.every((m) => isTestEmail(m.email));

  // Parent display names from the form itself (fall back to account names).
  const nameQ = await prisma.ipFormQuestion.findUnique({ where: { key: "ip_full_legal_name" }, select: { id: true } });
  let names: string[] = [];
  if (nameQ) {
    const nameAnswers = await prisma.ipFormAnswer.findMany({
      where: { responseId, questionId: nameQ.id, parentSlot: { in: [1, 2] } },
      orderBy: { parentSlot: "asc" },
    });
    names = nameAnswers.map((a) => (typeof a.value === "string" ? a.value.trim() : "")).filter(Boolean);
  }
  if (!names.length) names = memberUsers.map((m) => m.name).filter(Boolean) as string[];
  const parentNames = names.join(" & ") || "An intended parent";

  // Connected provider orgs (session or booking) with an APPROVED surrogacy service.
  const [sessions, bookings] = await Promise.all([
    prisma.aiChatSession.findMany({ where: { userId: { in: memberIds }, providerId: { not: null } }, select: { providerId: true } }),
    prisma.booking.findMany({
      where: { parentUserId: { in: memberIds } },
      select: { providerUser: { select: { providerId: true } } },
    }),
  ]);
  const providerIds = new Set<string>();
  for (const s of sessions) if (s.providerId) providerIds.add(s.providerId);
  for (const b of bookings) if (b.providerUser?.providerId) providerIds.add(b.providerUser.providerId);
  if (!providerIds.size) return;

  const surrogacyProviders = await prisma.provider.findMany({
    where: {
      id: { in: [...providerIds] },
      services: { some: { status: "APPROVED", providerType: { name: { contains: "surrogacy", mode: "insensitive" } } } },
    },
    select: { id: true, name: true },
  });
  if (!surrogacyProviders.length) return;

  const brand = await fetchEmailBrandData(prisma);
  const formsUrl = `${getBaseUrl()}/provider/parent-forms`;

  for (const provider of surrogacyProviders) {
    const providerUsers = await prisma.user.findMany({
      where: { providerId: provider.id, isDisabled: false },
      select: { id: true, email: true },
    });
    for (const pu of providerUsers) {
      void prisma.inAppNotification
        .create({
          data: {
            userId: pu.id,
            eventType: "IP_FORM_SUBMITTED",
            payload: { responseId, parentNames, submittedAt: response.submittedAt },
          },
        })
        .catch(() => {});
    }
    if (isTestData) {
      console.log(`[IP FORM NOTIFY] Test-data submission - provider email to ${provider.name} suppressed`);
      continue;
    }
    const html = buildBrandedEmail(brand, {
      title: "An Intended Parent Form is ready for you",
      greeting: `Good news!`,
      body:
        `<strong>${esc(parentNames)}</strong> completed and signed their Intended Parent Form. ` +
        `You can now download the PDF (with your agency's branding) and share the surrogate version with candidates ahead of a match call.`,
      buttons: [{ label: "View and Download the Form", url: formsUrl }],
    });
    await sendEmail(providerUsers.map((u) => u.email).filter(Boolean) as string[], `${parentNames} submitted their Intended Parent Form`, html, brand.companyName).catch(
      (e) => console.error(`[IP FORM NOTIFY] provider email failed: ${e?.message}`),
    );
  }
  console.log(`[IP FORM NOTIFY] Submission ${responseId} announced to ${surrogacyProviders.length} surrogacy provider(s)`);
}

/**
 * Kickoff + reminder deliveries for the parent(s). Used by ip-form-flow
 * (kickoff after the first completed surrogacy consultation) and the 10-min
 * reminder sweep. Writes IpFormReminder rows for dedupe when reminderType is
 * given; the unique constraint makes concurrent sweeps idempotent.
 */
export async function sendIpFormParentNudge(params: {
  responseId: string;
  reminderType: string | null; // null = kickoff (no ledger row)
  channels: ("email" | "sms" | "inapp")[];
  providerName?: string | null;
}): Promise<void> {
  const response = await prisma.ipFormResponse.findUnique({ where: { id: params.responseId } });
  if (!response || response.status === "SUBMITTED") return;
  const memberUsers = await prisma.user.findMany({
    where: { OR: [{ parentAccountId: response.parentAccountId }, { id: response.parentAccountId }] },
    select: { id: true, name: true, email: true, mobileNumber: true },
  });
  if (!memberUsers.length) return;

  const formUrl = `${getBaseUrl()}/ip-form`;
  const agencyPart = params.providerName ? `${params.providerName} needs` : "Your surrogacy agency needs";

  const claim = async (channel: string): Promise<boolean> => {
    if (!params.reminderType) return true;
    try {
      await prisma.ipFormReminder.create({
        data: { responseId: response.id, channel, reminderType: params.reminderType },
      });
      return true;
    } catch {
      return false; // unique violation - another process already sent this one
    }
  };

  if (params.channels.includes("email") && (await claim("email"))) {
    const brand = await fetchEmailBrandData(prisma);
    const html = buildBrandedEmail(brand, {
      title: "Your Intended Parent Form is waiting",
      greeting: `Hi ${esc(getFirstName(memberUsers[0]?.name))},`,
      body:
        `${esc(agencyPart)} your completed Intended Parent Form before they can present you to potential surrogates. ` +
        `The surrogate reads it to get to know your family and decide whether to meet you for a match call - ` +
        `<strong>a match call cannot be scheduled until the form is submitted</strong>.<br/><br/>` +
        `It takes about 20-30 minutes, saves as you go, and you can finish it in more than one sitting.`,
      buttons: [{ label: "Continue My Form", url: formUrl }],
    });
    await sendEmail(memberUsers.map((m) => m.email).filter(Boolean) as string[], "Finish your Intended Parent Form to unlock your match call", html, brand.companyName).catch(
      (e) => console.error(`[IP FORM NOTIFY] parent email failed: ${e?.message}`),
    );
  }

  if (params.channels.includes("sms") && (await claim("sms"))) {
    const contentSid = IP_FORM_REMINDER_CONTENT_SID;
    for (const m of memberUsers) {
      if (!m.mobileNumber || isTestEmail(m.email)) continue;
      if (contentSid && !contentSid.includes("PLACEHOLDER")) {
        await sendSmsTemplate(m.mobileNumber, contentSid, { "1": getFirstName(m.name), "2": formUrl }).catch((e) =>
          console.error(`[IP FORM NOTIFY] SMS failed: ${e?.message}`),
        );
      } else {
        await sendRawSms(
          m.mobileNumber,
          `Hi ${getFirstName(m.name)}, your GoStork Intended Parent Form is still waiting. Your surrogacy agency needs it before a match call can be scheduled - it takes about 20-30 minutes and saves as you go: ${formUrl}`,
        ).catch((e) => console.error(`[IP FORM NOTIFY] SMS failed: ${e?.message}`));
      }
    }
  }

  if (params.channels.includes("inapp") && (await claim("inapp"))) {
    for (const m of memberUsers) {
      void prisma.inAppNotification
        .create({
          data: {
            userId: m.id,
            eventType: "IP_FORM_REMINDER",
            payload: { responseId: response.id, providerName: params.providerName || null },
          },
        })
        .catch(() => {});
    }
  }
}
