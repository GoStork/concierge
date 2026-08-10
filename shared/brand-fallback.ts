/**
 * The one brand-primary literal in the codebase.
 *
 * Everything that paints the brand reads the LIVE colour - the client from
 * /api/brand/settings, the server from SiteSettings. This constant is only
 * ever the last resort: the split second before the client's fetch resolves,
 * or a server render where the settings row could not be read.
 *
 * It exists because that fallback used to be typed by hand at 29 call sites,
 * and they had drifted onto TWO retired greens - #26584A and #004D4D. A
 * provider with no brand colour of their own was sending payment requests in
 * a green GoStork stopped using, and nobody could see it from the code,
 * because each site looked like a reasonable local default.
 *
 * KEEP IN SYNC with the pre-JS fallbacks when the brand changes: the `--primary`
 * HSL in client/src/index.css and BRAND_DEFAULTS in use-brand-settings.ts (which
 * imports this). See the brand section of CLAUDE.md.
 */
export const BRAND_PRIMARY_FALLBACK = "#08726F";
