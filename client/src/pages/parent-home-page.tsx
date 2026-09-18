/**
 * Parent Home dashboard (/home).
 *
 * The concierge's read of where things stand first, then the action queue
 * ("what needs my attention right now"), upcoming meetings, the journey
 * (done / now / next), and compact Billing + Agreements summaries with
 * View-all links to the full pages - but only once those sections can hold
 * anything. On day one the page is the greeting, the next steps and the
 * journey; cost sheets, invoices and agreements appear as the journey reaches
 * them, with one line saying what comes later. Billing left the top nav -
 * this page is its front door; /my/billing stays routable for the full
 * tables. Chat remains the app's default landing - Home is the overview, not
 * the front door.
 */

import { useEffect, useState } from "react";
import { greetingNameOf } from "@/lib/display-name";
import { useConciergeName } from "@/hooks/use-concierge-name";
import { JourneyTimelineCard } from "@/components/journey/journey-timeline-card";
import { Map } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { BookingDetailPanel } from "@/components/booking-detail-dialog";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Receipt,
  FileSignature,
  CalendarClock,
  FileText,
  CheckCircle2,
  Video,
  MessageCircle,
  Receipt as ReceiptIcon,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { AgreementRows } from "@/components/agreements-list";
import { QueueRow, SectionHeader } from "@/components/home/home-sections";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

