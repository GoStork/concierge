/**
 * The parent record: one payload, two audiences.
 *
 * /parents/:id renders from a single component tree for BOTH a GoStork admin
 * and a provider staff user. That is the whole point - before this, an admin
 * clicking a parent landed on the account-admin form (password, calendar link)
 * and saw none of the journey a provider could see, and the two surfaces
 * drifted apart. One payload means they cannot drift again.
 *
 * The difference between the two readers lives HERE, on the server:
 *
 *   admin    - GATES_OPEN, every provider org, every profile, global counts.
 *   provider - the two gates from parent-privacy.ts, and everything force-
 *              scoped to their own org.
 *
 * Force-scoped means `providerId` appears in the WHERE clause of every query,
 * never as a post-`.filter()` on materialised rows. That is not stylistic: the
 * Gate A bug in the parents table happened precisely because a value was
 * computed onto a row first and filtered afterwards.
 */

import { serviceKeysFromLabels } from "../shared/service-keys";
import { prisma } from "./db";
import { JOURNEY_STAGE_ORDER, resolveJourneyStage } from "../shared/journey-ladder";
import {
  GATES_OPEN,
  ParentGates,
  parentAccountKey,
  redactParentContact,
  redactParentMembers,
  resolveParentGates,
} from "./parent-privacy";
import { isGostorkStaff } from "./parent-crm";

export class ParentRecordError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ParentRecordError";
  }
}

export type RecordSection = "identity" | "interests" | "money" | "crm" | "providers";

const ALL_SECTIONS: RecordSection[] = ["identity", "providers", "interests", "money", "crm"];

/** The journey ladder, most-advanced first. Mirrors the parents-table derivation. */

// Everything the parent maintains on /account that a connected provider may
// see. Shared by the record payload here AND both chat-session payloads in
// chat-router (imported there) - one list, never three.
export const IP_PROFILE_SELECT = {
  journeyStage: true, interestedServices: true, isFirstIvf: true,
  eggSource: true, spermSource: true, carrier: true, hasEmbryos: true,
  embryoCount: true, embryosTested: true, needsClinic: true,
  currentClinicName: true, clinicPriority: true, needsEggDonor: true,
  needsSurrogate: true, surrogateCountries: true, surrogateTermination: true,
  surrogateTwins: true, surrogateAgeRange: true, surrogateBudget: true,
  surrogateExperience: true, surrogateMedPrefs: true,
  surrogateRace: true, surrogateEthnicity: true, surrogateRelationship: true,
  surrogateBmiRange: true, surrogateTotalCostRange: true, surrogateLiveBirthsRange: true,
  surrogateMaxCSections: true, surrogateMaxMiscarriages: true, surrogateMaxAbortions: true,
  surrogateLastDeliveryYear: true, surrogateCovidVaccinated: true,
  surrogateSelectiveReduction: true, surrogateInternationalParents: true,
  donorPreferences: true,
  donorEyeColor: true, donorHairColor: true, donorHeight: true,
  donorEducation: true, donorEthnicity: true,
  eggDonorAgeRange: true, eggDonorCompensationRange: true, eggDonorTotalCostRange: true,
  eggDonorLotCostRange: true, eggDonorEggType: true, eggDonorDonationType: true,
  spermDonorType: true, spermDonorPreferences: true, spermDonorAgeRange: true,
  spermDonorEyeColor: true, spermDonorHairColor: true, spermDonorHeightRange: true,
  spermDonorRace: true, spermDonorEthnicity: true, spermDonorEducation: true,
  spermDonorMaxPrice: true, spermDonorVialType: true, spermDonorCovidVaccinated: true,
  clinicAgeGroup: true, clinicPriorityTags: true, clinicReason: true,
  diagnoses: true, insurance: true,
  sameSexCouple: true, isLGBTQ: true,
  currentAgencyName: true, currentAttorneyName: true,
} as const;

export type SubjectKind =
  | "egg-donor" | "surrogate" | "sperm-donor"
  | "clinic" | "agency" | "doctor" | "none";

/** AiChatSession.subjectType is free text. Normalise it once, here. */
export function classifySubject(subjectType: string | null | undefined): SubjectKind {
  const t = (subjectType || "").toLowerCase();
  if (!t) return "none";
  if (t.includes("surrog")) return "surrogate";
  if (t.includes("sperm")) return "sperm-donor";
  if (t.includes("egg") || t.includes("donor")) return "egg-donor";
  if (t.includes("doctor")) return "doctor";
  if (t.includes("clinic") || t.includes("ivf")) return "clinic";
  if (t.includes("agency")) return "agency";
  return "none";
}

/** Service key for the table's service chips, from the same subject string. */
function serviceTypeFor(kind: SubjectKind): string | null {
  switch (kind) {
    case "egg-donor": return "EGG_DONATION";
    case "surrogate": return "SURROGACY";
    case "sperm-donor": return "SPERM_DONATION";
    case "clinic": case "doctor": return "IVF_CLINIC";
    default: return null;
  }
}

/**
 * The client route for a profile. Built server-side so the record page never
 * has to re-derive it, and so all three shapes live in one place.
 * Verified against client/src/App.tsx: donors carry the provider in the path,
 * clinics and agencies are /providers/:id, doctors are /doctors/:slug.
 */
