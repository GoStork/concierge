import { getBaseUrl } from "../../lib/get-base-url";
import { BRAND_PRIMARY_FALLBACK } from "../../../../shared/brand-fallback";

/**
 * Shared branded-email builder. EVERY email sent by the platform must be
 * rendered through buildBrandedEmail() with brand data from
 * fetchEmailBrandData() - never hand-roll email HTML (hand-rolled emails
 * bypass the GCS logo signing below and ship a broken logo image).
 */

export function esc(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Mix a hex color toward white by a given ratio (0 = original, 1 = white) */
function tintHex(hex: string, ratio: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const tr = Math.round(r + (255 - r) * ratio);
  const tg = Math.round(g + (255 - g) * ratio);
  const tb = Math.round(b + (255 - b) * ratio);
  return `#${tr.toString(16).padStart(2, "0")}${tg.toString(16).padStart(2, "0")}${tb.toString(16).padStart(2, "0")}`;
}

/**
 * Build a safe CSS font stack from a brand font setting. The DB value may be
 * a plain font name ("DM Sans") OR a full CSS stack pasted from the UI
 * ('-apple-system, BlinkMacSystemFont, "SF Pro Text", ...'). Full stacks must
 * be used as-is, and double quotes must be normalized to single quotes -
 * these strings are injected into double-quoted style="" attributes, where an
 * embedded double quote terminates the attribute and silently destroys every
 * declaration after it.
 */
function toFontStack(font: string, fallback: string): string {
  const cleaned = (font || "").replace(/"/g, "'").trim();
  if (!cleaned) return fallback;
  if (cleaned.includes(",")) return cleaned;
  return `'${cleaned}',${fallback}`;
}

/** Darken a hex color by a given ratio (0 = original, 1 = black) */
function shadeHex(hex: string, ratio: number): string {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const r = Math.round(parseInt(m[1].slice(0, 2), 16) * (1 - ratio));
  const g = Math.round(parseInt(m[1].slice(2, 4), 16) * (1 - ratio));
  const b = Math.round(parseInt(m[1].slice(4, 6), 16) * (1 - ratio));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Load brand settings for email rendering. Resolves the header logo with
 * dark-background priority (dark icon > light icon > dark full > light full)
 * and signs GCS-hosted logo URLs so email clients can load them - the bucket
 * uses uniform bucket-level access, so the raw URL returns AccessDenied.
 * Uncached; NotificationService wraps this with a TTL cache.
 */
export async function fetchEmailBrandData(prisma: { siteSettings: { findFirst: () => Promise<any> } }): Promise<Record<string, string>> {
  const defaults: Record<string, string> = {
    brandColor: BRAND_PRIMARY_FALLBACK,
    primaryForegroundColor: "#ffffff",
    secondaryColor: "#F0FAF5",
    accentColor: "#0DA4EA",
    successColor: "#16a34a",
    warningColor: "#f59e0b",
    errorColor: "#ef4444",
    foregroundColor: "#0A0A0A",
    mutedForegroundColor: "#737373",
    backgroundColor: "#ffffff",
    cardColor: "#ffffff",
    borderColor: "#e5e5e5",
    companyName: "GoStork",
    logoUrl: "",
    headingFont: "Playfair Display",
    bodyFont: "DM Sans",
    buttonRadius: "8px",
    containerRadius: "12px",
    headingFontStack: "'Playfair Display',Georgia,serif",
    bodyFontStack: "'DM Sans',Arial,sans-serif",
  };
  try {
    const settings = await prisma.siteSettings.findFirst();
    if (settings) {
      const s = settings as any;
      defaults.brandColor = s.primaryColor || defaults.brandColor;
      defaults.secondaryColor = s.secondaryColor || defaults.secondaryColor;
      defaults.accentColor = s.accentColor || defaults.accentColor;
      defaults.successColor = s.successColor || defaults.successColor;
      defaults.warningColor = s.warningColor || defaults.warningColor;
      defaults.errorColor = s.errorColor || defaults.errorColor;
      defaults.companyName = (s.companyName || defaults.companyName).trim();
      // Email header has a dark (brandColor) background - prefer dark-mode icon logo.
      // Priority: dark icon > light icon > dark full > light full
      const rawLogo = s.darkLogoUrl || s.logoUrl || s.darkLogoWithNameUrl || s.logoWithNameUrl || "";
      const imageBaseUrl = getBaseUrl();
      let logoUrl = rawLogo && rawLogo.startsWith("/") ? `${imageBaseUrl}${rawLogo}` : rawLogo;
      // GCS bucket uses uniform bucket-level access - objects are private.
      // Generate a short-lived signed URL so email clients can load the logo directly.
      if (logoUrl && logoUrl.includes("storage.googleapis.com")) {
        try {
          const { Storage } = await import("@google-cloud/storage");
          const keyJson = process.env.GCS_SERVICE_ACCOUNT_KEY;
          if (keyJson) {
            const credentials = JSON.parse(keyJson);
            const storage = new Storage({ credentials });
            const bucketName = process.env.GCS_BUCKET_NAME || "gostork-recordings";
            const urlObj = new URL(logoUrl);
            const objectPath = decodeURIComponent(urlObj.pathname.slice(`/${bucketName}/`.length));
            const [signed] = await storage.bucket(bucketName).file(objectPath).getSignedUrl({
              action: "read",
              expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
            });
            logoUrl = signed;
          }
        } catch {
          // fall back to raw URL if signing fails
        }
      }
      defaults.logoUrl = logoUrl;
      defaults.primaryForegroundColor = s.primaryForegroundColor || defaults.primaryForegroundColor;
      defaults.foregroundColor = s.foregroundColor || defaults.foregroundColor;
      defaults.mutedForegroundColor = s.mutedForegroundColor || defaults.mutedForegroundColor;
      defaults.backgroundColor = s.backgroundColor || defaults.backgroundColor;
      defaults.cardColor = s.cardColor || defaults.cardColor;
      defaults.borderColor = s.borderColor || defaults.borderColor;
      defaults.headingFont = s.headingFont || defaults.headingFont;
      defaults.bodyFont = s.bodyFont || defaults.bodyFont;
      const borderRadiusRem = typeof s.borderRadius === "number" ? s.borderRadius : 0.5;
      if (borderRadiusRem <= 0) defaults.buttonRadius = "0px";
      else if (borderRadiusRem <= 0.125) defaults.buttonRadius = "2px";
      else if (borderRadiusRem <= 0.25) defaults.buttonRadius = "4px";
      else if (borderRadiusRem <= 0.5) defaults.buttonRadius = "8px";
      else if (borderRadiusRem <= 0.75) defaults.buttonRadius = "12px";
      else defaults.buttonRadius = "9999px";
      const containerRadiusRem = typeof s.containerRadius === "number" ? s.containerRadius : 0.75;
      defaults.containerRadius = `${Math.round(containerRadiusRem * 16)}px`;
      defaults.headingFontStack = toFontStack(defaults.headingFont, "Georgia,serif");
      defaults.bodyFontStack = toFontStack(defaults.bodyFont, "Arial,sans-serif");
    }
  } catch {
  }
  return defaults;
}

export function buildBrandedEmail(
  brand: Record<string, string>,
  opts: {
    title: string;
    greeting: string;
    body: string;
    detailRows?: { label: string; value: string }[];
    buttons?: { label: string; url: string; variant?: "primary" | "secondary" | "destructive" }[];
    footer?: string;
    alertBox?: { text: string; type: "warning" | "success" | "info" | "error" };
  },
): string {
  const btnRadius = brand.buttonRadius || "8px";
  const btnColor = (v?: string) => {
    if (v === "destructive") return brand.errorColor;
    if (v === "secondary") return "transparent";
    return brand.brandColor;
  };
  const btnTextColor = (v?: string) => {
    if (v === "secondary") return brand.brandColor;
    return brand.primaryForegroundColor;
  };
  const btnBorder = (v?: string) => {
    if (v === "secondary") return `2px solid ${brand.brandColor}`;
    return "none";
  };

  const alertBg: Record<string, string> = {
    warning: tintHex(brand.warningColor, 0.9),
    success: tintHex(brand.successColor, 0.9),
    info: brand.secondaryColor,
    error: tintHex(brand.errorColor, 0.9),
  };
  const alertBorderColor: Record<string, string> = { warning: brand.warningColor, success: brand.successColor, info: brand.accentColor, error: brand.errorColor };
  const alertTextColor: Record<string, string> = {
    warning: shadeHex(brand.warningColor, 0.4),
    success: shadeHex(brand.successColor, 0.4),
    info: brand.brandColor,
    error: shadeHex(brand.errorColor, 0.4),
  };

  // Date/Time values must never wrap onto a second line. The label column is
  // sized to its content (white-space:nowrap, no fixed width) so the value
  // column keeps the maximum room even on a narrow phone; date/time values get
  // an explicit nowrap so "Friday, July 24, 2026" and "11:30 AM PST" stay on
  // one line, while long values (names, notes) still break normally.
  // The detail table sits on the CARD colour, not a tint of the page colour.
  // It used to be cream-on-white, which read as a panel bolted into the middle
  // of the email; the row separators already give it structure, so the tint was
  // doing nothing but adding a second surface colour. Same reason the page
  // behind the email is now white: brand colour belongs in the header band and
  // the alert boxes, not smeared across every surface.
  const detailsHtml = opts.detailRows?.length
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:${brand.cardColor};border-radius:${brand.containerRadius};overflow:hidden;">
${opts.detailRows.map(r => {
  const isDateTime = /\b(date|time)\b/i.test(r.label);
  const valueWrap = isDateTime ? "white-space:nowrap;" : "word-break:break-word;";
  return `<tr><td style="padding:10px 14px;color:${brand.mutedForegroundColor};font-size:15px;font-family:${brand.bodyFontStack};border-bottom:1px solid ${brand.borderColor};white-space:nowrap;vertical-align:top;">${r.label}</td><td style="padding:10px 14px;color:${brand.foregroundColor};font-size:15px;font-family:${brand.bodyFontStack};border-bottom:1px solid ${brand.borderColor};font-weight:500;${valueWrap}">${r.value}</td></tr>`;
}).join("\n")}
</table>` : "";

  const alertHtml = opts.alertBox
    ? `<div style="background:${alertBg[opts.alertBox.type]};border-left:4px solid ${alertBorderColor[opts.alertBox.type]};padding:14px 16px;border-radius:4px;margin:16px 0;font-size:15px;font-family:${brand.bodyFontStack};color:${alertTextColor[opts.alertBox.type]};">${opts.alertBox.text}</div>` : "";

  // Buttons stack vertically by default (one per row, centered). Never place
  // them side by side: two buttons exceed a phone's viewport width, which
  // widens the layout viewport and defeats the max-width media query that
  // would have stacked them - the email then renders zoomed-out and tiny.
  const buttonsHtml = opts.buttons?.length
    ? `<table class="email-btns" cellpadding="0" cellspacing="0" style="margin:20px auto;" align="center">${opts.buttons.map(b =>
        `<tr><td align="center" style="padding:6px 0;"><table class="email-btn" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:${btnColor(b.variant)};border-radius:${btnRadius};border:${btnBorder(b.variant)};"><a class="email-btn-a" href="${b.url}" style="display:inline-block;padding:14px 32px;color:${btnTextColor(b.variant)};text-decoration:none;font-weight:600;font-size:16px;font-family:${brand.bodyFontStack};">${b.label}</a></td></tr></table></td></tr>`
      ).join("")}</table>` : "";

  const footerHtml = opts.footer ? `<p style="color:${brand.mutedForegroundColor};font-size:13px;line-height:1.5;margin:24px 0 0;padding-top:16px;border-top:1px solid ${brand.borderColor};font-family:${brand.bodyFontStack};">${opts.footer}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
:root { color-scheme: light; }
body { color-scheme: light; }
[data-ogsc] .og-dark { display: none !important; }
@media only screen and (max-width: 480px) {
  td.email-content { padding: 28px 20px !important; }
  table.email-btns { width: 100% !important; }
  table.email-btn { width: 100% !important; }
  a.email-btn-a { display: block !important; text-align: center !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${brand.cardColor};font-family:${brand.bodyFontStack};color-scheme:light;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:${brand.cardColor};">
<tr><td align="center" style="padding:32px 16px;">
<!--[if mso]><table width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:${brand.cardColor};border-radius:${brand.containerRadius};overflow:hidden;">
<tr><td style="background-color:${brand.brandColor} !important;padding:30px;text-align:center;mso-padding-alt:0px;">
${brand.logoUrl ? `<img src="${brand.logoUrl}" alt="${esc(brand.companyName)}" style="max-height:40px;margin-bottom:8px;" />` : ""}
<h1 style="color:${brand.primaryForegroundColor};font-family:${brand.headingFontStack};font-size:24px;margin:0;">${esc(brand.companyName)}</h1>
</td></tr>
<tr><td class="email-content" style="padding:40px 30px;">
<h2 style="color:${brand.brandColor};font-size:26px;margin:0 0 16px;font-family:${brand.headingFontStack};">${opts.title}</h2>
<p style="color:${brand.foregroundColor};font-size:16px;line-height:1.6;font-family:${brand.bodyFontStack};margin:0 0 12px;">${opts.greeting}</p>
<div style="color:${brand.foregroundColor};font-size:16px;line-height:1.6;font-family:${brand.bodyFontStack};margin:0 0 16px;">${opts.body}</div>
${detailsHtml}
${alertHtml}
${buttonsHtml}
${footerHtml}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}
