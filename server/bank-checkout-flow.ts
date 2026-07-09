/**
 * Bank skip-to-checkout - Eva-side card (Phase 6).
 *
 * Eva emits [[BANK_CHECKOUT:DONOR_ID]] when a parent shows purchase intent
 * on an egg/sperm BANK donor. ai-router strips the tag and calls
 * postBankCheckoutCard, which posts a "bank_checkout" card into the Eva
 * session: donor summary + published price + a Buy button. The button hits
 * POST /api/bank-checkout (BillingService.bankCheckout), which creates the
 * 3-way bank session, posts the cost sheet, and auto-fires the invoice.
 *
 * Honest failures: donor not found, provider not a bank, or no published
 * total cost all post a plain-text explanation instead of a card - never a
 * fabricated price.
 */
import { prisma } from "./db";

const BANK_TYPE_BY_DONOR: Record<string, string> = {
  "egg-donor": "Egg Bank",
  "sperm-donor": "Sperm Bank",
};

/** Finds the donor in either bank donor table. */
export async function resolveBankDonor(donorId: string): Promise<
  | { donorType: "egg-donor" | "sperm-donor"; donor: { id: string; firstName: string | null; externalId: string | null; totalCost: number | null; photos: string[]; providerId: string } }
  | null
> {
  const egg = await prisma.eggDonor.findUnique({
    where: { id: donorId },
    select: { id: true, firstName: true, externalId: true, totalCost: true, photos: true, providerId: true },
  });
  if (egg) return { donorType: "egg-donor", donor: egg };
  const sperm = await prisma.spermDonor.findUnique({
    where: { id: donorId },
    select: { id: true, firstName: true, externalId: true, totalCost: true, photos: true, providerId: true },
  });
  if (sperm) return { donorType: "sperm-donor", donor: sperm };
  return null;
}

export async function postBankCheckoutCard(sessionId: string, donorId: string): Promise<void> {
  const postNote = (content: string) =>
    prisma.aiChatMessage.create({
      data: { sessionId, role: "assistant", content, senderType: "ai" },
    });

  const resolved = await resolveBankDonor(donorId.trim());
  if (!resolved) {
    console.error(`[BANK_CHECKOUT] Donor ${donorId} not found - no card posted`);
    return;
  }
  const { donorType, donor } = resolved;
  const bankTypeName = BANK_TYPE_BY_DONOR[donorType];

  const provider = await prisma.provider.findUnique({
    where: { id: donor.providerId },
    select: { id: true, name: true, services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } },
  });
  const isBank = !!provider?.services.some(sv => sv.providerType?.name === bankTypeName);
  const donorLabel = [donor.firstName, donor.externalId ? `#${donor.externalId}` : null].filter(Boolean).join(" ") || "this donor";

  if (!provider || !isBank) {
    // Agency donor - the match process applies; Eva should not offer checkout.
    await postNote(
      `${donorLabel} is represented by ${provider?.name || "an agency"}, so the direct checkout isn't available - I'll guide you through their process instead.`,
    );
    return;
  }

  const priceCents = donor.totalCost != null ? Math.round(Number(donor.totalCost) * 100) : null;
  if (!priceCents || priceCents <= 0) {
    await postNote(
      `${provider.name} hasn't published a total cost for ${donorLabel} yet, so I can't start checkout. I can ask them for pricing - want me to?`,
    );
    return;
  }

  await prisma.aiChatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content: `${donorLabel} from ${provider.name} is available for direct checkout.`,
      senderType: "ai",
      uiCardType: "bank_checkout",
      uiCardData: {
        donorId: donor.id,
        donorType,
        providerId: provider.id,
        providerName: provider.name,
        donorLabel,
        photoUrl: donor.photos?.[0] || null,
        priceCents,
      },
    },
  });
}
