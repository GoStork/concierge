import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { pickCostSheet, type ProviderCostSheetLite, type MatchContext } from "./cost-sheet-matcher";
import { extractFromChatMessages } from "./cost-sheet-chat-extractor";

// Phase 2 cost-sheet auto-draft. Fires synchronously-fire-and-forget on
// Booking creation. Drops an inline approval card (uiCardType =
// "cost_sheet_draft_approval") in the PROVIDER's session chat. The card
// is invisible to the parent via chat-router.ts's existing
// uiCardType notIn filter (extended in Phase 2 step 10).
//
// Two-gate feature flag:
//   Gate 1 (global):  ConciergePromptSection.isActive=true for key
//                     "auto_cost_sheet_on_booking"
//   Gate 2 (per-provider): Provider.autoFeaturesEnabled.autoCostSheetDraft === true
//
// Both must be true. If either is false, the auto-draft silently skips
// and existing manual flow is unchanged.

interface AutoDraftResult {
  status: "drafted" | "skipped";
  reason?: string;
  messageId?: string;
}

interface LineItemDraft {
  label: string;
  amountCents: number;
  editable?: boolean;
  source?: string; // "template" | "chat.surrogateCompCents" | "chat.donorCompCents"
}

@Injectable()
export class CostSheetAutoDraftService {
  private readonly logger = new Logger(CostSheetAutoDraftService.name);

  constructor(private readonly prisma: PrismaService) {}

