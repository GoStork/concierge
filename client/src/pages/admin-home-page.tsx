/**
 * GoStork Admin Home (/admin/home) - the platform command center.
 *
 * Same philosophy as the parent/provider dashboards, built on their shared
 * pieces (QueueRow / SectionHeader / StatTile): stuck items FIRST - human
 * escalations, deposit deadlines about to expire, agreements out for
 * signature, failed payouts - then the 30-day platform funnel, money tiles,
 * and per-automation adoption. Billing left the admin top bar; /admin/billing
 * stays routable via the Money section's View-all.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookingDetailDialog } from "@/components/booking-detail-dialog";
import { useNavigate , Link } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Headphones,
  Globe,
  Receipt,
  FileSignature,
  Landmark,
  CheckCircle2,
  CalendarClock,
  DollarSign,
  TrendingUp,
  Zap,
  Video,
  Star,
  Building2,
} from "lucide-react";
import { StarDisplay } from "@/components/reviews/reviews-ui";
import { QueueRow, SectionHeader, StatTile } from "@/components/home/home-sections";
import { MentionsCard } from "@/components/home/mentions-card";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { derivePayoutStatus } from "@/lib/payout-status";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { useToast } from "@/hooks/use-toast";

interface AdminDashboard {
  escalations: Array<{ sessionId: string; parentName: string; providerName: string | null; updatedAt: string; taskKey: string }>;
  dueInvoices: Array<{ id: string; sessionId: string | null; dueAt: string; overdue: boolean; amountCents: number; serviceType: string | null; parentName: string; providerName: string | null; taskKey: string }>;
  sentAgreements: Array<{ agreementId: string; createdAt: string; documentType: string; parentName: string; providerName: string | null; signedCount: number; signerCount: number }>;
  failedPayouts: Array<{ id: string; payoutFailedAt: string; payoutFailureReason: string | null; amountCents: number; providerName: string | null; parentName: string; taskKey: string }>;
  pendingMeetings: Array<{ id: string; scheduledAt: string; subject: string | null; parentName: string; hostName: string; hostUserId: string | null; taskKey: string }>;
  funnel: { activeSessions: number; hotLeads: number; callsBooked: number; matched: number; onHold: number; depositsPaid: number; agreementsSigned: number };
  money: { totalCollected: number; totalFees: number; pendingPayouts: number; payoutsSent: number; awaitingPayment: number };
  adoption: { total: number; costSheet: number; invoice: number; agreement: number };
  upcomingMeetings: Array<{ id: string; scheduledAt: string; subject: string | null; status: string; hostUserId: string | null; parentName: string; providerName: string }>;
  recentInvoices: Array<{ id: string; status: string; amountCents: number; serviceType: string | null; createdAt: string; parentName: string; providerName: string | null }>;
  recentPayouts: Array<{ id: string; amountCents: number; paidAt: string | null; payoutInitiatedAt: string | null; payoutFailedAt: string | null; stripeTransferId: string | null; bankPayoutCompletedAt: string | null; bankPayoutFailedAt: string | null; status: string; providerName: string | null; parentName: string }>;
}

/** Phase 8: the newest few parent reviews, linking to the full /admin/reviews queue. */
function LatestReviewsCard() {
  const q = useQuery<any[]>({
    queryKey: ["/api/admin/reviews", "home"],
    queryFn: async () => {
      const res = await fetch("/api/admin/reviews", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load reviews");
      return res.json();
    },
    staleTime: 30_000,
  });
  const rows = (q.data || []).slice(0, 3);
  return (
    <Card className="p-5 space-y-3">
      <SectionHeader icon={<Star className="w-5 h-5 text-primary" />} title="Latest parent reviews" viewAllTo="/admin/reviews" viewAllLabel="Review Queue" />
      {rows.length === 0 ? (
        <p className="t-helper py-2">No reviews yet - parents are invited after consultations, matches, and handoff.</p>
      ) : (
        <div className="divide-y">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 py-3">
              <StarDisplay value={r.rating} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {r.providerName}{r.memberName ? ` - ${r.memberName}` : ""}
                  {r.visibility === "PRIVATE_FEEDBACK" && <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-secondary text-foreground">Private</span>}
                  {r.flaggedByProviderAt && <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]">Flagged</span>}
                </p>
                {r.text && <p className="t-helper truncate">{r.text}</p>}
              </div>
              <Link to="/admin/reviews" className="text-xs text-primary hover:underline shrink-0">Open</Link>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function AdminHomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const firstName = (user as any)?.firstName || (user as any)?.name?.split(" ")[0] || "there";

  const { data, isLoading } = useQuery<AdminDashboard>({
    queryKey: ["/api/admin/dashboard"],
    queryFn: async () => {
      const res = await fetch("/api/admin/dashboard", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load dashboard");
      return res.json();
    },
    // Always fresh - the global defaults cache forever, which would leave
    // resolved queue items on screen until a hard refresh.
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<any>(null);

  // The dashboard payload carries trimmed meeting rows; the popup needs the
  // full booking (participants, meeting room, status machinery) - fetch the
  // admin calendar list on demand and pick the row.
  const openMeeting = async (id: string) => {
    try {
      const res = await fetch("/api/calendar/bookings", { credentials: "include" });
      if (!res.ok) throw new Error();
      const all = await res.json();
      const full = (Array.isArray(all) ? all : []).find((b: any) => b.id === id);
      if (full) setSelectedMeeting(full);
      else navigate("/calendar");
    } catch {
      navigate("/calendar");
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/dashboard"] });

  const dismiss = useMutation({
    mutationFn: async (taskKey: string) => {
      const res = await fetch("/api/admin/dashboard/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ taskKey }),
      });
      if (!res.ok) throw new Error("Failed to dismiss");
      return taskKey;
    },
    onSuccess: (taskKey: string) => {
      refresh();
      toast({
        title: "Dismissed",
        description: "It will reappear if the same problem happens again.",
        action: (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await fetch(`/api/admin/dashboard/dismiss?taskKey=${encodeURIComponent(taskKey)}`, {
                method: "DELETE",
                credentials: "include",
              });
              refresh();
            }}
          >
            Undo
          </Button>
        ),
      });
    },
    onError: () => toast({ title: "Could not dismiss", variant: "destructive" }),
  });

  const retryPayout = async (invoiceId: string, providerName: string | null) => {
    setRetryingId(invoiceId);
    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/retry-payout`, {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || "Retry failed");
      if (body?.status === "transferred") {
        toast({ title: "Payout sent", description: `Transfer to ${providerName || "provider"} succeeded.`, variant: "success" });
      } else if (body?.status === "deferred") {
        toast({ title: "Funds still settling", description: "An automatic retry is scheduled - no action needed." });
      } else if (body?.status === "failed") {
        toast({ title: "Retry failed", description: body?.reason || "Unknown error", variant: "destructive" });
      } else {
        toast({ title: "Payout skipped", description: body?.message || body?.reason || "Nothing to transfer." });
      }
    } catch (e: any) {
      toast({ title: "Retry failed", description: e?.message, variant: "destructive" });
    } finally {
      setRetryingId(null);
      refresh();
    }
  };

  // Providers still onboarding (checklist < 100%) - one aggregate row each.
  const onboardingQ = useQuery<Array<{ providerId: string; providerName: string; doneCount: number; requiredCount: number; percent: number }>>({
    queryKey: ["/api/admin/onboarding/pending"],
    queryFn: async () => {
      const res = await fetch("/api/admin/onboarding/pending", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load onboarding queue");
      return res.json();
    },
    staleTime: 60_000,
  });
  const onboardingRows = onboardingQ.data || [];

  const queueCount =
    onboardingRows.length +
    (((data as any)?.signedProviderAgreements?.length as number) || 0) +
    (data?.escalations.length || 0) +
    (data?.pendingMeetings?.length || 0) +
    (data?.dueInvoices.filter(i => i.overdue).length || 0) +
    (data?.failedPayouts.length || 0) +
    ((data as any)?.flaggedReviews?.length || 0);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6 pb-24 md:pb-6">
      <div>
        <h1 className="text-2xl font-heading">Welcome back, {firstName}</h1>
        <p className="t-helper mt-1">The full picture - every parent, provider, and journey on the platform.</p>
      </div>

      {/* Someone tagged you - shown above the queue, cleared on open. */}
      <MentionsCard />

      {/* Needs attention: escalations, unconfirmed meetings, overdue deposits, failed payouts */}
      <Card className="p-5 space-y-3">
        <SectionHeader
          icon={<CheckCircle2 className="w-5 h-5 text-primary" />}
          title={queueCount > 0 ? `Needs attention (${queueCount})` : "Needs attention"}
        />
        {isLoading ? (
          <p className="t-helper py-2">Loading...</p>
        ) : queueCount === 0 ? (
          <div className="flex items-center gap-2 py-3 text-sm" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4" />
            All clear - no escalations, unconfirmed meetings, overdue deposits, or failed payouts.
          </div>
        ) : (
          <div className="space-y-2">
            {/* Providers mid-onboarding - open the edit page to continue the checklist. */}
            {onboardingRows.map((o) => (
              <QueueRow
                key={`onb-${o.providerId}`}
                tone="task"
                icon={<Building2 className="w-4 h-4" />}
                title={`${o.providerName} - onboarding ${o.doneCount}/${o.requiredCount}`}
                detail={`${o.percent}% of required setup steps done`}
                cta="Continue"
                onClick={() => navigate(`/admin/providers/${o.providerId}`)}
              />
            ))}
            {/* Good news first: a provider executed the GoStork agreement. */}
            {((data as any)?.signedProviderAgreements || []).map((a: any) => (
              <QueueRow
                key={a.taskKey}
                icon={<FileSignature className="w-4 h-4" />}
                title={`${a.providerName} signed the GoStork agreement`}
                detail={`Signed ${fmtWhen(a.completedAt)} - the executed contract is ready to download`}
                cta="Open"
                onClick={() => navigate(`/account/documents?agreement=${a.id}`)}
                onDismiss={() => dismiss.mutate(a.taskKey)}
              />
            ))}
            {((data as any)?.flaggedReviews || []).map((r: any) => (
              <QueueRow
                key={r.taskKey}
                tone="task"
                icon={<Star className="w-4 h-4" />}
                title={`${r.providerName || "A provider"} flagged a ${r.rating ?? "?"}-star review for re-check`}
                detail={r.flagReason ? `"${r.flagReason}" - flagged ${fmtWhen(r.flaggedAt)}` : `Flagged ${fmtWhen(r.flaggedAt)}`}
                cta="Review"
                onClick={() => navigate("/admin/reviews?filter=flagged")}
                onDismiss={() => dismiss.mutate(r.taskKey)}
              />
            ))}
            {(data?.escalations || []).map(e => (
              <QueueRow
                key={e.sessionId}
                tone="task"
                icon={<Headphones className="w-4 h-4" />}
                title={`${e.parentName} asked for a human${e.providerName ? ` (${e.providerName} journey)` : ""}`}
                detail={`Waiting since ${fmtWhen(e.updatedAt)}`}
                cta="Take over"
                onClick={() => navigate(`/admin/concierge-monitor?sessionId=${e.sessionId}`)}
                onDismiss={() => dismiss.mutate(e.taskKey)}
              />
            ))}
            {(data?.pendingMeetings || []).map(b => (
              <QueueRow
                key={b.id}
                tone="task"
                icon={<CalendarClock className="w-4 h-4" />}
                title={`${b.parentName}'s "${b.subject || "meeting"}" is awaiting confirmation`}
                detail={`Host: ${b.hostName} - ${fmtWhen(b.scheduledAt)}`}
                cta="Review"
                onClick={() => openMeeting(b.id)}
                onDismiss={() => dismiss.mutate(b.taskKey)}
              />
            ))}
            {(data?.dueInvoices || []).filter(i => i.overdue).map(inv => (
              <QueueRow
                key={inv.id}
                tone="task"
                icon={<Receipt className="w-4 h-4" />}
                title={`${inv.parentName}'s ${formatCents(inv.amountCents)} deposit is past its deadline`}
                detail={`${inv.providerName || "Provider"} - was due ${fmtWhen(inv.dueAt)}`}
                cta="Review"
                onClick={() => navigate(`/admin/billing?q=${inv.id}`)}
                onDismiss={() => dismiss.mutate(inv.taskKey)}
              />
            ))}
            {(data?.failedPayouts || []).map(fp => (
              <QueueRow
                key={fp.id}
                tone="task"
                icon={<Landmark className="w-4 h-4" />}
                title={`Payout of ${formatCents(fp.amountCents)} to ${fp.providerName || "provider"} failed`}
                detail={`${fp.parentName}'s invoice - failed ${fmtWhen(fp.payoutFailedAt)}${fp.payoutFailureReason ? ` - ${fp.payoutFailureReason}` : ""}`}
                cta="Open"
                onClick={() => navigate(`/admin/billing?q=${fp.id}`)}
                action={{ label: "Retry payout", loading: retryingId === fp.id, onClick: () => retryPayout(fp.id, fp.providerName) }}
                onDismiss={() => dismiss.mutate(fp.taskKey)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Upcoming meetings - the admin's own on top, then platform wide */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Video className="w-5 h-5 text-primary" />} title="Upcoming meetings" viewAllTo="/calendar" />
        {(data?.upcomingMeetings || []).length === 0 ? (
          <p className="t-helper py-2">No upcoming meetings scheduled.</p>
        ) : (() => {
          const meetings = data?.upcomingMeetings || [];
          const myId = (user as any)?.id;
          const mine = meetings.filter(b => b.hostUserId === myId);
          const platform = meetings.filter(b => b.hostUserId !== myId);
          const renderRow = (b: (typeof meetings)[number]) => (
            <div key={b.id} className="flex items-center gap-3 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{b.subject || `${b.parentName} with ${b.providerName}`}</p>
                <p className="t-helper">{b.parentName} - {b.providerName} - {fmtWhen(b.scheduledAt)}</p>
              </div>
              {b.status === "PENDING" && (
                <span className="text-xs font-medium shrink-0" style={{ color: "hsl(var(--brand-warning))" }}>Awaiting confirm</span>
              )}
              <Button variant="outline" size="sm" onClick={() => openMeeting(b.id)}>
                Details
              </Button>
            </div>
          );
          return (
            <div className="space-y-4">
              {/* My meetings: tinted panel so the admin's own commitments
                  never blend into the marketplace noise below */}
              {mine.length > 0 && (
                <div className="rounded-[var(--radius)] border border-[hsl(var(--primary)/0.25)] bg-secondary/60 px-4 pb-1 pt-3">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center bg-primary text-primary-foreground">
                      <Headphones className="w-3.5 h-3.5" />
                    </span>
                    <p className="text-sm font-heading font-semibold">My meetings</p>
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">{mine.length}</span>
                  </div>
                  <div className="divide-y">{mine.map(renderRow)}</div>
                </div>
              )}
              {platform.length > 0 && (
                <div className="rounded-[var(--radius)] border border-[hsl(var(--accent)/0.25)] bg-[hsl(var(--accent)/0.08)] px-4 pb-1 pt-3">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full flex items-center justify-center bg-accent text-accent-foreground">
                      <Globe className="w-3.5 h-3.5" />
                    </span>
                    <p className="text-sm font-heading font-semibold">Platform meetings</p>
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[hsl(var(--accent)/0.15)] text-accent">{platform.length}</span>
                  </div>
                  <div className="divide-y">{platform.map(renderRow)}</div>
                </div>
              )}
            </div>
          );
        })()}
      </Card>

      {/* Platform funnel - last 30 days */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<TrendingUp className="w-5 h-5 text-primary" />} title="Platform funnel" viewAllTo="/admin/analytics" viewAllLabel="Journey Analytics" />
        <p className="t-helper -mt-2">Last 30 days (Matched and On Hold are current counts)</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile label="Active sessions" value={data?.funnel.activeSessions ?? 0} />
          <StatTile label="Hot leads" value={data?.funnel.hotLeads ?? 0} />
          <StatTile label="Calls booked" value={data?.funnel.callsBooked ?? 0} />
          <StatTile label="On hold" value={data?.funnel.onHold ?? 0} hint="surrogates in match calls" />
          <StatTile label="Matched" value={data?.funnel.matched ?? 0} hint="surrogates matched" />
          <StatTile label="Deposits paid" value={data?.funnel.depositsPaid ?? 0} />
          <StatTile label="Agreements signed" value={data?.funnel.agreementsSigned ?? 0} />
          <StatTile label="Net Income" value={formatCents(data?.money.totalFees ?? 0)} hint="GoStork Fees - all time" />
        </div>
      </Card>

      {/* Phase 8: latest parent reviews (auto-published; this is the human backstop) */}
      <LatestReviewsCard />

      {/* Deposit deadlines (upcoming, not yet overdue) */}
      {(data?.dueInvoices || []).filter(i => !i.overdue).length > 0 && (
        <Card className="p-5 space-y-3">
          <SectionHeader icon={<Receipt className="w-5 h-5 text-primary" />} title="Deposit deadlines" viewAllTo="/admin/billing" />
          <div className="divide-y">
            {(data?.dueInvoices || []).filter(i => !i.overdue).map(inv => (
              <div key={inv.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{inv.parentName} - {inv.providerName || "Provider"}</p>
                  <p className="t-helper">Due {fmtWhen(inv.dueAt)}</p>
                </div>
                <p className="text-sm font-heading font-bold shrink-0">{formatCents(inv.amountCents)}</p>
                <Button variant="outline" size="sm" onClick={() => navigate(`/admin/billing?q=${inv.id}`)}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Agreements out for signature - platform wide */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<FileSignature className="w-5 h-5 text-primary" />} title="Out for signature" viewAllTo="/admin/agreements?status=sent" />
        {(data?.sentAgreements || []).length === 0 ? (
          <p className="t-helper py-2">No agreements awaiting signatures right now.</p>
        ) : (
          <div className="divide-y">
            {(data?.sentAgreements || []).map(a => (
              <div key={a.agreementId} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{a.parentName} - {a.providerName || "Provider"}</p>
                  <p className="t-helper">{a.documentType} - sent {new Date(a.createdAt).toLocaleDateString()}</p>
                </div>
                <span className="text-xs font-medium shrink-0" style={{ color: "hsl(var(--brand-warning))" }}>
                  {a.signerCount > 0 ? `${a.signedCount}/${a.signerCount} signed` : "Awaiting signature"}
                </span>
                <Button variant="outline" size="sm" onClick={() => navigate(`/agreements/${a.agreementId}`)}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Money */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<DollarSign className="w-5 h-5 text-primary" />} title="Money" viewAllTo="/admin/billing" />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatTile label="Gross Income" value={formatCents(data?.money.totalCollected ?? 0)} hint="Total Paid Invoices" />
          <StatTile label="Payouts Sent" value={formatCents(data?.money.payoutsSent ?? 0)} hint="COGS" />
          <StatTile label="Net Income" value={formatCents(data?.money.totalFees ?? 0)} hint="GoStork Fees" />
          <StatTile label="Pending Payouts" value={formatCents((data?.money.totalCollected ?? 0) - (data?.money.payoutsSent ?? 0))} hint="Future COGS" />
          <StatTile label="Unpaid Invoices" value={formatCents(data?.money.awaitingPayment ?? 0)} hint="Future Invoices" />
        </div>
      </Card>

      {/* Invoices */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Receipt className="w-5 h-5 text-primary" />} title="Invoices" viewAllTo="/admin/billing" />
        {(data?.recentInvoices || []).length === 0 ? (
          <p className="t-helper py-2">No invoices yet.</p>
        ) : (
          <div className="divide-y">
            {(data?.recentInvoices || []).map(inv => (
              <div key={inv.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{inv.parentName} - {inv.providerName || "Provider"}</p>
                  <p className="t-helper">{(inv.serviceType || "").replace(/_/g, " ").toLowerCase()} - {new Date(inv.createdAt).toLocaleDateString()}</p>
                </div>
                <InvoiceStatusBadge status={inv.status} medicalClearanceStatus={(inv as any).medicalClearanceStatus} />
                <p className="text-sm font-heading font-bold shrink-0">{formatCents(inv.amountCents)}</p>
                <Button variant="outline" size="sm" onClick={() => navigate(`/admin/billing?q=${inv.id}`)}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Payouts */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Landmark className="w-5 h-5 text-primary" />} title="Payouts" viewAllTo="/admin/billing?tab=PAID" />
        {(data?.recentPayouts || []).length === 0 ? (
          <p className="t-helper py-2">No payouts yet.</p>
        ) : (
          <div className="divide-y">
            {(data?.recentPayouts || []).map(po => {
              const ps = derivePayoutStatus(po as any);
              return (
                <div key={po.id} className="flex items-center gap-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{po.providerName || "Provider"}</p>
                    <p className="t-helper">{po.parentName}'s invoice - {po.paidAt ? new Date(po.paidAt).toLocaleDateString() : ""}</p>
                  </div>
                  <span className="text-xs font-medium shrink-0" title={ps.tooltip} style={{ color: ps.color }}>{ps.label}</span>
                  <p className="text-sm font-heading font-bold shrink-0">{formatCents(po.amountCents)}</p>
                  <Button variant="outline" size="sm" onClick={() => navigate(`/admin/billing?q=${po.id}`)}>
                    Open
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Automation adoption */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Zap className="w-5 h-5 text-primary" />} title="Automation adoption" viewAllTo="/admin/providers?automation=all_on" viewAllLabel="Providers" />
        <p className="t-helper -mt-2">Providers with each automation live, out of {data?.adoption.total ?? 0} approved providers. Click a tile to see who.</p>
        <div className="grid grid-cols-3 gap-3">
          <Link to="/admin/providers?automation=cost_sheet" className="block" data-testid="adoption-link-cost-sheet">
            <StatTile label="Cost-sheet drafts" value={`${data?.adoption.costSheet ?? 0}/${data?.adoption.total ?? 0}`} hint="on booking" />
          </Link>
          <Link to="/admin/providers?automation=invoice" className="block" data-testid="adoption-link-invoice">
            <StatTile label="Invoice drafts" value={`${data?.adoption.invoice ?? 0}/${data?.adoption.total ?? 0}`} hint="on parent-ready" />
          </Link>
          <Link to="/admin/providers?automation=agreement" className="block" data-testid="adoption-link-agreement">
            <StatTile label="Agreement drafts" value={`${data?.adoption.agreement ?? 0}/${data?.adoption.total ?? 0}`} hint="on invoice-paid" />
          </Link>
        </div>
      </Card>

      <BookingDetailDialog booking={selectedMeeting} open={!!selectedMeeting} onClose={() => setSelectedMeeting(null)} />
    </div>
  );
}