function profileUrlFor(
  kind: SubjectKind,
  providerId: string | null,
  profileId: string | null,
  slug?: string | null,
  // Admins get the internal provider page, which carries every tab (services,
  // staff, cost sheets, settings) rather than the public marketing profile.
  isAdmin = false,
): string | null {
  const org = (id: string) => (isAdmin ? `/admin/providers/${id}` : `/providers/${id}`);
  switch (kind) {
    case "egg-donor": return providerId && profileId ? `/eggdonor/${providerId}/${profileId}` : null;
    case "surrogate": return providerId && profileId ? `/surrogate/${providerId}/${profileId}` : null;
    case "sperm-donor": return providerId && profileId ? `/spermdonor/${providerId}/${profileId}` : null;
    case "clinic": case "agency": return providerId ? org(providerId) : null;
    case "doctor": return slug ? `/doctors/${slug}` : null;
    default:
      // A concierge thread has no subject profile, but it still belongs to an
      // org - IFLG and Bioetica rendered with no Profile link at all because
      // this returned null. The row IS about that provider, so link to them.
      return providerId ? org(providerId) : null;
  }
}

/** "Donor #10423" / "Surrogate #25714", matching buildTitle on the client. */
function displayNameFor(kind: SubjectKind, row: { id: string; externalId?: string | null }): string {
  const label = kind === "surrogate" ? "Surrogate" : "Donor";
  const raw = row.externalId || row.id.slice(0, 8);
  return `${label} #${String(raw).replace(/^[A-Za-z]+-/, "")}`;
}

function firstPhoto(photos: string[] | null | undefined, photoUrl: string | null | undefined): string | null {
  if (Array.isArray(photos)) {
    const hit = photos.find((p) => typeof p === "string" && p.trim().length > 0);
    if (hit) return hit;
  }
  return photoUrl || null;
}

export interface BuildOpts {
  sections?: RecordSection[];
}

/**
 * Build the record. Throws ParentRecordError(403 / 404); the router maps it.
 */

/**
 * One enriched entry per thing that happened to this family.
 *
 * Journey events are the spine - they are the only append-only record of the
 * order things happened in - but they carry IDs, not content. A card that
 * says "Invoice sent" without saying which invoice, for how much, or linking
 * to it is a card nobody can act on. So each event is joined to the object it
 * refers to here, server-side, for two reasons:
 *
 *  - a client-side join would be one fetch per card;
 *  - the scoping that keeps a provider inside their own org lives on this
 *    side of the wire, and a detail payload is exactly the thing that must
 *    not leak across it.
 *
 * MESSAGE CONTENT: Notification now stores the subject, the rendered HTML and
 * a plain-text version, captured at dispatch. Rows written before those
 * columns existed have none, and cannot get any - buildBrandedEmail resolves
 * brand settings, links and one-time tokens at send time, so an old row
 * cannot be faithfully re-rendered. Those cards say so instead of guessing.
 */
