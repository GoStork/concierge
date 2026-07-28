import { Injectable, Inject, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The private parent briefing.
 *
 * When a parent books their first consultation, the provider currently walks
 * in cold - everything the parent told Eva over dozens of messages is
 * invisible to them, so the call opens with the parent repeating themselves.
 * This posts a short briefing into the 3-way thread that ONLY the provider can
 * see, summarising who the parent is and what they are looking for.
 *
 * PRIVACY. The briefing is written from data the parent gave the platform, and
 * it is disclosed to the provider at the moment the parent books a call with
 * them - the same moment their identity is already revealed. It is posted as
 * `uiCardType: "provider_assessment"`, which PARENT_VISIBLE_SYSTEM_CARDS
 * excludes, so it is hidden from the parent's feed AND from their unread
 * count. Never widen that card type's visibility.
 *
 * NO FABRICATION. The model is given facts and told to say what is not known
 * rather than infer it. If generation fails after a retry, nothing is posted
 * and the failure is logged loudly - a hallucinated briefing about a real
 * family is far worse than no briefing.
 */

const BRIEFING_MODEL = "gemini-3.5-flash";

type ParentFacts = {
  name: string | null;
  gender: string | null;
  relationshipStatus: string | null;
  profile: Record<string, any> | null;
  conversation: string[];
  savedProfiles: string[];
};

@Injectable()
export class ParentBriefingService {
  private readonly logger = new Logger(ParentBriefingService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Everything we actually know, with empty values stripped so the model is
   *  never handed a field to guess at. */
  async gatherFacts(parentUserId: string, parentAccountId: string | null): Promise<ParentFacts> {
    const user = await this.prisma.user.findUnique({
      where: { id: parentUserId },
      select: { name: true, gender: true, relationshipStatus: true },
    });

    const profileRow = parentAccountId
      ? await this.prisma.intendedParentProfile
          .findUnique({ where: { parentAccountId } })
          .catch(() => null)
      : null;

    // Strip nulls, empty strings and empty arrays: a field we never captured
    // must not appear in the prompt at all, or the model will pad around it.
    let profile: Record<string, any> | null = null;
    if (profileRow) {
      profile = {};
      for (const [k, v] of Object.entries(profileRow as Record<string, any>)) {
        if (["id", "parentAccountId", "createdAt", "updatedAt"].includes(k)) continue;
        if (v === null || v === undefined || v === "") continue;
        if (Array.isArray(v) && v.length === 0) continue;
        profile[k] = v;
      }
      if (Object.keys(profile).length === 0) profile = null;
    }

    // The parent's own words carry the intent that structured fields miss.
    const accountUserIds = parentAccountId
      ? (
          await this.prisma.user.findMany({
            where: { parentAccountId },
            select: { id: true },
          })
        ).map((u: any) => u.id)
      : [parentUserId];

    const messages = await this.prisma.aiChatMessage
      .findMany({
        where: {
          session: { userId: { in: accountUserIds }, providerId: null },
          senderType: "parent",
        },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: { content: true, senderName: true },
      })
      .catch(() => []);

    const conversation = messages
      .reverse()
      .map((m: any) => `${m.senderName || "Parent"}: ${String(m.content || "").trim()}`)
      .filter((l: string) => l.length > 12);

    // What they saved tells you what they actually liked, not what they said.
    const saved = await this.prisma.userProfilePreference
      .findMany({
        where: { userId: { in: accountUserIds }, type: "favorite" },
        take: 20,
        select: { entityType: true, entityId: true },
      })
      .catch(() => []);
    const savedProfiles = saved.map((s: any) => `${s.entityType} ${s.entityId}`);

    return {
      name: user?.name || null,
      gender: user?.gender || null,
      relationshipStatus: user?.relationshipStatus || null,
      profile,
      conversation,
      savedProfiles,
    };
  }

  /** True when there is enough to say something worth a provider's time. */
  private hasEnough(facts: ParentFacts): boolean {
    const profileFields = facts.profile ? Object.keys(facts.profile).length : 0;
    return profileFields >= 3 || facts.conversation.length >= 4;
  }

  private buildPrompt(facts: ParentFacts, providerName: string, serviceName: string | null): string {
    return [
      `You are writing a short private briefing for ${providerName}, who has just had a consultation booked by an intended parent on GoStork.`,
      serviceName ? `The call is about their ${serviceName} service.` : "",
      "",
      "WHAT THIS IS: the provider has never spoken to this family. Tell them what they need to walk into the call already informed, so the parent does not have to repeat themselves.",
      "",
      "RULES - these matter more than style:",
      "- Use ONLY the facts below. Never infer, extrapolate or fill gaps.",
      "- If something important is not known, say so plainly (e.g. \"Budget not discussed\"). Do NOT guess.",
      "- No greeting, no sign-off, no invented names or numbers.",
      "- Write for a busy professional: short lead paragraph, then 3-6 bullet points.",
      "- Use **bold** for the bullet labels. Plain text otherwise.",
      "- Do not tell the provider what to do or how to sell. Report only.",
      "- Under 180 words.",
      "",
      "FACTS:",
      `Parent name: ${facts.name || "unknown"}`,
      facts.gender ? `Gender: ${facts.gender}` : "",
      facts.relationshipStatus ? `Relationship status: ${facts.relationshipStatus}` : "",
      facts.profile ? `Structured profile: ${JSON.stringify(facts.profile)}` : "No structured profile on file.",
      facts.savedProfiles.length ? `Profiles they saved as favourites: ${facts.savedProfiles.length}` : "",
      "",
      facts.conversation.length
        ? `THEIR OWN WORDS (most recent last):\n${facts.conversation.join("\n").slice(0, 12000)}`
        : "They have not written anything in chat yet.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** One retry: Gemini intermittently returns empty. Beyond that, fail loudly. */
  private async generate(prompt: string): Promise<string | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.error("[parent-briefing] GEMINI_API_KEY not configured - no briefing sent");
      return null;
    }
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: BRIEFING_MODEL,
      // thinkingBudget 0 is not optional here. Gemini's hidden reasoning phase
      // draws from the SAME output budget, so with it enabled the briefing came
      // back truncated mid-bullet ("...using her own eggs.\n\n*") - a partial
      // answer that still looks like a successful response. Same trap the Tier 2
      // router documents at ai-router.ts:517.
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await model.generateContent(prompt);
        const text = (res.response.text() || "").trim();
        // Guard the truncation case directly: a body that ends mid-bullet or
        // mid-sentence is a failure wearing a success costume.
        const looksTruncated = /[*\-]\s*$/.test(text) || (text.length > 40 && !/[.!?)"']$/.test(text));
        if (text.length > 40 && !looksTruncated) return text;
        this.logger.warn(
          looksTruncated
            ? `[parent-briefing] Attempt ${attempt} came back truncated (${text.length} chars)`
            : `[parent-briefing] Attempt ${attempt} returned only ${text.length} chars`,
        );
      } catch (e: any) {
        this.logger.warn(`[parent-briefing] Attempt ${attempt} failed: ${e?.message}`);
      }
      if (attempt === 1) await new Promise((r) => setTimeout(r, 800));
    }
    return null;
  }

  /**
   * Compose and post the briefing. Once per parent + provider + service line,
   * guarded by a unique index so a duplicate booking cannot double-post.
   *
   * Returns true when a briefing was posted. Never throws.
   */
  async sendForBooking(opts: {
    providerId: string;
    providerName?: string | null;
    providerTypeId?: string | null;
    serviceName?: string | null;
    sessionId: string;
    parentUserId: string;
    parentAccountId?: string | null;
    bookingId?: string | null;
  }): Promise<boolean> {
    try {
      const existing = await this.prisma.providerParentBriefing.findFirst({
        where: {
          providerId: opts.providerId,
          providerTypeId: opts.providerTypeId ?? null,
          ...(opts.parentAccountId
            ? { parentAccountId: opts.parentAccountId }
            : { parentAccountId: null, parentUserId: opts.parentUserId }),
        },
        select: { id: true },
      });
      if (existing) return false;

      const serviceName = opts.serviceName
        ?? (opts.providerTypeId
          ? (await this.prisma.providerType
              .findUnique({ where: { id: opts.providerTypeId }, select: { name: true } })
              .catch(() => null))?.name ?? null
          : null);

      const facts = await this.gatherFacts(opts.parentUserId, opts.parentAccountId || null);
      if (!this.hasEnough(facts)) {
        this.logger.log(
          `[parent-briefing] Too little known about ${opts.parentUserId} to brief ${opts.providerId} - skipping`,
        );
        return false;
      }

      const text = await this.generate(
        this.buildPrompt(facts, opts.providerName || "the provider", serviceName),
      );
      if (!text) {
        // Loud, and nothing posted. A stub here would read as fact.
        this.logger.error(
          `[parent-briefing] Generation FAILED for parent ${opts.parentUserId} / provider ${opts.providerId} - no briefing posted`,
        );
        return false;
      }

      // Claim the slot before posting so a concurrent booking cannot double-post.
      let row: any;
      try {
        row = await this.prisma.providerParentBriefing.create({
          data: {
            providerId: opts.providerId,
            parentAccountId: opts.parentAccountId || null,
            parentUserId: opts.parentUserId,
            providerTypeId: opts.providerTypeId ?? null,
            sessionId: opts.sessionId,
            bookingId: opts.bookingId || null,
          },
        });
      } catch (e: any) {
        this.logger.log(`[parent-briefing] Lost the send race - skipping (${e?.message})`);
        return false;
      }

      const message = await this.prisma.aiChatMessage.create({
        data: {
          sessionId: opts.sessionId,
          role: "assistant",
          content: `**Private briefing - only you can see this**\n\n${text}`,
          senderType: "system",
          senderName: "GoStork",
          // The card type is what keeps this off the parent's screen. See
          // PARENT_VISIBLE_SYSTEM_CARDS in server/parent-visibility.ts.
          uiCardType: "provider_assessment",
          uiCardData: { parentBriefing: true } as any,
        },
      });

      await this.prisma.providerParentBriefing
        .update({ where: { id: row.id }, data: { messageId: message.id } })
        .catch(() => {});

      this.logger.log(
        `[parent-briefing] Posted briefing ${row.id} into session ${opts.sessionId} for provider ${opts.providerId}`,
      );
      return true;
    } catch (e: any) {
      this.logger.warn(`[parent-briefing] Send failed for session ${opts.sessionId}: ${e?.message}`);
      return false;
    }
  }
}
