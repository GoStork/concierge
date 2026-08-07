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
import { findConnectedProviderSession } from "./parent-visibility";

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

/** Guest signing link email (+ optional SMS) for parent 2 (no GoStork account). */
export async function sendIpFormGuestInvite(params: {
  email: string;
  name: string | null;
  phone?: string | null;
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
    if (params.phone) {
      await sendRawSms(
        params.phone,
        `${params.inviterName} started your GoStork Intended Parent Form and needs your signature. Review your sections and sign here (private link, expires in 30 days): ${params.link}`,
      ).catch((e) => console.error(`[IP FORM NOTIFY] guest invite SMS failed: ${e?.message}`));
    }
  } catch (e: any) {
    console.error(`[IP FORM NOTIFY] guest invite failed: ${e?.message}`);
  }
}

/**
 * A partner just signed - tell the OTHER account members (email + SMS + in-app)
 * so they know the form is ready to submit. Used when parent 2 signs (the main
 * case: parent 1 fills the form, sends the link, and needs to know it's signed)
 * and symmetrically when a member signs.
 */
export async function notifyPartnerSigned(params: {
  responseId: string;
  signedSlot: number;
  signerName: string | null;
  signerUserId?: string | null;
}): Promise<void> {
  try {
    const response = await prisma.ipFormResponse.findUnique({ where: { id: params.responseId } });
    if (!response) return;
    const members = await prisma.user.findMany({
      where: { OR: [{ parentAccountId: response.parentAccountId }, { id: response.parentAccountId }] },
      select: { id: true, name: true, email: true, mobileNumber: true },
    });
    // Everyone except whoever just signed (guests have no user id, so all members are notified).
    const recipients = members.filter((m) => !params.signerUserId || m.id !== params.signerUserId);
    if (!recipients.length) return;
    const signer = getFirstName(params.signerName) === "there" ? "Your partner" : (params.signerName || "").trim();
    const formUrl = `${getBaseUrl()}/ip-form`;

    // In-app
    for (const m of recipients) {
      void prisma.inAppNotification
        .create({ data: { userId: m.id, eventType: "IP_FORM_PARTNER_SIGNED", payload: { responseId: response.id, signerName: signer, signedSlot: params.signedSlot } } })
        .catch(() => {});
    }

    // Email + SMS (skip test recipients)
    const brand = await fetchEmailBrandData(prisma);
    const emailTargets = recipients.map((m) => m.email).filter((e) => e && !isTestEmail(e)) as string[];
    if (emailTargets.length) {
      const html = buildBrandedEmail(brand, {
        title: `${signer} signed your Intended Parent Form`,
        greeting: `Hi ${esc(getFirstName(recipients[0]?.name))},`,
        body:
          `<strong>${esc(signer)}</strong> just reviewed and signed your Intended Parent Form. ` +
          `That was the last signature it needed - you can now review everything and submit it so your surrogacy agency can share it ahead of your match call.`,
        buttons: [{ label: "Review and Submit the Form", url: formUrl }],
      });
      await sendEmail(emailTargets, `${signer} signed your Intended Parent Form`, html, brand.companyName).catch((e) =>
        console.error(`[IP FORM NOTIFY] partner-signed email failed: ${e?.message}`),
      );
    }
    for (const m of recipients) {
      if (!m.mobileNumber || isTestEmail(m.email)) continue;
      await sendRawSms(
        m.mobileNumber,
        `Good news ${getFirstName(m.name)} - ${signer} signed your GoStork Intended Parent Form. It's ready to review and submit: ${formUrl}`,
      ).catch((e) => console.error(`[IP FORM NOTIFY] partner-signed SMS failed: ${e?.message}`));
    }
  } catch (e: any) {
    console.error(`[IP FORM NOTIFY] partner-signed notify failed: ${e?.message}`);
  }
}

/**
 * The provider orgs an IP-form submission is shared with.
 *
 * ONE definition, used by both the notifier below and the contact-release
 * writer in ip-form-router.ts. They must not drift: the set that gets the
 * "X submitted their form" email carrying the parents' full legal names is
 * exactly the set that gets Gate B opened, because the form itself contains the
 * email, phone, date of birth and home address.
 *
 * The status filter is the point. The IpFormResponse is ONE global row per
 * parent account (parentAccountId is @unique) with no provider column, so the
 * fan-out has to be computed - and it used to have no status filter at all,
 * meaning an agency that answered a single anonymous whisper received the
 * parents' legal names. Now a provider has to have actually met them: a booked
 * or connected session, or a booking.
 */