  async tryAutoDraftForBooking(bookingId: string): Promise<AutoDraftResult> {
    try {
      // 1. Load booking + provider + parent
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          providerUser: {
            select: {
              providerId: true,
              provider: {
                select: { id: true, name: true, autoFeaturesEnabled: true },
              },
            },
          },
          parentUser: { select: { id: true, parentAccountId: true } },
        },
      });
      if (!booking) return this.skip("booking_not_found");
      if (!booking.parentUserId || !booking.parentUser) return this.skip("no_parent_user");
      const providerId = booking.providerUser?.providerId;
      if (!providerId) return this.skip("no_provider");

      // 2. Gate 2 (per-provider)
      const autoFeatures = (booking.providerUser?.provider as any)?.autoFeaturesEnabled || {};
      if (autoFeatures?.autoCostSheetDraft !== true) {
        return this.skip("provider_opted_out");
      }

      // 3. Gate 1 (global)
      const gate1 = await this.prisma.conciergePromptSection.findUnique({
        where: { key: "auto_cost_sheet_on_booking" },
        select: { isActive: true },
      });
      if (!gate1?.isActive) return this.skip("prompt_section_inactive");

      // 4. Find the (parent, provider) AiChatSession - we drop the card there.
      const session = await this.prisma.aiChatSession.findFirst({
        where: {
          userId: booking.parentUserId,
          providerId,
          status: { in: ["ACTIVE", "CONSULTATION_BOOKED", "PROVIDER_CONNECTED", "HUMAN_JOINED"] },
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      if (!session) return this.skip("no_chat_session");

      // 5. Idempotency: don't re-draft if we already have an unresolved card
      // or a real ProviderQuote on this session.
      const existingQuote = await this.prisma.providerQuote.findFirst({
        where: { sessionId: session.id, supersededAt: null },
        select: { id: true },
      });
      if (existingQuote) return this.skip("quote_already_exists");

      const existingDraft = await this.prisma.aiChatMessage.findFirst({
        where: {
          sessionId: session.id,
          uiCardType: "cost_sheet_draft_approval",
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, uiCardData: true },
      });
      if (existingDraft) {
        const data = (existingDraft.uiCardData as any) || {};
        if (!data.resolvedAt) {
          return this.skip("draft_already_pending");
        }
      }

      // 6. Load IntendedParentProfile (the matcher needs it).
      const profile = booking.parentUser.parentAccountId
        ? await this.prisma.intendedParentProfile.findUnique({
            where: { parentAccountId: booking.parentUser.parentAccountId },
          })
        : null;
      if (!profile) return this.skip("no_intended_parent_profile");

      // 7. Load approved cost sheets for this provider.
      const sheets = await this.prisma.providerCostSheet.findMany({
        where: { providerId, status: "APPROVED" },
        include: { items: true },
      });
      if (sheets.length === 0) return this.skip("no_approved_cost_sheets");

      // 8. Extract chat context (last 50 messages).
      const recentMsgs = await this.prisma.aiChatMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { content: true },
      });
      const chat = extractFromChatMessages(recentMsgs.reverse());

      // 9. Pick the right cost sheet.
      const matcherCtx: MatchContext = { profile: profile as any, chat };
      const matcherSheets: ProviderCostSheetLite[] = sheets.map(s => ({
        id: s.id,
        status: s.status,
        matchingRules: (s.matchingRules as any) || null,
        updatedAt: s.updatedAt,
        category: s.category,
        description: s.description,
        lineItemTemplate: s.lineItemTemplate,
      }));
      const { picked, ranked } = pickCostSheet(matcherSheets, matcherCtx);
      if (!picked) return this.skip("no_matching_sheet");

      // 10. Build line items from template + chat extractions.
      const lineItems = this.buildLineItems(picked, chat);
      const totalCostCents = lineItems.reduce((sum, li) => sum + (li.amountCents || 0), 0);
      if (totalCostCents <= 0) return this.skip("zero_total_cost");

      // 11. Insert the approval card.
      const card = await this.prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: "Auto-drafted cost sheet ready for review.",
          senderType: "system",
          senderName: "GoStork",
          uiCardType: "cost_sheet_draft_approval",
          uiCardData: {
            sourceCostSheetId: picked.id,
            sourceCostSheetCategory: (picked as any).category || null,
            lineItems,
            totalCostCents,
            notes: null,
            matchedRuleCount: ranked[0]?.matchedRuleCount ?? 0,
            candidates: ranked.slice(0, 3).map(c => ({
              costSheetId: c.costSheet.id,
              category: (c.costSheet as any).category || null,
              matchedRuleCount: c.matchedRuleCount,
            })),
            chatExtractions: chat,
            autoDraftedAt: new Date().toISOString(),
            resolvedAt: null,
            resolvedAs: null,
          },
        },
      });

      this.logger.log(
        `Auto-draft drafted: booking=${bookingId} session=${session.id} sheet=${picked.id} total=$${(totalCostCents / 100).toFixed(2)}`,
      );
      return { status: "drafted", messageId: card.id };
    } catch (err: any) {
      this.logger.warn(`Auto-draft error for booking ${bookingId}: ${err.message}`);
      return this.skip("error:" + (err.message || "unknown"));
    }
  }

  private skip(reason: string): AutoDraftResult {
    this.logger.log(`Auto-draft skipped: ${reason}`);
    return { status: "skipped", reason };
  }

  // Build line items from the picked cost sheet's lineItemTemplate, then
  // substitute dynamic values from chat extractions. Template shape:
  //   [{ label: string, amountCents?: number, dynamicSource?: string, editable?: boolean }]
  // If no template, fall back to the sheet's CostItem rows (existing model).
  private buildLineItems(
    sheet: ProviderCostSheetLite & { lineItemTemplate?: unknown; items?: any[] },
    chat: ReturnType<typeof extractFromChatMessages>,
  ): LineItemDraft[] {
    const template = Array.isArray(sheet.lineItemTemplate) ? (sheet.lineItemTemplate as any[]) : null;
    if (template && template.length > 0) {
      return template.map(li => {
        const label = String(li?.label || "Line item");
        let amountCents = Number(li?.amountCents) || 0;
        let source: string | undefined = "template";
        const dyn = typeof li?.dynamicSource === "string" ? li.dynamicSource : null;
        if (dyn === "chat.surrogateCompCents" && chat.surrogateCompCents != null) {
          amountCents = chat.surrogateCompCents;
          source = "chat.surrogateCompCents";
        } else if (dyn === "chat.donorCompCents" && chat.donorCompCents != null) {
          amountCents = chat.donorCompCents;
          source = "chat.donorCompCents";
        }
        return { label, amountCents, editable: li?.editable !== false, source };
      });
    }
    // Fallback: synthesize line items from the existing CostItem rows.
    const items = Array.isArray(sheet.items) ? sheet.items : [];
    return items
      .filter(it => it.isIncluded !== false)
      .map(it => ({
        label: `${it.category}: ${it.key}`,
        amountCents: Math.round(((it.minValue || it.maxValue || 0) as number) * 100),
        editable: true,
        source: "cost_item",
      }))
      .filter(li => li.amountCents > 0);
  }
}
