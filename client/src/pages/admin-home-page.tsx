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

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Headphones,
  Receipt,
  FileSignature,
  Landmark,
  CheckCircle2,
  DollarSign,
  TrendingUp,
  Zap,
  Video,
} from "lucide-react";
import { QueueRow, SectionHeader, StatTile } from "@/components/home/home-sections";
import { formatMoneyCents as formatCents } from "@/lib/format-money";
import { derivePayoutStatus } from "@/lib/payout-status";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";

interface AdminDashboard {
  escalations: Array<{ sessionId: string; parentName: string; providerName: string | null; updatedAt: string }>;
  dueInvoices: Array<{ id: string; sessionId: string | null; dueAt: string; overdue: boolean; amountCents: number; serviceType: string | null; parentName: string; providerName: string | null }>;
  sentAgreements: Array<{ agreementId: string; createdAt: string; documentType: string; parentName: string; providerName: string | null; signedCount: number; signerCount: number }>;
  failedPayouts: Array<{ id: string; payoutFailedAt: string; amountCents: number; providerName: string | null; parentName: string }>;
  funnel: { activeSessions: number; hotLeads: number; callsBooked: number; matched: number; onHold: number; depositsPaid: number; agreementsSigned: number };
  money: { totalCollected: number; totalFees: number; pendingPayouts: number; payoutsSent: number };
  adoption: { total: number; costSheet: number; invoice: number; agreement: number };
  upcomingMeetings: Array<{ id: string; scheduledAt: string; subject: string | null; status: string; parentName: string; providerName: string }>;
  recentInvoices: Array<{ id: string; status: string; amountCents: number; serviceType: string | null; createdAt: string; parentName: string; providerName: string | null }>;
  recentPayouts: Array<{ id: string; amountCents: number; paidAt: string | null; payoutInitiatedAt: string | null; payoutFailedAt: string | null; stripeTransferId: string | null; bankPayoutCompletedAt: string | null; bankPayoutFailedAt: string | null; status: string; providerName: string | null; parentName: string }>;
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

  const queueCount =
    (data?.escalations.length || 0) +
    (data?.dueInvoices.filter(i => i.overdue).length || 0) +
    (data?.failedPayouts.length || 0);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6 pb-24 md:pb-6">
      <div>
        <h1 className="text-2xl font-heading">Welcome back, {firstName}</h1>
        <p className="text-sm text-muted-foreground mt-1">The full picture - every parent, provider, and journey on the platform.</p>
      </div>

