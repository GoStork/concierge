/**
 * Phase 7A: journey timeline derivation.
 *
 * A journey is a (parent account x provider org) relationship. Stages are
 * DERIVED from source-of-truth records (sessions, bookings + outcomes,
 * invoices, agreements, handoff stamps) plus JourneyEvents (win-back /
 * churn) - never stored, so they are always consistent and retroactively
 * correct. Stage = the highest rung that still has valid evidence
 * (a canceled-only consultation stops proving its rung).
 *
 * Ladders per journey type (uniform language across provider types):
 *   agency (surrogacy / egg_donation):
 *     registered -> exploring -> consult_scheduled -> consult_completed ->
 *     match_call_scheduled -> matched -> invoice_sent -> invoice_paid ->
 *     agreement_sent -> agreement_signed -> handed_off
 *   ivf:  same minus matched; agreement rungs optional
 *   bank: registered -> exploring -> donor_selected -> checkout ->
 *         invoice_paid -> (agreement_sent -> agreement_signed) -> handed_off
 *   legal: registered -> exploring (the firm profile card presented) ->
 *          consult_scheduled -> consult_completed -> invoice_sent ->
 *          invoice_paid -> agreement_sent -> agreement_signed -> handed_off
 *
 * Optional rungs (parenthesised) are dropped from display when the journey
 * advanced past them without evidence.
 *
 * No Show is a BRANCH rung, not a regression: when the latest elapsed call
 * was a no-show and nothing newer is booked, "Consultation Scheduled" stays
 * done (the booking happened) and a warning-toned "No Show" rung renders
 * where "Consultation Completed" would be. It disappears once a new call is
 * booked or completed.
 *
 * The agency ladders split bookings by meetingSubtype: MATCH_CALL bookings
 * prove the "Match Call Scheduled" rung (never the consultation rungs), and
 * two branch rungs can fork off it where "Matched" would be: "Not Matched"
 * (a MATCH_DECLINED_* event with no confirmed match after it) and a
 * match-call "No Show" (same rules as the consultation branch). Both clear
 * once a new match call is booked or the match confirms.
 */
import { prisma } from "./db";

export interface JourneyStageOut {
  id: string;
  label: string;
  reachedAt: string | null;
  state: "done" | "current" | "upcoming";
  optional?: boolean;
  tone?: "warning" | "destructive";
  /**
   * A fork off the main line rather than a step on it - "No Show",
   * "Not Matched". The client hangs these beside the rung that FOLLOWS them.
   * Sent explicitly because the client used to re-derive it from a hardcoded
   * list of ids that had to mirror this file by hand; adding a Doctor Call
   * no-show here rendered it inline, in the middle of the ladder, because
   * nobody updated the copy over there.
   */
  branch?: boolean;
}

export interface JourneyOut {
  journeyType: "surrogacy" | "egg_donation" | "ivf" | "bank" | "legal";
  /**
   * The SERVICE-LINE filter key this journey belongs to (surrogacy,
   * egg_donation, sperm_donation, ivf, legal). Finer than journeyType in one
   * place: a bank journey is egg_donation or sperm_donation depending on
   * what the bank sells. Drives the record page's service chips.
   */
  serviceLine: string;
  typeLabel: string;
  providerId: string;
  providerName: string;
  providerLogo: string | null;
  sessionId: string | null;
  stages: JourneyStageOut[];
  currentStageId: string | null;
  attention: { kind: string; label: string; actionable?: boolean } | null;
  lastActivityAt: string | null;
}

const TYPE_LABEL: Record<JourneyOut["journeyType"], string> = {
  surrogacy: "Surrogacy",
  egg_donation: "Egg Donation",
  ivf: "IVF",
  bank: "Donor Bank",
  legal: "Legal",
};

/**
 * A session subjectType -> the SERVICE LINE it belongs to, or null when it
 * carries no signal. This is the attribution key the per-line journey split
 * uses, shared with the provider parents table so the two can never disagree
 * about which line a thread's evidence belongs to.
 */
export function serviceLineOfSubject(st: string | null | undefined): string | null {
  const s = (st || "").toLowerCase();
  if (!s) return null;
  if (s.includes("legal") || s.includes("lawyer")) return "legal";
  if (s.includes("surrog")) return "surrogacy";
  if (s.includes("sperm")) return "sperm_donation";
  if (s.includes("egg") || s.includes("donor")) return "egg_donation";
  if (s.includes("ivf") || s.includes("clinic") || s.includes("doctor")) return "ivf";
  return null;
}

export function classifyJourneyType(serviceNames: string[], subjectTypes: string[]): JourneyOut["journeyType"] {
  const svc = serviceNames.map((s) => s.toLowerCase());
  const subj = subjectTypes.map((s) => (s || "").toLowerCase()).filter(Boolean);
  if (svc.some((s) => s.includes("legal")) || subj.includes("legal")) return "legal";
  if (svc.some((s) => s.includes("egg bank") || s.includes("sperm bank"))) return "bank";

  // Subject types disambiguate MULTI-SERVICE agencies: an org that does both
  // surrogacy and egg donation is placed by what the chats are actually about.
  //
  // What it must never do is promote an org into a service it does not offer.
  // PFCLA is an IVF clinic. One chat thread mis-stamped with another agency's
  // SURROGATE as its subject was enough to hand the clinic the surrogacy
  // ladder - so a family's clinic journey showed "Match Call Scheduled" and
  // "Matched", two rungs that only exist for agencies, on both the provider's
  // and the parent's screen. The subject says what a conversation is about;
  // the provider's own approved services say what they can be.
  const offers = (needle: string) => svc.some((s) => s.includes(needle));
  // No services loaded (a bare bucket) leaves the subject as the only signal.
  const noServicesKnown = svc.length === 0;
  if ((offers("surrogacy") || noServicesKnown) && subj.some((s) => s.includes("surrog"))) return "surrogacy";
  if ((offers("egg donor") || noServicesKnown) && subj.some((s) => s.includes("egg") || s.includes("donor"))) {
    return "egg_donation";
  }
  if (offers("surrogacy")) return "surrogacy";
  if (offers("egg donor")) return "egg_donation";
  if (offers("ivf") || offers("clinic")) return "ivf";
  return "surrogacy";
}