export async function ipFormProviderIds(memberIds: string[]): Promise<string[]> {
  if (!memberIds.length) return [];
  const [sessions, bookings] = await Promise.all([
    prisma.aiChatSession.findMany({
      where: {
        userId: { in: memberIds },
        providerId: { not: null },
        status: { in: ["CONSULTATION_BOOKED", "PROVIDER_CONNECTED"] },
      },
      select: { providerId: true },
    }),
    prisma.booking.findMany({
      where: { parentUserId: { in: memberIds } },
      select: { providerUser: { select: { providerId: true } } },
    }),
  ]);
  const providerIds = new Set<string>();
  for (const s of sessions) if (s.providerId) providerIds.add(s.providerId);
  for (const b of bookings) if (b.providerUser?.providerId) providerIds.add(b.providerUser.providerId);
  if (!providerIds.size) return [];

  const formProviders = await prisma.provider.findMany({
    where: { id: { in: [...providerIds] }, collectsIntendedParentForm: true },
    select: { id: true },
  });
  return formProviders.map((p) => p.id);
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

  const providerIds = new Set<string>(await ipFormProviderIds(memberIds));
  if (!providerIds.size) return;

  const formProviders = await prisma.provider.findMany({
    where: {
      id: { in: [...providerIds] },
    },
    select: {
      id: true,
      name: true,
      // Surrogate-safe variant is only offered to surrogacy agencies.
      services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } },
    },
  });
  if (!formProviders.length) return;

  const brand = await fetchEmailBrandData(prisma);
  const formsUrl = `${getBaseUrl()}/provider/parent-forms`;

  for (const provider of formProviders) {
    const isSurrogacy = provider.services.some((s) => (s.providerType?.name || "").toLowerCase().includes("surrogacy"));
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
    // Drop a message into the shared parent-provider chat so the provider sees
    // it in-thread (provider-facing providerContent; parent reads `content`).
    //
    // findCONNECTED, not findShared. The two-tier helper falls back to a bare
    // providerId lookup when no shared thread exists, and a whisper stamps
    // providerId onto the parent's PRIVATE Eva session - so that fallback
    // resolves to Eva. This card carries the signed Intended Parent Form:
    // legal names, date of birth, home address. It does not belong in a
    // conversation the provider is not a party to, and it would not even
    // render there (`ip_form_submitted` is not in the parent's card allow-
    // list), so the fallback was silent misdelivery, not a rescue.
    const sharedSession = await findConnectedProviderSession(memberIds, provider.id);
    if (!sharedSession) {
      console.warn(
        `[ip-form] ${provider.name} has no shared thread with parent account ` +
        `${memberIds[0]} - the submitted-form card was not posted. It will be ` +
        `visible on the parent record and in their inbox.`,
      );
    }
    if (sharedSession) {
      void prisma.aiChatMessage.create({
        data: {
          sessionId: sharedSession.id,
          role: "assistant",
          content: `Your Intended Parent Form is submitted and shared with ${provider.name}.${isSurrogacy ? " This is what a potential surrogate reviews before your match call." : ""}`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "ip_form_submitted",
          uiCardData: {
            // Provider/admin see the download card; parents read `content`.
            providerContent: `${parentNames} submitted and signed their Intended Parent Form. Download the full PDF${isSurrogacy ? " or the surrogate-safe version" : ""} below.`,
            ipFormResponseId: responseId,
            parentNames,
            surrogateAvailable: isSurrogacy,
          },
        },
      }).catch(() => {});
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
        (isSurrogacy
          ? `You can now download the PDF (with your branding) and share the surrogate version with candidates ahead of a match call.`
          : `You can now download the PDF (with your branding) from your Parent Forms page.`),
      buttons: [{ label: "View and Download the Form", url: formsUrl }],
    });
    await sendEmail(providerUsers.map((u) => u.email).filter(Boolean) as string[], `${parentNames} submitted their Intended Parent Form`, html, brand.companyName).catch(
      (e) => console.error(`[IP FORM NOTIFY] provider email failed: ${e?.message}`),
    );
  }
  console.log(`[IP FORM NOTIFY] Submission ${responseId} announced to ${formProviders.length} form-collecting provider(s)`);
}

