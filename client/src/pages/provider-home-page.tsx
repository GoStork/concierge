/**
 * Provider Home dashboard (/provider/home).
 *
 * Work queue first: every unresolved inline decision across the provider's
 * sessions (cost-sheet / invoice / agreement approval cards, readiness
 * questions, whispers, pending bookings, agreements out for signature), then
 * upcoming meetings, revenue tiles, and compact Billing / Agreements /
 * Performance summaries. Billing and Performance left the top nav - this page
 * is their front door; the full pages stay routable via View-all links.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookingDetailDialog } from "@/components/booking-detail-dialog";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Receipt,
  FileSignature,
  FileText,
  CheckCircle2,
  ChevronRight,
  Video,
  DollarSign,
  MessageCircleQuestion,
  MessageCircle,
  CalendarClock,
  BarChart3,
  Landmark,
} from "lucide-react";
import { AgreementRows } from "@/components/agreements-list";
import { QueueRow, SectionHeader } from "@/components/home/home-sections";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { derivePayoutStatus } from "@/lib/payout-status";

interface ProviderQueue {
  openApprovals: Array<{ messageId: string; sessionId: string; type: string; createdAt: string; parentName: string; documentType: string | null; totalCents: number | null }>;
  pendingWhispers: Array<{ id: string; questionText: string; createdAt: string }>;
  agreementsAwaiting: Array<{ agreementId: string; documentType: string; createdAt: string; parentName: string; signedCount: number; signerCount: number }>;
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function approvalLabel(a: ProviderQueue["openApprovals"][number]): { title: string; detail: string; cta: string } {
  switch (a.type) {
    case "cost_sheet_draft_approval":
      return { title: `Cost sheet draft for ${a.parentName}`, detail: "Eva drafted it - review and approve to send", cta: "Review" };
    case "invoice_draft_approval":
      return {
        title: `Invoice draft for ${a.parentName}${a.totalCents ? ` - ${formatCents(a.totalCents)}` : ""}`,
        detail: "Eva drafted it - review and approve to send",
        cta: "Review",
      };
    case "agreement_draft_approval":
      return { title: `${a.documentType || "Agreement"} draft for ${a.parentName}`, detail: "Payment cleared - approve to send for signature", cta: "Review" };
    case "provider_readiness_prompt":
      return { title: `Match readiness question for ${a.parentName}`, detail: "Does your surrogate want to move forward?", cta: "Answer" };
    default:
      return { title: `Pending item for ${a.parentName}`, detail: "Open the chat to resolve it", cta: "Open" };
  }
}

export default function ProviderHomePage() {
  const [selectedMeeting, setSelectedMeeting] = useState<any>(null);
  const { user } = useAuth();
  const navigate = useNavigate();
  const firstName = (user as any)?.firstName || (user as any)?.name?.split(" ")[0] || "there";

  // Always refetch on mount/focus - global defaults cache forever, which
  // would leave resolved queue items on screen until a hard refresh.
  const fresh = { refetchOnMount: "always" as const, refetchOnWindowFocus: true, staleTime: 15_000 };

  const { data: queue } = useQuery<ProviderQueue>({ queryKey: ["/api/provider/dashboard-queue"], ...fresh });

  const { data: providerSessions = [] } = useQuery<Array<{ id: string; unreadCount?: number; pendingQuestions?: number }>>({
    queryKey: ["/api/provider/concierge-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/provider/concierge-sessions", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    ...fresh,
  });

  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: ["/api/provider/invoices"],
    queryFn: async () => {
      const res = await fetch("/api/provider/invoices", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      const d = await res.json();
      return Array.isArray(d) ? d : (d.invoices || []);
    },

    ...fresh,
  });

  const { data: providerAgreements = [] } = useQuery<any[]>({
    queryKey: ["/api/agreements"],
    queryFn: async () => {
      const res = await fetch("/api/agreements", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreements");
      return res.json();
    },

    ...fresh,
  });

  const { data: costSheetData } = useQuery<{ quotes: any[] }>({
    queryKey: ["/api/provider/cost-sheets"],
    queryFn: async () => {
      const res = await fetch("/api/provider/cost-sheets", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cost sheets");
      return res.json();
    },
    ...fresh,
  });

  // Last-30-days engagement KPIs - same endpoint the full Performance page
  // (sponsorship dashboard in "performance" mode) reads.
  const { data: perf } = useQuery<any>({
    queryKey: ["/api/sponsorship/analytics", "home", "30"],
    queryFn: async () => {
      const res = await fetch("/api/sponsorship/analytics?range=30&scope=all", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    ...fresh,
  });

  const { data: pendingBookings = [] } = useQuery<any[]>({
    queryKey: ["/api/calendar/bookings/pending"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/bookings/pending", { credentials: "include" });
      if (!res.ok) return [];
      const d = await res.json();
      // Endpoint also returns recently EXPIRED rows for the calendar page -
      // the work queue only wants live PENDING requests.
      const rows = Array.isArray(d) ? d : (d.bookings || []);
      return rows.filter((b: any) => b.status === "PENDING");
    },

    ...fresh,
  });

  const { data: bookings = [] } = useQuery<any[]>({
    queryKey: ["/api/calendar/bookings", "provider-home"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/bookings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load meetings");
      return res.json();
    },

    ...fresh,
  });

  const upcomingMeetings = bookings
    .filter((b: any) => new Date(b.scheduledAt).getTime() > Date.now() && !["CANCELLED", "DECLINED", "RESCHEDULED", "EXPIRED"].includes(b.status))
    .sort((a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  const costSheets = costSheetData?.quotes || [];
  const kpis = perf?.kpis;
  // Signer progress per SENT agreement (from the work-queue endpoint) so the
  // Agreements section absorbs the old separate "Out for signature" block.
  const progressByAgreement = new Map(
    (queue?.agreementsAwaiting || []).map(a => [
      a.agreementId,
      a.signerCount > 0 ? `${a.signedCount}/${a.signerCount} signed` : null,
    ]),
  );

  const totalReceived = invoices.filter((i: any) => i.status === "PAID").reduce((s: number, i: any) => s + (i.providerPayoutAmount || 0), 0);
  const awaitingCount = invoices.filter((i: any) => ["AWAITING_PAYMENT", "PAYMENT_PROCESSING"].includes(i.status)).length;
  const pendingPayouts = invoices.filter((i: any) => i.status === "PAID" && !i.stripeTransferId).length;

  const unreadMessages = providerSessions.reduce((sum, cs) => sum + (cs.unreadCount || 0), 0);

  const payoutRows = invoices
    .filter((i: any) => i.status === "PAID" && (i.providerPayoutAmount || 0) > 0)
    .sort((a: any, b: any) => new Date(b.payoutInitiatedAt || b.paidAt || b.createdAt).getTime() - new Date(a.payoutInitiatedAt || a.paidAt || a.createdAt).getTime());

  const queueCount =
    (queue?.openApprovals.length || 0) +
    (queue?.pendingWhispers.length || 0) +
    pendingBookings.length +
    (unreadMessages > 0 ? 1 : 0);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6 pb-24 md:pb-6">
      <div>
        <h1 className="text-2xl font-heading">Welcome back, {firstName}</h1>
        <p className="text-sm text-muted-foreground mt-1">Everything that needs your attention, in one place.</p>
      </div>

      {/* Work queue */}
      <Card className="p-5 space-y-3">
        <SectionHeader
          icon={<CheckCircle2 className="w-5 h-5 text-primary" />}
          title={queueCount > 0 ? `Your work queue (${queueCount})` : "Your work queue"}
        />
        {queueCount === 0 ? (
          <div className="flex items-center gap-2 py-3 text-sm" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4" />
            All clear - nothing waiting on you right now.
          </div>
        ) : (
          <div className="space-y-2">
            {(queue?.openApprovals || []).map(a => {
              const { title, detail, cta } = approvalLabel(a);
              const icon = a.type === "invoice_draft_approval" ? <Receipt className="w-4 h-4" />
                : a.type === "agreement_draft_approval" ? <FileSignature className="w-4 h-4" />
                : a.type === "provider_readiness_prompt" ? <MessageCircleQuestion className="w-4 h-4" />
                : <FileText className="w-4 h-4" />;
              return (
                <QueueRow
                  key={a.messageId}
                  icon={icon}
                  title={title}
                  detail={detail}
                  cta={cta}
                  onClick={() => navigate(`/chat/${a.sessionId}?msg=${a.messageId}`)}
                />
              );
            })}
            {pendingBookings.map((b: any) => (
              <QueueRow
                key={b.id}
                icon={<CalendarClock className="w-4 h-4" />}
                title={`Meeting request${b.parentUser?.name ? ` from ${b.parentUser.name}` : b.attendeeName ? ` from ${b.attendeeName}` : ""}`}
                detail={fmtWhen(b.scheduledAt)}
                cta="Respond"
                onClick={() => setSelectedMeeting(b)}
              />
            ))}
            {unreadMessages > 0 && (
              <QueueRow
                icon={<MessageCircle className="w-4 h-4" />}
                title={`${unreadMessages} unread message${unreadMessages === 1 ? "" : "s"}`}
                detail="Parents are waiting on a reply"
                cta="Open chats"
                onClick={() => navigate("/chat")}
              />
            )}
            {(queue?.pendingWhispers || []).map(w => (
              <QueueRow
                key={w.id}
                icon={<MessageCircleQuestion className="w-4 h-4" />}
                title="Question from a prospective parent"
                detail={w.questionText.length > 90 ? `${w.questionText.slice(0, 90)}...` : w.questionText}
                cta="Answer"
                onClick={() => navigate("/chat")}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Upcoming meetings */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Video className="w-5 h-5 text-primary" />} title="Upcoming meetings" viewAllTo="/calendar" />
        {upcomingMeetings.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No upcoming meetings scheduled.</p>
        ) : (
          <div className="divide-y">
            {upcomingMeetings.slice(0, 3).map((b: any) => (
              <div key={b.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{b.subject || `Meeting with ${b.parentUser?.name || b.attendeeName || "a parent"}`}</p>
                  <p className="text-xs text-muted-foreground">{fmtWhen(b.scheduledAt)}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setSelectedMeeting(b)}>
                  Details
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Cost sheets */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<FileText className="w-5 h-5 text-primary" />} title="Cost Sheets" viewAllTo="/provider/cost-sheets" />
        {costSheets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No cost sheets shared yet. Eva drafts one when a parent books a consult (with auto-draft on), or share one from the + menu in any chat.</p>
        ) : (
          <div className="divide-y">
            {costSheets.slice(0, 3).map((cs: any) => (
              <div key={cs.id} className="flex items-center gap-3 py-3" style={{ opacity: cs.supersededAt ? 0.65 : 1 }}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{cs.parentName}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(cs.createdAt).toLocaleDateString()}
                    {cs.supersededAt ? " - Superseded" : cs.parentAcknowledgedAt ? " - Acknowledged" : " - Awaiting parent review"}
                  </p>
                </div>
                <p className="text-sm font-heading font-bold shrink-0">{formatCents(cs.totalCostCents)}</p>
                <Button variant="outline" size="sm" onClick={() => navigate(`/chat/${cs.sessionId}?msg=quote:${cs.id}`)}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Invoices summary */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<DollarSign className="w-5 h-5 text-primary" />} title="Invoices" viewAllTo="/provider/invoices" />
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Total received</p>
            <p className="text-lg font-heading font-bold">{formatCents(totalReceived)}</p>
          </div>
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Awaiting payment</p>
            <p className="text-lg font-heading font-bold">{awaitingCount}</p>
          </div>
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Pending payouts</p>
            <p className="text-lg font-heading font-bold">{pendingPayouts}</p>
          </div>
        </div>
        {invoices.slice(0, 3).map((inv: any) => (
          <div key={inv.id} className="flex items-center gap-3 py-2 border-t">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{inv.parentName || inv.parentUser?.name || "Parent"}</p>
              <p className="text-xs text-muted-foreground">{inv.serviceType} - {new Date(inv.createdAt).toLocaleDateString()}</p>
            </div>
            <InvoiceStatusBadge status={inv.status} />
            <p className="text-sm font-heading font-bold shrink-0">{formatCents(inv.serviceAmount, inv.currency)}</p>
            <Button variant="outline" size="sm" onClick={() => navigate(`/provider/invoices?q=${inv.id}`)}>
              Open
            </Button>
          </div>
        ))}
      </Card>

      {/* Payouts */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Landmark className="w-5 h-5 text-primary" />} title="Payouts" viewAllTo="/provider/payouts" />
        {payoutRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No payouts yet. GoStork sends your payout automatically after a parent's payment clears.</p>
        ) : (
          <div className="divide-y">
            {payoutRows.slice(0, 3).map((inv: any) => {
              const ps = derivePayoutStatus(inv);
              return (
                <div key={inv.id} className="flex items-center gap-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{inv.parentName || inv.parentUser?.name || "Parent"}</p>
                    <p className="text-xs text-muted-foreground">{(inv.serviceType || "-").replace(/_/g, " ").toLowerCase()} - {new Date(inv.payoutInitiatedAt || inv.paidAt || inv.createdAt).toLocaleDateString()}</p>
                  </div>
                  <span className="text-xs font-medium shrink-0" style={{ color: ps.color }}>{ps.label}</span>
                  <p className="text-sm font-heading font-bold shrink-0">{formatCents(inv.providerPayoutAmount, inv.currency)}</p>
                  <Button variant="outline" size="sm" onClick={() => navigate(`/provider/payouts?q=${inv.id}`)}>
                    Open
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Performance - last 30 days engagement across all profiles */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<BarChart3 className="w-5 h-5 text-primary" />} title="Performance" viewAllTo="/performance" viewAllLabel="Full report" />
        <p className="text-xs text-muted-foreground -mt-2">Last 30 days, across all your profiles</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Impressions</p>
            <p className="text-lg font-heading font-bold">{(kpis?.totalImpressions ?? 0).toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground">{(kpis?.uniqueReach ?? 0).toLocaleString()} parents reached</p>
          </div>
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Clicks</p>
            <p className="text-lg font-heading font-bold">{(kpis?.profileViews ?? 0).toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground">opened full profile</p>
          </div>
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Saves</p>
            <p className="text-lg font-heading font-bold">{(kpis?.saves ?? 0).toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground">hearted by parents</p>
          </div>
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Inquiries</p>
            <p className="text-lg font-heading font-bold">{(kpis?.inquiries ?? 0).toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground">about your profiles</p>
          </div>
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Consultations</p>
            <p className="text-lg font-heading font-bold">{(kpis?.consultations ?? 0).toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground">booked - account-level</p>
          </div>
          <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Hot Leads</p>
            <p className="text-lg font-heading font-bold">{(kpis?.hotLeads ?? 0).toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground">account-level</p>
          </div>
        </div>
      </Card>

      {/* Agreements */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<FileSignature className="w-5 h-5 text-primary" />} title="Agreements" viewAllTo="/provider/agreements" />
        <AgreementRows
          items={providerAgreements.slice(0, 5).map((a: any) => ({
            id: a.id,
            status: a.status,
            documentType: a.documentType,
            createdAt: a.createdAt,
            signedAt: a.signedAt,
            title: a.parentName,
            // Absorbs the old "Out for signature" section: SENT rows show
            // their signer progress inline.
            progressLabel: progressByAgreement.get(a.id) || null,
          }))}
          emptyText="No agreements sent yet."
        />
      </Card>
      <BookingDetailDialog booking={selectedMeeting} open={!!selectedMeeting} onClose={() => setSelectedMeeting(null)} />
    </div>
  );
}