/**
 * Build every journey for a parent account, optionally scoped to one
 * provider org (provider sidebar / admin session panel).
 */
export async function buildJourneyTimelines(
  parentAccountId: string,
  opts?: {
    providerId?: string | null;
    /**
     * Scope the money/terminal rungs (matched, invoices, agreement, handoff)
     * to ONE session's evidence. A parent can run several profile threads
     * with the same provider org - without this, every chat's sidebar
     * inherits the org-level terminal state (e.g. "Handed Off" showing on a
     * profile that never went anywhere). Consultation rungs and
     * registered/exploring stay relationship-level (bookings aren't
     * session-linked).
     */
    sessionId?: string | null;
    includePreStages?: boolean;
  },
): Promise<{ registeredAt: string | null; journeys: JourneyOut[] }> {
  const members = await prisma.user.findMany({
    where: { OR: [{ parentAccountId }, { id: parentAccountId }] },
    select: { id: true, createdAt: true },
  });
  const memberIds = members.map((m) => m.id);
  if (memberIds.length === 0) return { registeredAt: null, journeys: [] };
  const registeredAt = members.reduce<Date | null>(
    (min, m) => (!min || m.createdAt < min ? m.createdAt : min),
    null,
  );

  // Intended Parent Form (account-level, one per account). The surrogacy
  // ladder gets a "Parent Form Submitted" rung once the form was prompted.
  const ipFormResponse = await prisma.ipFormResponse
    .findUnique({ where: { parentAccountId }, select: { promptedAt: true, submittedAt: true } })
    .catch(() => null);

  // ---- Load the relationship evidence in one sweep ----
  const [sessions, bookings, invoices, agreements, events] = await Promise.all([
    prisma.aiChatSession.findMany({
      where: { userId: { in: memberIds }, providerId: { not: null }, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: {
        id: true, providerId: true, subjectType: true, createdAt: true, updatedAt: true,
        handoffCompletedAt: true, status: true,
        provider: { select: { id: true, name: true, logoUrl: true, depositMilestone: true, services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.booking.findMany({
      where: { parentUserId: { in: memberIds }, ...(opts?.providerId ? { providerUser: { providerId: opts.providerId } } : {}) },
      select: {
        id: true, status: true, outcome: true, scheduledAt: true, createdAt: true, cancelledAt: true,
        cancelledByRole: true, meetingSubtype: true, duration: true, sessionId: true,
        providerUser: { select: { providerId: true, roles: true, provider: { select: { name: true } } } },
      },
    }),
    prisma.invoice.findMany({
      where: { parentUserId: { in: memberIds }, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: { id: true, providerId: true, sessionId: true, status: true, createdAt: true, paidAt: true, triggerSource: true, medicalClearanceStatus: true, authorizedAt: true, clearanceConfirmedAt: true },
    }),
    prisma.agreement.findMany({
      where: { parentUserId: { in: memberIds }, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: { id: true, providerId: true, sessionId: true, status: true, createdAt: true, signedAt: true },
    }),
    prisma.journeyEvent.findMany({
      where: { parentAccountId, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: { providerId: true, sessionId: true, eventType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // ---- Group everything by provider org ----
  type Bucket = {
    providerId: string; providerName: string; providerLogo: string | null;
    serviceNames: string[]; subjectTypes: string[];
    depositMilestone: string | null;
    sessions: typeof sessions; bookings: typeof bookings; invoices: typeof invoices;
    agreements: typeof agreements; events: typeof events;
  };
  const buckets = new Map<string, Bucket>();
  const ensure = (pid: string, name: string, logo: string | null, serviceNames: string[] = []): Bucket => {
    let b = buckets.get(pid);
    if (!b) {
      b = { providerId: pid, providerName: name, providerLogo: logo, serviceNames, subjectTypes: [], depositMilestone: null, sessions: [], bookings: [], invoices: [], agreements: [], events: [] };
      buckets.set(pid, b);
    }
    return b;
  };

  for (const sess of sessions) {
    const prov = sess.provider;
    if (!prov) continue;
    if ((prov.name || "").trim().toLowerCase() === "gostork") continue; // house = no journey
    const b = ensure(prov.id, prov.name, prov.logoUrl, prov.services.map((sv) => sv.providerType?.name || "").filter(Boolean));
    b.depositMilestone = prov.depositMilestone || b.depositMilestone;
    b.sessions.push(sess);
    if (sess.subjectType) b.subjectTypes.push(sess.subjectType);
  }
  for (const bk of bookings) {
    const pid = bk.providerUser?.providerId;
    if (!pid) continue;
    const provName = (bk.providerUser?.provider?.name || "").trim().toLowerCase();
    if (provName === "gostork" || (bk.providerUser?.roles || []).some((r: any) => String(r).startsWith("GOSTORK"))) continue;
    const b = buckets.get(pid) || ensure(pid, bk.providerUser?.provider?.name || "Provider", null);
    b.bookings.push(bk);
  }
  for (const inv of invoices) {
    const b = buckets.get(inv.providerId);
    if (b) b.invoices.push(inv);
  }
  for (const agr of agreements) {
    const b = buckets.get(agr.providerId);
    if (b) b.agreements.push(agr);
  }
  for (const ev of events) {
    if (!ev.providerId) continue;
    const b = buckets.get(ev.providerId);
    if (b) b.events.push(ev);
  }

  // Fill service names for buckets created from bookings only.
  const missingSvc = [...buckets.values()].filter((b) => b.serviceNames.length === 0);
  if (missingSvc.length > 0) {
    const provs = await prisma.provider.findMany({
      where: { id: { in: missingSvc.map((b) => b.providerId) } },
      select: { id: true, name: true, logoUrl: true, depositMilestone: true, services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } },
    });
    for (const pr of provs) {
      const b = buckets.get(pr.id)!;
      b.depositMilestone = pr.depositMilestone || b.depositMilestone;
      b.providerName = pr.name;
      b.providerLogo = pr.logoUrl;
      b.serviceNames = pr.services.map((sv) => sv.providerType?.name || "").filter(Boolean);
    }
  }

  // ---- Split multi-line orgs into one journey per service line ----
  //
  // A journey used to be (parent account x provider org), which broke the
  // moment a family ran TWO services with one org: Family Creations handed
  // off their egg-donation journey, and the org-level bucket stamped
  // "Handed Off" (plus the donor invoices and agreement) onto the surrogacy
  // ladder of a surrogate thread that started this morning. Evidence is
  // assigned by each record's session subjectType; records that cannot be
  // attributed (no sessionId, subject-less session) count on EVERY line -
  // the pre-split behavior, kept only where attribution is impossible.
  const derivedBuckets: Bucket[] = [];
  for (const b of buckets.values()) {
    // The EFFECTIVE line of a session at THIS org: the raw subject line,
    // collapsed through classifyJourneyType so a subject naming a service the
    // org does not run cannot open a phantom line here. Without this, one
    // PFCLA thread mis-stamped with another agency's SURROGATE subject split
    // the clinic into TWO buckets that both classified back to "ivf" -
    // rendering two identical IVF ladders with the evidence divided between
    // them. At a bank, egg vs sperm subjects stay distinct lines; anything
    // else at a bank follows the org's own flavor.
    const orgBankLine =
      b.serviceNames.some((n) => /sperm bank/i.test(n)) && !b.serviceNames.some((n) => /egg bank/i.test(n))
        ? "sperm_donation"
        : "egg_donation";
    const effLineOf = (st: string | null | undefined): string | null => {
      const raw = serviceLineOfSubject(st);
      if (!raw) return null;
      const jt = classifyJourneyType(b.serviceNames, [st as string]);
      if (jt === "bank") return raw === "sperm_donation" || raw === "egg_donation" ? raw : orgBankLine;
      if (jt === "egg_donation") return "egg_donation";
      return jt; // surrogacy | ivf | legal map to themselves
    };
    const lines = Array.from(new Set(b.sessions.map((s2) => effLineOf(s2.subjectType)).filter(Boolean))) as string[];
    if (lines.length < 2) {
      derivedBuckets.push(b);
      continue;
    }
    const sessionLine = new Map<string, string | null>(b.sessions.map((s2) => [s2.id, effLineOf(s2.subjectType)]));
    for (const line of lines) {
      const inLine = (sessId: string | null | undefined): boolean => {
        if (!sessId) return true; // unattributable - counts everywhere
        const l = sessionLine.get(sessId);
        return l === undefined || l === null || l === line;
      };
      const sub: Bucket = {
        providerId: b.providerId,
        providerName: b.providerName,
        providerLogo: b.providerLogo,
        serviceNames: b.serviceNames,
        depositMilestone: b.depositMilestone,
        sessions: b.sessions.filter((s2) => {
          const l = effLineOf(s2.subjectType);
          return l === null || l === line;
        }),
        subjectTypes: b.sessions.filter((s2) => effLineOf(s2.subjectType) === line).map((s2) => s2.subjectType!).filter(Boolean),
        bookings: b.bookings.filter((bk) => inLine(bk.sessionId)),
        invoices: b.invoices.filter((i) => inLine(i.sessionId)),
        agreements: b.agreements.filter((a) => inLine(a.sessionId)),
        events: b.events.filter((e) => inLine(e.sessionId)),
      };
      // Sidebar scoping: with a sessionId the caller wants THAT thread's
      // journey - drop the sibling line's bucket entirely.
      if (opts?.sessionId && !sub.sessions.some((s2) => s2.id === opts.sessionId)) continue;
      derivedBuckets.push(sub);
    }
  }

  // ---- Derive each journey ----
  const journeys: JourneyOut[] = [];
  for (const b of derivedBuckets) {
    const journeyType = classifyJourneyType(b.serviceNames, b.subjectTypes);
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

    // Consultation evidence. A booking proves "scheduled" while it is live
    // (PENDING/CONFIRMED in the future) or once it actually completed;
    // canceled/expired/no-show bookings stop proving the rung.
    // Session scoping: bookings LINKED to a different thread are excluded;
    // legacy/unlinked bookings (sessionId null) keep counting everywhere.
    const scopedBookings = opts?.sessionId
      ? b.bookings.filter((bk: any) => !bk.sessionId || bk.sessionId === opts.sessionId)
      : b.bookings;
    const nowMs = Date.now();
    const endOf = (bk: any) => new Date(bk.scheduledAt).getTime() + (bk.duration || 30) * 60 * 1000;
    const liveOf = (list: any[]) => list.filter((bk: any) => ["PENDING", "CONFIRMED"].includes(bk.status) && endOf(bk) > nowMs);
    const completedOf = (list: any[]) => list.filter((bk: any) => bk.outcome === "COMPLETED" || bk.outcome === "UNVERIFIED");
    const noShowsOf = (list: any[]) => list.filter((bk: any) => ["NO_SHOW_PARENT", "NO_SHOW_PROVIDER", "NO_SHOW_BOTH"].includes(bk.outcome || ""));
    const earliestCreatedAt = (list: any[]) => (list.length > 0 ? list.reduce<Date | null>((min, bk) => (!min || bk.createdAt < min ? bk.createdAt : min), null) : null);
    const latestMissedAt = (list: any[]) => (list.length > 0 ? list.reduce<Date | null>((max, bk) => (!max || bk.scheduledAt > max ? bk.scheduledAt : max), null) : null);
    // Attention-chip evidence stays cross-subtype: "nothing newer is booked"
    // must see a live match call after a missed consultation (and vice versa).
    const liveBooking = liveOf(scopedBookings);
    const completed = completedOf(scopedBookings);
    const noShows = noShowsOf(scopedBookings);
    const everScheduledAt = earliestCreatedAt(scopedBookings);
    const lastNoShowAt = latestMissedAt(noShows);
    // Consultation rung evidence: match calls have their own rung, so they
    // never prove the consultation rungs. On IVF the Doctor Call is its own
    // rung for the same reason - the first call is with the clinic, the
    // Doctor Call is with the physician, and readiness/handoff hang off the
    // latter (see video.controller: IVF readiness fires ONLY after it).
    const splitsDoctorCall = journeyType === "ivf";
    const consultBookings = scopedBookings.filter(
      (bk) => bk.meetingSubtype !== "MATCH_CALL"
        && !(splitsDoctorCall && bk.meetingSubtype === "DOCTOR_CONSULTATION"),
    );
    const liveConsult = liveOf(consultBookings);
    const completedConsult = completedOf(consultBookings);
    const noShowConsults = noShowsOf(consultBookings);
    // Canceled branch: the call was called off and nothing replaced it. A
    // RESCHEDULED booking never counts - a new booking exists by definition -
    // and a no-show outranks it, because a no-show is evidence about a call
    // that actually stayed on the calendar. Same suppression as the no-show
    // branch: any completed or live call anywhere clears it.
    const canceledOf = (list: any[]) => list.filter((bk: any) => bk.status === "CANCELLED");
    const latestCanceledAt = (list: any[]) => (list.length > 0 ? list.reduce<Date | null>((max, bk) => (!max || (bk.cancelledAt || bk.scheduledAt) > max ? (bk.cancelledAt || bk.scheduledAt) : max), null) : null);
    const canceledConsults = canceledOf(consultBookings);
    const showConsultCanceledRung =
      canceledConsults.length > 0 && noShowConsults.length === 0
      && completed.length === 0 && liveBooking.length === 0;
    const lastConsultCanceledAt = latestCanceledAt(canceledConsults);
    // A no-show still proves the call WAS scheduled; so does a cancellation
    // WHEN its branch is on display - "Scheduled ✓, then Canceled" is the
    // true story, and a branch hanging off an unreached rung reads as a
    // rendering bug. A canceled call with a later real one keeps the old
    // behaviour: the later call is the evidence.
    const consultScheduledAt = liveConsult.length > 0 || completedConsult.length > 0 || noShowConsults.length > 0 || showConsultCanceledRung ? earliestCreatedAt(consultBookings) : null;
    const consultCompletedAt = completedConsult.length > 0 ? completedConsult.reduce<Date | null>((min, bk) => (!min || bk.scheduledAt < min ? bk.scheduledAt : min), null) : null;
    // No Show branch: a consultation was missed and nothing newer happened.
    // Suppression stays cross-subtype (any completed or live call, match
    // calls included) so a finished journey never resurfaces the branch.
    const showNoShowRung = noShowConsults.length > 0 && completed.length === 0 && liveBooking.length === 0;
    const lastConsultNoShowAt = latestMissedAt(noShowConsults);
    // Match Call rung evidence (agency ladders): same rules as consultation.
    const matchCallBookings = scopedBookings.filter((bk) => bk.meetingSubtype === "MATCH_CALL");
    const liveMatchCall = liveOf(matchCallBookings);
    const completedMatchCall = completedOf(matchCallBookings);
    const noShowMatchCalls = noShowsOf(matchCallBookings);
    const canceledMatchCalls = canceledOf(matchCallBookings);
    const showMatchCanceledRung =
      canceledMatchCalls.length > 0 && noShowMatchCalls.length === 0
      && completed.length === 0 && liveBooking.length === 0;
    const lastMatchCanceledAt = latestCanceledAt(canceledMatchCalls);
    const matchCallScheduledAt = liveMatchCall.length > 0 || completedMatchCall.length > 0 || noShowMatchCalls.length > 0 || showMatchCanceledRung ? earliestCreatedAt(matchCallBookings) : null;
    const lastMatchNoShowAt = latestMissedAt(noShowMatchCalls);
    // Doctor Call rung evidence (IVF ladder): same rules again.
    const doctorCallBookings = scopedBookings.filter((bk) => bk.meetingSubtype === "DOCTOR_CONSULTATION");
    const liveDoctorCall = liveOf(doctorCallBookings);
    const completedDoctorCall = completedOf(doctorCallBookings);
    const noShowDoctorCalls = noShowsOf(doctorCallBookings);
    const canceledDoctorCalls = canceledOf(doctorCallBookings);
    const showDoctorCallCanceled =
      canceledDoctorCalls.length > 0 && noShowDoctorCalls.length === 0
      && completedDoctorCall.length === 0 && liveDoctorCall.length === 0;
    const lastDoctorCallCanceledAt = latestCanceledAt(canceledDoctorCalls);
    const doctorCallScheduledAt =
      liveDoctorCall.length > 0 || completedDoctorCall.length > 0 || noShowDoctorCalls.length > 0
      || showDoctorCallCanceled
        ? earliestCreatedAt(doctorCallBookings)
        : null;
    const doctorCallCompletedAt = completedDoctorCall.length > 0
      ? completedDoctorCall.reduce<Date | null>((min, bk) => (!min || bk.scheduledAt < min ? bk.scheduledAt : min), null)
      : null;
    const lastDoctorCallNoShowAt = latestMissedAt(noShowDoctorCalls);
    const showDoctorCallNoShow =
      noShowDoctorCalls.length > 0 && completedDoctorCall.length === 0 && liveDoctorCall.length === 0;

    // Session scoping (see opts.sessionId doc): money/terminal evidence only.
    const sid = opts?.sessionId || null;
    const scopedInvoices = sid ? b.invoices.filter((i) => i.sessionId === sid) : b.invoices;
    const scopedAgreements = sid ? b.agreements.filter((a) => a.sessionId === sid) : b.agreements;
    const scopedSessions = sid ? b.sessions.filter((s2) => s2.id === sid) : b.sessions;

    const matchEvent = b.events.find((e) => e.eventType === "MATCH_CONFIRMED" && (!sid || e.sessionId === sid));
    const depositInvoice = scopedInvoices.filter((i) => i.triggerSource !== "BANK_CHECKOUT");
    const matchedAt = matchEvent?.createdAt || (journeyType === "surrogacy" || journeyType === "egg_donation" ? depositInvoice.find((i) => i.triggerSource === "AUTO_READINESS")?.createdAt || null : null);
    // Not Matched branch: either side declined the match and nothing points
    // forward anymore (no confirmed match after the decline, no new match
    // call booked). A fresh match call round or a later confirm clears it.
    const declineEvents = b.events.filter((e) => ["MATCH_DECLINED", "MATCH_DECLINED_BY_PARENT", "MATCH_DECLINED_BY_SURROGATE"].includes(e.eventType) && (!sid || e.sessionId === sid));
    const lastDeclineAt = declineEvents.length > 0 ? declineEvents[declineEvents.length - 1].createdAt : null;
    const showNotMatchedRung = !!lastDeclineAt && (!matchedAt || matchedAt < lastDeclineAt) && liveMatchCall.length === 0;
    // Match-call No Show branch: mirrors the consultation branch; the
    // decline branch outranks it (a decline is the more definitive signal).
    const showMatchNoShowRung = !showNotMatchedRung && !matchedAt && noShowMatchCalls.length > 0 && completedMatchCall.length === 0 && liveMatchCall.length === 0;
    const nonBankInvoices = scopedInvoices.filter((i) => i.triggerSource !== "BANK_CHECKOUT");
    const invoiceSentAt = nonBankInvoices.length > 0 ? nonBankInvoices.reduce<Date | null>((min, i) => (!min || i.createdAt < min ? i.createdAt : min), null) : null;
    const paidInvoice = scopedInvoices.filter((i) => i.status === "PAID" && i.paidAt);
    const paidAt = paidInvoice.length > 0 ? paidInvoice.reduce<Date | null>((min, i) => (!min || (i.paidAt && i.paidAt < min) ? i.paidAt : min), null) : null;
    const signed = scopedAgreements.filter((a) => a.status === "SIGNED");
    const signedAt = signed.length > 0 ? signed[0].signedAt || signed[0].createdAt : null;
    // "Sent" evidence: any agreement that left draft (SENT covers rejected /
    // expired too - the send still happened). AGREEMENT_SENT event wins on date.
    const sentAgreements = scopedAgreements.filter((a) => ["SENT", "SIGNED", "REJECTED", "EXPIRED"].includes(a.status));
    const agreementSentAt = b.events.find((e) => e.eventType === "AGREEMENT_SENT" && (!sid || e.sessionId === sid))?.createdAt
      || (sentAgreements.length > 0 ? sentAgreements.reduce<Date | null>((min, a) => (!min || a.createdAt < min ? a.createdAt : min), null) : null);
    const handoffAt = scopedSessions.map((s2) => s2.handoffCompletedAt).filter(Boolean).sort()[0] || null;
    const exploringAt = b.sessions.length > 0 ? b.sessions.reduce<Date | null>((min, s2) => (!min || s2.createdAt < min ? s2.createdAt : min), null) : everScheduledAt;

    const bankInvoices = scopedInvoices.filter((i) => i.triggerSource === "BANK_CHECKOUT");
    const checkoutAt = bankInvoices.length > 0 ? bankInvoices[0].createdAt : null;
    const bankPaidAt = bankInvoices.find((i) => i.status === "PAID")?.paidAt || null;

    // Hybrid escrow (AT_CLEARANCE) evidence. An escrow journey gets a
    // "Deposit Secured" rung (card hold placed OR funds captured into the
    // vault) and a "Medical Clearance" rung (screening passed = funds
    // released) in place of the plain "Invoice Paid". The ladder shape
    // shows for every journey with an AT_CLEARANCE provider - parents see
    // the clearance phase coming before any invoice exists.
    const escrowInvoices = scopedInvoices.filter((i: any) => i.medicalClearanceStatus != null);
    const isEscrowJourney = journeyType === "surrogacy" && (b.depositMilestone === "AT_CLEARANCE" || escrowInvoices.length > 0);
    const depositSecuredAt = escrowInvoices
      .map((i: any) => i.authorizedAt || (["PAID", "REFUNDED", "PARTIALLY_REFUNDED"].includes(i.status) ? i.paidAt : null))
      .filter(Boolean)
      .sort((a: any, z: any) => new Date(a).getTime() - new Date(z).getTime())[0] || null;
    const clearanceClearedAt = escrowInvoices
      .filter((i: any) => i.medicalClearanceStatus === "CLEARED")
      .map((i: any) => i.clearanceConfirmedAt)
      .filter(Boolean)
      .sort((a: any, z: any) => new Date(a).getTime() - new Date(z).getTime())[0] || null;
    const clearanceFailed = !clearanceClearedAt && escrowInvoices.some((i: any) => i.medicalClearanceStatus === "FAILED");

    // optional: skippable step - renders "(if needed)" and is dropped when
    // the journey passed it without evidence. dropIfPassed: REQUIRED step
    // that only gets the drop behavior (for rungs introduced after old
    // journeys already progressed past them) - no "(if needed)" label.
    // doneWhenReached: a discrete milestone that reads as "done" (checkmark)
    // the moment it has evidence, even while it is the furthest rung - it is a
    // completed action, not a stage you sit in.
    type Rung = { id: string; label: string; at: Date | string | null; optional?: boolean; dropIfPassed?: boolean; doneWhenReached?: boolean; tone?: "warning" | "destructive"; branch?: boolean };
    // Shared tail: invoice + agreement rungs read the same on every ladder.
    const consultRungs: Rung[] = [
      { id: "consult_scheduled", label: "Consultation Scheduled", at: consultScheduledAt },
      ...(showNoShowRung ? [{ id: "no_show", label: "No Show", at: lastConsultNoShowAt, tone: "warning" as const, branch: true }] : []),
      ...(showConsultCanceledRung ? [{ id: "consult_canceled", label: "Canceled", at: lastConsultCanceledAt, tone: "destructive" as const, branch: true }] : []),
      { id: "consult_completed", label: "Consultation Completed", at: consultCompletedAt },
    ];
    const moneyRungs = (optionalAgreement: boolean): Rung[] => [
      { id: "invoice_sent", label: "Invoice Sent", at: invoiceSentAt },
      { id: "invoice_paid", label: "Invoice Paid", at: paidAt },
      { id: "agreement_sent", label: "Agreement Sent", at: agreementSentAt, ...(optionalAgreement ? { optional: true } : {}) },
      { id: "agreement_signed", label: "Agreement Signed", at: signedAt, ...(optionalAgreement ? { optional: true } : {}) },
    ];

    let rungs: Rung[];
    if (journeyType === "legal") {
      // Legal's "exploring" = the firm profile card was presented to the
      // parent (LAWYER_CONNECTED covers pre-rework history).
      const legalExploringAt =
        b.events.find((e) => e.eventType === "PROFILE_PRESENTED")?.createdAt
        || b.events.find((e) => e.eventType === "LAWYER_CONNECTED")?.createdAt
        || exploringAt;
      rungs = [
        { id: "registered", label: "Registered", at: registeredAt },
        { id: "exploring", label: "Exploring Profiles", at: legalExploringAt },
        ...consultRungs,
        ...moneyRungs(false),
        { id: "handed_off", label: "Handed Off", at: handoffAt },
      ];
    } else if (journeyType === "bank") {
      rungs = [
        { id: "registered", label: "Registered", at: registeredAt },
        { id: "exploring", label: "Exploring Profiles", at: exploringAt },
        { id: "donor_selected", label: "Donor Selected", at: b.events.find((e) => e.eventType === "BANK_CHECKOUT_STARTED")?.createdAt || checkoutAt },
        { id: "checkout", label: "Checkout", at: checkoutAt },
        { id: "invoice_paid", label: "Invoice Paid", at: bankPaidAt },
        { id: "agreement_sent", label: "Agreement Sent", at: agreementSentAt, optional: true },
        { id: "agreement_signed", label: "Agreement Signed", at: signedAt, optional: true },
        { id: "handed_off", label: "Handed Off", at: handoffAt },
      ];
    } else if (journeyType === "ivf") {
      // International IVF clinics collect a short Intended Parent Form too;
      // dropIfPassed hides the rung on journeys that never had one.
      const ivfIpFormRungs: Rung[] = ipFormResponse?.submittedAt
        ? [{ id: "ip_form_submitted", label: "Parent Form Submitted", at: ipFormResponse.submittedAt, dropIfPassed: true, doneWhenReached: true }]
        : [];
      // The Doctor Call is a real, separate step on an IVF journey - the
      // clinic consultation comes first, then the call with the physician.
      // It was missing entirely: DOCTOR_CONSULTATION bookings were folded
      // into the consultation rungs, and the only reason a second call ever
      // appeared here was a mis-stamped thread borrowing the agency ladder's
      // "Match Call". dropIfPassed so journeys that never had one stay clean.
      const doctorCallRungs: Rung[] = [
        { id: "doctor_call_scheduled", label: "Doctor Call Scheduled", at: doctorCallScheduledAt, dropIfPassed: true },
        ...(showDoctorCallNoShow
          ? [{ id: "doctor_call_no_show", label: "No Show", at: lastDoctorCallNoShowAt, tone: "warning" as const, branch: true }]
          : []),
        ...(showDoctorCallCanceled
          ? [{ id: "doctor_call_canceled", label: "Canceled", at: lastDoctorCallCanceledAt, tone: "destructive" as const, branch: true }]
          : []),
        { id: "doctor_call_completed", label: "Doctor Call Completed", at: doctorCallCompletedAt, dropIfPassed: true },
      ];
      rungs = [
        { id: "registered", label: "Registered", at: registeredAt },
        { id: "exploring", label: "Exploring Profiles", at: exploringAt },
        ...consultRungs,
        ...ivfIpFormRungs,
        ...doctorCallRungs,
        ...moneyRungs(true),
        { id: "handed_off", label: "Handed Off", at: handoffAt },
      ];
    } else {
      // Escrow (AT_CLEARANCE) surrogacy journeys swap "Invoice Paid" for the
      // two escrow phases: Deposit Secured (hold placed or funds vaulted)
      // and Medical Clearance (screening passed - funds released to the
      // agency at that moment). Non-escrow journeys keep the plain ladder.
      const escrowMoneyRungs: Rung[] = [
        { id: "invoice_sent", label: "Invoice Sent", at: invoiceSentAt },
        { id: "deposit_secured", label: "Deposit Secured", at: depositSecuredAt },
        { id: "medical_clearance", label: "Medical Clearance", at: clearanceClearedAt, ...(clearanceFailed ? { tone: "warning" as const } : {}) },
        { id: "agreement_sent", label: "Agreement Sent", at: agreementSentAt },
        { id: "agreement_signed", label: "Agreement Signed", at: signedAt },
      ];
      // Intended Parent Form rung (surrogacy only), right after the
      // consultation - the agency cannot schedule a match call without it, so
      // parents see the step coming from day one. It is REQUIRED (not
      // "(if needed)"); dropIfPassed keeps pre-feature journeys clean by
      // hiding the rung on old journeys that progressed past it without one.
      const ipFormRungs: Rung[] =
        journeyType === "surrogacy"
          ? [{ id: "ip_form_submitted", label: "Parent Form Submitted", at: ipFormResponse?.submittedAt || null, dropIfPassed: true, doneWhenReached: true }]
          : [];
      // Match Call rung + its branches, right before "Matched". REQUIRED
      // going forward; dropIfPassed hides it on legacy journeys that matched
      // without a MATCH_CALL booking record. The branches fork off it and
      // render beside "Matched" (the following rung), like no_show does
      // beside "Consultation Completed".
      const matchCallRungs: Rung[] = [
        { id: "match_call_scheduled", label: "Match Call Scheduled", at: matchCallScheduledAt, dropIfPassed: true },
        ...(showNotMatchedRung ? [{ id: "not_matched", label: "Not Matched", at: lastDeclineAt, tone: "warning" as const, branch: true }] : []),
        ...(showMatchNoShowRung ? [{ id: "match_call_no_show", label: "No Show", at: lastMatchNoShowAt, tone: "warning" as const, branch: true }] : []),
        ...(showMatchCanceledRung ? [{ id: "match_call_canceled", label: "Canceled", at: lastMatchCanceledAt, tone: "destructive" as const, branch: true }] : []),
      ];
      rungs = [
        { id: "registered", label: "Registered", at: registeredAt },
        { id: "exploring", label: "Exploring Profiles", at: exploringAt },
        ...consultRungs,
        ...ipFormRungs,
        ...matchCallRungs,
        { id: "matched", label: "Matched", at: matchedAt },
        ...(isEscrowJourney ? escrowMoneyRungs : moneyRungs(false)),
        { id: "handed_off", label: "Handed Off", at: handoffAt },
      ];
    }
    // Everyone - parents, providers, and admins - sees the full ladder,
    // Registered included (user decision, 7A review).

    // Highest rung with evidence = current stage. Optional rungs without
    // evidence are dropped when a later rung has evidence; earlier gaps
    // inherit "done" only below the highest evidenced rung.
    let highestIdx = -1;
    rungs.forEach((r, i) => { if (r.at) highestIdx = Math.max(highestIdx, i); });
    rungs = rungs.filter((r, i) => !((r.optional || r.dropIfPassed) && !r.at && i < highestIdx));
    highestIdx = -1;
    rungs.forEach((r, i) => { if (r.at) highestIdx = Math.max(highestIdx, i); });

    // A reached FINAL rung is done, not "current" - the journey is over,
    // so a handed-off tree renders fully checked (user decision, 7B).
    const stages: JourneyStageOut[] = rungs.map((r, i) => ({
      id: r.id,
      label: r.label,
      reachedAt: iso(r.at as any),
      state: i < highestIdx ? "done" : i === highestIdx ? (i === rungs.length - 1 || r.doneWhenReached ? "done" : "current") : "upcoming",
      ...(r.optional ? { optional: true } : {}),
      ...(r.tone ? { tone: r.tone } : {}),
      ...(r.branch ? { branch: true } : {}),
    }));

    // Attention chips: churn beats no-show beats canceled-not-rebooked.
    let attention: JourneyOut["attention"] = null;
    const churn = [...b.events].reverse().find((e) => e.eventType === "CHURN_REASON");
    const reengaged = [...b.events].reverse().find((e) => e.eventType === "REENGAGED");
    const lastNoShow = [...b.events].reverse().find((e) => e.eventType.endsWith("_NO_SHOW_PARENT") || e.eventType.endsWith("_NO_SHOW_BOTH"));
    const lastCancelNoRebook = [...b.events].reverse().find((e) => e.eventType === "CANCELED_NOT_REBOOKED");
    // Call-level warnings expire once the relationship has visibly moved on:
    // (a) the journey progressed past the consultation phase (match / money /
    // agreement / handoff evidence), or (b) a later call actually happened.
    // Without this, a stray missed extra call sticks to the sidebar forever
    // even on a journey that is already paid and out for signature.
    // (match_call_scheduled is deliberately NOT progress here: a no-show
    // proves that rung too, and a missed match call must keep its warning.
    // Live/completed match calls already expire chips via liveBooking /
    // completedAfterNoShow, which stay cross-subtype.)
    const PROGRESS_RUNGS = new Set(["matched", "invoice_sent", "invoice_paid", "deposit_secured", "medical_clearance", "agreement_sent", "agreement_signed", "handed_off", "donor_selected", "checkout"]);
    const progressedPastConsult = rungs.some((r) => r.at && PROGRESS_RUNGS.has(r.id));
    const completedAfterNoShow = lastNoShowAt != null && completed.some((bk) => bk.scheduledAt > lastNoShowAt);
    const callWarningStale = progressedPastConsult || completedAfterNoShow;
    if (clearanceFailed) {
      // Escrow ended in a failed medical screening: funds went back to the
      // parent (hold voided or vault refunded) and the GoStork Guarantee
      // redirect is in the admins' hands. Outranks the call-level warnings.
      attention = { kind: "clearance_failed", label: "Medical clearance failed - GoStork Guarantee active" };
    } else if (churn && (!reengaged || reengaged.createdAt < churn.createdAt)) {
      attention = { kind: "dormant", label: "Journey paused by parent" };
    } else if (lastNoShow && liveBooking.length === 0 && !callWarningStale && (!reengaged || reengaged.createdAt < lastNoShow.createdAt)) {
      // actionable: the parent (or both sides) missed it and nothing new is
      // booked - the parent home renders a "reschedule" to-do from this.
      attention = { kind: "no_show", label: "Call missed - follow-up sent", actionable: true };
    } else if (lastCancelNoRebook && liveBooking.length === 0 && !callWarningStale && (!reengaged || reengaged.createdAt < lastCancelNoRebook.createdAt)) {
      attention = { kind: "canceled", label: "Call canceled - not rebooked", actionable: true };
    }

    const activityDates = [
      ...b.sessions.map((s2) => s2.updatedAt),
      ...b.bookings.map((bk) => bk.createdAt),
      ...b.invoices.map((i) => i.createdAt),
    ].filter(Boolean) as Date[];
    const lastActivityAt = activityDates.length ? activityDates.sort((a, z) => z.getTime() - a.getTime())[0] : null;

    journeys.push({
      journeyType,
      serviceLine:
        journeyType === "bank"
          ? (b.subjectTypes.some((s) => /sperm/i.test(s || ""))
              || (b.serviceNames.some((n) => /sperm bank/i.test(n)) && !b.serviceNames.some((n) => /egg bank/i.test(n)))
              ? "sperm_donation"
              : "egg_donation")
          : journeyType,
      typeLabel: TYPE_LABEL[journeyType],
      providerId: b.providerId,
      providerName: b.providerName,
      providerLogo: b.providerLogo,
      sessionId: b.sessions[0]?.id || null,
      stages,
      currentStageId: highestIdx >= 0 ? rungs[highestIdx].id : null,
      attention,
      lastActivityAt: iso(lastActivityAt),
    });
  }

  // Most-advanced journeys first inside each type, types in a stable order.
  const typeOrder = ["surrogacy", "egg_donation", "ivf", "bank", "legal"];
  journeys.sort((a, z) => {
    const t = typeOrder.indexOf(a.journeyType) - typeOrder.indexOf(z.journeyType);
    if (t !== 0) return t;
    const prog = (j: JourneyOut) => j.stages.filter((st) => st.state !== "upcoming").length;
    return prog(z) - prog(a);
  });

  return { registeredAt: registeredAt ? registeredAt.toISOString() : null, journeys };
}