/** Photocopy request to a guest parent-2 (no account) with a fresh signing link. */
export async function sendIpFormGuestPhotocopyRequest(params: { email: string; name: string | null; providerName: string; link: string }): Promise<void> {
  try {
    if (isTestEmail(params.email)) {
      console.log(`[IP FORM NOTIFY] Test-data guest photocopy request (${params.email}) - suppressed`);
      return;
    }
    const brand = await fetchEmailBrandData(prisma);
    const html = buildBrandedEmail(brand, {
      title: "Your ID document is needed",
      greeting: `Hi ${esc(getFirstName(params.name) === "there" ? "" : getFirstName(params.name)) || "there"},`,
      body:
        `<strong>${esc(params.providerName)}</strong> needs a photo or scan of your ID document (passport or government ID) to move forward. ` +
        `Use the secure link below to upload it - it only takes a moment and stays private to ${esc(params.providerName)}. No account needed.`,
      buttons: [{ label: "Upload my ID document", url: params.link }],
    });
    await sendEmail([params.email], `Action needed: upload your ID document for ${params.providerName}`, html, brand.companyName);
  } catch (e: any) {
    console.error(`[IP FORM NOTIFY] guest photocopy request failed: ${e?.message}`);
  }
}

/**
 * A supplemental ID photocopy was uploaded after submission - notify the
 * connected providers that require it (in-app + shared chat message).
 */
export async function notifyProvidersPhotocopyUploaded(responseId: string): Promise<void> {
  const response = await prisma.ipFormResponse.findUnique({ where: { id: responseId } });
  if (!response) return;
  const memberUsers = await prisma.user.findMany({
    where: { OR: [{ parentAccountId: response.parentAccountId }, { id: response.parentAccountId }] },
    select: { id: true, name: true },
  });
  const memberIds = memberUsers.map((m) => m.id);
  const nameQ = await prisma.ipFormQuestion.findUnique({ where: { key: "ip_full_legal_name" }, select: { id: true } });
  let names: string[] = [];
  if (nameQ) {
    const rows = await prisma.ipFormAnswer.findMany({ where: { responseId, questionId: nameQ.id, parentSlot: { in: [1, 2] } }, orderBy: { parentSlot: "asc" } });
    names = rows.map((a) => (typeof a.value === "string" ? a.value.trim() : "")).filter(Boolean);
  }
  if (!names.length) names = memberUsers.map((m) => m.name).filter(Boolean) as string[];
  const parentNames = names.join(" & ") || "An intended parent";

  const [sessions, bookings] = await Promise.all([
    prisma.aiChatSession.findMany({ where: { userId: { in: memberIds }, providerId: { not: null } }, select: { providerId: true } }),
    prisma.booking.findMany({ where: { parentUserId: { in: memberIds } }, select: { providerUser: { select: { providerId: true } } } }),
  ]);
  const providerIds = new Set<string>();
  for (const s of sessions) if (s.providerId) providerIds.add(s.providerId);
  for (const b of bookings) if (b.providerUser?.providerId) providerIds.add(b.providerUser.providerId);
  if (!providerIds.size) return;
  const providers = await prisma.provider.findMany({
    where: { id: { in: [...providerIds] }, collectsIntendedParentForm: true, requiresIdPhotocopy: true },
    select: { id: true, name: true },
  });
  for (const provider of providers) {
    const providerUsers = await prisma.user.findMany({ where: { providerId: provider.id, isDisabled: false }, select: { id: true } });
    for (const pu of providerUsers) {
      void prisma.inAppNotification.create({ data: { userId: pu.id, eventType: "IP_FORM_SUBMITTED", payload: { responseId, parentNames } } }).catch(() => {});
    }
    // Same rule as above, and this one carries a photo ID - a passport or
    // driver's licence scan. Strict lookup only; no fallback.
    const sharedSession = await findConnectedProviderSession(memberIds, provider.id);
    if (!sharedSession) {
      console.warn(
        `[ip-form] ${provider.name} has no shared thread with parent account ` +
        `${memberIds[0]} - the ID-document card was not posted.`,
      );
    }
    if (sharedSession) {
      void prisma.aiChatMessage.create({
        data: {
          sessionId: sharedSession.id,
          role: "assistant",
          content: `Your ID document is uploaded and shared with ${provider.name}.`,
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "ip_form_submitted",
          uiCardData: { providerContent: `${parentNames} uploaded the requested ID document. Re-download their Intended Parent Form to get it.`, ipFormResponseId: responseId, parentNames, surrogateAvailable: false },
        },
      }).catch(() => {});
    }
  }
}

