/**
 * "You already work with this agency, so there's nothing to book."
 *
 * When Eva surfaces a new surrogate or donor, the agency that represents her is
 * often one the family has ALREADY had a consultation with. Making them book a
 * second intro call with the same agency wastes both sides' time and stalls the
 * journey, but the old flow did exactly that: session dedupe is keyed on
 * (accountUserIds, providerId, TITLE), and a new subject means a new title,
 * which meant a new booking card every time.
 *
 * So instead of a calendar, we open the subject thread directly and tell both
 * sides why there is no call to schedule.
 *
 * STATUS CHOICE - PROVIDER_CONNECTED, not CONSULTATION_BOOKED.
 * CONSULTATION_BOOKED asserts a call exists on THIS thread, and no
 * Booking.sessionId points here, so the per-thread consultation rungs would
 * render a call that does not exist. PROVIDER_CONNECTED says exactly what is
 * true - the provider is in the room and the parent's identity is revealed -
 * and is the status every downstream lookup already accepts. A new status
 * string would mean auditing every `status: { in: [...] }` list in the
 * codebase, with silent failure on any one missed.
 */
import { prisma } from "./db";
import { deriveSubjectSessionTitle } from "./subject-session-title";
import { emitJourneyEvent } from "./journey-events";
import { expandParentAccount } from "./consultation-gates";
import { formatWhen, resolveProviderTimezone } from "./src/lib/booking-when";

export interface ConnectedShortcutResult {
  sessionId: string;
  created: boolean;
  title: string | null;
}

/**
 * Open (or reuse) a thread for a new subject at an agency the family is
 * already connected to.
 *
 * @param connectedSessionId the EXISTING shared thread that proves the
 *   connection. Callers must resolve it with findConnectedProviderSession -
 *   never a bare providerId lookup, which a whisper-stamped Eva session would
 *   satisfy (see parent-visibility.ts).
 */
export async function openConnectedAgencySubjectThread(input: {
  parentUserId: string;
  providerId: string;
  connectedSessionId: string;
  subjectProfileId?: string | null;
  subjectType?: string | null;
  profileLabel?: string | null;
  profilePhotoUrl?: string | null;
  matchmakerId?: string | null;
}): Promise<ConnectedShortcutResult | null> {
  const provider = await prisma.provider
    .findUnique({ where: { id: input.providerId }, select: { id: true, name: true } })
    .catch(() => null);
  if (!provider) return null;

  const accountIds = await expandParentAccount(input.parentUserId);
  const title = await deriveSubjectSessionTitle({
    proposedLabel: input.profileLabel,
    subjectProfileId: input.subjectProfileId,
    subjectType: input.subjectType,
    providerName: provider.name,
  });

  // Same dedupe key the booking path uses, so the two can never fork.
  const existing = title
    ? await prisma.aiChatSession
        .findFirst({
          where: { userId: { in: accountIds }, providerId: provider.id, title },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        })
        .catch(() => null)
    : null;
  if (existing) return { sessionId: existing.id, created: false, title };

  const connected = await prisma.aiChatSession
    .findUnique({
      where: { id: input.connectedSessionId },
      select: { providerJoinedAt: true, matchmakerId: true },
    })
    .catch(() => null);

  const session = await prisma.aiChatSession.create({
    data: {
      userId: input.parentUserId,
      providerId: provider.id,
      providerName: provider.name,
      status: "PROVIDER_CONNECTED",
      // Must be non-null: it is half the discriminator that tells a shared
      // thread from the parent's private Eva chat, and it drives the
      // "Connected" badge in the provider inbox.
      providerJoinedAt: connected?.providerJoinedAt ?? new Date(),
      title,
      subjectProfileId: input.subjectProfileId || undefined,
      subjectType: input.subjectType || undefined,
      profilePhotoUrl: input.profilePhotoUrl || undefined,
      matchmakerId: input.matchmakerId || connected?.matchmakerId || undefined,
    },
  });

  await postConnectedAnnouncement({
    sessionId: session.id,
    parentUserId: input.parentUserId,
    accountIds,
    providerId: provider.id,
    providerName: provider.name,
    title,
    fromSessionId: input.connectedSessionId,
  });

  // The provider can talk to this family directly now, so any anonymous
  // whispers still pending elsewhere are moot. Same sweep the booking path
  // runs - without it they linger as a ghost unread on a hidden sidebar row.
  await prisma.silentQuery
    .updateMany({
      where: {
        providerId: provider.id,
        status: "PENDING",
        sessionId: { not: session.id },
        session: { userId: { in: accountIds } },
      },
      data: { status: "AUTO_RESOLVED" },
    })
    .catch(() => {});

  const providerUsers = await prisma.user
    .findMany({ where: { providerId: provider.id, isDisabled: false }, select: { id: true } })
    .catch(() => [] as any[]);
  const parentRow = await prisma.user
    .findUnique({ where: { id: input.parentUserId }, select: { firstName: true, name: true } })
    .catch(() => null);
  const parentFirst =
    (parentRow?.firstName || parentRow?.name || "").trim().split(/\s+/)[0] || "The parent";
  for (const pu of providerUsers || []) {
    await prisma.inAppNotification
      .create({
        data: {
          userId: pu.id,
          eventType: "SUBJECT_THREAD_OPENED",
          payload: {
            sessionId: session.id,
            message: `${parentFirst} is interested in ${title || "another profile"} - no new consultation needed, you're already connected.`,
          },
        },
      })
      .catch(() => {});
  }

  void emitJourneyEvent({
    eventType: "SUBJECT_THREAD_OPENED",
    parentUserId: input.parentUserId,
    providerId: provider.id,
    sessionId: session.id,
    actorRole: "system",
    metadata: {
      subjectProfileId: input.subjectProfileId ?? null,
      subjectType: input.subjectType ?? null,
      fromSessionId: input.connectedSessionId,
    },
  });

  // Deliberately NO journeyStage write and NO autoReply/parentBriefing: no
  // consultation was requested, and both of those are send-once-per-service
  // and already fired for the first call.

  console.log(
    `[CONNECTED-SHORTCUT] Opened subject thread ${session.id} ("${title}") with provider ${provider.id} - no booking required`,
  );
  return { sessionId: session.id, created: true, title };
}