async function buildActivity(ctx: {
  prisma: any;
  accountKey: string;
  memberIds: string[];
  isAdmin: boolean;
  scopeProviderId: string | null;
  orgById: Map<string, any>;
  invoices: any[];
  agreements: any[];
  quotes: any[];
  ipFormRow: any;
  bookings: any[];
}): Promise<any[]> {
  const { prisma, accountKey, memberIds, isAdmin, scopeProviderId, orgById } = ctx;
  const scoped = scopeProviderId ? { providerId: scopeProviderId } : {};

  const bookings = ctx.bookings;
  const [events, reviews, notifications, matchmakers] = await Promise.all([
    prisma.journeyEvent.findMany({
      where: { parentAccountId: accountKey, ...scoped },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.providerReview.findMany({
      where: {
        OR: [{ parentAccountId: accountKey }, { authorUserId: { in: memberIds } }],
        ...scoped,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.notification.findMany({
      where: { userId: { in: memberIds } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.matchmaker.findMany({ where: { isActive: true }, select: { id: true, name: true, avatarUrl: true } }),
  ]);

  const sessionPersonaId = (await prisma.aiChatSession.findFirst({
    where: { userId: { in: memberIds }, matchmakerId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { matchmakerId: true },
  }))?.matchmakerId ?? null;
  const persona = matchmakers.find((m: any) => m.id === sessionPersonaId) || matchmakers[0] || null;

  const bookingById = new Map<string, any>(bookings.map((b: any) => [b.id, b]));
  const invoiceById = new Map<string, any>(ctx.invoices.map((i: any) => [i.id, i]));
  const agreementById = new Map<string, any>(ctx.agreements.map((a: any) => [a.id, a]));
  const quoteById = new Map<string, any>(ctx.quotes.map((q: any) => [q.id, q]));
  const notifByBooking = new Map<string, any[]>();
  for (const n of notifications) {
    if (!n.bookingId || !bookingById.has(n.bookingId)) continue;
    const list = notifByBooking.get(n.bookingId) || [];
    list.push(n);
    notifByBooking.set(n.bookingId, list);
  }

  const money = (m: any) => (typeof m === "number" ? m : null);

  const out: any[] = [];

  for (const ev of events) {
    const meta = (ev.metadata || {}) as Record<string, any>;
    const org = ev.providerId ? orgById.get(ev.providerId) : null;
    const entry: any = {
      id: ev.id,
      at: ev.createdAt,
      eventType: ev.eventType,
      actorRole: ev.actorRole,
      providerId: ev.providerId,
      providerName: org?.name ?? null,
      sessionId: ev.sessionId,
      aiName: persona?.name ?? null,
      aiAvatarUrl: persona?.avatarUrl ?? null,
      detail: null as any,
    };

    // Meeting: the whole booking, so the card can carry the same actions the
    // booking widget offers everywhere else.
    const booking = ev.bookingId ? bookingById.get(ev.bookingId) : null;
    if (booking) {
      entry.detail = {
        type: "booking",
        bookingId: booking.id,
        scheduledAt: booking.scheduledAt,
        durationMinutes: booking.duration ?? null,
        status: booking.status,
        outcome: booking.outcome ?? null,
        meetingType: booking.meetingType,
        meetingSubtype: booking.meetingSubtype ?? null,
        meetingUrl: booking.meetingUrl ?? null,
        timezone: booking.bookerTimezone ?? null,
        notes: booking.notes ?? null,
        // The whole row, so the record can mount the SAME booking widget the
        // chats use rather than growing a second one with its own subset of
        // the actions. Already scoped to this viewer's org by the query that
        // loaded it - see the bookings fetch in buildParentRecord.
        booking,
      };
    }

    const invoice = meta.invoiceId ? invoiceById.get(meta.invoiceId) : null;
    if (invoice) {
      entry.detail = {
        type: "invoice",
        invoiceId: invoice.id,
        status: invoice.status,
        amountCents: money(invoice.serviceAmount),
        dueAt: invoice.dueAt ?? null,
        paymentUrl: invoice.paymentToken ? `/pay/${invoice.paymentToken}` : null,
        description: invoice.description ?? null,
      };
    }

    const agreement = meta.agreementId ? agreementById.get(meta.agreementId) : null;
    if (agreement) {
      entry.detail = {
        type: "agreement",
        agreementId: agreement.id,
        status: agreement.status,
        // pandaDocViewUrl is the signer-facing document; there is no separate
        // stored PDF url on this model.
        documentUrl: agreement.pandaDocViewUrl ?? null,
        signerStatus: agreement.signerStatus ?? null,
      };
    }

    const quote = meta.quoteId || meta.costSheetId
      ? quoteById.get(meta.quoteId || meta.costSheetId)
      : null;
    if (quote) {
      entry.detail = {
        type: "cost_sheet",
        quoteId: quote.id,
        totalCostCents: money(quote.totalCostCents),
        fileUrl: quote.costSheetFileUrl ?? null,
        fileName: quote.costSheetFileName ?? null,
        notes: quote.notes ?? null,
      };
    }

    if (ev.eventType === "REVIEW_SUBMITTED" || ev.eventType === "REVIEW_UPDATED") {
      const r = reviews.find((x: any) => x.id === meta.reviewId) || reviews[0] || null;
      if (r) {
        entry.detail = {
          type: "review",
          reviewId: r.id,
          rating: r.rating ?? null,
          recommendation: r.recommendation,
          bodyText: r.bodyText ?? null,
          providerId: r.providerId,
          memberId: r.memberId ?? null,
          hasResponse: !!r.providerReply,
          responseText: r.providerReply ?? null,
        };
      }
    }

    if (ev.eventType === "IP_FORM_SUBMITTED" && ctx.ipFormRow) {
      entry.detail = {
        type: "ip_form",
        responseId: ctx.ipFormRow.id,
        submittedAt: ctx.ipFormRow.submittedAt,
      };
    }

    out.push(entry);
  }

  // The booking's CURRENT status is only true of its most recent event. Shown
  // on every one, a "Consultation scheduled" card read "CONFIRMED -
  // COMPLETED", which is both wrong about that moment and made two genuinely
  // different cards look like the same card twice.
  const newestEventPerBooking = new Set<string>();
  for (const e of out) {
    const d = e.detail;
    if (d?.type !== "booking") continue;
    if (newestEventPerBooking.has(d.bookingId)) {
      d.isCurrentState = false;
    } else {
      newestEventPerBooking.add(d.bookingId);
      d.isCurrentState = true;
    }
  }

  // Every message that went out is its own entry. Folded into the meeting card
  // as "10 sent (four kinds)" it was a number nobody could act on; as rows it
  // is a delivery log you can scan.
  for (const n of notifications) {
    if (n.bookingId && !bookingById.has(n.bookingId)) continue;   // out of scope
    const b = n.bookingId ? bookingById.get(n.bookingId) : null;
    out.push({
      id: `notif-${n.id}`,
      at: n.sentAt || n.createdAt,
      eventType: n.channel === "SMS" || n.type === "SMS" ? "MESSAGE_SMS" : "MESSAGE_EMAIL",
      actorRole: "system",
      providerId: b?.providerId ?? null,
      providerName: null,
      sessionId: null,
      aiName: persona?.name ?? null,
      aiAvatarUrl: persona?.avatarUrl ?? null,
      detail: {
        type: "message",
        notificationId: n.id,
        channel: n.type,
        kind: n.channel,
        recipient: n.recipient,
        status: n.status,
        sentAt: n.sentAt,
        bookingId: n.bookingId ?? null,
        subject: n.subject ?? null,
        // A preview only - the full HTML is served by the preview route, so a
        // record with 100 emails does not ship 100 rendered documents.
        bodyPreview: n.bodyText ? String(n.bodyText).slice(0, 400) : null,
        hasHtml: !!n.bodyHtml,
        // False on every row written before the content columns existed. The
        // card says so rather than inventing a body.
        contentStored: !!(n.subject || n.bodyText || n.bodyHtml),
      },
    });
  }

  return out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export async function buildParentRecord(user: any, parentUserId: string, opts: BuildOpts = {}) {
  const sections = new Set(opts.sections?.length ? opts.sections : ALL_SECTIONS);
  const isAdmin = isGostorkStaff(user);
  const scopeProviderId: string | null = isAdmin ? null : (user?.providerId ?? null);
  if (!isAdmin && !scopeProviderId) throw new ParentRecordError(403, "Forbidden");

  // ── Phase 0: the parent and every login on their account, in two queries ──
  const targetUser = await prisma.user.findUnique({
    where: { id: parentUserId },
    select: { id: true, parentAccountId: true },
  });
  if (!targetUser) throw new ParentRecordError(404, "Parent not found");
  const accountKey = parentAccountKey(targetUser);

  // One query for BOTH the id list and the member DTOs. The endpoint this
  // replaces queried the account twice for exactly these two things.
  const members = await prisma.user.findMany({
    where: targetUser.parentAccountId
      ? { parentAccountId: targetUser.parentAccountId, roles: { has: "PARENT" } }
      : { id: parentUserId },
    select: {
      id: true, name: true, email: true, mobileNumber: true, photoUrl: true, createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const memberIds = members.length ? members.map((m) => m.id) : [parentUserId];

  // ── Phase 1: releases. Serves the access check, the per-org chips and the
  // admin's cross-org map in a single indexed read.
  const releases = await prisma.parentContactRelease.findMany({
    where: { parentAccountId: accountKey, ...(scopeProviderId ? { providerId: scopeProviderId } : {}) },
    select: { providerId: true, reason: true, releasedAt: true },
  });
  const releaseByProvider = new Map(releases.map((r) => [r.providerId, r]));

  // ── Phase 2: the evidence, one round trip ────────────────────────────────
  const sessionWhere: any = { userId: { in: memberIds } };
  if (scopeProviderId) sessionWhere.providerId = scopeProviderId;

  const [sessions, bookings, invoices, agreements, quotes, ipFormRow] = await Promise.all([
    prisma.aiChatSession.findMany({
      where: sessionWhere,
      select: {
        id: true, userId: true, status: true, providerId: true, subjectProfileId: true,
        subjectType: true, createdAt: true, updatedAt: true, providerJoinedAt: true,
        handoffCompletedAt: true, historySummary: true,
        messages: {
          select: { content: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.booking.findMany({
      where: {
        parentUserId: { in: memberIds },
        ...(scopeProviderId ? { providerUser: { providerId: scopeProviderId } } : {}),
      },
      // Wide enough for the shared booking widget the activity timeline mounts
      // (InlineBookingNotification): it renders duration, subject, the meeting
      // link and both participants, and a thinner row made it print
      // "undefined min" next to two people called "Parent" and "Provider".
      //
      // parentUser.email is deliberately NOT selected. It is Gate B data that
      // redactParentContact withholds elsewhere on this very payload; putting
      // it back through a booking relation would route around the gate.
      select: {
        id: true, meetingSubtype: true, meetingType: true, status: true, outcome: true,
        scheduledAt: true, duration: true, sessionId: true, subject: true, notes: true,
        meetingUrl: true, publicToken: true, bookerTimezone: true, createdAt: true,
        providerUser: {
          select: {
            id: true, name: true, photoUrl: true, providerId: true, dailyRoomUrl: true,
            provider: { select: { id: true, name: true } },
          },
        },
        // photoUrl, so the booking widget shows the family's face rather than a
        // monogram. Not Gate B data - the photo already renders in this same
        // payload's header; email and phone are what the gate withholds.
        parentUser: { select: { id: true, name: true, photoUrl: true } },
      },
      orderBy: { scheduledAt: "desc" },
    }),
    prisma.invoice.findMany({
      where: { parentUserId: { in: memberIds }, ...(scopeProviderId ? { providerId: scopeProviderId } : {}) },
      select: {
        id: true, providerId: true, sessionId: true, serviceType: true, serviceAmount: true,
        status: true, paidAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.agreement.findMany({
      where: { parentUserId: { in: memberIds }, ...(scopeProviderId ? { providerId: scopeProviderId } : {}) },
      select: {
        id: true, providerId: true, sessionId: true, status: true, documentType: true,
        serviceType: true, signedAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.providerQuote.findMany({
      where: { parentUserId: { in: memberIds }, ...(scopeProviderId ? { providerId: scopeProviderId } : {}) },
      select: {
        id: true, providerId: true, sessionId: true, totalCostCents: true,
        supersededAt: true, parentAcknowledgedAt: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.ipFormResponse.findUnique({
      where: { parentAccountId: accountKey },
      select: { id: true, status: true, submittedAt: true, promptedAt: true },
    }).catch(() => null),
  ]);

  // ── Access check ─────────────────────────────────────────────────────────
  // Same three-way test the endpoint this replaces used, but derived from data
  // already in hand rather than three more queries: a shared session, a
  // contact release, or a booking with this org's staff.
  if (!isAdmin) {
    const sharedSession = sessions.some(
      (s) => s.providerId === scopeProviderId && ["PROVIDER_CONNECTED", "CONSULTATION_BOOKED"].includes(s.status),
    );
    const hasBooking = bookings.some((b) => b.providerUser?.providerId === scopeProviderId);
    if (!sharedSession && !releaseByProvider.has(scopeProviderId as string) && !hasBooking) {
      throw new ParentRecordError(403, "Forbidden");
    }
  }

  // ── Gates ────────────────────────────────────────────────────────────────
  const gates: ParentGates = isAdmin
    ? GATES_OPEN
    : await resolveParentGates(scopeProviderId, accountKey, {
        sessionStatus: null,
        // The access check above already proved a relationship exists.
        hasBooking: true,
      });

  // ── Phase 3: hydrate every referenced profile, one query per type ────────
  // The id set is the UNION of chat subjects and saved favourites. Hydrating
  // the two separately would double this phase.
  const savedDonorRows = sections.has("interests")
    ? await prisma.userDonorPreference.findMany({
        where: { userId: { in: memberIds }, type: "favorite" },
        select: { donorId: true, userId: true, createdAt: true },
      })
    : [];
  const savedProfileRows = sections.has("interests")
    ? await prisma.userProfilePreference.findMany({
        where: { userId: { in: memberIds }, type: "favorite" },
        select: { entityType: true, entityId: true, userId: true, createdAt: true },
      })
    : [];

  const donorLikeIds = new Set<string>();
  for (const s of sessions) if (s.subjectProfileId) donorLikeIds.add(s.subjectProfileId);
  for (const d of savedDonorRows) donorLikeIds.add(d.donorId);
  const idList = Array.from(donorLikeIds);

  // Doctor threads carry a SLUG in subjectProfileId, not a uuid, and doctors
  // live in ProviderMember rather than any donor table - so they need their own
  // lookup or a doctor thread renders under the clinic's name with no link.
  const doctorSlugs = Array.from(new Set(
    sessions
      .filter((s2) => classifySubject(s2.subjectType) === "doctor" && s2.subjectProfileId)
      .map((s2) => s2.subjectProfileId as string),
  ));
  const doctors = doctorSlugs.length
    ? await prisma.providerMember.findMany({
        where: { slug: { in: doctorSlugs } },
        select: { slug: true, name: true, title: true, photoUrl: true, providerId: true },
      })
    : [];
  const doctorBySlug = new Map(doctors.map((d) => [d.slug as string, d]));

  const [eggDonors, surrogates, spermDonors] = idList.length
    ? await Promise.all([
        prisma.eggDonor.findMany({
          where: { id: { in: idList } },
          select: { id: true, providerId: true, externalId: true, photos: true, photoUrl: true, status: true },
        }),
        prisma.surrogate.findMany({
          where: { id: { in: idList } },
          select: { id: true, providerId: true, externalId: true, photos: true, photoUrl: true, status: true },
        }),
        prisma.spermDonor.findMany({
          where: { id: { in: idList } },
          select: { id: true, providerId: true, externalId: true, photoUrl: true, status: true },
        }),
      ])
    : [[], [], []];

  type Hydrated = { id: string; providerId: string; externalId: string | null; photo: string | null; status: string | null; kind: SubjectKind };
  const profileById = new Map<string, Hydrated>();
  for (const d of eggDonors) profileById.set(d.id, { id: d.id, providerId: d.providerId, externalId: d.externalId, photo: firstPhoto(d.photos, d.photoUrl), status: d.status, kind: "egg-donor" });
  for (const s of surrogates) profileById.set(s.id, { id: s.id, providerId: s.providerId, externalId: s.externalId, photo: firstPhoto(s.photos, s.photoUrl), status: s.status, kind: "surrogate" });
  for (const p of spermDonors) profileById.set(p.id, { id: p.id, providerId: p.providerId, externalId: p.externalId, photo: firstPhoto(null, p.photoUrl), status: p.status, kind: "sperm-donor" });

  // Every provider org referenced anywhere in the record.
  const orgIds = new Set<string>();
  for (const s of sessions) if (s.providerId) orgIds.add(s.providerId);
  for (const b of bookings) if (b.providerUser?.providerId) orgIds.add(b.providerUser.providerId);
  for (const i of invoices) orgIds.add(i.providerId);
  for (const a of agreements) orgIds.add(a.providerId);
  for (const q of quotes) orgIds.add(q.providerId);
  for (const p of profileById.values()) orgIds.add(p.providerId);
  for (const r of savedProfileRows) if (r.entityType === "clinic" || r.entityType === "agency") orgIds.add(r.entityId);
  if (scopeProviderId) orgIds.add(scopeProviderId);

  const orgs = orgIds.size
    ? await prisma.provider.findMany({
        where: { id: { in: Array.from(orgIds) } },
        select: { id: true, name: true, logoUrl: true },
      })
    : [];
  const orgById = new Map(orgs.map((o) => [o.id, o]));

  // ── Journey status, per session and per org ──────────────────────────────
  const handedOff = sessions.some((s) => s.handoffCompletedAt);
  const matchCallOrgs = new Set(
    bookings
      .filter((b) => b.meetingSubtype === "MATCH_CALL" && !["CANCELLED", "DECLINED", "RESCHEDULED", "EXPIRED"].includes(b.status))
      .map((b) => b.providerUser?.providerId)
      .filter(Boolean) as string[],
  );
  const paidSessions = new Set(invoices.filter((i) => i.status === "PAID").map((i) => i.sessionId).filter(Boolean) as string[]);
  const signedSessions = new Set(agreements.filter((a) => a.status === "SIGNED").map((a) => a.sessionId).filter(Boolean) as string[]);
  const agreementSessions = new Set(agreements.map((a) => a.sessionId).filter(Boolean) as string[]);
  const invoiceSessions = new Set(invoices.map((i) => i.sessionId).filter(Boolean) as string[]);
  // Same predicate the timeline uses. Relationship-level: bookings are not
  // session-linked, so a completed consultation counts for the family.
  const consultCompleted = bookings.some(
    (b: any) => b.meetingSubtype !== "MATCH_CALL" && (b.outcome === "COMPLETED" || b.outcome === "UNVERIFIED"),
  );

  // The record was a THIRD copy of the ladder, alongside the two list
  // endpoints and the timeline. All of them now resolve through
  // shared/journey-ladder.ts, so the header badge, the table column and the
  // timeline cannot name different rungs for the same family.
  function sessionStatus(s: (typeof sessions)[number]): string | null {
    const prof = s.subjectProfileId ? profileById.get(s.subjectProfileId) : null;
    return resolveJourneyStage({
      handedOff: !!s.handoffCompletedAt || handedOff,
      agreementSigned: signedSessions.has(s.id),
      agreementSent: agreementSessions.has(s.id),
      invoicePaid: paidSessions.has(s.id),
      invoiceSent: invoiceSessions.has(s.id),
      matched: !!(prof && prof.kind === "surrogate" && prof.status === "MATCHED"),
      matchCallScheduled: !!(s.providerId && matchCallOrgs.has(s.providerId)),
      ipFormSubmitted: ipFormRow?.status === "SUBMITTED",
      consultCompleted: consultCompleted,
      consultScheduled: s.status === "CONSULTATION_BOOKED",
      connected: s.status === "PROVIDER_CONNECTED" || !!s.providerJoinedAt,
    });
  }

  function mostAdvanced(values: string[]): string | null {
    const order = JOURNEY_STAGE_ORDER as readonly string[];
    return values.reduce<string | null>(
      (best, v) => (order.indexOf(v) > order.indexOf(best ?? "") ? v : best),
      null,
    );
  }

  // ── Conversations ────────────────────────────────────────────────────────
  const conversations = sessions.map((s) => {
    const kind = classifySubject(s.subjectType);
    const prof = s.subjectProfileId ? profileById.get(s.subjectProfileId) : null;
    const org = s.providerId ? orgById.get(s.providerId) : null;
    const resolvedKind: SubjectKind = prof ? prof.kind : kind;
    const doc = resolvedKind === "doctor" && s.subjectProfileId
      ? doctorBySlug.get(s.subjectProfileId)
      : null;
    const displayName = prof
      ? displayNameFor(prof.kind, prof)
      : doc
        ? doc.name
        : resolvedKind === "clinic" || resolvedKind === "agency"
          ? (org?.name || "Provider")
          : org?.name || "GoStork concierge";
    return {
      sessionId: s.id,
      providerId: s.providerId,
      providerName: org?.name ?? null,
      providerLogoUrl: org?.logoUrl ?? null,
      subjectKind: resolvedKind,
      subjectProfileId: s.subjectProfileId,
      displayName,
      photoUrl: prof?.photo ?? doc?.photoUrl ?? org?.logoUrl ?? null,
      profileStatus: prof?.status ?? null,
      // A doctor's subjectProfileId is a SLUG, not a uuid - /doctors/:slug is
      // keyed that way. Passing null here meant every doctor thread rendered
      // with no Profile link at all.
      profileUrl: profileUrlFor(
        resolvedKind,
        prof?.providerId ?? s.providerId,
        s.subjectProfileId,
        resolvedKind === "doctor" ? s.subjectProfileId : null,
        isAdmin,
      ),
      serviceType: serviceTypeFor(resolvedKind),
      matchStatus: sessionStatus(s),
      rawStatus: s.status,
      lastMessagePreview: s.messages[0]?.content
        ? String(s.messages[0].content).replace(/\[\[.*?\]\]/g, "").replace(/\n/g, " ").trim().slice(0, 120)
        : null,
      // Admin-only: feeds the Eva memory panel. Stripped below for providers.
      historySummary: isAdmin ? s.historySummary : null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  });

  // ── Saved, not contacted ─────────────────────────────────────────────────
  // LEAK GUARD: a parent's favourites span every org's roster. The saved-
  // preference endpoints are self-only today, so no ownership filter has ever
  // been written. Without this, agency A learns the family is shopping bank B.
  const chattedProfileIds = new Set(sessions.map((s) => s.subjectProfileId).filter(Boolean) as string[]);
  const savedProfiles: any[] = [];
  for (const row of savedDonorRows) {
    if (chattedProfileIds.has(row.donorId)) continue;
    const prof = profileById.get(row.donorId);
    if (!prof) continue;
    if (scopeProviderId && prof.providerId !== scopeProviderId) continue;
    const org = orgById.get(prof.providerId);
    savedProfiles.push({
      profileId: prof.id,
      subjectKind: prof.kind,
      displayName: displayNameFor(prof.kind, prof),
      photoUrl: prof.photo,
      profileStatus: prof.status,
      providerId: prof.providerId,
      providerName: org?.name ?? null,
      savedByUserId: row.userId,
      savedAt: row.createdAt,
      profileUrl: profileUrlFor(prof.kind, prof.providerId, prof.id, null, isAdmin),
    });
  }
  for (const row of savedProfileRows) {
    // doctor favourites are keyed by slug, clinic/agency by providerId
    const kind: SubjectKind = row.entityType === "doctor" ? "doctor" : row.entityType === "agency" ? "agency" : "clinic";
    const orgId = kind === "doctor" ? null : row.entityId;
    if (scopeProviderId && orgId !== scopeProviderId) continue;
    if (scopeProviderId && kind === "doctor") continue; // cannot attribute a slug to an org here
    const org = orgId ? orgById.get(orgId) : null;
    savedProfiles.push({
      profileId: row.entityId,
      subjectKind: kind,
      displayName: org?.name || row.entityId,
      photoUrl: org?.logoUrl ?? null,
      profileStatus: null,
      providerId: orgId,
      providerName: org?.name ?? null,
      savedByUserId: row.userId,
      savedAt: row.createdAt,
      profileUrl: profileUrlFor(kind, orgId, row.entityId, kind === "doctor" ? row.entityId : null, isAdmin),
    });
  }

  // ── Engagement ───────────────────────────────────────────────────────────
  // LEAK GUARD: these are account-wide across every org. "Viewed 340 profiles"
  // is a cross-org aggregate, so a provider gets their own roster only.
  let engagement: { impressions: number | null; profilesViewed: number | null; lastBrowsedAt: Date | null } = {
    impressions: null, profilesViewed: null, lastBrowsedAt: null,
  };
  if (sections.has("interests")) {
    if (isAdmin) {
      const [views, impressions, latest] = await Promise.all([
        prisma.parentProfileView.count({ where: { parentAccountId: accountKey } }),
        prisma.profileEvent.count({ where: { parentAccountId: accountKey, eventType: "IMPRESSION" } }),
        prisma.profileEvent.findFirst({
          where: { parentAccountId: accountKey },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      engagement = { impressions, profilesViewed: views, lastBrowsedAt: latest?.createdAt ?? null };
    } else {
      // Scope to profiles this org actually owns.
      const ownIds = await prisma.eggDonor.findMany({ where: { providerId: scopeProviderId as string }, select: { id: true } })
        .then(async (eggs) => {
          const surro = await prisma.surrogate.findMany({ where: { providerId: scopeProviderId as string }, select: { id: true } });
          return [...eggs.map((e) => e.id), ...surro.map((s) => s.id)];
        });
      if (ownIds.length) {
        const [views, impressions] = await Promise.all([
          prisma.parentProfileView.count({ where: { parentAccountId: accountKey, profileId: { in: ownIds } } }),
          prisma.profileEvent.count({ where: { parentAccountId: accountKey, eventType: "IMPRESSION", profileId: { in: ownIds } } }),
        ]);
        engagement = { impressions, profilesViewed: views, lastBrowsedAt: null };
      } else {
        engagement = { impressions: 0, profilesViewed: 0, lastBrowsedAt: null };
      }
    }
  }

  // ── Provider orgs the parent has a relationship with ─────────────────────
  const relationshipOrgIds = new Set<string>();
  for (const s of sessions) if (s.providerId) relationshipOrgIds.add(s.providerId);
  for (const b of bookings) if (b.providerUser?.providerId) relationshipOrgIds.add(b.providerUser.providerId);
  for (const r of releases) relationshipOrgIds.add(r.providerId);
  const providerOrgs = Array.from(relationshipOrgIds).map((id) => {
    const org = orgById.get(id);
    const orgSessions = conversations.filter((c) => c.providerId === id);
    const rel = releaseByProvider.get(id);
    return {
      providerId: id,
      providerName: org?.name ?? "Provider",
      logoUrl: org?.logoUrl ?? null,
      matchStatus: mostAdvanced(orgSessions.map((c) => c.matchStatus).filter(Boolean) as string[]),
      contactReleased: !!rel,
      contactReleaseReason: rel?.reason ?? null,
      lastActivityAt: orgSessions[0]?.updatedAt ?? null,
      sessionIds: orgSessions.map((c) => c.sessionId),
    };
  }).sort((a, b) => new Date(b.lastActivityAt || 0).getTime() - new Date(a.lastActivityAt || 0).getTime());

  // LEAK GUARD: a loud failure beats a silent leak. If a provider-scoped build
  // ever assembles a second org, that is a bug in a WHERE clause above.
  if (!isAdmin && providerOrgs.some((p) => p.providerId !== scopeProviderId)) {
    throw new ParentRecordError(500, "Provider scope violation while building parent record");
  }

  // ── Money, grouped by org then session ───────────────────────────────────
  const money = sections.has("money")
    ? {
        byProvider: Array.from(new Set([...invoices, ...agreements, ...quotes].map((r: any) => r.providerId))).map((pid) => {
          const org = orgById.get(pid);
          const inv = invoices.filter((i) => i.providerId === pid);
          const agr = agreements.filter((a) => a.providerId === pid);
          const qs = quotes.filter((q) => q.providerId === pid);
          return {
            providerId: pid,
            providerName: org?.name ?? "Provider",
            invoices: inv,
            agreements: agr,
            costSheets: qs,
            totals: {
              quotedCents: qs.filter((q) => !q.supersededAt).reduce((sum, q) => sum + (q.totalCostCents || 0), 0),
              invoicedCents: inv.reduce((sum, i) => sum + (i.serviceAmount || 0), 0),
              paidCents: inv.filter((i) => i.status === "PAID").reduce((sum, i) => sum + (i.serviceAmount || 0), 0),
            },
          };
        }),
      }
    : { byProvider: [] };

  // ── CRM ──────────────────────────────────────────────────────────────────
  const crmWhere = isAdmin
    ? { parentAccountId: accountKey }
    : { parentAccountId: accountKey, scope: "PROVIDER", providerId: scopeProviderId };
  const [notes, followUps, owners, tagAssignments] = sections.has("crm")
    ? await Promise.all([
        prisma.parentNote.findMany({
          where: { ...crmWhere, deletedAt: null },
          orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        }),
        prisma.parentFollowUp.findMany({ where: { ...crmWhere, status: "OPEN" }, orderBy: { dueAt: "asc" } }),
        prisma.parentOwner.findMany({ where: crmWhere }),
        prisma.parentTagAssignment.findMany({
          where: crmWhere,
          include: { tag: { select: { id: true, label: true, colorToken: true, scope: true } } },
        }),
      ])
    : [[], [], [], []];

  // The owner row snapshots the NAME so a renamed staff account never blanks an
  // existing byline, but a photo snapshot would go stale the first time someone
  // changed theirs. Resolve it live instead - and a missing photo is fine, the
  // client falls back to a monogram.
  const ownerPhotoById = new Map<string, string | null>();
  if (owners.length) {
    const ownerUsers = await prisma.user.findMany({
      where: { id: { in: Array.from(new Set(owners.map((o: any) => o.ownerUserId))) } },
      select: { id: true, photoUrl: true, name: true, providerId: true },
    });
    for (const u of ownerUsers) ownerPhotoById.set(u.id, u.photoUrl);

    // Clinic staff are often a User with no photo AND a ProviderMember (their
    // doctor profile) that has one - Vicken Sahakian is a User with photoUrl
    // null and a member row carrying his headshot. Fall back to it so an owner
    // chip does not show initials for someone whose face is already on the
    // platform.
    //
    // Matched on exact name within the same org because that is the ONLY link
    // that exists: ProviderMember has no userId and no email. Exact, not
    // fuzzy, and org-scoped - "Vicken Sahakian" and "Dr. Vicken Sepilian" are
    // two different doctors at the same clinic, and a loose match would put
    // one man's face on the other's name.
    const needsPhoto = ownerUsers.filter((u: any) => !u.photoUrl && u.name && u.providerId);
    if (needsPhoto.length) {
      const members = await prisma.providerMember.findMany({
        where: {
          OR: needsPhoto.map((u: any) => ({ providerId: u.providerId, name: u.name })),
          photoUrl: { not: null },
        },
        select: { name: true, providerId: true, photoUrl: true },
      });
      for (const u of needsPhoto) {
        const m = members.find((x: any) => x.providerId === u.providerId && x.name === u.name);
        if (m?.photoUrl) ownerPhotoById.set(u.id, m.photoUrl);
      }
    }
  }
  const ownersWithPhoto = owners.map((o: any) => ({ ...o, ownerPhotoUrl: ownerPhotoById.get(o.ownerUserId) ?? null }));

  const now = Date.now();

  // ── Identity ─────────────────────────────────────────────────────────────
  const parent = await prisma.user.findUnique({
    where: { id: parentUserId },
    select: {
      id: true, name: true, email: true, photoUrl: true, city: true, state: true,
      mobileNumber: true, relationshipStatus: true, partnerFirstName: true,
      partnerAge: true, dateOfBirth: true,
      gender: true, partnerGender: true, sexualOrientation: true,
      parentAccount: { select: { intendedParentProfile: { select: IP_PROFILE_SELECT } } },
    },
  });
  if (!parent) throw new ParentRecordError(404, "Parent not found");

  const { providerOffersSurrogacy } = await import("./ip-form-flow");
  const surrogateAvailable = scopeProviderId ? await providerOffersSurrogacy(scopeProviderId) : isAdmin;
  const ipFormBase = ipFormRow
    ? { responseId: ipFormRow.id, status: ipFormRow.status, submittedAt: ipFormRow.submittedAt, promptedAt: ipFormRow.promptedAt, surrogateAvailable }
    : { responseId: null, status: "NOT_STARTED", submittedAt: null, promptedAt: null, surrogateAvailable };

  // Thread-derived services first; the family's own stated interests as the
  // fallback. A plain concierge thread carries no serviceType, so without the
  // fallback this rendered an empty dash on a record whose profile block lists
  // "Surrogate, Fertility Clinic" a few inches below. Same rule as the parents
  // list - see serviceKeysFromLabels.
  const fromThreads = Array.from(
    new Set(conversations.map((c) => c.serviceType).filter(Boolean) as string[]),
  );
  const services = fromThreads.length
    ? fromThreads
    : serviceKeysFromLabels(
        (parent as any).parentAccount?.intendedParentProfile?.interestedServices as string[] | undefined,
      );

  // ── Activity: one enriched entry per thing that happened ────────
  //
  // The timeline card for "Invoice sent" is useless if it cannot show WHICH
  // invoice, for how much, and link to it. Journey events carry ids only, so
  // the detail is joined HERE rather than by the client - a client-side join
  // would be one fetch per card, and the scoping rules that keep a provider
  // inside their own org live on this side of the wire.
  //
  // Everything below is batched: four findMany calls, no query in a loop.
  const activity = await buildActivity({
    prisma, accountKey, memberIds, isAdmin, scopeProviderId,
    orgById, invoices, agreements, quotes, ipFormRow, bookings,
  });

  return {
    viewer: { role: isAdmin ? "admin" : "provider", providerId: scopeProviderId },
    accountKey,
    parent: redactParentContact(parent as any, gates),
    accountMembers: redactParentMembers(members as any, gates),
    // The IP form is the richest PII we hold - legal names, DOB, home address.
    // Withhold the responseId (the PDF handle) unless contact was released,
    // but keep `status` so the page can say "submitted, unlocks when..." rather
    // than the flat lie "not submitted yet".
    ipForm: gates.showContact ? ipFormBase : { ...ipFormBase, responseId: null },
    gates: {
      showIdentity: gates.showIdentity,
      showContact: gates.showContact,
      contactReleased: gates.showContact,
      contactReleaseReason: gates.contactReason,
    },
    contactReleased: gates.showContact,
    contactReleaseReason: gates.contactReason,
    services,
    matchStatus: mostAdvanced(conversations.map((c) => c.matchStatus).filter(Boolean) as string[]),
    providerOrgs,
    conversations,
    savedProfiles,
    engagement,
    activity,
    money,
    crm: {
      notes,
      followUps: followUps.map((f) => ({ ...f, overdue: new Date(f.dueAt).getTime() < now })),
      owners: ownersWithPhoto,
      tags: tagAssignments.map((t: any) => ({
        id: t.id,
        tagId: t.tagId,
        scope: t.scope,
        providerId: t.providerId,
        label: t.tag?.label ?? "",
        colorToken: t.tag?.colorToken ?? "accent",
        // The activity feed places tags chronologically like everything else.
        createdAt: t.assignedAt,
        assignedByUserId: t.assignedByUserId ?? null,
      })),
    },
  };
}