/**
 * Supplemental ID-photocopy request to the parent(s): email + SMS + in-app.
 * Fired when a provider that requires the scan connects and it's still missing.
 */
export async function sendIpFormPhotocopyRequest(params: { responseId: string; providerName: string }): Promise<void> {
  const response = await prisma.ipFormResponse.findUnique({ where: { id: params.responseId } });
  if (!response) return;
  const members = await prisma.user.findMany({
    where: { OR: [{ parentAccountId: response.parentAccountId }, { id: response.parentAccountId }] },
    select: { id: true, name: true, email: true, mobileNumber: true },
  });
  if (!members.length) return;
  const formUrl = `${getBaseUrl()}/ip-form?section=private`;

  const brand = await fetchEmailBrandData(prisma);
  const emailTargets = members.map((m) => m.email).filter((e) => e && !isTestEmail(e)) as string[];
  if (emailTargets.length) {
    const html = buildBrandedEmail(brand, {
      title: "One more thing for your Intended Parent Form",
      greeting: `Hi ${esc(getFirstName(members[0]?.name))},`,
      body:
        `<strong>${esc(params.providerName)}</strong> needs a photo or scan of each intended parent's ID document (passport or government ID) before moving forward. ` +
        `Everything else on your form is set - just add the ID document under Private Information and you're done. It stays private to ${esc(params.providerName)}.`,
      buttons: [{ label: "Add my ID document", url: formUrl }],
    });
    await sendEmail(emailTargets, `Action needed: add your ID document for ${params.providerName}`, html, brand.companyName).catch((e) =>
      console.error(`[IP FORM NOTIFY] photocopy email failed: ${e?.message}`),
    );
  }
  for (const m of members) {
    if (m.mobileNumber && !isTestEmail(m.email)) {
      await sendRawSms(
        m.mobileNumber,
        `Hi ${getFirstName(m.name)}, ${params.providerName} needs a copy of each parent's ID document to continue. Add it to your GoStork Intended Parent Form here: ${formUrl}`,
      ).catch((e) => console.error(`[IP FORM NOTIFY] photocopy SMS failed: ${e?.message}`));
    }
    void prisma.inAppNotification
      .create({ data: { userId: m.id, eventType: "IP_FORM_PHOTOCOPY_REQUEST", payload: { responseId: response.id, providerName: params.providerName } } })
      .catch(() => {});
  }
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
    const agencyName = params.providerName || "your surrogacy agency";
    const isKickoff = !params.reminderType;
    // ONE story everywhere - keep in sync with Eva's chat message in
    // ip-form-flow.ts: consultation done -> next milestone is the Match Call
    // with a surrogate -> the agency shares this form so she can decide to
    // meet you -> the form unlocks the match call.
    const storyBody =
      `Here's what comes next on your journey: your <strong>Match Call</strong> - a video call with a surrogate who could be carrying for your family.<br/><br/>` +
      `Before that call can be scheduled, ${esc(agencyName)} needs your Intended Parent Form. This is how a potential surrogate gets to know you - your story, your photos, and a personal letter from you to her. ` +
      `She reads it and decides whether she'd like to meet you, so <strong>this form is what unlocks your match call</strong>.<br/><br/>` +
      `It takes about 20-30 minutes, saves as you go, and both partners can fill their parts in parallel - finish it in as many sittings as you need.`;
    const html = buildBrandedEmail(brand, {
      title: isKickoff ? "One step closer to meeting your surrogate" : "Your Intended Parent Form is still waiting",
      greeting: `Hi ${esc(getFirstName(memberUsers[0]?.name))},`,
      body: isKickoff
        ? `What a milestone - your first call with ${esc(agencyName)} is done!<br/><br/>${storyBody}`
        : `Just a gentle nudge from us - your Intended Parent Form isn't finished yet, and it's the one thing standing between you and your match call.<br/><br/>${storyBody}`,
      buttons: [{ label: isKickoff ? "Start My Form" : "Continue My Form", url: formUrl }],
      footer: "Questions about any part of the form? Ask Eva in your GoStork chat - she can even help you draft your letter.",
    });
    await sendEmail(
      memberUsers.map((m) => m.email).filter(Boolean) as string[],
      isKickoff ? "Your match call is next - one form unlocks it" : "Your match call is waiting on your Intended Parent Form",
      html,
      brand.companyName,
    ).catch((e) => console.error(`[IP FORM NOTIFY] parent email failed: ${e?.message}`));
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
