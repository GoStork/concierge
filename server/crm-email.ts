/**
 * Minimal branded email send for CRM router events (e.g. #7 @mention).
 *
 * The rich NotificationService lives in the Nest layer; this Express router
 * needs a small, self-contained sender for internal staff notifications. Same
 * SendGrid path as sendRawEmail, env-gated - a missing key logs a mock rather
 * than throwing, so a note is never blocked on email.
 */
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export async function sendCrmEmail(to: string, subject: string, html: string): Promise<void> {
  const key = process.env.SENDGRID_API_KEY;
  if (!key || !to) {
    console.log(`[crm-email MOCK] To: ${to}, Subject: ${subject}`);
    return;
  }
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.SENDGRID_FROM_EMAIL || "noreply@gostork.com", name: "GoStork" },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    if (!res.ok) console.warn(`[crm-email] SendGrid ${res.status} for ${to}`);
  } catch (e: any) {
    console.warn(`[crm-email] send failed for ${to}: ${e?.message}`);
  }
}

/** A plain, readable internal email for a colleague who was @mentioned. */
export function mentionEmailHtml(params: { mentioner: string; parentName: string; noteText: string; url: string }): string {
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;">
      <h2 style="font-size:18px;">${esc(params.mentioner)} mentioned you</h2>
      <p style="color:#4b5563;">on <strong>${esc(params.parentName)}</strong>'s record:</p>
      <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #08726F;background:#f9fafb;color:#374151;">
        ${esc(params.noteText).slice(0, 600)}
      </blockquote>
      <p><a href="${esc(params.url)}" style="display:inline-block;background:#08726F;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;">Open the record</a></p>
    </div>`;
}
