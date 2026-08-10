import { prisma as defaultPrisma } from "./db";
import { BRAND_PRIMARY_FALLBACK } from "../shared/brand-fallback";

/**
 * GoStork's live primary colour, for server-rendered documents.
 *
 * The client gets this from /api/brand/settings; anything rendered on the
 * server - an invoice document, a receipt PDF - has to read SiteSettings
 * itself. Doing that (rather than typing a hex) is what makes these surfaces
 * follow a rebrand instead of quietly keeping the colour they were written
 * with.
 *
 * Never throws: a document must still render if the settings row is
 * unreadable, just in the fallback colour.
 */
export async function platformPrimaryColor(db?: any): Promise<string> {
  try {
    const settings = await (db || defaultPrisma).siteSettings.findFirst({
      select: { primaryColor: true },
    });
    return settings?.primaryColor || BRAND_PRIMARY_FALLBACK;
  } catch {
    return BRAND_PRIMARY_FALLBACK;
  }
}

export { BRAND_PRIMARY_FALLBACK };
