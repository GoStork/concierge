import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { extractFromChatMessages } from "./cost-sheet-chat-extractor";
import { findProviderTypeIdForDonorType } from "../costs/total-cost.utils";
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
// Booking creation. Drops inline approval cards (uiCardType =
// "cost_sheet_draft_approval") in the PROVIDER's session chat. Cards are
// invisible to the parent via chat-router.ts's existing uiCardType
// notIn filter.
//
// Selection priority:
//   1. SESSION SUBJECT CONTEXT (primary): a consultation booked about an
//      egg donor must get egg-donation sheets - regardless of what the
//      parent's own profile says about egg source. Egg Donor subjects are
//      narrowed to fresh/frozen via the donor's own donorType field.
//   2. Parent-profile-derived subtypes (fallback): only when the session
//      has no subject (e.g. a Clinic consult or a generic provider chat).
//
// Multiple matches: ONE approval card PER matching cost sheet. The
// provider approves the right one(s) and rejects the rest. Idempotency is
// per (session, sourceCostSheetId) - an unresolved card for sheet X
// blocks re-drafting X but not drafting Y.
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
  // True for zero-amount items the sheet marks isIncluded - rendered as
  // "Included" in the card (matching the donor-profile Costs section)
  // instead of being dropped or shown as $0.
  includedInPackage?: boolean;
  // True for items the sheet marks isIncluded=false. Shown grayed under a
  // "Not included" divider so parents see what the price does NOT cover.
  // Never counted toward the total.
  excluded?: boolean;
}

@Injectable()
export class CostSheetAutoDraftService {
  private readonly logger = new Logger(CostSheetAutoDraftService.name);

