/**
 * Provider-side notification for a NEWLY PUBLISHED parent review (Phase 8).
 *
 * Emails the coordinator who handled this intended parent (resolved from the
 * account's most recent booking with the provider), CC'ing the provider's
 * admin users, with a direct link to the Performance > Reviews tab where the
 * public reply is written. Uses buildBrandedEmail on SendGrid per the email
 * architecture rule (Twilio is SMS-only in this stack). Also drops an in-app
 * notification for the same users. Fire-and-forget safe; never throws.
 *
 * Privacy: the email shows only the public reviewer label (first name +
 * initial, or "Verified GoStork Parent") - never the parent's full identity.
 * PRIVATE_FEEDBACK reviews must never reach this function.
 */
import { prisma } from "./db";
import { getBaseUrl } from "./src/lib/get-base-url";
import { esc, buildBrandedEmail, fetchEmailBrandData } from "./src/modules/notifications/email-builder";

/**
 * GoStork-admin email when a provider flags a review for re-check. The
 * in-app REVIEW_FLAGGED notification + the admin home "Needs attention" row
 * cover the platform; this makes sure it reaches the inbox too.
 */
export async function notifyAdminsReviewFlagged(params: {
  reviewId: string;
  providerName: string;
  rating: number | null;
  reviewText?: string | null;
  flagReason?: string | null;
}): Promise<void> {
  try {
    // Automated test runs (authors on @gostork-test.com) must not spam real
    // inboxes - log instead of sending.
    const flaggedReview = await prisma.providerReview.findUnique({ where: { id: params.reviewId }, select: { authorUserId: true } });
    if (flaggedReview) {
      const authorRow = await prisma.user.findUnique({ where: { id: flaggedReview.authorUserId }, select: { email: true } });
      if (/@gostork-test\.com$/i.test(authorRow?.email || "")) {
        console.log(`[REVIEW FLAG NOTIFY] Test-data review (${authorRow?.email}) - email suppressed`);
        return;
      }
    }
    const [brand, admins] = await Promise.all([
      fetchEmailBrandData(prisma),
      prisma.user.findMany({
        where: { roles: { hasSome: ["GOSTORK_ADMIN", "GOSTORK_CONCIERGE"] }, isDisabled: false },
        select: { email: true },
      }),
    ]);
    const emails = admins.map((a) => a.email).filter(Boolean);
    if (!emails.length) return;

    const queueUrl = `${getBaseUrl()}/admin/reviews?filter=flagged`;
    const subject = `Review flagged for re-check - ${params.providerName}`;
    const html = buildBrandedEmail(brand, {
      title: "A provider flagged a review",
      greeting: `<strong>${esc(params.providerName)}</strong> asked GoStork to re-check a ${params.rating ?? "?"}-star parent review.`,
      body: [
        params.flagReason ? `<strong>Their reason:</strong> ${esc(params.flagReason)}` : "",
        params.reviewText ? `<strong>The review:</strong> <em>"${esc(params.reviewText)}"</em>` : "",
      ].filter(Boolean).join("<br/><br/>"),
      alertBox: { text: "The review stays published while flagged. Remove it or clear the flag from the review queue.", type: "warning" },
      buttons: [{ label: "Open Review Queue", url: queueUrl }],
    });

    const sendgridKey = process.env.SENDGRID_API_KEY;
    if (sendgridKey) {
      try {
        const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${sendgridKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: emails.map((email) => ({ email })) }],
            from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: brand.companyName },
            subject,
            content: [{ type: "text/html", value: html }],
          }),
        });
        if (!resp.ok) {
          console.error(`[REVIEW FLAG NOTIFY] SendGrid error: ${resp.status} - ${await resp.text()}`);
        } else {
          console.log(`[REVIEW FLAG NOTIFY] Email sent to ${emails.join(", ")}`);
        }
      } catch (e: any) {
        console.error(`[REVIEW FLAG NOTIFY] Email send failed:`, e.message);
      }
    } else {
      console.log(`[REVIEW FLAG NOTIFY EMAIL MOCK] To: ${emails.join(", ")}, Subject: ${subject}`);
    }
  } catch (e: any) {
    console.error(`[REVIEW FLAG NOTIFY] failed: ${e?.message}`);
  }
}

/**
 * Provider-side notification when GoStork resolves a review (admin removed
 * it, kept it after a flag re-check, or republished a removed one). Email to
 * the coordinator + provider admins, plus in-app rows. Test-data suppressed.
 */
