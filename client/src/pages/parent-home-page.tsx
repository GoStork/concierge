/**
 * Parent Home dashboard (/home).
 *
 * Action queue first ("what needs my attention right now"), then upcoming
 * meetings and compact Billing + Agreements summaries with View-all links to
 * the full pages. Billing left the top nav - this page is its front door;
 * /my/billing stays routable for the full tables. Chat remains the app's
 * default landing - Home is the overview, not the front door.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { BookingDetailDialog } from "@/components/booking-detail-dialog";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Receipt,
  FileSignature,
  CalendarClock,
  FileText,
  CheckCircle2,
  ChevronRight,
  Video,
  DollarSign,
  MessageCircle,
  Receipt as ReceiptIcon,
} from "lucide-react";
import { AgreementRows } from "@/components/agreements-list";
import { QueueRow, SectionHeader } from "@/components/home/home-sections";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

interface DashboardQueue {
  pendingProposals: Array<{ messageId: string; sessionId: string; createdAt: string; providerName: string | null; callLabel: string; subjectLabel: string | null }>;
  awaitingMySignature: Array<{ agreementId: string; documentType: string; sessionId: string; createdAt: string; providerName: string | null }>;
  prepDocs: Array<{ messageId: string; sessionId: string; createdAt: string; providerName: string | null; callLabel: string; scheduledAt: string | null; url: string; fileName: string }>;
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function ParentHomePage() {
  const [selectedMeeting, setSelectedMeeting] = useState<any>(null);
  const { user } = useAuth();
  const navigate = useNavigate();
  const firstName = (user as any)?.firstName || (user as any)?.name?.split(" ")[0] || "there";
  const isViewer = (user as any)?.parentAccountRole === "VIEWER";

  // Dashboard queries always refetch on mount/focus - the app's global
  // defaults cache forever, which left completed tasks stuck on screen until
  // a hard refresh.
  const fresh = { refetchOnMount: "always" as const, refetchOnWindowFocus: true, staleTime: 15_000 };

  const { data: queue } = useQuery<DashboardQueue>({ queryKey: ["/api/my/dashboard-queue"], ...fresh });

  const { data: chatSessions = [] } = useQuery<Array<{ id: string; unreadCount?: number }>>({
    queryKey: ["/api/my/chat-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/my/chat-sessions", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    ...fresh,
  });

  const { data: invoices = [] } = useQuery<any[]>({
    queryKey: ["/api/my/invoices"],
    queryFn: async () => {
      const res = await fetch("/api/my/invoices", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoices");
      return res.json();
    },
    enabled: !isViewer,
    ...fresh,
  });

  const { data: costSheetData } = useQuery<{ quotes: any[] }>({
    queryKey: ["/api/my/cost-sheets"],
    queryFn: async () => {
      const res = await fetch("/api/my/cost-sheets", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cost sheets");
      return res.json();
    },
    enabled: !isViewer,
    ...fresh,
  });

  const { data: myAgreements = [] } = useQuery<any[]>({
    queryKey: ["/api/my/agreements"],
    queryFn: async () => {
      const res = await fetch("/api/my/agreements", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreements");
      return res.json();
    },
    ...fresh,
  });

  const { data: bookings = [] } = useQuery<any[]>({
    queryKey: ["/api/calendar/bookings", "home"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/bookings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load meetings");
      return res.json();
    },
    ...fresh,
  });

  const unpaidInvoices = invoices.filter((i: any) => i.status === "AWAITING_PAYMENT");
  const costSheets = costSheetData?.quotes || [];
  const unackedCostSheets = costSheets.filter((cs: any) => !cs.supersededAt && !cs.parentAcknowledgedAt);
  const upcomingMeetings = bookings
    .filter((b: any) => new Date(b.scheduledAt).getTime() > Date.now() && !["CANCELLED", "DECLINED", "RESCHEDULED", "EXPIRED"].includes(b.status))
    .sort((a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  const totalPaid = invoices.filter((i: any) => i.status === "PAID").reduce((s: number, i: any) => s + (i.serviceAmount || 0), 0);

  const unreadMessages = chatSessions.reduce((sum, cs) => sum + (cs.unreadCount || 0), 0);

  const actionCount =
    unpaidInvoices.length +
    (queue?.awaitingMySignature.length || 0) +
    (queue?.pendingProposals.length || 0) +
    (queue?.prepDocs?.length || 0) +
    unackedCostSheets.length +
    (unreadMessages > 0 ? 1 : 0);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 pb-24 md:pb-6">
      <div>
        <h1 className="text-2xl font-heading">Welcome back, {firstName}</h1>
        <p className="text-sm text-muted-foreground mt-1">Here's where your journey stands.</p>
      </div>

      {/* Action queue */}
      <Card className="p-5 space-y-3">
        <SectionHeader
          icon={<CheckCircle2 className="w-5 h-5 text-primary" />}
          title={actionCount > 0 ? `Needs your attention (${actionCount})` : "Needs your attention"}
        />
        {actionCount === 0 ? (
          <div className="flex items-center gap-2 py-3 text-sm" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4" />
            You're all caught up - nothing waiting on you right now.
          </div>
        ) : (
          <div className="space-y-2">
            {unpaidInvoices.map((inv: any) => (
              <QueueRow
                key={inv.id}
                icon={<Receipt className="w-4 h-4" />}
                title={`Invoice from ${inv.providerName || "your provider"} - ${formatCents(inv.serviceAmount, inv.currency)}`}
                detail={inv.dueAt ? `Due ${fmtWhen(inv.dueAt)}` : "Awaiting your payment"}
                cta="Pay now"
                onClick={() => window.open(`/pay/${inv.paymentToken}`, "_blank")}
              />
            ))}
            {(queue?.awaitingMySignature || []).map(a => (
              <QueueRow
                key={a.agreementId}
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
                detail="Eva or your providers wrote to you"
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
                icon={<FileText className="w-4 h-4" />}
                title={`Cost sheet from ${cs.providerName || "your provider"} - ${formatCents(cs.totalCostCents)}`}
                detail="Review it in your chat"
                cta="Review"
                onClick={() => navigate(`/chat/${cs.sessionId}?msg=quote:${cs.id}`)}
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
                  <p className="text-sm font-medium truncate">{b.subject || `Meeting with ${b.providerUser?.name || "your provider"}`}</p>
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
      {!isViewer && (
        <Card className="p-5 space-y-3">
          <SectionHeader icon={<FileText className="w-5 h-5 text-primary" />} title="Cost Sheets" viewAllTo="/my/cost-sheets" />
          {costSheets.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No cost sheets yet. Providers share their pricing here after your consultations.</p>
          ) : (
            <div className="divide-y">
              {costSheets.slice(0, 3).map((cs: any) => (
                <div key={cs.id} className="flex items-center gap-3 py-3" style={{ opacity: cs.supersededAt ? 0.65 : 1 }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{cs.providerName || "Provider"}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(cs.createdAt).toLocaleDateString()}
                      {cs.supersededAt ? " - Superseded" : cs.parentAcknowledgedAt ? " - Acknowledged" : " - Awaiting your review"}
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
      )}

      {/* Invoices summary */}
      {!isViewer && (
        <Card className="p-5 space-y-3">
          <SectionHeader icon={<ReceiptIcon className="w-5 h-5 text-primary" />} title="Invoices" viewAllTo="/my/invoices" />
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Total paid</p>
              <p className="text-lg font-heading font-bold">{formatCents(totalPaid)}</p>
            </div>
            <div className="rounded-[var(--radius)] border p-3 bg-secondary/40">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Awaiting payment</p>
              <p className="text-lg font-heading font-bold">{unpaidInvoices.length}</p>
            </div>
          </div>
          {invoices.slice(0, 3).map((inv: any) => (
            <div key={inv.id} className="flex items-center gap-3 py-2 border-t">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{inv.providerName}</p>
                <p className="text-xs text-muted-foreground">{inv.serviceType} - {new Date(inv.createdAt).toLocaleDateString()}</p>
              </div>
              <InvoiceStatusBadge status={inv.status} />
              <p className="text-sm font-heading font-bold shrink-0">{formatCents(inv.serviceAmount, inv.currency)}</p>
            </div>
          ))}
        </Card>
      )}

      {/* Agreements */}
      <Card className="p-5 space-y-3">
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
      <BookingDetailDialog booking={selectedMeeting} open={!!selectedMeeting} onClose={() => setSelectedMeeting(null)} />
    </div>
  );
}
