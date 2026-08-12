import { asJson } from "../../../../shared/prisma-json";
import { serviceTypeOfSession } from "../../../service-lines";
import {
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { emitJourneyEvent } from "../../../journey-events";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { NotificationService } from "../notifications/notification.service";
import { CostSheetAutoDraftService } from "./cost-sheet-auto-draft.service";
import { prisma } from "../../../db";
import { formatMoneyCents } from "../../lib/format-money";
import { canSendProviderMessage } from "../../../../shared/roles";
import { resolveQuotePaymentSchedule } from "../costs/payment-schedule.service";

// Phase 2 cost-sheet auto-draft endpoints.
//
//   POST /api/sessions/:sessionId/cost-sheet-draft/:messageId/approve
//        - provider approves: create a real ProviderQuote, post the
//          standard cost_sheet card to both parties, fire email + SMS
//          via sendCostSheetReadyToParent, mark the draft card resolved
//   POST /api/sessions/:sessionId/cost-sheet-draft/:messageId/reject
//        - provider rejects: mark the draft card resolved with no quote
//   POST /api/sessions/:sessionId/cost-sheet-draft/:messageId/edit
//        - provider edits inline: updates the draft card's uiCardData
//          (line items, total, notes) before approving
//   POST /api/sessions/:sessionId/quotes/:quoteId/acknowledge
//        - parent click on Acknowledge (Stage 5). Soft signal only.

interface LineItem {
  label: string;
  amountCents: number;
  editable?: boolean;
  source?: string;
}

@Controller()
export class CostSheetAutoDraftController {
  private readonly logger = new Logger(CostSheetAutoDraftController.name);
  private readonly db = prisma;

  constructor(
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(CostSheetAutoDraftService) private readonly autoDraft: CostSheetAutoDraftService,
  ) {}

  // ─── Generate drafts on demand ─────────────────────────────────────────────
  // Powers the provider's "+ -> Cost Sheet" button and "Edit & Resend".
  // Same draft engine as the booking trigger, but explicit provider intent
  // bypasses the feature gates and the quote-exists check.

  @Post("api/sessions/:sessionId/cost-sheet-draft/generate")
  @UseGuards(SessionOrJwtGuard)
  async generate(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
  ) {
    const user = req.user as any;
    await this.loadSessionForProvider(sessionId, user);
    const result = await this.autoDraft.draftForSession(sessionId);
    return result;
  }

  // ─── Auth helpers ──────────────────────────────────────────────────────────

  private async loadSessionForProvider(sessionId: string, user: any) {
    const session = await this.db.aiChatSession.findUnique({
      where: { id: sessionId },
      include: { user: true, provider: true },
    });
    if (!session) throw new NotFoundException("Session not found");
    if (!session.providerId) {
      throw new HttpException("Session has no provider", HttpStatus.BAD_REQUEST);
    }
    const roles: string[] = user?.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN") || roles.includes("GOSTORK_CONCIERGE");
    const isProviderMember = user?.providerId && user.providerId === session.providerId;
    if (!isAdmin && !isProviderMember) {
      throw new ForbiddenException("You don't have access to this session");
    }
    if (!isAdmin && !canSendProviderMessage(roles, (session as any).subjectType)) {
      throw new ForbiddenException("Your role cannot approve cost sheets for this session");
    }
    return { session, isAdmin, isProviderMember, roles };
  }

  private async loadDraftCard(sessionId: string, messageId: string) {
    const msg = await this.db.aiChatMessage.findUnique({ where: { id: messageId } });
    if (!msg) throw new NotFoundException("Draft card not found");
    if (msg.sessionId !== sessionId) throw new NotFoundException("Draft card not in this session");
    if (msg.uiCardType !== "cost_sheet_draft_approval") {
      throw new HttpException("Not a cost sheet draft card", HttpStatus.BAD_REQUEST);
    }
    const data = (msg.uiCardData as any) || {};
    if (data.resolvedAt) {
      throw new HttpException(`Draft already ${data.resolvedAs || "resolved"}`, HttpStatus.CONFLICT);
    }
    return { msg, data };
  }

  // ─── Approve ───────────────────────────────────────────────────────────────

  @Post("api/sessions/:sessionId/cost-sheet-draft/:messageId/approve")
  @UseGuards(SessionOrJwtGuard)
  async approve(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: { totalCostCents?: number; notes?: string; lineItems?: LineItem[]; attachFile?: boolean },
  ) {
    const user = req.user as any;
    const { session } = await this.loadSessionForProvider(sessionId, user);
    const { msg, data } = await this.loadDraftCard(sessionId, messageId);

    // Allow inline overrides at approve-time. Otherwise use draft values.
    const lineItems: LineItem[] = Array.isArray(body.lineItems) ? body.lineItems : (data.lineItems || []);
    const totalCostCents =
      typeof body.totalCostCents === "number" && body.totalCostCents > 0
        ? body.totalCostCents
        : lineItems.filter((li: any) => !li.excluded).reduce((sum, li) => sum + (Number(li.amountCents) || 0), 0) ||
          Number(data.totalCostCents) || 0;
    if (totalCostCents <= 0) {
      throw new HttpException("totalCostCents must be a positive number", HttpStatus.BAD_REQUEST);
    }
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : data.notes ?? null;

    // Attach the original uploaded cost-sheet document unless the provider
    // unchecked the box. Uses the same quote fields the manual flow uses,
    // so the parent card's existing signed-URL download route just works.
    const attachFile = body.attachFile !== false;
    const costSheetFileUrl = attachFile ? (data.fileUrl || null) : null;
    const costSheetFileName = attachFile ? (data.fileName || null) : null;

    // Snapshot the installment plan, exactly as the manual send does - a
    // parent's experience must not depend on which button the provider
    // pressed. This path knows the source sheet, so it targets that one
    // rather than falling back to the provider's most recent.
    const paymentScheduleSnapshot = await resolveQuotePaymentSchedule(this.db, session.providerId!, {
      sessionId,
      preferredSheetId: data.sourceCostSheetId || null,
    });

    // Supersede prior active quotes for this session, then create the new one.
    const quote = await this.db.$transaction(async tx => {
      await tx.providerQuote.updateMany({
        where: { sessionId, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      return tx.providerQuote.create({
        data: {
          sessionId,
          providerId: session.providerId!,
          parentUserId: session.userId,
          totalCostCents,
          costSheetFileUrl,
          costSheetFileName,
          notes,
          source: "AUTO_DRAFT_APPROVED",
          serviceType: await serviceTypeOfSession(sessionId),
          createdByUserId: user.id || null,
          lineItems: lineItems as any,
          paymentSchedule: (paymentScheduleSnapshot ?? undefined) as any,
          sourceCostSheetId: data.sourceCostSheetId || null,
          autoDraftedAt: data.autoDraftedAt ? new Date(data.autoDraftedAt) : new Date(),
        },
      });
    });

    // Post the regular cost_sheet card visible to BOTH parties.
    await this.db.aiChatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: `${session.provider?.name || "Your provider"} sent you a cost sheet. Total: ${formatMoneyCents(totalCostCents)}${
          paymentScheduleSnapshot ? ". It includes a payment schedule so you can see what is due and when." : ""
        }`,
        senderType: "system",
        senderName: session.provider?.name || "Provider",
        uiCardType: "cost_sheet",
        uiCardData: asJson({
          quoteId: quote.id,
          providerName: session.provider?.name || null,
          totalCostCents,
          costSheetFileUrl,
          costSheetFileName,
          notes: quote.notes,
          lineItems,
          parentAcknowledgedAt: null,
          sentAt: quote.createdAt.toISOString(),
          source: "AUTO_DRAFT_APPROVED",
          paymentSchedule: paymentScheduleSnapshot ?? null,
          // The provider reads this same card, so it needs their side of the
          // sentence too - nobody should read about themselves in the third
          // person in their own chat.
          providerContent: `You sent a cost sheet. Total: ${formatMoneyCents(totalCostCents)}${
            paymentScheduleSnapshot
              ? `, with a ${paymentScheduleSnapshot.tranches.length}-payment schedule attached.`
              : "."
          }`,
        }),
      },
    });

    // Mark the draft card resolved (kept for audit trail).
    await this.db.aiChatMessage.update({
      where: { id: messageId },
      data: {
        uiCardData: {
          ...data,
          resolvedAt: new Date().toISOString(),
          resolvedAs: "approved",
          // WHO approved it, so the task this card raises can close in their
          // name rather than falling back to the org.
          resolvedByUserId: (req.user as any)?.id ?? null,
          resultingQuoteId: quote.id,
        },
      },
    });

    // Fire parent notifications (email + SMS) - same path as manual flow.
    if (session.user?.email) {
      await this.notifications
        .sendCostSheetReadyToParent({
          parentUserId: session.userId,
          parentName: session.user.name || session.user.firstName || "there",
          parentEmail: session.user.email,
          parentPhone: session.user.mobileNumber,
          providerName: session.provider?.name || "Your provider",
          providerId: session.providerId!,
          sessionId,
          totalCostFormatted: formatMoneyCents(totalCostCents),
          hasFile: false,
        })
        .catch(err => this.logger.error(`Cost-sheet parent notification failed: ${err.message}`));
    }

    this.logger.log(
      `Auto-draft approved: session=${sessionId} quote=${quote.id} total=${formatMoneyCents(totalCostCents)}`,
    );

    return { quote, draftMessageId: messageId };
  }

  // ─── Reject ────────────────────────────────────────────────────────────────

  @Post("api/sessions/:sessionId/cost-sheet-draft/:messageId/reject")
  @UseGuards(SessionOrJwtGuard)
  async reject(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: { reason?: string },
  ) {
    const user = req.user as any;
    await this.loadSessionForProvider(sessionId, user);
    const { data } = await this.loadDraftCard(sessionId, messageId);
    await this.db.aiChatMessage.update({
      where: { id: messageId },
      data: {
        uiCardData: {
          ...data,
          resolvedAt: new Date().toISOString(),
          resolvedAs: "rejected",
          resolvedByUserId: user?.id ?? null,
          rejectionReason: typeof body.reason === "string" ? body.reason.trim() || null : null,
        },
      },
    });
    this.logger.log(`Auto-draft rejected: session=${sessionId} message=${messageId}`);
    return { ok: true };
  }

  // ─── Inline edit (before approve) ──────────────────────────────────────────

  @Post("api/sessions/:sessionId/cost-sheet-draft/:messageId/edit")
  @UseGuards(SessionOrJwtGuard)
  async edit(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: { lineItems?: LineItem[]; totalCostCents?: number; notes?: string },
  ) {
    const user = req.user as any;
    await this.loadSessionForProvider(sessionId, user);
    const { data } = await this.loadDraftCard(sessionId, messageId);

    const next = { ...data };
    if (Array.isArray(body.lineItems)) next.lineItems = body.lineItems;
    if (typeof body.totalCostCents === "number" && body.totalCostCents > 0) {
      next.totalCostCents = body.totalCostCents;
    } else if (Array.isArray(body.lineItems)) {
      next.totalCostCents = body.lineItems.reduce((sum, li) => sum + (Number(li.amountCents) || 0), 0);
    }
    if (typeof body.notes === "string") next.notes = body.notes.trim() || null;

    await this.db.aiChatMessage.update({
      where: { id: messageId },
      data: { uiCardData: next },
    });
    return { ok: true, uiCardData: next };
  }

  // ─── Parent acknowledges cost sheet ────────────────────────────────────────

  @Post("api/sessions/:sessionId/quotes/:quoteId/acknowledge")
  @UseGuards(SessionOrJwtGuard)
  async acknowledge(
    @Req() req: Request,
    @Param("sessionId") sessionId: string,
    @Param("quoteId") quoteId: string,
  ) {
    const user = req.user as any;
    if (!user?.id) throw new ForbiddenException("Not authenticated");
    const quote = await this.db.providerQuote.findUnique({ where: { id: quoteId } });
    if (!quote) throw new NotFoundException("Quote not found");
    if (quote.sessionId !== sessionId) throw new NotFoundException("Quote not in session");

    // Confirm the caller is the parent on this session (or a parent-account member).
    const session = await this.db.aiChatSession.findUnique({
      where: { id: sessionId },
      select: { userId: true, user: { select: { parentAccountId: true } } },
    });
    if (!session) throw new NotFoundException("Session not found");
    let isParent = session.userId === user.id;
    if (!isParent && session.user?.parentAccountId) {
      const member = await this.db.user.findFirst({
        where: { id: user.id, parentAccountId: session.user.parentAccountId },
        select: { id: true },
      });
      isParent = !!member;
    }
    if (!isParent) throw new ForbiddenException("Only the parent can acknowledge the cost sheet");

    if (quote.parentAcknowledgedAt) return { ok: true, alreadyAcknowledged: true };

    const updated = await this.db.providerQuote.update({
      where: { id: quoteId },
      data: { parentAcknowledgedAt: new Date() },
      select: { parentAcknowledgedAt: true },
    });
    void emitJourneyEvent({ eventType: "COST_SHEET_OPENED", parentUserId: user.id, providerId: quote.providerId, sessionId, actorRole: "parent", metadata: { quoteId } });
    this.logger.log(`Parent acknowledged cost sheet: quote=${quoteId} at ${updated.parentAcknowledgedAt?.toISOString()}`);

    // Tell the PROVIDER side what just happened - uiCardType "provider_only"
    // keeps this out of the parent's chat (ai-router filters it). The parent
    // already sees the green confirmation footer on the card itself; posting
    // anything about invoices here would be premature - at this stage the
    // parent has only scheduled a call. Invoicing happens much later, after
    // the readiness "Yes" (Phase 3).
    try {
      const sessionWithProvider = await this.db.aiChatSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true, userId: true, providerId: true,
          user: { select: { name: true, firstName: true, parentAccountId: true } },
          provider: { select: { name: true } },
        },
      });
      if (sessionWithProvider) {
        const parentLabel = sessionWithProvider.user?.firstName || sessionWithProvider.user?.name || "The parent";
        const totalFormatted = formatMoneyCents(quote.totalCostCents);
        const ackMessage =
          `${parentLabel} acknowledged the cost sheet (${totalFormatted}).`;
        await this.db.aiChatMessage.create({
          data: {
            sessionId,
            role: "assistant",
            content: ackMessage,
            senderType: "system",
            senderName: "GoStork",
            uiCardType: "provider_only",
          },
        });

        // In-app notify every provider-side member so they see "invoice next"
        // in their inbox, not just inside this chat.
        if (sessionWithProvider.providerId) {
          const providerMembers = await this.db.user.findMany({
            where: { providerId: sessionWithProvider.providerId },
            select: { id: true },
          });
          for (const m of providerMembers) {
            await this.db.inAppNotification.create({
              data: {
                userId: m.id,
                eventType: "COST_SHEET_ACKNOWLEDGED",
                payload: {
                  sessionId,
                  quoteId,
                  totalCostCents: quote.totalCostCents,
                  parentName: parentLabel,
                  message: `${parentLabel} acknowledged your ${totalFormatted} cost sheet.`,
                },
              },
            });
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`acknowledge chat-message / notification failed for quote=${quoteId}: ${err.message}`);
    }

    return { ok: true, parentAcknowledgedAt: updated.parentAcknowledgedAt };
  }
}
