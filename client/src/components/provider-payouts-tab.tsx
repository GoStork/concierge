/**
 * Provider Payouts tab - shown at /account/payouts.
 *
 * Two onboarding paths to receive payouts from GoStork:
 *
 *  EXPRESS - one click opens Stripe-hosted onboarding. Stripe collects
 *    KYC + bank info. Provider gets a minimal Stripe Express dashboard.
 *    Best for tech-comfortable providers.
 *
 *  CUSTOM  - provider fills the same fields directly in this GoStork
 *    page. GoStork POSTs to Stripe behind the scenes. Provider never
 *    sees Stripe. Best for conservative providers.
 *
 * Both methods end up with the same Stripe Connect account on the
 * backend; payouts auto-fire to the provider's bank when an invoice
 * flips to PAID.
 */

import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, ExternalLink, CheckCircle2, AlertCircle, ArrowRight, Building2, User as UserIcon,
  ChevronDown, ChevronUp, Unlink, History,
} from "lucide-react";
import { PayoutTable } from "@/components/payout-table";
import { Button } from "@/components/ui/button";
import { SaveBar } from "@/components/ui/save-bar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-bar";
import { useToast } from "@/hooks/use-toast";

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

// Maps a Stripe requirement field id to a human-friendly label. Stripe's
// raw ids look like "individual.dob.day" or "external_account" - not
// something an agency owner can act on without context.
const REQUIREMENT_LABELS: Record<string, string> = {
  external_account: "Bank account",
  "individual.dob.day": "Representative date of birth",
  "individual.dob.month": "Representative date of birth",
  "individual.dob.year": "Representative date of birth",
  "individual.ssn_last_4": "Representative SSN (last 4)",
  "individual.id_number": "Representative full SSN",
  "individual.verification.document": "Representative ID document upload",
  "individual.address.line1": "Representative address",
  "individual.address.city": "Representative address",
  "individual.address.state": "Representative address",
  "individual.address.postal_code": "Representative address",
  "company.tax_id": "Business EIN",
  "company.address.line1": "Business address",
  "company.address.city": "Business address",
  "company.address.state": "Business address",
  "company.address.postal_code": "Business address",
  "company.verification.document": "Business verification document",
  business_profile: "Business profile (name + URL)",
  tos_acceptance: "Terms of service acceptance",
};
function humanizeRequirement(id: string): string {
  return REQUIREMENT_LABELS[id] || id.replace(/_/g, " ").replace(/\./g, " - ");
}