  // Explicit @Inject is REQUIRED - this project runs tsx/esbuild without
  // emitDecoratorMetadata, so Nest cannot infer the token from the TS type
  // alone. Without it, prisma injects as undefined and every call throws
  // "Cannot read properties of undefined (reading 'booking')".
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

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
        select: { id: true, subjectType: true, subjectProfileId: true },
      });
      if (!session) return this.skip("no_chat_session");

      const existingQuote = await this.prisma.providerQuote.findFirst({
        where: { sessionId: session.id, supersededAt: null },
        select: { id: true },
      });
      if (existingQuote) return this.skip("quote_already_exists");

      return this.draftCore(session, providerId, booking.parentUser.parentAccountId ?? null, `booking=${bookingId}`, false);
    } catch (err: any) {
      this.logger.warn(`Auto-draft error for booking ${bookingId}: ${err.message}`);
      return this.skip("error:" + (err.message || "unknown"));
    }
  }

  // Provider-initiated draft generation (the "+ -> Cost Sheet" button and
  // "Edit & Resend"). Bypasses the two feature gates AND the quote-exists
  // check - clicking the button IS explicit intent. Per-sheet pending
  // idempotency still applies so double-clicks don't duplicate cards.
  async draftForSession(sessionId: string): Promise<AutoDraftResult> {
    try {
      const session = await this.prisma.aiChatSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          subjectType: true,
          subjectProfileId: true,
          providerId: true,
          user: { select: { parentAccountId: true } },
        },
      });
      if (!session) return this.skip("session_not_found");
      if (!session.providerId) return this.skip("no_provider");
      return this.draftCore(
        { id: session.id, subjectType: session.subjectType, subjectProfileId: session.subjectProfileId },
        session.providerId,
        session.user?.parentAccountId ?? null,
        `manual session=${sessionId}`,
        true, // supersede stale pending drafts - provider wants a fresh, complete set
      );
    } catch (err: any) {
      this.logger.warn(`Manual draft error for session ${sessionId}: ${err.message}`);
      return this.skip("error:" + (err.message || "unknown"));
    }
  }

  private async draftCore(
    session: { id: string; subjectType: string | null; subjectProfileId: string | null },
    providerId: string,
    parentAccountId: string | null,
    logTag: string,
    supersedePending: boolean,
  ): Promise<AutoDraftResult> {
    try {
      // Existing unresolved draft cards in this session.
      const existingDrafts = await this.prisma.aiChatMessage.findMany({
        where: { sessionId: session.id, uiCardType: "cost_sheet_draft_approval" },
        select: { id: true, uiCardData: true },
      });
      const pendingSheetIds = new Set<string>();
      if (supersedePending) {
        // Manual regenerate: resolve every stale pending draft so the
        // provider always gets ONE fresh, complete set at the bottom of
        // the chat - never a mix of old and new cards.
        for (const d of existingDrafts) {
          const data = (d.uiCardData as any) || {};
          if (!data.resolvedAt) {
            await this.prisma.aiChatMessage.update({
              where: { id: (d as any).id },
              data: {
                uiCardData: {
                  ...data,
                  resolvedAt: new Date().toISOString(),
                  resolvedAs: "superseded",
                },
              },
            });
          }
        }
      } else {
        // Booking auto-trigger: per-sheet idempotency. Skip re-drafting
        // sheets that already have an unresolved card, but still draft
        // cards for newly matching ones.
        for (const d of existingDrafts) {
          const data = (d.uiCardData as any) || {};
          if (!data.resolvedAt && data.sourceCostSheetId) pendingSheetIds.add(data.sourceCostSheetId);
        }
      }

      // ---- Target leaves: session subject context FIRST ----
      // A booking about a specific egg donor / surrogate must produce cost
      // sheets for THAT service, regardless of the parent's own profile
      // fields (their profile may say "partner eggs" while they're actively
      // exploring an egg donor - the inquiry wins).
      let targetLeaves: string[] | null = null;
      // The subject's own compensation (dollars). Substituted into the
      // sheet's base-compensation line so the drafted quote matches the
      // donor-profile Costs section exactly (same substitution rule as
      // total-cost.utils.ts computeCostFromSheet).
      let subjectCompDollars: number | null = null;
      // The total-cost donorType token for template-key lookups below.
      let donorTypeToken: string | null = null;
      // Sperm donor vial availability (e.g. ["IUI","ICI"]) - used to drop
      // per-vial-tier sheets the donor isn't actually offered in.
      let subjectVialTypes: string[] = [];
      const subject = (session.subjectType || "").toLowerCase();
      if (subject.includes("egg")) {
        donorTypeToken = "egg-donor";
        // Narrow to fresh/frozen via the donor's own type when known.
        let donorType: string | null = null;
        if (session.subjectProfileId) {
          const donor = await this.prisma.eggDonor.findUnique({
            where: { id: session.subjectProfileId },
            select: { donorType: true, donorCompensation: true },
          }).catch(() => null);
          donorType = donor?.donorType?.toLowerCase() || null;
          subjectCompDollars = donor?.donorCompensation != null ? Number(donor.donorCompensation) : null;
        }
        if (donorType?.includes("fresh")) targetLeaves = ["egg_donor_fresh"];
        else if (donorType?.includes("frozen")) {
          targetLeaves = ["egg_donor_frozen"];
          // Frozen egg programs price per EGG LOT, not per-donor
          // compensation - never substitute comp into a frozen sheet.
          subjectCompDollars = null;
        }
        else targetLeaves = ["egg_donor_fresh", "egg_donor_frozen"];
      } else if (subject.includes("surrog")) {
        donorTypeToken = "surrogate";
        targetLeaves = ["surrogacy"];
        if (session.subjectProfileId) {
          const surrogate = await this.prisma.surrogate.findUnique({
            where: { id: session.subjectProfileId },
            select: { baseCompensation: true },
          }).catch(() => null);
          subjectCompDollars = surrogate?.baseCompensation != null ? Number(surrogate.baseCompensation) : null;
        }
      } else if (subject.includes("sperm")) {
        donorTypeToken = "sperm-donor";
        targetLeaves = ["sperm_donor"];
        // Sperm banks price per VIAL (ICI/IUI/IVF tiers) - donors have no
        // compensation concept in the parent-facing quote, so no comp
        // substitution. Only the vial availability matters.
        if (session.subjectProfileId) {
          const spermDonor = await this.prisma.spermDonor.findUnique({
            where: { id: session.subjectProfileId },
            select: { vialTypes: true },
          }).catch(() => null);
          subjectVialTypes = Array.isArray(spermDonor?.vialTypes) ? spermDonor!.vialTypes : [];
        }
      }

      // Base-compensation template field names for this provider's service
      // (e.g. "Egg Donor Compensation"). AI-parsed sheet rows often carry
      // these exact template names with a non-canonical category ("Egg
      // Donor Fees"), so the category heuristic alone misses them - the
      // same reason total-cost.utils.ts checks template keys first.
      const baseCompKeys = new Set<string>();
      if (donorTypeToken && subjectCompDollars != null) {
        const providerTypeId = await findProviderTypeIdForDonorType(
          this.prisma, providerId, donorTypeToken,
        ).catch(() => undefined);
        if (providerTypeId) {
          const templates = await this.prisma.costTemplate.findMany({
            where: { providerTypeId, isBaseCompensation: true },
            select: { fieldName: true },
          });
          for (const t of templates) baseCompKeys.add(t.fieldName);
        }
      }

      // Fallback: derive from the parent's profile when the session has no
      // donor/surrogate subject (clinic consults, generic provider chats).
      if (!targetLeaves) {
        if (!parentAccountId) {
          return this.skip("no_parent_account");
        }
        const account = await this.prisma.parentAccount.findUnique({
          where: { id: parentAccountId },
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
        targetLeaves = subtypes as string[];
      }

      // Every APPROVED sheet covering any target leaf gets its own card.
      let sheets = await this.prisma.providerCostSheet.findMany({
        where: {
          providerId,
          status: "APPROVED",
          parentClientId: null,
          subTypes: { hasSome: targetLeaves },
        },
        include: { items: true, program: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
      });
      if (sheets.length === 0) return this.skip("no_matching_approved_sheets");

      // Sperm banks price per vial type + tier (ICI/IUI/IVF x Premium/
      // Platinum), one sheet each. Only draft the tiers the donor is
      // actually available in (same vial-matching convention as
      // total-cost.utils matchVialCostsFromSheet: item keys start with
      // the vial type; program names carry it too). No vialTypes on the
      // donor = keep everything.
      if (subject.includes("sperm") && subjectVialTypes.length > 0) {
        const vt = subjectVialTypes.map(v => v.toLowerCase());
        const matchesVial = (s: typeof sheets[number]) => {
          const progName = ((s as any).program?.name || "").toLowerCase();
          if (vt.some(v => progName.includes(v))) return true;
          return (s.items || []).some((it: any) =>
            vt.some(v => (it.key || "").toLowerCase().startsWith(v)),
          );
        };
        const filtered = sheets.filter(matchesVial);
        if (filtered.length > 0) {
          this.logger.log(
            `Auto-draft vial filter: donor offers [${subjectVialTypes.join(",")}] - ${filtered.length}/${sheets.length} sheets kept`,
          );
          sheets = filtered;
        }
      }

      // Chat context for dynamic amounts (surrogate comp, donor comp).
      const recentMsgs = await this.prisma.aiChatMessage.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { content: true },
      });
      const chat = extractFromChatMessages(recentMsgs.reverse());

      const draftedIds: string[] = [];
      for (const sheet of sheets) {
        if (pendingSheetIds.has(sheet.id)) continue; // unresolved card already up

        const sheetLeaves = ((sheet as any).subTypes as string[] | undefined) || [];
        const overlap = sheetLeaves.filter(l => targetLeaves!.includes(l));
        const cardSubType: SubType | null = isValidSubType(overlap[0])
          ? (overlap[0] as SubType)
          : (isValidSubType(sheet.subType) ? (sheet.subType as SubType) : null);

        const lineItems = this.buildLineItems(sheet, chat, subjectCompDollars, baseCompKeys);
        // Excluded items appear on the card for transparency but never
        // count toward the quoted total.
        const totalCostCents = lineItems
          .filter(li => !li.excluded)
          .reduce((sum, li) => sum + (li.amountCents || 0), 0);
        if (totalCostCents <= 0) {
          this.logger.log(`Auto-draft skipping sheet ${sheet.id}: zero total`);
          continue;
        }

        const card = await this.prisma.aiChatMessage.create({
          data: {
            sessionId: session.id,
            role: "assistant",
            content: "Auto-drafted cost sheet ready for review.",
            senderType: "system",
            senderName: "GoStork",
            uiCardType: "cost_sheet_draft_approval",
            uiCardData: {
              sourceCostSheetId: sheet.id,
              sourceCostSheetCategory: sheet.category || null,
              sourceCostSheetSubType: cardSubType,
              sourceCostSheetSubTypeLabel: cardSubType ? SUBTYPE_LABEL[cardSubType] : null,
              // Program name so the provider can tell sibling drafts apart
              // when several sheets match (e.g. Fixed vs Regular egg
              // donation programs).
              programName: (sheet as any).program?.name || null,
              // Original uploaded cost-sheet document - the approval card
              // offers a checkbox (default on) to attach it to the quote.
              // Sheets from the upload-first flow store only filePath (a
              // raw GCS object path), so normalize to the canonical URL
              // format the parent download route knows how to re-sign.
              fileUrl: sheet.fileUrl || (sheet.filePath ? this.storage.publicUrlFor(sheet.filePath) : null),
              fileName: sheet.originalFileName || null,
              lineItems,
              totalCostCents,
              notes: null,
              matchedSubtypes: targetLeaves,
              matchSource: subject ? `session_subject:${session.subjectType}` : "parent_profile",
              siblingSheetCount: sheets.length,
              chatExtractions: chat,
              autoDraftedAt: new Date().toISOString(),
              resolvedAt: null,
              resolvedAs: null,
            },
          },
        });
        draftedIds.push(card.id);
        this.logger.log(
          `Auto-draft drafted: ${logTag} session=${session.id} sheet=${sheet.id} subType=${cardSubType} total=$${(totalCostCents / 100).toFixed(2)}`,
        );
      }

      if (draftedIds.length === 0) return this.skip("all_matching_sheets_already_pending_or_zero");
      return { status: "drafted", messageId: draftedIds[0] };
    } catch (err: any) {
      this.logger.warn(`Auto-draft error for ${logTag}: ${err.message}`);
      return this.skip("error:" + (err.message || "unknown"));
    }
  }

  private skip(reason: string): AutoDraftResult {
    this.logger.log(`Auto-draft skipped: ${reason}`);
    return { status: "skipped", reason };
  }

  // Build line items from the picked sheet's lineItemTemplate, then
  // substitute dynamic values from chat extractions. If no template,
  // fall back to the sheet's CostItem rows using the SAME rules as the
  // donor-profile Costs section (total-cost.utils.ts computeCostFromSheet):
  //   - only isIncluded items count
  //   - the base-compensation line is replaced by the subject's own
  //     compensation when known (donor's $20k, not the template's $10k)
  //   - zero-amount included items are KEPT and flagged includedInPackage
  //     so the card renders "Included" - the drafted quote then reads
  //     identically to the profile the parent was already shown.
  private buildLineItems(
    sheet: { lineItemTemplate: unknown; items: any[] },
    chat: ReturnType<typeof extractFromChatMessages>,
    subjectCompDollars: number | null = null,
    baseCompKeys: Set<string> = new Set(),
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

    // Base-compensation detection - full total-cost.utils.ts logic:
    // exact CostTemplate base-comp field-name match FIRST (catches
    // "Egg Donor Compensation" filed under category "Egg Donor Fees"),
    // then the canonical-category + key heuristic as fallback.
    const baseCompCategories = new Set(["donor_compensation", "surrogate_compensation"]);
    const isBaseCompItem = (it: { key?: string; category?: string }) => {
      if (it.key && baseCompKeys.has(it.key)) return true;
      const cat = (it.category || "").toLowerCase();
      const key = (it.key || "").toLowerCase();
      return (
        baseCompCategories.has(cat) &&
        key.includes("compensation") &&
        !/surcharge|additional|bonus|vip|premium|extra/.test(key)
      );
    };

    const items = Array.isArray(sheet.items) ? sheet.items : [];
    return items
      .map((it) => {
        const isExcluded = it.isIncluded === false;
        let amountCents = Math.round((((it.minValue ?? it.maxValue ?? 0)) as number) * 100);
        let source = "cost_item";
        if (!isExcluded && subjectCompDollars != null && isBaseCompItem(it)) {
          amountCents = Math.round(subjectCompDollars * 100);
          source = "subject_profile_compensation";
        }
        return {
          // Humanize the snake_case tokens the AI parser stores in
          // category/key. Compare AFTER humanizing - raw values often
          // differ only in casing/underscores and would render doubled.
          label: (() => {
            const cat = humanizeToken(it.category);
            const key = humanizeToken(it.key);
            return cat === key ? key : `${cat}: ${key}`;
          })(),
          amountCents,
          editable: true,
          source,
          includedInPackage: !isExcluded && amountCents === 0,
          excluded: isExcluded,
        };
      })
      // Excluded rows with no price at all carry no information - drop them.
      .filter((li) => !(li.excluded && li.amountCents === 0));
  }
}

// "surrogate_compensation" -> "Surrogate Compensation"; short tokens like
// "gs" are uppercased ("gs_miscellaneous" -> "GS Miscellaneous").
function humanizeToken(raw: string | null | undefined): string {
  if (!raw) return "Line item";
  return String(raw)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
