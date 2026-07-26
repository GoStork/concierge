/**
 * Read-only admin view of a provider's Stripe Connect payout setup.
 * Mounted on /admin/providers/:id?tab=payouts. Mirrors the data shape of
 * ProviderPayoutsTab but without onboarding buttons - admins don't onboard
 * on behalf of providers (the Custom form is a provider-self-service flow
 * because the provider has to acknowledge ToS).
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PayoutsState {
  payoutMethod: "STRIPE_CONNECT_EXPRESS" | "STRIPE_CONNECT_CUSTOM" | null;
  stripeConnectAccountId: string | null;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
  requirementsEventuallyDue: string[];
  requirementsPastDue: string[];
  requirementsDisabledReason: string | null;
  bankName: string | null;
  accountLast4: string | null;
  accountType: string | null;
  onboardingStartedAt: string | null;
  onboardingCompletedAt: string | null;
  readyForPayouts: boolean;
}

interface AdminProviderPayoutsViewProps {
  providerId: string;
}

interface PendingInvoice {
  id: string;
  serviceAmount: number;
  providerPayoutAmount: number;
  referralFeeAmount: number;
  currency: string;
  paidAt: string;
  payoutFailedAt: string | null;
  payoutFailureReason: string | null;
  serviceType: string;
}

function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function AdminProviderPayoutsView({ providerId }: AdminProviderPayoutsViewProps) {
  const queryClient = useQueryClient();
  const { data: state, isLoading } = useQuery<PayoutsState>({
    queryKey: [`/api/admin/providers/${providerId}/payouts`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/providers/${providerId}/payouts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load payout state");
      return res.json();
    },
  });

  const { data: pendingData } = useQuery<{ invoices: PendingInvoice[] }>({
    queryKey: [`/api/admin/providers/${providerId}/payouts/pending`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/providers/${providerId}/payouts/pending`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load pending invoices");
      return res.json();
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/providers/${providerId}/payouts/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Refresh failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/providers/${providerId}/payouts`] });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/providers/${providerId}/payouts/pending`] });
    },
  });

  const retryPayoutMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/retry-payout`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Retry failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/providers/${providerId}/payouts/pending`] });
    },
  });

  if (isLoading || !state) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!state.payoutMethod) {
    return (
      <div className="space-y-4">
        <header>
          <h3 className="font-semibold">Payouts</h3>
          <p className="t-helper mt-0.5">
            Provider hasn't started Stripe Connect setup yet.
          </p>
        </header>
        <div className="rounded-lg border p-4 bg-secondary/40">
          <p className="text-sm">
            When the provider visits <code className="text-xs bg-muted px-1 rounded">/account/payouts</code> they'll
            be prompted to either complete Stripe-hosted onboarding (Express) or fill out the bank-info form here (Custom).
            Until they do, GoStork won't auto-fire transfers when invoices flip to PAID and the
            <code className="text-xs bg-muted px-1 rounded">notifyAdminTransferFailed</code> path triggers
            so you can manually wire from Chase.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">Payouts</h3>
          <p className="t-helper mt-0.5">
            Read-only view of the provider's Stripe Connect setup.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshMutation.isPending}
          onClick={() => refreshMutation.mutate()}
          title="Pull latest state from Stripe"
        >
          {refreshMutation.isPending
            ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
          Refresh from Stripe
        </Button>
      </header>

      {/* Top-level status */}
      {state.readyForPayouts ? (
        <div className="rounded-lg border p-4 bg-accent/10 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-success))" }} />
          <div>
            <p className="text-sm font-medium">Payouts enabled</p>
            <p className="t-helper mt-0.5">
              Auto-transfers are firing when invoices for this provider flip to PAID.
            </p>
          </div>
        </div>
      ) : state.requirementsDisabledReason ? (
        <div className="rounded-lg border p-4 flex items-start gap-3" style={{ borderColor: "hsl(var(--brand-error) / 0.4)", background: "hsl(var(--brand-error) / 0.05)" }}>
          <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-error))" }} />
          <div>
            <p className="text-sm font-medium">Payouts blocked</p>
            <p className="t-helper mt-0.5">
              Reason: <code className="bg-muted px-1 rounded">{state.requirementsDisabledReason}</code>
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border p-4 bg-accent/10 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-warning))" }} />
          <div>
            <p className="text-sm font-medium">Onboarding in progress</p>
            <p className="t-helper mt-0.5">
              Provider has started setup but Stripe hasn't approved payouts yet.
            </p>
          </div>
        </div>
      )}

      {/* Detail grid */}
      <div className="rounded-xl border bg-card">
        <Row label="Method" value={state.payoutMethod === "STRIPE_CONNECT_EXPRESS" ? "Stripe Connect Express (Stripe-hosted onboarding)" : "Stripe Connect Custom (GoStork-hosted form)"} />
        <Row label="Stripe Connect account ID" value={state.stripeConnectAccountId
          ? <a href={`https://dashboard.stripe.com/connect/accounts/${state.stripeConnectAccountId}`} target="_blank" rel="noopener noreferrer" className="font-mono text-xs underline inline-flex items-center gap-1">
              {state.stripeConnectAccountId}
              <ExternalLink className="w-3 h-3" />
            </a>
          : <span className="text-muted-foreground">Not created</span>} />
        <Row label="Payouts enabled" value={state.payoutsEnabled ? "Yes" : "No"} />
        <Row label="Details submitted" value={state.detailsSubmitted ? "Yes" : "No"} />
        <Row label="Bank on file" value={state.bankName || state.accountLast4
          ? `${state.bankName || "Bank"}${state.accountLast4 ? ` -- ${state.accountLast4}` : ""}${state.accountType ? ` (${state.accountType})` : ""}`
          : <span className="text-muted-foreground">Not linked</span>} />
        <Row label="Onboarding started" value={state.onboardingStartedAt ? new Date(state.onboardingStartedAt).toLocaleString() : "-"} />
        <Row label="Onboarding completed" value={state.onboardingCompletedAt ? new Date(state.onboardingCompletedAt).toLocaleString() : "-"} />
      </div>

      {/* Requirements lists */}
      {(state.requirementsCurrentlyDue.length > 0 || state.requirementsPastDue.length > 0 || state.requirementsEventuallyDue.length > 0) && (
        <section className="space-y-3">
          <h4 className="text-sm font-medium">Outstanding requirements (from Stripe)</h4>
          {state.requirementsPastDue.length > 0 && (
            <RequirementsList label="Past due (payouts paused)" items={state.requirementsPastDue} tone="error" />
          )}
          {state.requirementsCurrentlyDue.length > 0 && (
            <RequirementsList label="Currently due" items={state.requirementsCurrentlyDue} tone="warning" />
          )}
          {state.requirementsEventuallyDue.length > 0 && (
            <RequirementsList label="Eventually due" items={state.requirementsEventuallyDue} tone="muted" />
          )}
        </section>
      )}

      {/* Invoices stuck without a successful payout */}
      {pendingData && pendingData.invoices.length > 0 && (
        <section className="space-y-3">
          <h4 className="text-sm font-medium">Pending payouts</h4>
          <p className="t-helper">
            PAID invoices where GoStork hasn't yet successfully transferred the provider's cut. Either
            the auto-transfer failed, or the provider wasn't onboarded when the invoice was paid.
          </p>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-4 py-2 font-medium text-xs">Invoice</th>
                  <th className="text-left px-4 py-2 font-medium text-xs">Service</th>
                  <th className="text-right px-4 py-2 font-medium text-xs">Payout owed</th>
                  <th className="text-left px-4 py-2 font-medium text-xs">Status</th>
                  <th className="text-left px-4 py-2 font-medium text-xs">Paid at</th>
                  <th className="text-right px-4 py-2 font-medium text-xs">Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingData.invoices.map(inv => (
                  <tr key={inv.id} className="border-b last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-2 font-mono text-xs">{inv.id.slice(0, 8)}</td>
                    <td className="px-4 py-2">{inv.serviceType}</td>
                    <td className="px-4 py-2 text-right font-medium">
                      {formatCents(inv.providerPayoutAmount, inv.currency)}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {inv.payoutFailedAt ? (
                        <span style={{ color: "hsl(var(--brand-error))" }}>
                          Failed: {inv.payoutFailureReason?.slice(0, 60) || "Unknown error"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Never auto-fired</span>
                      )}
                    </td>
                    <td className="t-helper px-4 py-2">
                      {new Date(inv.paidAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={retryPayoutMutation.isPending && retryPayoutMutation.variables === inv.id}
                        onClick={() => retryPayoutMutation.mutate(inv.id)}
                      >
                        {retryPayoutMutation.isPending && retryPayoutMutation.variables === inv.id
                          ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                          : <RotateCw className="w-3 h-3 mr-1" />}
                        Retry payout
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5 border-b last:border-0">
      <span className="t-micro-label w-48 shrink-0">{label}</span>
      <span className="text-sm text-right break-all">{value}</span>
    </div>
  );
}

function RequirementsList({ label, items, tone }: { label: string; items: string[]; tone: "error" | "warning" | "muted" }) {
  const color = tone === "error" ? "hsl(var(--brand-error))" : tone === "warning" ? "hsl(var(--brand-warning))" : "hsl(var(--muted-foreground))";
  return (
    <div className="rounded-lg border p-3 bg-background">
      <p className="text-xs font-medium" style={{ color }}>{label}</p>
      <ul className="t-helper mt-1.5 list-disc list-inside space-y-0.5">
        {items.map(r => <li key={r}><code className="bg-muted px-1 rounded">{r}</code></li>)}
      </ul>
    </div>
  );
}