export function ProviderPayoutsTab() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Load current state ────────────────────────────────────────────────────
  const { data: state, isLoading } = useQuery<PayoutsState>({
    queryKey: ["/api/provider/payouts"],
    queryFn: async () => {
      const res = await fetch("/api/provider/payouts", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load payouts state");
      return res.json();
    },
  });

  // If the provider just came back from Stripe-hosted onboarding, force a
  // refetch (the account.updated webhook may already have updated us, but
  // this guarantees the page reflects the latest state without waiting on
  // network round-trips).
  useEffect(() => {
    if (searchParams.get("onboarding") === "complete") {
      queryClient.invalidateQueries({ queryKey: ["/api/provider/payouts"] });
      // Clear the query param so a refresh doesn't keep firing.
      const next = new URLSearchParams(searchParams);
      next.delete("onboarding");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, queryClient]);

  // ── Method selection (drives the form below) ──────────────────────────────
  // When state already has a method, lock to it. Otherwise default to Custom
  // (the conservative-provider option, expected to cover the majority).
  const [selectedMethod, setSelectedMethod] = useState<"STRIPE_CONNECT_EXPRESS" | "STRIPE_CONNECT_CUSTOM">(
    "STRIPE_CONNECT_CUSTOM",
  );
  useEffect(() => {
    if (state?.payoutMethod) setSelectedMethod(state.payoutMethod);
  }, [state?.payoutMethod]);

  // ── Express path: start onboarding ────────────────────────────────────────
  const startExpressMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/provider/payouts/express/start", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to start onboarding");
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Onboarded + payouts enabled - show a compact status card, no form.
  if (state?.readyForPayouts) {
    return (
      <div className="space-y-6">
        <header>
          <h2 className="text-2xl font-heading">Payouts</h2>
          <p className="t-helper mt-1">
            Money GoStork sends to your bank when parents pay invoices.
          </p>
        </header>
        <PayoutsReadyCard state={state} />
        <PayoutHistoryTable />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-heading">Payouts</h2>
        <p className="t-helper mt-1">
          Tell GoStork how to send you the money parents pay. One-time setup.
        </p>
      </header>

      {/* Status banner - shown when partway through onboarding */}
      {state && (state.payoutMethod || state.requirementsCurrentlyDue.length > 0 || state.requirementsDisabledReason) && (
        <StatusBanner state={state} />
      )}

      {/* Method picker - only when nothing has been started yet */}
      {!state?.payoutMethod && (
        <section className="space-y-3">
          <Label >How do you want to receive payouts?</Label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <MethodCard
              selected={selectedMethod === "STRIPE_CONNECT_CUSTOM"}
              onSelect={() => setSelectedMethod("STRIPE_CONNECT_CUSTOM")}
              icon={<Building2 className="w-5 h-5" />}
              title="Enter bank info here"
              body="Fill in your bank routing + account number on this page. Quick. Stays inside GoStork."
              tag="Recommended for most"
            />
            <MethodCard
              selected={selectedMethod === "STRIPE_CONNECT_EXPRESS"}
              onSelect={() => setSelectedMethod("STRIPE_CONNECT_EXPRESS")}
              icon={<ExternalLink className="w-5 h-5" />}
              title="Connect with Stripe"
              body="Open Stripe's secure onboarding in a new page. Stripe collects your info and links your bank."
              tag="For tech-comfortable users"
            />
          </div>
        </section>
      )}

      {/* Express path: just a button */}
      {selectedMethod === "STRIPE_CONNECT_EXPRESS" && (
        <section className="rounded-xl border p-6 bg-card space-y-3">
          <h3 className="font-semibold">Stripe Connect onboarding</h3>
          <p className="t-helper">
            You'll be redirected to a secure Stripe-hosted page where you'll enter your business info,
            owner details, and bank account. Takes about 5-10 minutes. After you finish, you'll come back
            here automatically.
          </p>
          {startExpressMutation.isError && (
            <p className="text-sm" style={{ color: "hsl(var(--brand-error))" }}>
              {(startExpressMutation.error as Error).message}
            </p>
          )}
          <Button
            onClick={() => startExpressMutation.mutate()}
            disabled={startExpressMutation.isPending}
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
          >
            {startExpressMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <ExternalLink className="w-4 h-4 mr-2" />
            )}
            {state?.stripeConnectAccountId ? "Continue Stripe onboarding" : "Start Stripe onboarding"}
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </section>
      )}

      {/* Custom path: inline form */}
      {selectedMethod === "STRIPE_CONNECT_CUSTOM" && <CustomPayoutForm state={state} />}
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function MethodCard({
  selected, onSelect, icon, title, body, tag,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  tag: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left rounded-xl border p-5 transition-colors bg-card"
      style={{
        background: selected ? "hsl(var(--primary) / 0.05)" : "hsl(var(--card))",
        borderColor: selected ? "hsl(var(--primary))" : "hsl(var(--border))",
      }}
    >
      <div className="flex items-center gap-2 mb-2" style={{ color: "hsl(var(--primary))" }}>
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{tag}</span>
      </div>
      <h4 className="font-semibold">{title}</h4>
      <p className="t-helper mt-1">{body}</p>
    </button>
  );
}

function StatusBanner({ state }: { state: PayoutsState }) {
  if (state.payoutsEnabled) {
    return (
      <div className="rounded-lg border p-4 bg-accent/10 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-success))" }} />
        <div>
          <p className="text-sm font-medium">Payouts enabled</p>
          <p className="t-helper mt-0.5">
            GoStork will automatically send your share to your bank when invoices are paid.
          </p>
        </div>
      </div>
    );
  }
  if (state.requirementsDisabledReason) {
    return (
      <div className="rounded-lg border p-4 flex items-start gap-3" style={{ borderColor: "hsl(var(--brand-error) / 0.4)", background: "hsl(var(--brand-error) / 0.05)" }}>
        <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-error))" }} />
        <div>
          <p className="text-sm font-medium">Stripe needs more from you</p>
          <p className="t-helper mt-0.5">
            Reason: {state.requirementsDisabledReason.replace(/_/g, " ")}
          </p>
          {state.requirementsCurrentlyDue.length > 0 && (
            <ul className="t-helper mt-2 list-disc list-inside">
              {state.requirementsCurrentlyDue.map(r => (
                <li key={r}>{humanizeRequirement(r)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }
  if (state.requirementsCurrentlyDue.length > 0) {
    return (
      <div className="rounded-lg border p-4 bg-accent/10 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-warning))" }} />
        <div className="flex-1">
          <p className="text-sm font-medium">A few more details needed</p>
          <ul className="t-helper mt-1 list-disc list-inside">
            {state.requirementsCurrentlyDue.map(r => (
              <li key={r}>{humanizeRequirement(r)}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (state.onboardingStartedAt && !state.detailsSubmitted) {
    return (
      <div className="rounded-lg border p-4 bg-card flex items-start gap-3">
        <Loader2 className="w-5 h-5 mt-0.5 shrink-0 animate-spin text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Onboarding in progress</p>
          <p className="t-helper mt-0.5">
            Resume below to finish setting up.
          </p>
        </div>
      </div>
    );
  }
  return null;
}

function PayoutsReadyCard({ state }: { state: PayoutsState }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [isChangingBank, setIsChangingBank] = useState(false);
  const [disconnectBlockedReason, setDisconnectBlockedReason] = useState<string | null>(null);

  const expressLoginMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/provider/payouts/express/login-link", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to generate Stripe login link");
      return res.json() as Promise<{ url: string }>;
    },
    onSuccess: (data) => {
      window.open(data.url, "_blank", "noopener,noreferrer");
    },
    onError: (e: any) => toast({ title: "Could not open Stripe", description: e?.message, variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/provider/payouts/disconnect", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to disconnect");
      return res.json() as Promise<
        | { status: "disconnected" }
        | { status: "blocked"; reason: string }
      >;
    },
    onSuccess: (data) => {
      if (data.status === "blocked") {
        setDisconnectBlockedReason(data.reason);
        return;
      }
      toast({ title: "Payout account disconnected" });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/payouts"] });
    },
    onError: (e: any) => {
      toast({ title: "Disconnect failed", description: e?.message, variant: "destructive" });
    },
  });

  return (
    <section className="rounded-xl border p-6 bg-accent/10 space-y-4">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="w-6 h-6 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-success))" }} />
        <div className="flex-1">
          <h3 className="font-semibold">Payouts are enabled</h3>
          <p className="t-helper mt-1">
            GoStork sends your share to your bank automatically when parents pay invoices. Payouts usually
            land within 2 business days.
          </p>
        </div>
      </div>
      {(state.bankName || state.accountLast4) && (
        <div className="rounded-lg border p-3 bg-card text-sm">
          <p className="t-micro-label">Receiving bank</p>
          <p className="mt-1 font-medium">
            {state.bankName || "Bank on file"}{state.accountLast4 ? ` -- ${state.accountLast4}` : ""}
            {state.accountType ? ` (${state.accountType})` : ""}
          </p>
        </div>
      )}

      {/* Change bank account - expandable */}
      <div className="rounded-lg border bg-card">
        <button
          type="button"
          onClick={() => setIsChangingBank(v => !v)}
          className="w-full flex items-center justify-between p-3 text-left hover:bg-muted/30 transition-colors rounded-lg"
        >
          <span className="text-sm font-medium">Change bank account</span>
          {isChangingBank ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        {isChangingBank && (
          <div className="border-t p-4">
            {state.payoutMethod === "STRIPE_CONNECT_EXPRESS" ? (
              <div className="space-y-3">
                <p className="t-helper">
                  Your account is on Stripe Express. Bank changes happen on the Stripe-hosted dashboard.
                </p>
                <Button
                  onClick={() => expressLoginMutation.mutate()}
                  disabled={expressLoginMutation.isPending}
                  style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
                >
                  {expressLoginMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <ExternalLink className="w-4 h-4 mr-2" />
                  )}
                  Manage on Stripe
                </Button>
              </div>
            ) : (
              <BankReplaceForm onSaved={() => setIsChangingBank(false)} />
            )}
          </div>
        )}
      </div>

      {/* Disconnect */}
      <div className="rounded-lg border bg-card p-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Disconnect payout account</p>
          <p className="t-helper mt-0.5">
            Stops future payouts. Only allowed when there are no pending or failed transfers.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={async () => {
            setDisconnectBlockedReason(null);
            const ok = await confirm({
              title: "Disconnect your payout account?",
              message: "GoStork will stop sending payouts to your bank. You'll need to set up payouts again to receive future payments from parents. This will not affect invoices that have already been paid out.",
              confirmLabel: "Disconnect",
              tone: "destructive",
            });
            if (ok) disconnectMutation.mutate();
          }}
          className="shrink-0"
          style={{ borderColor: "hsl(var(--brand-error) / 0.5)", color: "hsl(var(--brand-error))" }}
        >
          <Unlink className="w-4 h-4 mr-2" />
          Disconnect
        </Button>
      </div>
      {disconnectBlockedReason && (
        <div className="rounded-lg border p-3 flex items-start gap-2 bg-card" style={{ borderColor: "hsl(var(--brand-warning) / 0.4)", background: "hsl(var(--brand-warning) / 0.05)" }}>
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-warning))" }} />
          <p className="text-sm" style={{ color: "hsl(var(--brand-warning))" }}>{disconnectBlockedReason}</p>
        </div>
      )}

    </section>
  );
}

