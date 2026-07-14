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
 *     matched -> invoice_sent -> invoice_paid -> agreement_sent ->
 *     agreement_signed -> handed_off
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
 */
import { prisma } from "./db";

export interface JourneyStageOut {
  id: string;
  label: string;
  reachedAt: string | null;
  state: "done" | "current" | "upcoming";
  optional?: boolean;
  tone?: "warning";
}

export interface JourneyOut {
  journeyType: "surrogacy" | "egg_donation" | "ivf" | "bank" | "legal";
  typeLabel: string;
  providerId: string;
  providerName: string;
  providerLogo: string | null;
  sessionId: string | null;
  stages: JourneyStageOut[];
  currentStageId: string | null;
  attention: { kind: string; label: string } | null;
  lastActivityAt: string | null;
}

const TYPE_LABEL: Record<JourneyOut["journeyType"], string> = {
  surrogacy: "Surrogacy",
  egg_donation: "Egg Donation",
  ivf: "IVF",
  bank: "Donor Bank",
  legal: "Legal",
};

export function classifyJourneyType(serviceNames: string[], subjectTypes: string[]): JourneyOut["journeyType"] {
  const svc = serviceNames.map((s) => s.toLowerCase());
  const subj = subjectTypes.map((s) => (s || "").toLowerCase()).filter(Boolean);
  if (svc.some((s) => s.includes("legal")) || subj.includes("legal")) return "legal";
  if (svc.some((s) => s.includes("egg bank") || s.includes("sperm bank"))) return "bank";
  // Multi-service agencies disambiguate by what the chats are actually about.
  if (subj.some((s) => s.includes("surrog"))) return "surrogacy";
  if (subj.some((s) => s.includes("egg") || s.includes("donor"))) return "egg_donation";
  if (svc.some((s) => s.includes("surrogacy"))) return "surrogacy";
  if (svc.some((s) => s.includes("egg donor"))) return "egg_donation";
  if (svc.some((s) => s.includes("ivf") || s.includes("clinic"))) return "ivf";
  return "surrogacy";
}

/**
 * Build every journey for a parent account, optionally scoped to one
 * provider org (provider sidebar / admin session panel).
 */