export async function notifyProviderReviewOutcome(params: {
  reviewId: string;
  providerId: string;
  authorUserId: string;
  rating: number | null;
  outcome: "removed" | "kept" | "republished";
  wasFlagged: boolean;
}): Promise<void> {
  try {
    const [brand, author] = await Promise.all([
      fetchEmailBrandData(prisma),
      prisma.user.findUnique({ where: { id: params.authorUserId }, select: { parentAccountId: true, email: true } }),
    ]);
    const isTestData = /@gostork-test\.com$/i.test(author?.email || "");

    const memberIds = author?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: author.parentAccountId }, select: { id: true } })).map((u) => u.id)
      : [params.authorUserId];
    const lastBooking = await prisma.booking.findFirst({
      where: { parentUserId: { in: memberIds }, providerUser: { providerId: params.providerId } },
      orderBy: { scheduledAt: "desc" },
      select: { providerUser: { select: { id: true, email: true } } },
    });
    const coordinator = lastBooking?.providerUser || null;
    const admins = await prisma.user.findMany({
      where: { providerId: params.providerId, roles: { has: "PROVIDER_ADMIN" }, isDisabled: false },
      select: { id: true, email: true },
    });

    const r = params.rating ?? "?";
    const copy = params.outcome === "removed"
      ? {
          eventType: "REVIEW_REMOVED",
          subject: params.wasFlagged ? "Flag resolved - review removed" : "GoStork removed a parent review",
          title: params.wasFlagged ? "Your flag was resolved" : "A review was removed",
          greeting: params.wasFlagged
            ? `Following your flag, GoStork re-checked the ${r}-star review and <strong>removed it</strong>.`
            : `GoStork removed a ${r}-star parent review from your profile after moderation.`,
          alert: { text: "The review no longer appears on your profile and no longer affects your rating.", type: "info" as const },
        }
      : params.outcome === "kept"
      ? {
          eventType: "REVIEW_KEPT",
          subject: "Flag resolved - review stays published",
          title: "Your flag was resolved",
          greeting: `GoStork re-checked the ${r}-star review you flagged and found it consistent with our verified-review policy, so it <strong>stays published</strong>.`,
          alert: { text: "A thoughtful public reply is often the strongest response - you can post one from your Reviews tab.", type: "info" as const },
        }
      : {
          eventType: "REVIEW_REPUBLISHED",
          subject: "A removed review was restored",
          title: "A review is published again",
          greeting: `A previously removed ${r}-star parent review was restored by GoStork and is <strong>published again</strong> on your profile.`,
          alert: { text: "You can reply publicly or flag it for another re-check from your Reviews tab.", type: "info" as const },
        };

    const reviewUrl = `${getBaseUrl()}/performance?tab=reviews`;
    const to = coordinator?.email || admins[0]?.email;
    const cc = to ? admins.map((a) => a.email).filter((e) => e && e.toLowerCase() !== to.toLowerCase()) : [];

    const sendgridKey = process.env.SENDGRID_API_KEY;
    if (isTestData) {
      console.log(`[REVIEW OUTCOME NOTIFY] Test-data review - email suppressed (${params.outcome})`);
    } else if (to && sendgridKey) {
      const html = buildBrandedEmail(brand, {
        title: copy.title,
        greeting: copy.greeting,
        body: "",
        alertBox: copy.alert,
        buttons: [{ label: "Open Reviews", url: reviewUrl }],
      });
      try {
        const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${sendgridKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to }], ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}) }],
            from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: brand.companyName },
            subject: copy.subject,
            content: [{ type: "text/html", value: html }],
          }),
        });
        if (!resp.ok) console.error(`[REVIEW OUTCOME NOTIFY] SendGrid error: ${resp.status} - ${await resp.text()}`);
        else console.log(`[REVIEW OUTCOME NOTIFY] ${params.outcome} email sent to ${to}${cc.length ? ` (cc: ${cc.join(", ")})` : ""}`);
      } catch (e: any) {
        console.error(`[REVIEW OUTCOME NOTIFY] Email send failed:`, e.message);
      }
    } else if (to) {
      console.log(`[REVIEW OUTCOME NOTIFY EMAIL MOCK] To: ${to}, Subject: ${copy.subject}`);
    }

    // In-app rows always fire (even for test data - they're cheap and scoped).
    const notifyIds = Array.from(new Set([coordinator?.id, ...admins.map((a) => a.id)].filter(Boolean))) as string[];
    for (const uid of notifyIds) {
      await prisma.inAppNotification.create({
        data: {
          userId: uid,
          eventType: copy.eventType,
          payload: { reviewId: params.reviewId, providerId: params.providerId, rating: params.rating, message: copy.subject },
        },
      }).catch(() => {});
    }
  } catch (e: any) {
    console.error(`[REVIEW OUTCOME NOTIFY] failed: ${e?.message}`);
  }
}