// ─── Bank-only replace form (Custom path) ───────────────────────────────────

function BankReplaceForm({ onSaved }: { onSaved: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [accountConfirm, setAccountConfirm] = useState("");
  const [holderName, setHolderName] = useState("");
  const [accountType, setAccountType] = useState<"checking" | "savings">("checking");
  const [error, setError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (account !== accountConfirm) throw new Error("Account numbers don't match");
      const res = await fetch("/api/provider/payouts/bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          routingNumber: routing,
          accountNumber: account,
          accountHolderName: holderName,
          accountType,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message || "Failed to update bank account");
      }
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      toast({ title: "Bank account updated", description: "Future payouts will go to the new bank." });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/payouts"] });
      onSaved();
    },
    onError: (e: any) => setError(e?.message || "Save failed"),
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Routing number" required hint="9 digits">
          <Input value={routing} onChange={e => setRouting(e.target.value.replace(/\D/g, "").slice(0, 9))} maxLength={9} inputMode="numeric" />
        </Field>
        <Field label="Account type" required>
          <select
            value={accountType}
            onChange={e => setAccountType(e.target.value as any)}
            className="h-10 rounded-md border bg-card px-3 text-sm w-full"
          >
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
          </select>
        </Field>
      </div>
      <Field label="Account number" required>
        <Input value={account} onChange={e => setAccount(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
      </Field>
      <Field label="Confirm account number" required>
        <Input value={accountConfirm} onChange={e => setAccountConfirm(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
      </Field>
      <Field label="Account holder name (optional)" hint="Leave blank to use your legal business name">
        <Input value={holderName} onChange={e => setHolderName(e.target.value)} />
      </Field>
      {error && (
        <div className="rounded-lg border p-3 flex items-start gap-2 bg-card" style={{ borderColor: "hsl(var(--brand-error) / 0.4)", background: "hsl(var(--brand-error) / 0.05)" }}>
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-error))" }} />
          <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{error}</p>
        </div>
      )}
      <SaveBar
        visible={!!(routing || account || accountConfirm || holderName)}
        position="fixed"
        testId="bank-replace-save-bar"
        discardLabel="Discard"
        saveLabel="Update bank account"
        saving={saveMutation.isPending}
        saveDisabled={!routing || !account || !accountConfirm}
        onDiscard={() => {
          setRouting(""); setAccount(""); setAccountConfirm(""); setHolderName(""); setAccountType("checking"); setError(null);
        }}
        onSave={() => saveMutation.mutate()}
      />
    </div>
  );
}

// ─── Custom path form ───────────────────────────────────────────────────────

// Mirrors TAX_CLASSIFICATIONS in provider-legal-identity-tab. Kept in sync
// manually so the readonly readout here matches the label the provider
// picked on the Legal Identity tab.
const TAX_CLASSIFICATION_LABEL: Record<string, string> = {
  INDIVIDUAL_SOLE_PROPRIETOR: "Individual / Sole proprietor",
  C_CORPORATION: "C Corporation",
  S_CORPORATION: "S Corporation",
  PARTNERSHIP: "Partnership",
  TRUST_ESTATE: "Trust / Estate",
  LLC: "LLC",
  OTHER: "Other",
};

interface LegalIdentitySnapshot {
  legalName: string | null;
  businessName: string | null;
  businessUrl: string | null;
  taxClassification: string | null;
  businessType: string | null;
  taxId: string | null;
  businessAddressLine1: string | null;
  businessAddressLine2: string | null;
  businessAddressCity: string | null;
  businessAddressState: string | null;
  businessAddressPostalCode: string | null;
}

function CustomPayoutForm({ state }: { state: PayoutsState | undefined }) {
  const queryClient = useQueryClient();

  // Pull legal identity (business name, tax id, address, business type)
  // from the dedicated tab. Provider/admin edits happen there, not here.
  const { data: legalIdentity, isLoading: legalLoading } = useQuery<LegalIdentitySnapshot>({
    queryKey: ["/api/provider/legal-identity"],
    queryFn: async () => {
      const res = await fetch("/api/provider/legal-identity", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load legal identity");
      return res.json();
    },
  });

  const legalIdentityComplete = !!(
    legalIdentity?.legalName?.trim() &&
    legalIdentity?.businessName?.trim() &&
    legalIdentity?.businessUrl?.trim() &&
    legalIdentity?.taxId?.trim() &&
    legalIdentity?.taxClassification &&
    legalIdentity?.businessAddressLine1?.trim() &&
    legalIdentity?.businessAddressCity?.trim() &&
    legalIdentity?.businessAddressState?.trim() &&
    legalIdentity?.businessAddressPostalCode?.trim()
  );

  // Representative
  const [repFirst, setRepFirst] = useState("");
  const [repLast, setRepLast] = useState("");
  const [repEmail, setRepEmail] = useState("");
  const [repPhone, setRepPhone] = useState("");
  const [repDobMonth, setRepDobMonth] = useState("");
  const [repDobDay, setRepDobDay] = useState("");
  const [repDobYear, setRepDobYear] = useState("");
  const [repSsn, setRepSsn] = useState("");
  // Reuse business address (from Legal Identity) for rep by default - common case.
  const [repAddrSameAsBusiness, setRepAddrSameAsBusiness] = useState(true);
  const [repAddrLine1, setRepAddrLine1] = useState("");
  const [repAddrCity, setRepAddrCity] = useState("");
  const [repAddrState, setRepAddrState] = useState("");
  const [repAddrPostal, setRepAddrPostal] = useState("");

  // Bank
  const [bankRouting, setBankRouting] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankAccountConfirm, setBankAccountConfirm] = useState("");
  const [bankHolderName, setBankHolderName] = useState("");
  const [bankAccountType, setBankAccountType] = useState<"checking" | "savings">("checking");

  const [error, setError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!legalIdentityComplete) {
        throw new Error("Complete your legal details first.");
      }
      if (bankAccount && bankAccountConfirm && bankAccount !== bankAccountConfirm) {
        throw new Error("Bank account numbers don't match");
      }
      // Representative address - either same as the Legal Identity
      // business address (default) or a manually-entered one.
      const repAddr = repAddrSameAsBusiness
        ? {
            line1: legalIdentity!.businessAddressLine1 || "",
            city: legalIdentity!.businessAddressCity || "",
            state: legalIdentity!.businessAddressState || "",
            postalCode: legalIdentity!.businessAddressPostalCode || "",
          }
        : { line1: repAddrLine1, city: repAddrCity, state: repAddrState, postalCode: repAddrPostal };
      // Body only carries representative + bank - business identity and
      // business address are read server-side from ProviderLegalIdentity.
      const body = {
        representative: {
          firstName: repFirst,
          lastName: repLast,
          email: repEmail || undefined,
          phone: repPhone || undefined,
          dob: {
            day: parseInt(repDobDay, 10),
            month: parseInt(repDobMonth, 10),
            year: parseInt(repDobYear, 10),
          },
          ssnLast4: repSsn,
          address: repAddr,
        },
        bank: {
          routingNumber: bankRouting,
          accountNumber: bankAccount,
          accountHolderName: bankHolderName || (legalIdentity?.legalName ?? ""),
          accountType: bankAccountType,
        },
      };
      const res = await fetch("/api/provider/payouts/custom/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message || "Failed to save payout info");
      }
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/provider/payouts"] });
    },
    onError: (e: any) => setError(e?.message || "Save failed"),
  });

  return (
    <section className="space-y-6">
      {/* Business identity + address come from the Legal Identity tab.
          Read-only here; provider edits them in one place upstream - the
          "Edit in Legal Identity" link carries that, not a dimmer surface.
          It was on secondary to recede against the editable cards, but a
          cream panel between two white ones just read as unfinished. */}
      <div className="rounded-xl border p-5 bg-card space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-sm">Business identity</h3>
            <p className="t-helper mt-0.5">
              From your Legal tab. Used for Stripe Connect KYC.
            </p>
          </div>
          <a
            href="/account/legal-identity"
            className="text-xs underline text-primary shrink-0"
          >
            Edit in Legal
          </a>
        </div>
        {legalLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : legalIdentityComplete ? (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <ReadOnly label="Legal name" value={legalIdentity?.legalName} />
            <ReadOnly label="Legal business name" value={legalIdentity?.businessName} />
            <ReadOnly label="Tax classification" value={legalIdentity?.taxClassification ? (TAX_CLASSIFICATION_LABEL[legalIdentity.taxClassification] || legalIdentity.taxClassification) : null} />
            <ReadOnly label="Tax ID" value={legalIdentity?.taxId} />
            <ReadOnly label="Website URL" value={legalIdentity?.businessUrl} />
            <ReadOnly
              label="Address"
              value={[
                legalIdentity?.businessAddressLine1,
                legalIdentity?.businessAddressLine2,
                [legalIdentity?.businessAddressCity, legalIdentity?.businessAddressState, legalIdentity?.businessAddressPostalCode].filter(Boolean).join(", "),
              ].filter(Boolean).join("\n")}
            />
          </dl>
        ) : (
          <div className="flex items-start gap-2 rounded-md border p-3 bg-card" style={{ borderColor: "hsl(var(--brand-warning) / 0.4)" }}>
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-warning))" }} />
            <div className="text-xs">
              <p className="font-medium">Complete your legal details first</p>
              <p className="text-muted-foreground mt-0.5">
                Stripe needs your business name, website URL, tax ID, tax classification, and address before we can set up payouts.{" "}
                <a href="/account/legal-identity" className="underline text-primary">Open the Legal tab</a>
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Representative */}
      {/* The editable sections are white cards; the read-only Business
          identity panel above stays on secondary so it recedes against
          them. Without any fill these sections dissolved into the sand
          page - the whole tab read as one cream sheet. */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <h3 className="font-semibold text-sm">
          {legalIdentity?.businessType === "individual" ? "Personal info" : "Authorized representative (owner or officer)"}
        </h3>
        <p className="t-helper">
          Required by US banking regulations. Used for identity verification only - not displayed publicly.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="First name" required><Input value={repFirst} onChange={e => setRepFirst(e.target.value)} /></Field>
          <Field label="Last name" required><Input value={repLast} onChange={e => setRepLast(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Email (optional)"><Input type="email" value={repEmail} onChange={e => setRepEmail(e.target.value)} /></Field>
          <Field label="Phone (optional)"><Input type="tel" value={repPhone} onChange={e => setRepPhone(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {/* short date fields, no commas needed */}
          <Field label="Birth month" required><Input type="number" min={1} max={12} value={repDobMonth} onChange={e => setRepDobMonth(e.target.value)} placeholder="MM" /></Field>
          <Field label="Birth day" required><Input type="number" min={1} max={31} value={repDobDay} onChange={e => setRepDobDay(e.target.value)} placeholder="DD" /></Field>
          <Field label="Birth year" required><Input type="number" min={1900} max={2010} value={repDobYear} onChange={e => setRepDobYear(e.target.value)} placeholder="YYYY" /></Field>
        </div>
        <Field label="SSN last 4 digits" required hint="Last 4 only. Full SSN may be requested by Stripe later if your volume exceeds thresholds.">
          <Input value={repSsn} onChange={e => setRepSsn(e.target.value.replace(/\D/g, "").slice(0, 4))} maxLength={4} inputMode="numeric" placeholder="0000" />
        </Field>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={repAddrSameAsBusiness}
            onChange={e => setRepAddrSameAsBusiness(e.target.checked)}
            className="accent-primary"
          />
          Representative lives at the business address
        </label>
        {!repAddrSameAsBusiness && (
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Field label="Street" required><Input value={repAddrLine1} onChange={e => setRepAddrLine1(e.target.value)} /></Field>
            <Field label="City" required><Input value={repAddrCity} onChange={e => setRepAddrCity(e.target.value)} /></Field>
            <Field label="State" required><Input value={repAddrState} onChange={e => setRepAddrState(e.target.value)} maxLength={2} /></Field>
            <Field label="ZIP" required><Input value={repAddrPostal} onChange={e => setRepAddrPostal(e.target.value)} /></Field>
          </div>
        )}
      </div>

      {/* Bank */}
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <h3 className="font-semibold text-sm">Where to send payouts</h3>
        <p className="t-helper">
          Bank account that will receive your share. US bank, USD only.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Routing number" required hint="9 digits">
            <Input value={bankRouting} onChange={e => setBankRouting(e.target.value.replace(/\D/g, "").slice(0, 9))} maxLength={9} inputMode="numeric" />
          </Field>
          <Field label="Account type" required>
            <select
              value={bankAccountType}
              onChange={e => setBankAccountType(e.target.value as any)}
              className="h-10 rounded-md border bg-card px-3 text-sm w-full"
            >
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
            </select>
          </Field>
        </div>
        <Field label="Account number" required>
          <Input value={bankAccount} onChange={e => setBankAccount(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </Field>
        <Field label="Confirm account number" required>
          <Input value={bankAccountConfirm} onChange={e => setBankAccountConfirm(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </Field>
        <Field label="Account holder name (optional)" hint="Leave blank to use your legal business name">
          <Input value={bankHolderName} onChange={e => setBankHolderName(e.target.value)} placeholder={legalIdentity?.legalName || ""} />
        </Field>
      </div>

      {error && (
        <div className="rounded-lg border p-3 flex items-start gap-2 bg-card" style={{ borderColor: "hsl(var(--brand-error) / 0.4)", background: "hsl(var(--brand-error) / 0.05)" }}>
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--brand-error))" }} />
          <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{error}</p>
        </div>
      )}

      {saveMutation.isSuccess && (
        <p className="text-xs" style={{ color: "hsl(var(--brand-success))" }}>Saved. Stripe is verifying your details.</p>
      )}

      <SaveBar
        visible={!!(
          repFirst || repLast || repEmail || repPhone ||
          repDobMonth || repDobDay || repDobYear || repSsn ||
          repAddrLine1 || repAddrCity || repAddrState || repAddrPostal ||
          bankRouting || bankAccount || bankAccountConfirm || bankHolderName
        )}
        position="fixed"
        testId="payouts-custom-save-bar"
        discardLabel="Discard"
        saveLabel={state?.stripeConnectAccountId ? "Update payout info" : "Save and verify with Stripe"}
        saving={saveMutation.isPending}
        onDiscard={() => {
          setRepFirst(""); setRepLast(""); setRepEmail(""); setRepPhone("");
          setRepDobMonth(""); setRepDobDay(""); setRepDobYear(""); setRepSsn("");
          setRepAddrSameAsBusiness(true);
          setRepAddrLine1(""); setRepAddrCity(""); setRepAddrState(""); setRepAddrPostal("");
          setBankRouting(""); setBankAccount(""); setBankAccountConfirm(""); setBankHolderName("");
          setBankAccountType("checking");
          setError(null);
        }}
        onSave={() => saveMutation.mutate()}
      />
    </section>
  );
}

function Field({
  label, required, hint, children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required && <span style={{ color: "hsl(var(--brand-error))" }} className="ml-0.5">*</span>}
      </Label>
      {children}
      {hint && <p className="t-helper">{hint}</p>}
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <dt className="t-micro-label">{label}</dt>
      <dd className="text-sm whitespace-pre-line">{value || <span className="text-muted-foreground italic">Not set</span>}</dd>
    </div>
  );
}

// ─── Payout history table ───────────────────────────────────────────────────
//
// Lists every invoice that resulted in a platform-to-Connect transfer (or was
// supposed to). Status is derived from the same three-way logic used in
// provider-billing-tab.tsx:
//   stripeTransferId set    -> Sent
//   payoutFailedAt set      -> Failed
//   status==PAID, no xfer   -> Pending
// We only show rows where the parent has paid - unpaid invoices don't have a
// payout to track yet.

function PayoutHistoryTable() {
  const { data: invoices = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/provider/invoices"],
    queryFn: async () => {
      const res = await fetch("/api/provider/invoices", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load payout history");
      const d = await res.json();
      return Array.isArray(d) ? d : (d.invoices || []);
    },
    refetchOnWindowFocus: true,
    refetchInterval: 15000,
  });

  // Only invoices the parent has actually paid - that's when a payout
  // exists (or should). Sort newest first.
  const payouts = invoices
    .filter((inv: any) => inv.status === "PAID" && (inv.providerPayoutAmount || 0) > 0)
    .sort((a: any, b: any) => {
      const aT = new Date(a.payoutInitiatedAt || a.paidAt || a.createdAt).getTime();
      const bT = new Date(b.payoutInitiatedAt || b.paidAt || b.createdAt).getTime();
      return bT - aT;
    });

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-semibold flex items-center gap-2"><History className="w-4 h-4" /> Payout history</h3>
        <p className="t-helper mt-0.5">
          {payouts.length} payout{payouts.length === 1 ? "" : "s"} - what GoStork has sent (or is sending) to your bank.
        </p>
      </div>
      <PayoutTable payouts={payouts} mode="open" testIdPrefix="settings-payout" />
    </section>
  );
}