export async function buildJourneyTimelines(
  parentAccountId: string,
  opts?: { providerId?: string | null; includePreStages?: boolean },
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

  // ---- Load the relationship evidence in one sweep ----
  const [sessions, bookings, invoices, agreements, events] = await Promise.all([
    prisma.aiChatSession.findMany({
      where: { userId: { in: memberIds }, providerId: { not: null }, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: {
        id: true, providerId: true, subjectType: true, createdAt: true, updatedAt: true,
        handoffCompletedAt: true, status: true,
        provider: { select: { id: true, name: true, logoUrl: true, services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.booking.findMany({
      where: { parentUserId: { in: memberIds }, ...(opts?.providerId ? { providerUser: { providerId: opts.providerId } } : {}) },
      select: {
        id: true, status: true, outcome: true, scheduledAt: true, createdAt: true, cancelledAt: true,
        cancelledByRole: true, meetingSubtype: true, duration: true,
        providerUser: { select: { providerId: true, roles: true, provider: { select: { name: true } } } },
      },
    }),
    prisma.invoice.findMany({
      where: { parentUserId: { in: memberIds }, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: { id: true, providerId: true, status: true, createdAt: true, paidAt: true, triggerSource: true },
    }),
    prisma.agreement.findMany({
      where: { parentUserId: { in: memberIds }, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: { id: true, providerId: true, status: true, createdAt: true, signedAt: true },
    }),
    prisma.journeyEvent.findMany({
      where: { parentAccountId, ...(opts?.providerId ? { providerId: opts.providerId } : {}) },
      select: { providerId: true, eventType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // ---- Group everything by provider org ----
  type Bucket = {
    providerId: string; providerName: string; providerLogo: string | null;
    serviceNames: string[]; subjectTypes: string[];
    sessions: typeof sessions; bookings: typeof bookings; invoices: typeof invoices;
    agreements: typeof agreements; events: typeof events;
  };
  const buckets = new Map<string, Bucket>();
  const ensure = (pid: string, name: string, logo: string | null, serviceNames: string[] = []): Bucket => {
    let b = buckets.get(pid);
    if (!b) {
      b = { providerId: pid, providerName: name, providerLogo: logo, serviceNames, subjectTypes: [], sessions: [], bookings: [], invoices: [], agreements: [], events: [] };
      buckets.set(pid, b);
    }
    return b;
  };

  for (const sess of sessions) {
    const prov = sess.provider;
    if (!prov) continue;
    if ((prov.name || "").trim().toLowerCase() === "gostork") continue; // house = no journey
    const b = ensure(prov.id, prov.name, prov.logoUrl, prov.services.map((sv) => sv.providerType?.name || "").filter(Boolean));
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
      select: { id: true, name: true, logoUrl: true, services: { where: { status: "APPROVED" }, select: { providerType: { select: { name: true } } } } },
    });
    for (const pr of provs) {
      const b = buckets.get(pr.id)!;
      b.providerName = pr.name;
      b.providerLogo = pr.logoUrl;
      b.serviceNames = pr.services.map((sv) => sv.providerType?.name || "").filter(Boolean);
    }
  }

  // ---- Derive each journey ----
  const journeys: JourneyOut[] = [];
  for (const b of buckets.values()) {
    const journeyType = classifyJourneyType(b.serviceNames, b.subjectTypes);
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

    // Consultation evidence. A booking proves "scheduled" while it is live
    // (PENDING/CONFIRMED in the future) or once it actually completed;
    // canceled/expired/no-show bookings stop proving the rung.
    const nowMs = Date.now();
    const endOf = (bk: any) => new Date(bk.scheduledAt).getTime() + (bk.duration || 30) * 60 * 1000;
    const liveBooking = b.bookings.filter((bk) => ["PENDING", "CONFIRMED"].includes(bk.status) && endOf(bk) > nowMs);
    const completed = b.bookings.filter((bk) => bk.outcome === "COMPLETED" || bk.outcome === "UNVERIFIED");
    const noShows = b.bookings.filter((bk) => ["NO_SHOW_PARENT", "NO_SHOW_PROVIDER", "NO_SHOW_BOTH"].includes(bk.outcome || ""));
    const everScheduledAt = b.bookings.length > 0 ? b.bookings.reduce<Date | null>((min, bk) => (!min || bk.createdAt < min ? bk.createdAt : min), null) : null;
    // A no-show still proves the call WAS scheduled - only pure cancellation
    // (nothing live, completed, or attended-by-anyone) regresses the rung.
    const consultScheduledAt = liveBooking.length > 0 || completed.length > 0 || noShows.length > 0 ? everScheduledAt : null;
    const consultCompletedAt = completed.length > 0 ? completed.reduce<Date | null>((min, bk) => (!min || bk.scheduledAt < min ? bk.scheduledAt : min), null) : null;
    // No Show branch: latest elapsed call was missed and nothing newer is live.
    const showNoShowRung = noShows.length > 0 && completed.length === 0 && liveBooking.length === 0;
    const lastNoShowAt = noShows.length > 0 ? noShows.reduce<Date | null>((max, bk) => (!max || bk.scheduledAt > max ? bk.scheduledAt : max), null) : null;

    const matchEvent = b.events.find((e) => e.eventType === "MATCH_CONFIRMED");
    const depositInvoice = b.invoices.filter((i) => i.triggerSource !== "BANK_CHECKOUT");
    const matchedAt = matchEvent?.createdAt || (journeyType === "surrogacy" || journeyType === "egg_donation" ? depositInvoice.find((i) => i.triggerSource === "AUTO_READINESS")?.createdAt || null : null);
    const nonBankInvoices = b.invoices.filter((i) => i.triggerSource !== "BANK_CHECKOUT");
    const invoiceSentAt = nonBankInvoices.length > 0 ? nonBankInvoices.reduce<Date | null>((min, i) => (!min || i.createdAt < min ? i.createdAt : min), null) : null;
    const paidInvoice = b.invoices.filter((i) => i.status === "PAID" && i.paidAt);
    const paidAt = paidInvoice.length > 0 ? paidInvoice.reduce<Date | null>((min, i) => (!min || (i.paidAt && i.paidAt < min) ? i.paidAt : min), null) : null;
    const signed = b.agreements.filter((a) => a.status === "SIGNED");
    const signedAt = signed.length > 0 ? signed[0].signedAt || signed[0].createdAt : null;
    // "Sent" evidence: any agreement that left draft (SENT covers rejected /
    // expired too - the send still happened). AGREEMENT_SENT event wins on date.
    const sentAgreements = b.agreements.filter((a) => ["SENT", "SIGNED", "REJECTED", "EXPIRED"].includes(a.status));
    const agreementSentAt = b.events.find((e) => e.eventType === "AGREEMENT_SENT")?.createdAt
      || (sentAgreements.length > 0 ? sentAgreements.reduce<Date | null>((min, a) => (!min || a.createdAt < min ? a.createdAt : min), null) : null);
    const handoffAt = b.sessions.map((s2) => s2.handoffCompletedAt).filter(Boolean).sort()[0] || null;
    const exploringAt = b.sessions.length > 0 ? b.sessions.reduce<Date | null>((min, s2) => (!min || s2.createdAt < min ? s2.createdAt : min), null) : everScheduledAt;

    const bankInvoices = b.invoices.filter((i) => i.triggerSource === "BANK_CHECKOUT");
    const checkoutAt = bankInvoices.length > 0 ? bankInvoices[0].createdAt : null;
    const bankPaidAt = bankInvoices.find((i) => i.status === "PAID")?.paidAt || null;

    type Rung = { id: string; label: string; at: Date | string | null; optional?: boolean; tone?: "warning" };
    // Shared tail: invoice + agreement rungs read the same on every ladder.
    const consultRungs: Rung[] = [
      { id: "consult_scheduled", label: "Consultation Scheduled", at: consultScheduledAt },
      ...(showNoShowRung ? [{ id: "no_show", label: "No Show", at: lastNoShowAt, tone: "warning" as const }] : []),
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
      rungs = [
        { id: "registered", label: "Registered", at: registeredAt },
        { id: "exploring", label: "Exploring Profiles", at: exploringAt },
        ...consultRungs,
        ...moneyRungs(true),
        { id: "handed_off", label: "Handed Off", at: handoffAt },
      ];
    } else {
      rungs = [
        { id: "registered", label: "Registered", at: registeredAt },
        { id: "exploring", label: "Exploring Profiles", at: exploringAt },
        ...consultRungs,
        { id: "matched", label: "Matched", at: matchedAt },
        ...moneyRungs(false),
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
    rungs = rungs.filter((r, i) => !(r.optional && !r.at && i < highestIdx));
    highestIdx = -1;
    rungs.forEach((r, i) => { if (r.at) highestIdx = Math.max(highestIdx, i); });

    // A reached FINAL rung is done, not "current" - the journey is over,
    // so a handed-off tree renders fully checked (user decision, 7B).
    const stages: JourneyStageOut[] = rungs.map((r, i) => ({
      id: r.id,
      label: r.label,
      reachedAt: iso(r.at as any),
      state: i < highestIdx ? "done" : i === highestIdx ? (i === rungs.length - 1 ? "done" : "current") : "upcoming",
      ...(r.optional ? { optional: true } : {}),
      ...(r.tone ? { tone: r.tone } : {}),
    }));

    // Attention chips: churn beats no-show beats canceled-not-rebooked.
    let attention: JourneyOut["attention"] = null;
    const churn = [...b.events].reverse().find((e) => e.eventType === "CHURN_REASON");
    const reengaged = [...b.events].reverse().find((e) => e.eventType === "REENGAGED");
    const lastNoShow = [...b.events].reverse().find((e) => e.eventType.endsWith("_NO_SHOW_PARENT") || e.eventType.endsWith("_NO_SHOW_BOTH"));
    const lastCancelNoRebook = [...b.events].reverse().find((e) => e.eventType === "CANCELED_NOT_REBOOKED");
    if (churn && (!reengaged || reengaged.createdAt < churn.createdAt)) {
      attention = { kind: "dormant", label: "Journey paused by parent" };
    } else if (lastNoShow && liveBooking.length === 0 && (!reengaged || reengaged.createdAt < lastNoShow.createdAt)) {
      attention = { kind: "no_show", label: "Call missed - follow-up sent" };
    } else if (lastCancelNoRebook && liveBooking.length === 0 && (!reengaged || reengaged.createdAt < lastCancelNoRebook.createdAt)) {
      attention = { kind: "canceled", label: "Call canceled - not rebooked" };
    }

    const activityDates = [
      ...b.sessions.map((s2) => s2.updatedAt),
      ...b.bookings.map((bk) => bk.createdAt),
      ...b.invoices.map((i) => i.createdAt),
    ].filter(Boolean) as Date[];
    const lastActivityAt = activityDates.length ? activityDates.sort((a, z) => z.getTime() - a.getTime())[0] : null;

    journeys.push({
      journeyType,
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