export async function notifyProviderNewReview(params: {
  reviewId: string;
  providerId: string;
  authorUserId: string;
  reviewerLabel: string;
  rating: number;
  text?: string | null;
  memberName?: string | null;
}): Promise<void> {
  try {
    const [brand, provider, author] = await Promise.all([
      fetchEmailBrandData(prisma),
      prisma.provider.findUnique({ where: { id: params.providerId }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: params.authorUserId }, select: { parentAccountId: true, email: true } }),
    ]);
    if (!provider) return;
    // Automated test runs must not spam real coordinator inboxes.
    if (/@gostork-test\.com$/i.test(author?.email || "")) {
      console.log(`[REVIEW NOTIFY] Test-data review (${author?.email}) - email suppressed`);
      return;
    }

    // Coordinator = the provider user on the account's most recent booking
    // with this provider ("the coordinator handling that IP").
    const memberIds = author?.parentAccountId
      ? (await prisma.user.findMany({ where: { parentAccountId: author.parentAccountId }, select: { id: true } })).map((u) => u.id)
      : [params.authorUserId];
    const lastBooking = await prisma.booking.findFirst({
      where: { parentUserId: { in: memberIds }, providerUser: { providerId: params.providerId } },
      orderBy: { scheduledAt: "desc" },
      select: { providerUser: { select: { id: true, email: true, name: true } } },
    });
    const coordinator = lastBooking?.providerUser || null;

    const admins = await prisma.user.findMany({
      where: { providerId: params.providerId, roles: { has: "PROVIDER_ADMIN" }, isDisabled: false },
      select: { id: true, email: true },
    });

    const to = coordinator?.email || admins[0]?.email;
    if (!to) {
      console.warn(`[REVIEW NOTIFY] No coordinator or admin email for provider ${params.providerId} - skipping email`);
      return;
    }
    const cc = admins.map((a) => a.email).filter((e) => e && e.toLowerCase() !== to.toLowerCase());

    const reviewUrl = `${getBaseUrl()}/performance?tab=reviews`;
    const stars = "★".repeat(params.rating) + "☆".repeat(Math.max(0, 5 - params.rating));
    const subject = `New ${params.rating}-star parent review for ${provider.name}`;
    const html = buildBrandedEmail(brand, {
      title: "You received a new parent review",
      greeting: `<strong>${esc(params.reviewerLabel)}</strong> just reviewed ${esc(provider.name)}${params.memberName ? ` (about ${esc(params.memberName)})` : ""}: <strong>${stars}</strong>`,
      body: params.text ? `<em>"${esc(params.text)}"</em>` : "",
      alertBox: { text: "A thoughtful public reply shows prospective families how you engage - you can post one response per review.", type: "info" },
      buttons: [{ label: "Read & Reply", url: reviewUrl }],
    });

    const sendgridKey = process.env.SENDGRID_API_KEY;
    if (sendgridKey) {
      try {
        const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${sendgridKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to }], ...(cc.length ? { cc: cc.map((email) => ({ email })) } : {}) }],
            from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: brand.companyName },
            subject,
            content: [{ type: "text/html", value: html }],
          }),
        });
        if (!resp.ok) {
          console.error(`[REVIEW NOTIFY] SendGrid error: ${resp.status} - ${await resp.text()}`);
        } else {
          console.log(`[REVIEW NOTIFY] Email sent to ${to}${cc.length ? ` (cc: ${cc.join(", ")})` : ""}`);
        }
      } catch (e: any) {
        console.error(`[REVIEW NOTIFY] Email send failed:`, e.message);
      }
    } else {
      console.log(`[REVIEW NOTIFY EMAIL MOCK] To: ${to}, CC: ${cc.join(", ") || "-"}, Subject: ${subject}`);
    }

    // In-app notification for the same people (coordinator + admins).
    const notifyIds = Array.from(new Set([coordinator?.id, ...admins.map((a) => a.id)].filter(Boolean))) as string[];
    for (const uid of notifyIds) {
      await prisma.inAppNotification.create({
        data: {
          userId: uid,
          eventType: "REVIEW_RECEIVED",
          payload: {
            reviewId: params.reviewId,
            providerId: params.providerId,
            rating: params.rating,
            message: `${params.reviewerLabel} left a ${params.rating}-star review - reply from Performance > Reviews.`,
          },
        },
      }).catch(() => {});
    }
  } catch (e: any) {
    console.error(`[REVIEW NOTIFY] failed: ${e?.message}`);
  }
}