      {/* Needs attention: escalations, overdue deposits, failed payouts */}
      <Card className="p-5 space-y-3">
        <SectionHeader
          icon={<CheckCircle2 className="w-5 h-5 text-primary" />}
          title={queueCount > 0 ? `Needs attention (${queueCount})` : "Needs attention"}
        />
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-2">Loading...</p>
        ) : queueCount === 0 ? (
          <div className="flex items-center gap-2 py-3 text-sm" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4" />
            All clear - no escalations, overdue deposits, or failed payouts.
          </div>
        ) : (
          <div className="space-y-2">
            {(data?.escalations || []).map(e => (
              <QueueRow
                key={e.sessionId}
                icon={<Headphones className="w-4 h-4" />}
                title={`${e.parentName} asked for a human${e.providerName ? ` (${e.providerName} journey)` : ""}`}
                detail={`Waiting since ${fmtWhen(e.updatedAt)}`}
                cta="Take over"
                onClick={() => navigate(`/admin/concierge-monitor?sessionId=${e.sessionId}`)}
              />
            ))}
            {(data?.dueInvoices || []).filter(i => i.overdue).map(inv => (
              <QueueRow
                key={inv.id}
                icon={<Receipt className="w-4 h-4" />}
                title={`${inv.parentName}'s ${formatCents(inv.amountCents)} deposit is past its deadline`}
                detail={`${inv.providerName || "Provider"} - was due ${fmtWhen(inv.dueAt)}`}
                cta="Review"
                onClick={() => navigate(`/admin/billing?q=${inv.id}`)}
              />
            ))}
            {(data?.failedPayouts || []).map(fp => (
              <QueueRow
                key={fp.id}
                icon={<Landmark className="w-4 h-4" />}
                title={`Payout of ${formatCents(fp.amountCents)} to ${fp.providerName || "provider"} failed`}
                detail={`${fp.parentName}'s invoice - failed ${fmtWhen(fp.payoutFailedAt)}`}
                cta="Resolve"
                onClick={() => navigate(`/admin/billing?q=${fp.id}`)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Upcoming meetings - platform wide */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Video className="w-5 h-5 text-primary" />} title="Upcoming meetings" viewAllTo="/calendar" />
        {(data?.upcomingMeetings || []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No upcoming meetings scheduled.</p>
        ) : (
          <div className="divide-y">
            {(data?.upcomingMeetings || []).map(b => (
              <div key={b.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{b.subject || `${b.parentName} with ${b.providerName}`}</p>
                  <p className="text-xs text-muted-foreground">{b.parentName} - {b.providerName} - {fmtWhen(b.scheduledAt)}</p>
                </div>
                {b.status === "PENDING" && (
                  <span className="text-xs font-medium shrink-0" style={{ color: "hsl(var(--brand-warning))" }}>Awaiting confirm</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Platform funnel - last 30 days */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<TrendingUp className="w-5 h-5 text-primary" />} title="Platform funnel" />
        <p className="text-xs text-muted-foreground -mt-2">Last 30 days (Matched and On Hold are current counts)</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile label="Active sessions" value={data?.funnel.activeSessions ?? 0} />
          <StatTile label="Hot leads" value={data?.funnel.hotLeads ?? 0} />
          <StatTile label="Calls booked" value={data?.funnel.callsBooked ?? 0} />
          <StatTile label="On hold" value={data?.funnel.onHold ?? 0} hint="surrogates in match calls" />
          <StatTile label="Matched" value={data?.funnel.matched ?? 0} hint="surrogates matched" />
          <StatTile label="Deposits paid" value={data?.funnel.depositsPaid ?? 0} />
          <StatTile label="Agreements signed" value={data?.funnel.agreementsSigned ?? 0} />
          <StatTile label="Fees collected" value={formatCents(data?.money.totalFees ?? 0)} hint="all time" />
        </div>
      </Card>

      {/* Deposit deadlines (upcoming, not yet overdue) */}
      {(data?.dueInvoices || []).filter(i => !i.overdue).length > 0 && (
        <Card className="p-5 space-y-3">
          <SectionHeader icon={<Receipt className="w-5 h-5 text-primary" />} title="Deposit deadlines" viewAllTo="/admin/billing" />
          <div className="divide-y">
            {(data?.dueInvoices || []).filter(i => !i.overdue).map(inv => (
              <div key={inv.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{inv.parentName} - {inv.providerName || "Provider"}</p>
                  <p className="text-xs text-muted-foreground">Due {fmtWhen(inv.dueAt)}</p>
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
          <p className="text-sm text-muted-foreground py-2">No agreements awaiting signatures right now.</p>
        ) : (
          <div className="divide-y">
            {(data?.sentAgreements || []).map(a => (
              <div key={a.agreementId} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{a.parentName} - {a.providerName || "Provider"}</p>
                  <p className="text-xs text-muted-foreground">{a.documentType} - sent {new Date(a.createdAt).toLocaleDateString()}</p>
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

      {/* Invoices */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Receipt className="w-5 h-5 text-primary" />} title="Invoices" viewAllTo="/admin/billing" />
        {(data?.recentInvoices || []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No invoices yet.</p>
        ) : (
          <div className="divide-y">
            {(data?.recentInvoices || []).map(inv => (
              <div key={inv.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{inv.parentName} - {inv.providerName || "Provider"}</p>
                  <p className="text-xs text-muted-foreground">{(inv.serviceType || "").replace(/_/g, " ").toLowerCase()} - {new Date(inv.createdAt).toLocaleDateString()}</p>
                </div>
                <InvoiceStatusBadge status={inv.status} />
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
        <SectionHeader icon={<Landmark className="w-5 h-5 text-primary" />} title="Payouts" viewAllTo="/admin/billing" />
        {(data?.recentPayouts || []).length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No payouts yet.</p>
        ) : (
          <div className="divide-y">
            {(data?.recentPayouts || []).map(po => {
              const ps = derivePayoutStatus(po as any);
              return (
                <div key={po.id} className="flex items-center gap-3 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{po.providerName || "Provider"}</p>
                    <p className="text-xs text-muted-foreground">{po.parentName}'s invoice - {po.paidAt ? new Date(po.paidAt).toLocaleDateString() : ""}</p>
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

      {/* Money */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<DollarSign className="w-5 h-5 text-primary" />} title="Money" viewAllTo="/admin/billing" />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatTile label="Total collected" value={formatCents(data?.money.totalCollected ?? 0)} hint="all paid invoices" />
          <StatTile label="Fees Collected" value={formatCents(data?.money.totalFees ?? 0)} />
          <StatTile label="Payouts sent" value={formatCents(data?.money.payoutsSent ?? 0)} hint="to providers" />
          <StatTile label="Held by GoStork" value={formatCents((data?.money.totalCollected ?? 0) - (data?.money.payoutsSent ?? 0))} hint="collected minus payouts" />
          <StatTile label="Pending payouts" value={data?.money.pendingPayouts ?? 0} />
        </div>
      </Card>

      {/* Automation adoption */}
      <Card className="p-5 space-y-3">
        <SectionHeader icon={<Zap className="w-5 h-5 text-primary" />} title="Automation adoption" viewAllTo="/admin/providers" viewAllLabel="Providers" />
        <p className="text-xs text-muted-foreground -mt-2">Providers with each automation live, out of {data?.adoption.total ?? 0} approved providers</p>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Cost-sheet drafts" value={`${data?.adoption.costSheet ?? 0}/${data?.adoption.total ?? 0}`} hint="on booking" />
          <StatTile label="Invoice drafts" value={`${data?.adoption.invoice ?? 0}/${data?.adoption.total ?? 0}`} hint="on parent-ready" />
          <StatTile label="Agreement drafts" value={`${data?.adoption.agreement ?? 0}/${data?.adoption.total ?? 0}`} hint="on invoice-paid" />
        </div>
      </Card>

    </div>
  );
}
