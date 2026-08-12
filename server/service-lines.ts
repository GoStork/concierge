import { prisma } from "./db";

/**
 * The service line a chat thread belongs to, as the shared enum
 * (SURROGACY / EGG_DONATION / SPERM_DONATION / IVF_CLINIC).
 *
 * Sessions store human subject types ("Egg Donor", "sperm-donor"); every
 * paperwork row downstream - Agreement.serviceType, Invoice.serviceType,
 * ProviderQuote.serviceType - keys on the enum. One resolver for all of them,
 * so a thread cannot be surrogacy on the agreement and egg donation on the
 * quote sent in the same conversation.
 *
 * Lives here rather than in pandadoc-service, where it started: it is not
 * PandaDoc's, it is the platform's answer to "which line is this?".
 */
export async function serviceTypeOfSession(sessionId: string | null | undefined): Promise<string | null> {
  if (!sessionId) return null;
  const s = await prisma.aiChatSession.findUnique({ where: { id: sessionId }, select: { subjectType: true } });
  return serviceTypeOfSubject(s?.subjectType);
}

/** The same mapping, for callers that already hold the subject text. */
export function serviceTypeOfSubject(subjectType: string | null | undefined): string | null {
  const t = (subjectType || "").toLowerCase();
  if (!t) return null;
  if (t.includes("egg")) return "EGG_DONATION";
  if (t.includes("surrog")) return "SURROGACY";
  if (t.includes("sperm")) return "SPERM_DONATION";
  if (t.includes("ivf") || t.includes("clinic") || t.includes("doctor")) return "IVF_CLINIC";
  return null;
}

/**
 * The enum as the record's SCOPE vocabulary.
 *
 * Two vocabularies exist and both are load-bearing: paperwork keys on the enum
 * (Agreement.serviceType, Invoice.serviceType), while the record's filter and
 * the journey timeline key on lowercase line ids. This is the one bridge, so
 * a task raised off an agreement lands in the same lane the filter looks in.
 */
export function serviceLineOfType(serviceType: string | null | undefined): string | null {
  switch (serviceType) {
    case "SURROGACY": return "surrogacy";
    case "EGG_DONATION": return "egg_donation";
    case "SPERM_DONATION": return "sperm_donation";
    case "IVF_CLINIC": return "ivf";
    case "LEGAL": return "legal";
    default: return null;
  }
}

/** The lines a note or task may claim - anything else is stored as null. */
export const SERVICE_LINES = ["surrogacy", "egg_donation", "sperm_donation", "ivf", "legal"] as const;

export function readServiceLine(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  return (SERVICE_LINES as readonly string[]).includes(v) ? v : null;
}
