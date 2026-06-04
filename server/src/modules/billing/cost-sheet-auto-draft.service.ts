import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { extractFromChatMessages } from "./cost-sheet-chat-extractor";
import {
  matchSubtypes,
  MatcherInput,
} from "../costs/cost-sheet-subtype-matcher";
import {
  SUBTYPE_LABEL,
  SubType,
  isValidSubType,
} from "../costs/cost-templates-config";

// Phase 2 cost-sheet auto-draft. Fires synchronously-fire-and-forget on
// Booking creation. Drops an inline approval card (uiCardType =
// "cost_sheet_draft_approval") in the PROVIDER's session chat. The card
// is invisible to the parent via chat-router.ts's existing
// uiCardType notIn filter.
//
// Selection is now driven by the subtype matcher: derive the parent's
// eligible subtypes from their User + IntendedParentProfile, intersect
// with the provider's APPROVED programs, pick the most recently updated.
// No more matching-rules JSON, no more rule-count tiebreak.
//
// Two-gate feature flag:
//   Gate 1 (global):  ConciergePromptSection.isActive=true for key
//                     "auto_cost_sheet_on_booking"
//   Gate 2 (per-provider): Provider.autoFeaturesEnabled.autoCostSheetDraft === true

interface AutoDraftResult {
  status: "drafted" | "skipped";
  reason?: string;
  messageId?: string;
}

interface LineItemDraft {
  label: string;
  amountCents: number;
  editable?: boolean;
  source?: string;
}

@Injectable()
export class CostSheetAutoDraftService {
  private readonly logger = new Logger(CostSheetAutoDraftService.name);

  constructor(private readonly prisma: PrismaService) {}

  async tryAutoDraftForBooking(bookingId: string): Promise<AutoDraftResult> {
    try {
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

      const autoFeatures = (booking.providerUser?.provider as any)?.autoFeaturesEnabled || {};
      if (autoFeatures?.autoCostSheetDraft !== true) {
        return this.skip("provider_opted_out");
      }

      const gate1 = await this.prisma.conciergePromptSection.findUnique({
        where: { key: "auto_cost_sheet_on_booking" },
        select: { isActive: true },
      });
      if (!gate1?.isActive) return this.skip("prompt_section_inactive");

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

      // Build matcher input from the parent's User + IntendedParentProfile.
      if (!booking.parentUser.parentAccountId) {
        return this.skip("no_parent_account");
      }
      const account = await this.prisma.parentAccount.findUnique({
        where: { id: booking.parentUser.parentAccountId },
        include: {
          intendedParentProfile: true,
          members: { orderBy: { createdAt: "asc" } },
        },
      });
      if (!account?.intendedParentProfile) return this.skip("no_intended_parent_profile");

      const primary = account.members[0];
      const matcherInput: MatcherInput = {
        userGender: primary?.gender ?? null,
        partnerGender: primary?.partnerGender ?? null,
        hasEmbryos: account.intendedParentProfile.hasEmbryos ?? null,
        eggSource: account.intendedParentProfile.eggSource ?? null,
        spermSource: account.intendedParentProfile.spermSource ?? null,
        carrier: account.intendedParentProfile.carrier ?? null,
        interestedServices: account.intendedParentProfile.interestedServices ?? null,
      };
      const { subtypes } = matchSubtypes(matcherInput);
      if (subtypes.length === 0) return this.skip("no_matching_subtypes");

      // Provider's APPROVED programs that match any of the parent's eligible
      // leaves. Uses the canonical subTypes[] (multi-leaf) with hasSome so a
      // combined-package cost sheet (e.g. ["surrogacy","egg_donor_fresh"])
      // matches a parent eligible for either leaf. Tiebreak: most recently
      // updated sheet wins.
      const sheets = await this.prisma.providerCostSheet.findMany({
        where: {
          providerId,
          status: "APPROVED",
          parentClientId: null,
          subTypes: { hasSome: subtypes },
        },
        include: { items: true },
        orderBy: { updatedAt: "desc" },
      });
      if (sheets.length === 0) return this.skip("no_matching_approved_sheets");

      const picked = sheets[0];
      // Pick the most specific leaf for labelling: intersection of the
      // sheet's covered leaves with the parent's eligible leaves.
      const pickedLeaves = ((picked as any).subTypes as string[] | undefined) || [];
      const overlap = pickedLeaves.filter(l => (subtypes as string[]).includes(l));
      const pickedSubType: SubType | null = isValidSubType(overlap[0])
        ? (overlap[0] as SubType)
        : (isValidSubType(picked.subType) ? (picked.subType as SubType) : null);

      // Chat context for dynamic amounts (surrogate comp, donor comp).
      const recentMsgs = await this.prisma.aiChatMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { content: true },
      });
      const chat = extractFromChatMessages(recentMsgs.reverse());

      const lineItems = this.buildLineItems(picked, chat);
      const totalCostCents = lineItems.reduce((sum, li) => sum + (li.amountCents || 0), 0);
      if (totalCostCents <= 0) return this.skip("zero_total_cost");

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
            sourceCostSheetCategory: picked.category || null,
            sourceCostSheetSubType: pickedSubType,
            sourceCostSheetSubTypeLabel: pickedSubType ? SUBTYPE_LABEL[pickedSubType] : null,
            lineItems,
            totalCostCents,
            notes: null,
            matchedSubtypes: subtypes,
            candidates: sheets.slice(0, 3).map((s) => ({
              costSheetId: s.id,
              subType: s.subType,
              category: s.category || null,
            })),
            chatExtractions: chat,
            autoDraftedAt: new Date().toISOString(),
            resolvedAt: null,
            resolvedAs: null,
          },
        },
      });

      this.logger.log(
        `Auto-draft drafted: booking=${bookingId} session=${session.id} sheet=${picked.id} subType=${pickedSubType} total=$${(totalCostCents / 100).toFixed(2)}`,
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

  // Build line items from the picked sheet's lineItemTemplate, then
  // substitute dynamic values from chat extractions. If no template,
  // fall back to the sheet's CostItem rows.
  private buildLineItems(
    sheet: { lineItemTemplate: unknown; items: any[] },
    chat: ReturnType<typeof extractFromChatMessages>,
  ): LineItemDraft[] {
    const template = Array.isArray(sheet.lineItemTemplate) ? (sheet.lineItemTemplate as any[]) : null;
    if (template && template.length > 0) {
      return template.map((li) => {
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
    const items = Array.isArray(sheet.items) ? sheet.items : [];
    return items
      .filter((it) => it.isIncluded !== false)
      .map((it) => ({
        label: `${it.category}: ${it.key}`,
        amountCents: Math.round(((it.minValue || it.maxValue || 0) as number) * 100),
        editable: true,
        source: "cost_item",
      }))
      .filter((li) => li.amountCents > 0);
  }
}