interface DashboardQueue {
  pendingProposals: Array<{ messageId: string; sessionId: string; createdAt: string; providerName: string | null; callLabel: string; subjectLabel: string | null }>;
  awaitingMySignature: Array<{ agreementId: string; documentType: string; sessionId: string; createdAt: string; providerName: string | null }>;
  prepDocs: Array<{ messageId: string; sessionId: string; createdAt: string; providerName: string | null; callLabel: string; scheduledAt: string | null; url: string; fileName: string }>;
  callsToReschedule?: Array<{ sessionId: string; missedAt: string | null; callLabel: string; providerName: string | null; subjectLabel: string | null }>;
  ipFormPending?: Array<{ responseId: string; promptedAt: string; signedSlots: number[]; hasSecondParent: boolean; lastSectionKey?: string | null }>;
  ipForm?: { responseId: string; status: string; signedSlots: number[]; hasSecondParent: boolean; lastSectionKey?: string | null } | null;
  journeyNextSteps?: Array<{ serviceLine: string | null; typeLabel: string; providerName: string | null; sessionId: string | null; stepId: string; label: string }>;
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The marketplace tab that shows this journey's profiles. Legal has no
 *  deck; it goes to chat. */
function marketplaceTabFor(serviceLine: string | null | undefined, typeLabel: string): string | null {
  const key = String(serviceLine || typeLabel || "").toLowerCase();
  if (key.includes("surrog")) return "surrogates";
  if (key.includes("egg")) return "egg-donors";
  if (key.includes("sperm")) return "sperm-donors";
  if (key.includes("ivf") || key.includes("clinic")) return "ivf-clinics";
  return null;
}

// A ladder rung names the state AFTER the step ("Consultation Completed").
// As a to-do it must name the action, or the parent reads it as done.
const NEXT_STEP_PHRASES: Record<string, string> = {
  consult_scheduled: "book a consultation",
  consult_completed: "have your consultation",
  ip_form_submitted: "fill in the parent form",
  doctor_call_scheduled: "book a doctor call",
  doctor_call_completed: "have your doctor call",
  match_call_scheduled: "book a match call",
  matched: "confirm your match",
  invoice_sent: "receive your invoice",
  agreement_sent: "receive your agreement",
  agreement_signed: "sign your agreement",
};
function nextStepPhrase(stepId: string, label: string): string {
  return NEXT_STEP_PHRASES[stepId] || label.toLowerCase();
}

function joinNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export default function ParentHomePage() {
  // Which meeting is expanded lives in the URL (?meeting=), so the queue row
  // for an upcoming consultation can open it and Back closes it.
  const [searchParams, setSearchParams] = useSearchParams();
  const openMeetingId = searchParams.get("meeting");
  const setOpenMeetingId = (id: string | null) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("meeting", id); else next.delete("meeting");
      return next;
    }, { replace: true });
  const { user } = useAuth();
  const navigate = useNavigate();
  const firstName = greetingNameOf(user as any);
  const isViewer = (user as any)?.parentAccountRole === "VIEWER";

  // The tab announced as its URL before: this page had no title.
  useEffect(() => {
    const prev = document.title;
    document.title = "Home - GoStork";
    return () => { document.title = prev; };
  }, []);

  // Dashboard queries always refetch on mount/focus - the app's global
  // defaults cache forever, which left completed tasks stuck on screen until
  // a hard refresh.
  const fresh = { refetchOnMount: "always" as const, refetchOnWindowFocus: true, staleTime: 15_000 };

  const queueQuery = useQuery<DashboardQueue>({ queryKey: ["/api/my/dashboard-queue"], ...fresh });
  const queue = queueQuery.data;

  const chatSessionsQuery = useQuery<Array<{ id: string; unreadCount?: number; providerId?: string | null; matchmakerName?: string | null }>>({
    queryKey: ["/api/my/chat-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/my/chat-sessions", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    ...fresh,
  });
  const chatSessions = chatSessionsQuery.data ?? [];
  const chosenConciergeName = chatSessions.find((cs) => !cs.providerId && cs.matchmakerName)?.matchmakerName || null;
  // The parent chose their concierge in onboarding; the first persona in the
  // brand list is only the fallback (Home said "From Ariel" to a parent whose
  // concierge is Adam). Their Eva thread is the session with no provider.
  const conciergeName = useConciergeName(chosenConciergeName);

  const invoicesQuery = useQuery<any[]>({
    queryKey: ["/api/my/invoices"],
    queryFn: async () => {
      const res = await fetch("/api/my/invoices", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
    enabled: !isViewer,
    ...fresh,
  });
  const invoices = invoicesQuery.data ?? [];

  const costSheetQuery = useQuery<{ quotes: any[] }>({
    queryKey: ["/api/my/cost-sheets"],
    queryFn: async () => {
      const res = await fetch("/api/my/cost-sheets", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cost sheets");
      return res.json();
    },
    enabled: !isViewer,
    ...fresh,
  });

  const agreementsQuery = useQuery<any[]>({
    queryKey: ["/api/my/agreements"],
    queryFn: async () => {
      const res = await fetch("/api/my/agreements", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreements");
      return res.json();
    },
    ...fresh,
  });
  const myAgreements = agreementsQuery.data ?? [];

  const bookingsQuery = useQuery<any[]>({
    queryKey: ["/api/calendar/bookings", "home"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/bookings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load meetings");
      return res.json();
    },
    ...fresh,
  });
  const bookings = bookingsQuery.data ?? [];

  // Everything the attention card counts. While any of these is still
  // loading, the count is unknown - the card must not say "all caught up"
  // (measured: ten seconds of false reassurance on a phone). A failed query
  // is an error row, never silence.
  const queueSources = [queueQuery, invoicesQuery, costSheetQuery, chatSessionsQuery];
  const queueLoading = queueSources.some((q) => q.isLoading && q.fetchStatus !== "idle");
  const queueErrors = queueSources.filter((q) => q.isError);
  const retryQueue = () => queueSources.forEach((q) => { if (q.isError) void q.refetch(); });

  // Missed calls that still need rebooking - derived server-side PER SESSION
  // (dashboard-queue), because the org-level journey may already be handed
  // off for one match while a parallel thread has a freshly missed call.
  const callsToReschedule = queue?.callsToReschedule || [];

  const unpaidInvoices = invoices.filter((i: any) => i.status === "AWAITING_PAYMENT");
  const costSheets = costSheetQuery.data?.quotes || [];
  const unackedCostSheets = costSheets.filter((cs: any) => !cs.supersededAt && !cs.parentAcknowledgedAt);
  const upcomingMeetings = bookings
    .filter((b: any) => new Date(b.scheduledAt).getTime() > Date.now() && !["CANCELLED", "DECLINED", "RESCHEDULED", "EXPIRED"].includes(b.status))
    .sort((a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  const totalPaid = invoices.filter((i: any) => i.status === "PAID").reduce((s: number, i: any) => s + (i.serviceAmount || 0), 0);

  const unreadMessages = chatSessions.reduce((sum, cs) => sum + (cs.unreadCount || 0), 0);

  // One next-step to-do per journey terminal (server-derived from the same
  // ladder the Your Journeys card renders): Onboarding right after signup,
  // then Exploring Profiles, and so on - one entry per service line. Two
  // "Start exploring profiles for your X journey" rows truncated to the same
  // words on a phone and both went to the same bare /marketplace, so the
  // service leads the title and each row lands on its own deck.
  // Opened from the queue row above, the panel may be below the fold.
  useEffect(() => {
    if (!openMeetingId) return;
    const el = document.getElementById(`booking-detail-panel-${openMeetingId}`);
    const r = el?.getBoundingClientRect();
    if (el && r && (r.top < 0 || r.bottom > window.innerHeight)) {
      el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    }
  }, [openMeetingId, upcomingMeetings.length]);

  const journeyNextSteps = queue?.journeyNextSteps || [];
  const journeyStepCopy = (s: NonNullable<DashboardQueue["journeyNextSteps"]>[number]) => {
    const svc = `${s.typeLabel}${s.providerName ? ` with ${s.providerName}` : ""}`;
    const tab = marketplaceTabFor(s.serviceLine, s.typeLabel);
    switch (s.stepId) {
      case "onboarding":
        return { title: `Finish getting to know ${conciergeName}`, detail: `${svc}: a few questions so we can find your best matches`, cta: "Continue", to: "/chat" };
      case "exploring":
        return tab
          ? { title: `${s.typeLabel}: explore your matches`, detail: `${conciergeName} has profiles ready for you`, cta: "Explore", to: `/marketplace?tab=${tab}` }
          : { title: `${s.typeLabel}: your next step`, detail: `${conciergeName} will walk you through it in chat`, cta: "Open chat", to: s.sessionId ? `/chat/${s.sessionId}` : "/chat" };
      case "invoice_paid":
        return { title: `${s.typeLabel}: your invoice is waiting`, detail: `${svc}: pay it to move to the agreement`, cta: "View billing", to: "/my/billing" };
      case "consult_completed":
      case "doctor_call_completed": {
        // The next rung is the call itself. Worded as a finished fact
        // ("consultation completed") it told a parent with a call five days
        // out that it had already happened. With the booking in hand, say
        // when it is and whether the provider has confirmed.
        const b = upcomingMeetings.find((m: any) =>
          (s.sessionId && m.sessionId === s.sessionId) ||
          (s.providerName && m.providerUser?.provider?.name === s.providerName));
        const callWord = s.stepId === "doctor_call_completed" ? "doctor call" : "consultation";
        if (b) {
          const org = b.providerUser?.provider?.name || s.providerName || "your provider";
          return {
            title: `${s.typeLabel}: your ${callWord} is coming up`,
            detail: `${fmtWhen(b.scheduledAt)} - ${b.status === "PENDING" ? `waiting for ${org} to confirm` : `confirmed with ${org}`}`,
            cta: "Details",
            to: `?meeting=${b.id}`,
          };
        }
        return { title: `${s.typeLabel}: ${nextStepPhrase(s.stepId, s.label)}`, detail: `${svc}: ${conciergeName} will take you through it in chat`, cta: "Open chat", to: s.sessionId ? `/chat/${s.sessionId}` : "/chat" };
      }
      default:
        return { title: `${s.typeLabel}: ${nextStepPhrase(s.stepId, s.label)}`, detail: `${svc}: ${conciergeName} will take you through it in chat`, cta: "Open chat", to: s.sessionId ? `/chat/${s.sessionId}` : "/chat" };
    }
  };
  const nextStepRows = (() => {
    const seen = new Set<string>();
    const rows: Array<{ key: string; title: string; detail: string; cta: string; to: string }> = [];
    for (const s of journeyNextSteps) {
      const c = journeyStepCopy(s);
      if (seen.has(c.to)) continue;
      seen.add(c.to);
      rows.push({ key: `journey-step-${s.serviceLine}-${s.providerName || "none"}`, ...c });
    }
    return rows;
  })();

  const blockingCount =
    unpaidInvoices.length +
    (queue?.awaitingMySignature.length || 0) +
    (queue?.pendingProposals.length || 0) +
    (queue?.prepDocs?.length || 0) +
    (queue?.ipFormPending?.length || 0) +
    unackedCostSheets.length +
    callsToReschedule.length +
    (unreadMessages > 0 ? 1 : 0);
  const actionCount = blockingCount + nextStepRows.length;
  // Suggestions are not debts: when nothing is blocked on the parent, the
  // card is "Your next steps", not "Needs your attention (2)".
  const queueTitle = blockingCount > 0 ? `Needs your attention (${blockingCount})` : "Your next steps";

  // The concierge's read of where things stand, in one or two sentences,
  // derived from the same data the cards show. Deterministic on purpose: it
  // must never disagree with the rows beneath it.
  const openingLine = (() => {
    if (queueLoading) return null;
    const lines = Array.from(new Set(journeyNextSteps.map((s) => s.typeLabel))).filter(Boolean);
    const journeyPart = lines.length > 0 ? `You're set up for ${joinNames(lines.map((l) => l.toLowerCase()))}.` : "";
    if (blockingCount > 0) {
      const n = blockingCount;
      return `${journeyPart} ${n === 1 ? "One thing is waiting on you" : `${n} things are waiting on you`} - it's listed right below, and I'm in chat whenever you want to talk it through.`.trim();
    }
    if (upcomingMeetings.length > 0) {
      const b = upcomingMeetings[0];
      return `${journeyPart} Your next meeting is ${fmtWhen(b.scheduledAt)}. Nothing else needs you before then.`.trim();
    }
    const first = journeyNextSteps[0];
    if (first?.stepId === "onboarding") return `${journeyPart} Next, I have a few questions so I can find your best matches - pick up where we left off in chat.`.trim();
    if (first?.stepId === "exploring") return `${journeyPart} I have profiles ready for you to look through - your next step is choosing who feels right.`.trim();
    if (first) return `${journeyPart} Your next step is to ${nextStepPhrase(first.stepId, first.label)}, and I'll walk you through it in chat.`.trim();
    return journeyPart || `Nothing is waiting on you right now. I'm in chat whenever you want to pick things up.`;
  })();

  // Sections appear when they can hold something. Before the first
  // consultation there is nothing to price, invoice or sign - six cards of
  // absence told the parent nothing the journey card does not.
  const showCostSheets = !isViewer && costSheets.length > 0;
  const showInvoices = !isViewer && invoices.length > 0;
  const showAgreements = myAgreements.length > 0;
  const laterSections: string[] = [];
  if (!isViewer && !showCostSheets) laterSections.push("cost sheets after your consultations");
  if (!isViewer && !showInvoices) laterSections.push("invoices once you're matched");
  if (!showAgreements) laterSections.push("your agreement after the deposit");

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6 pb-24 md:pb-6">
      <div>
        <h1 className="t-page-title font-heading">Welcome back, {firstName}</h1>
        {/* The concierge speaks first. Orchid eyebrow = her voice, as in
            chat's prompt blocks. */}
        <div className="mt-3 max-w-2xl" data-testid="home-concierge-note" aria-live="polite">
          <p className="t-prompt-eyebrow">From {conciergeName}</p>
          {openingLine ? (
            <p className="text-base leading-relaxed mt-1">{openingLine}</p>
          ) : (
            <p className="text-base leading-relaxed mt-1 text-muted-foreground" aria-busy="true">Checking where things stand...</p>
          )}
        </div>
      </div>

      {/* Top row: the action queue and the upcoming meetings sit side by side
          on desktop (both are short, glanceable lists) and stack on mobile.
          Frames stretch to a shared height so every row on this page ends on
          one line, same as the billing row below. */}
      <div className="grid gap-6 lg:grid-cols-2">
      {/* Action queue - always first so pending items are never below the fold */}
      <Card className="p-6 space-y-3">
        <SectionHeader
          icon={<CheckCircle2 className="w-5 h-5 text-primary" />}
          title={queueLoading ? "Needs your attention" : queueTitle}
        />
        {queueErrors.length > 0 && (
          <div className="flex items-center gap-3 rounded-[var(--radius)] border border-[hsl(var(--brand-error)/0.3)] bg-[hsl(var(--brand-error)/0.06)] px-4 py-3" role="alert" data-testid="home-queue-error">
            <AlertCircle className="w-4 h-4 shrink-0 text-[hsl(var(--brand-error-text))]" aria-hidden="true" />
            <p className="text-sm flex-1">We couldn't load part of your list, so it may be incomplete.</p>
            <Button size="sm" variant="outline" onClick={retryQueue}>Retry</Button>
          </div>
        )}
        {queueLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading your list">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-[var(--radius)] border border-border">
                <div className="w-9 h-9 rounded-full bg-secondary animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-2/3 rounded-full bg-secondary animate-pulse" />
                  <div className="h-3 w-1/2 rounded-full bg-secondary animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : actionCount === 0 ? (
          queueErrors.length === 0 && (
            <div className="flex items-center gap-2 py-3 text-sm">
              <CheckCircle2 className="w-4 h-4 text-primary" aria-hidden="true" />
              You're all caught up - nothing waiting on you right now.
            </div>
          )
        ) : (
          <div className="space-y-2">
            {callsToReschedule.map((c: any) => (
              <QueueRow
                key={`reschedule-${c.sessionId}`}
                tone="task"
                icon={<CalendarClock className="w-4 h-4" />}
                title={`Reschedule your ${c.callLabel} with ${c.providerName || "your provider"}${c.subjectLabel ? ` (${c.subjectLabel})` : ""}`}
                detail={c.missedAt ? `The call on ${fmtWhen(c.missedAt)} was missed - pick a new time in chat` : "Your last call was missed - pick a new time in chat"}
                cta="Rebook"
                onClick={() => navigate(`/chat/${c.sessionId}`)}
              />
            ))}
            {unpaidInvoices.map((inv: any) => (
              <QueueRow
                key={inv.id}
                tone="task"
                icon={<Receipt className="w-4 h-4" />}
                title={`Invoice from ${inv.providerName || "your provider"} - ${formatCents(inv.serviceAmount, inv.currency)}`}
                detail={inv.dueAt ? `Due ${fmtWhen(inv.dueAt)}` : "Awaiting your payment"}
                cta="Pay now"
                onClick={() => navigate(`/pay/${inv.paymentToken}`)}
              />
            ))}
            {(queue?.ipFormPending || []).map(f => {
              // Once the second parent has signed, the only thing left is submit.
              const readyToSubmit = f.hasSecondParent ? f.signedSlots.includes(2) : f.signedSlots.includes(1);
              return (
                <QueueRow
                  key={`ipform-${f.responseId}`}
                  tone="task"
                  icon={<FileText className="w-4 h-4" />}
                  title={readyToSubmit ? "Submit your Intended Parent Form" : "Finish your Intended Parent Form"}
                  detail={
                    f.signedSlots.length === 0
                      ? "Your agency shares it with potential surrogates - a match call can't be scheduled without it"
                      : f.hasSecondParent && f.signedSlots.length === 1
                      ? "One signature in - the second parent still needs to sign"
                      : "Almost done - review and submit"
                  }
                  cta={readyToSubmit ? "Submit" : "Continue"}
                  onClick={() => navigate(f.lastSectionKey ? `/ip-form?section=${encodeURIComponent(f.lastSectionKey)}` : "/ip-form")}
                />
              );
            })}
            {(queue?.awaitingMySignature || []).map(a => (
              <QueueRow
                key={a.agreementId}
                tone="task"
                icon={<FileSignature className="w-4 h-4" />}
                title={`${a.documentType}${a.providerName ? ` from ${a.providerName}` : ""}`}
                detail="Waiting for your signature"
                cta="Review & sign"
                onClick={() => navigate(`/agreements/${a.agreementId}`)}
              />
            ))}
            {(queue?.pendingProposals || []).map(p => (
              <QueueRow
                key={p.messageId}
                tone="task"
                icon={<CalendarClock className="w-4 h-4" />}
                title={`Pick a time for your ${p.callLabel}${p.subjectLabel ? ` with ${p.subjectLabel}` : ""}`}
                detail={p.providerName ? `Proposed by ${p.providerName}` : "Time options are waiting in your chat"}
                cta="Choose time"
                onClick={() => navigate(`/chat/${p.sessionId}?msg=${p.messageId}`)}
              />
            ))}
            {unreadMessages > 0 && (
              <QueueRow
                icon={<MessageCircle className="w-4 h-4" />}
                title={`${unreadMessages} unread message${unreadMessages === 1 ? "" : "s"}`}
                detail={`${conciergeName} or your providers wrote to you`}
                cta="Open chats"
                onClick={() => navigate("/chat")}
              />
            )}
            {(queue?.prepDocs || []).map(pd => (
              <QueueRow
                key={pd.messageId}
                icon={<FileText className="w-4 h-4" />}
                title={`Prep guide for your ${pd.callLabel}${pd.providerName ? ` with ${pd.providerName}` : ""}`}
                detail={pd.scheduledAt ? `Read it before ${fmtWhen(pd.scheduledAt)}` : pd.fileName}
                cta="Read"
                onClick={() => window.open(pd.url, "_blank", "noopener,noreferrer")}
                onDismiss={async () => {
                  await fetch("/api/my/dashboard/dismiss", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ messageId: pd.messageId }),
                  }).catch(() => {});
                  queryClient.invalidateQueries({ queryKey: ["/api/my/dashboard-queue"] });
                }}
              />
            ))}
            {unackedCostSheets.map((cs: any) => (
              <QueueRow
                key={cs.id}
                tone="task"
                icon={<FileText className="w-4 h-4" />}
                title={`Cost sheet from ${cs.providerName || "your provider"} - ${formatCents(cs.totalCostCents)}`}
                detail="Review it in your chat"
                cta="Review"
                onClick={() => navigate(`/chat/${cs.sessionId}?msg=quote:${cs.id}`)}
              />
            ))}
            {/* Per-terminal next steps LAST: the concrete items above are
                things blocking on the parent right now; these are the
                standing "here's what comes next" per journey. */}
            {/* The title counts only what is waiting on the parent; the
                standing next steps get their own label so "(1)" never sits
                over three rows. */}
            {blockingCount > 0 && nextStepRows.length > 0 && (
              <p className="t-micro-label pt-2">Next steps</p>
            )}
            {nextStepRows.map((c) => (
              <QueueRow
                key={c.key}
                tone="task"
                icon={<Map className="w-4 h-4" />}
                title={c.title}
                detail={c.detail}
                cta={c.cta}
                onClick={() => navigate(c.to)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Upcoming meetings */}
      <Card className="p-6 space-y-3">
        <SectionHeader icon={<Video className="w-5 h-5 text-primary" />} title="Upcoming meetings" viewAllTo="/calendar" />
        {bookingsQuery.isError ? (
          <div className="flex items-center gap-3 py-2" role="alert">
            <AlertCircle className="w-4 h-4 shrink-0 text-[hsl(var(--brand-error-text))]" aria-hidden="true" />
            <p className="text-sm flex-1">We couldn't load your meetings.</p>
            <Button size="sm" variant="outline" onClick={() => void bookingsQuery.refetch()}>Retry</Button>
          </div>
        ) : bookingsQuery.isLoading ? (
          <div className="py-3 space-y-2" aria-busy="true" aria-label="Loading meetings">
            <div className="h-3.5 w-1/2 rounded-full bg-secondary animate-pulse" />
            <div className="h-3 w-1/3 rounded-full bg-secondary animate-pulse" />
          </div>
        ) : upcomingMeetings.length === 0 ? (
          // Neutral, not success green: for a parent who has not booked a
          // Match Call yet, an empty calendar is not good news.
          <p className="t-helper py-3">Nothing booked yet. When you're ready, {conciergeName} sets up a free consultation from chat.</p>
        ) : (
          <div className="divide-y">
            {upcomingMeetings.slice(0, 3).map((b: any) => {
              const open = openMeetingId === b.id;
              return (
                <div key={b.id} className="py-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{b.subject || `Meeting with ${b.providerUser?.name || "your provider"}`}</p>
                      <p className="t-helper">
                        {fmtWhen(b.scheduledAt)}
                        {b.status === "PENDING" && (
                          <span className="text-[hsl(var(--brand-warning-text))]"> - awaiting confirmation</span>
                        )}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenMeetingId(open ? null : b.id)}
                      aria-expanded={open}
                      aria-controls={`booking-detail-panel-${b.id}`}
                      className="gap-1"
                    >
                      {open ? "Hide" : "Details"}
                      {open ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
                    </Button>
                  </div>
                  {/* Expands in place: the meeting card used to be a modal
                      with Reschedule and Cancel inside it. */}
                  {open && <BookingDetailPanel booking={b} onClose={() => setOpenMeetingId(null)} />}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      </div>

      {/* Phase 7A: journey timelines - one card per active journey, every
          type the parent is running in parallel (surrogacy, egg donation,
          IVF, banks, legal). Derived server-side; parents see their own
          account automatically. Home shows done / now / next per journey
          with the whole road behind a toggle. */}
      <Card className="p-6 space-y-3">
        <SectionHeader
          icon={<Map className="w-5 h-5 text-primary" />}
          title="Your journey"
        />
        <JourneyTimelineCard variant="home" testId="home-journeys" />
      </Card>

      {/* Permanent Intended Parent Form handle - always here once the form has
          been sent, so the parent can reopen/edit/view it any time (the
          "needs attention" task above disappears once submitted). */}
      {queue?.ipForm && (() => {
        const f = queue.ipForm!;
        const submitted = f.status === "SUBMITTED";
        const readyToSubmit = !submitted && (f.hasSecondParent ? f.signedSlots.includes(2) : f.signedSlots.includes(1));
        const href = f.lastSectionKey ? `/ip-form?section=${encodeURIComponent(f.lastSectionKey)}` : "/ip-form";
        return (
          <Card className="p-6 space-y-3" data-testid="home-ip-form-card">
            <SectionHeader icon={<FileText className="w-5 h-5 text-primary" />} title="Your Intended Parent Form" />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="t-helper flex-1 min-w-[14rem]">
                {submitted
                  ? "Submitted and shared with your surrogacy agency. You can review it any time."
                  : readyToSubmit
                  ? "Both signatures are in - review and submit when you're ready."
                  : "Your agency shares this with potential surrogates before your match call."}
              </p>
              <Button variant={submitted ? "outline" : "default"} onClick={() => navigate(href)} data-testid="home-ip-form-open" className="shrink-0">
                {submitted ? "View form" : readyToSubmit ? "Submit form" : "Open form"}
              </Button>
            </div>
          </Card>
        );
      })()}

      {/* Billing row: cost sheets and invoices sit side by side on desktop (both
          are short 3-row lists) and stack on mobile. Each card renders only
          once it has something to show. */}
      {(showCostSheets || showInvoices) && (
        <div className="grid gap-6 lg:grid-cols-2">
        {showCostSheets && (
        <Card className="p-6 space-y-3">
          <SectionHeader icon={<FileText className="w-5 h-5 text-primary" />} title="Cost sheets" viewAllTo="/my/cost-sheets" />
          <div className="divide-y">
            {costSheets.slice(0, 3).map((cs: any) => (
              <div key={cs.id} className="flex items-center gap-3 py-3" style={{ opacity: cs.supersededAt ? 0.65 : 1 }}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{cs.providerName || "Provider"}</p>
                  <p className="t-helper">
                    {new Date(cs.createdAt).toLocaleDateString()}
                    {cs.supersededAt ? " - Superseded" : cs.parentAcknowledgedAt ? " - Acknowledged" : " - Awaiting your review"}
                  </p>
                </div>
                <p className="text-sm font-heading font-bold shrink-0">{formatCents(cs.totalCostCents)}</p>
                <Button variant="outline" size="sm" onClick={() => navigate(`/chat/${cs.sessionId}?msg=quote:${cs.id}`)} aria-label={`Open cost sheet from ${cs.providerName || "provider"}`}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        </Card>
        )}

        {showInvoices && (
        <Card className="p-6 space-y-3">
          <SectionHeader icon={<ReceiptIcon className="w-5 h-5 text-primary" />} title="Invoices" viewAllTo="/my/invoices" />
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
              <p className="t-micro-label">Total paid</p>
              <p className="text-lg font-heading font-bold">{formatCents(totalPaid)}</p>
            </div>
            <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
              <p className="t-micro-label">Awaiting payment</p>
              <p className="text-lg font-heading font-bold">{unpaidInvoices.length}</p>
            </div>
          </div>
          {invoices.slice(0, 3).map((inv: any) => (
            <div key={inv.id} className="flex items-center gap-3 py-2 border-t">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{inv.providerName}</p>
                <p className="t-helper">{inv.serviceType} - {new Date(inv.createdAt).toLocaleDateString()}</p>
              </div>
              <InvoiceStatusBadge status={inv.status} medicalClearanceStatus={(inv as any).medicalClearanceStatus} />
              <p className="text-sm font-heading font-bold shrink-0">{formatCents(inv.serviceAmount, inv.currency)}</p>
            </div>
          ))}
        </Card>
        )}
        </div>
      )}

      {/* Agreements */}
      {showAgreements && (
        <Card className="p-6 space-y-3">
          {/* No dedicated agreements page - parents have 1-2 agreements, each
              row opens the agreement directly. */}
          <SectionHeader
            icon={<FileSignature className="w-5 h-5 text-primary" />}
            title="Agreements"
          />
          <AgreementRows
            items={myAgreements.map((a: any) => ({
              id: a.id,
              status: a.status,
              documentType: a.documentType,
              createdAt: a.createdAt,
              signedAt: a.signedAt,
              title: a.provider?.name || "Provider",
            }))}
            emptyText="No agreements yet. Your provider sends the official agreement here after your deposit payment."
          />
        </Card>
      )}

      {/* What comes later, in one line, instead of empty cards for each. */}
      {laterSections.length > 0 && (
        <p className="t-helper px-1" data-testid="home-later-sections">
          Later on this page: {joinNames(laterSections)}.
        </p>
      )}
    </div>
  );
}
