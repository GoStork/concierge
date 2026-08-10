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