/**
 * The dual-audience announcement. BOTH sides read this thread, so the parent
 * gets second person in `content` and the provider gets their own copy in
 * `uiCardData.providerContent` - a parent must never read about themselves in
 * the third person in their own chat.
 */
async function postConnectedAnnouncement(input: {
  sessionId: string;
  parentUserId: string;
  accountIds: string[];
  providerId: string;
  providerName: string;
  title: string | null;
  fromSessionId: string;
}): Promise<void> {
  const subject = input.title || "this profile";

  // The consultation that proves the connection - newest first.
  const booking = await prisma.booking
    .findFirst({
      where: {
        parentUserId: { in: input.accountIds },
        meetingSubtype: null,
        status: { notIn: ["CANCELLED", "EXPIRED"] },
        providerUser: { providerId: input.providerId },
      },
      orderBy: { scheduledAt: "desc" },
      select: { id: true, scheduledAt: true, bookerTimezone: true, providerUserId: true },
    })
    .catch(() => null);

  let parentLine: string;
  let providerLine: string;
  if (booking) {
    const providerTz = await resolveProviderTimezone(
      prisma,
      booking.providerUserId,
      booking.bookerTimezone,
    );
    const whenParent = formatWhen(booking.scheduledAt, booking.bookerTimezone);
    const whenProvider = formatWhen(booking.scheduledAt, providerTz);
    const upcoming = booking.scheduledAt.getTime() > Date.now();
    parentLine = upcoming
      ? `You're already connected with ${input.providerName}, so there's no second consultation to book. Your call on ${whenParent} covers ${subject} too - I've opened this thread so everything about her lives in one place. Message them here any time.`
      : `You're already connected with ${input.providerName} from your consultation on ${whenParent}, so there's no new call needed for ${subject}. I've opened this thread so everything about her lives in one place - message them here any time.`;
    providerLine = `${await parentFirstName(input.parentUserId)} is interested in ${subject}. You're already connected from the consultation on ${whenProvider}, so no new consultation call is needed - this thread is for ${subject} specifically.`;
  } else {
    parentLine = `You're already connected with ${input.providerName}, so there's no new consultation to book for ${subject}. I've opened this thread so everything about her lives in one place - message them here any time.`;
    providerLine = `${await parentFirstName(input.parentUserId)} is interested in ${subject}. You're already connected with this family, so no new consultation call is needed - this thread is for ${subject} specifically.`;
  }

  await prisma.aiChatMessage
    .create({
      data: {
        sessionId: input.sessionId,
        role: "assistant",
        content: parentLine,
        senderType: "system",
        senderName: "GoStork",
        uiCardData: {
          providerContent: providerLine,
          connectedShortcut: {
            fromSessionId: input.fromSessionId,
            referencedBookingId: booking?.id ?? null,
          },
        } as any,
      },
    })
    .catch((e: any) =>
      console.error(`[CONNECTED-SHORTCUT] Announcement failed: ${e?.message}`),
    );
}

async function parentFirstName(parentUserId: string): Promise<string> {
  const row = await prisma.user
    .findUnique({ where: { id: parentUserId }, select: { firstName: true, name: true } })
    .catch(() => null);
  return (row?.firstName || row?.name || "").trim().split(/\s+/)[0] || "The parent";
}
