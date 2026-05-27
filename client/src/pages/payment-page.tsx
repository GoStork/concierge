/**
 * Public payment page - accessible without authentication.
 * Route: /pay/:paymentToken
 *
 * Uses Stripe Elements (PaymentElement) for card capture.
 * The payment token is a random UUID stored on the Invoice record (not the internal Invoice ID)
 * to prevent enumeration.
 */

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useState, useCallback } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Loader2, AlertCircle, CheckCircle2, Shield, Clock, Landmark, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface InvoiceLineItem {
  id?: string;
  serviceType: string;
  description?: string | null;
  amountCents: number;
}

interface WireAccount {
  type: string;
  bankName?: string | null;
  accountHolderName?: string | null;
  accountHolderAddress?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  swiftCode?: string | null;
  iban?: string | null;
  sortCode?: string | null;
  supportedNetworks?: string[];
}
interface WireInstructions {
  paymentIntentId: string;
  currency: string;
  amountCents: number;
  reference: string;
  hostedInstructionsUrl?: string | null;
  accounts: WireAccount[];
}

interface PublicInvoice {
  id: string;
  paymentToken: string;
  providerName: string;
  serviceType: string;
  description?: string;
  serviceAmount: number;
  referralFeeAmount: number;
  currency: string;
  status: string;
  isProtected: boolean;
  dueAt?: string | null;
  medicalClearanceStatus?: string | null;
  paymentMethod?: string | null;
  wireInstructions?: WireInstructions | null;
  lineItems?: InvoiceLineItem[];
}

const LINE_TYPE_LABELS: Record<string, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
  OTHER: "Other",
};
function lineLabel(serviceType: string): string {
  return LINE_TYPE_LABELS[(serviceType || "").toUpperCase()] || serviceType || "Service";
}

function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function CountdownTimer({ dueAt }: { dueAt: string }) {
  const [remaining, setRemaining] = useState<string>("");

  useEffect(() => {
    const tick = () => {
      const diff = new Date(dueAt).getTime() - Date.now();
      if (diff <= 0) { setRemaining("Expired"); return; }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1_000);
      setRemaining(`${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [dueAt]);

  const isUrgent = new Date(dueAt).getTime() - Date.now() < 4 * 3_600_000;

  return (
    <div
      className="flex items-center gap-2 rounded-lg px-4 py-3 text-sm font-medium"
      style={{ background: isUrgent ? "hsl(var(--brand-error) / 0.1)" : "hsl(var(--brand-warning) / 0.1)", color: isUrgent ? "hsl(var(--brand-error))" : "hsl(var(--brand-warning))" }}
    >
      <Clock className="w-4 h-4 shrink-0" />
      <span>Surrogate hold expires in: <strong>{remaining}</strong></span>
    </div>
  );
}

// ─── Wire-transfer instructions panel ───────────────────────────────────────
//
// International parents (and US parents paying large invoices) often prefer
// a bank wire over card/ACH because of per-transaction limits and FX cost.
// The wire flow is one-way: parents go to their own bank to initiate the
// wire, using the reference code in the memo so Stripe can match the
// inbound payment back to this invoice.

function CopyableField({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked; user can still select manually */ }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
        <div
          className={`text-sm font-mono break-all ${highlight ? "font-semibold" : ""}`}
          style={highlight ? { color: "hsl(var(--primary))" } : {}}
        >
          {value}
        </div>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted/50 transition"
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function WireTransferPanel({
  paymentToken,
  cachedInstructions,
  amountFormatted,
}: {
  paymentToken: string;
  cachedInstructions: WireInstructions | null;
  amountFormatted: string;
}) {
  const [expanded, setExpanded] = useState(!!cachedInstructions);
  const [instructions, setInstructions] = useState<WireInstructions | null>(cachedInstructions);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchInstructions = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/billing/create-wire-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentToken }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
        throw new Error(err.message || `Failed (${r.status})`);
      }
      return (await r.json()) as WireInstructions;
    },
    onSuccess: (data) => {
      setInstructions(data);
      setExpanded(true);
      setErrorMsg(null);
    },
    onError: (e: any) => setErrorMsg(e.message || "Could not generate wire instructions."),
  });

  // When the panel is opened for the first time and we don't already have
  // cached instructions, fetch them. Done in an effect so the user only sees
  // the loading state after they explicitly opened the section.
  useEffect(() => {
    if (expanded && !instructions && !fetchInstructions.isPending) {
      fetchInstructions.mutate();
    }
  }, [expanded, instructions, fetchInstructions]);

  // Stripe typically returns multiple destinations for a US bank transfer:
  // an ABA entry for domestic ACH/wire and a SWIFT entry for international
  // wires. Render each as its own card so the parent picks the one their
  // bank supports.
  const accounts = instructions?.accounts || [];
  const labelForAccount = (a: WireAccount): string => {
    const nets = a.supportedNetworks || [];
    if (a.type === "aba" || nets.includes("ach") || nets.includes("domestic_wire_us")) return "US Domestic - ACH / Wire";
    if (a.type === "swift" || nets.includes("swift")) return "International Wire (SWIFT)";
    if (a.type === "iban") return "SEPA / European Wire (IBAN)";
    if (a.type === "sort_code") return "UK Bank Transfer (Sort Code)";
    if (a.type === "spei") return "Mexico SPEI";
    if (a.type === "zengin") return "Japan Zengin";
    return a.type.toUpperCase();
  };

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: "hsl(var(--primary) / 0.3)" }}>
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-secondary/30 transition"
        style={{ background: expanded ? "hsl(var(--secondary) / 0.4)" : undefined }}
      >
        <div className="flex items-center gap-3">
          <Landmark className="w-5 h-5" style={{ color: "hsl(var(--primary))" }} />
          <div>
            <p className="font-medium text-sm">Pay by Bank Wire Transfer</p>
            <p className="text-xs text-muted-foreground">For international parents or large invoices. 1-3 business days.</p>
          </div>
        </div>
        <span className="text-xs font-medium" style={{ color: "hsl(var(--primary))" }}>
          {expanded ? "Hide" : "Show"}
        </span>
      </button>

      {expanded && (
        <div className="px-5 py-4 space-y-3 border-t" style={{ borderColor: "hsl(var(--primary) / 0.15)" }}>
          {fetchInstructions.isPending && !instructions && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Generating your wire instructions...
            </div>
          )}

          {errorMsg && (
            <div className="rounded-lg px-3 py-2 text-sm" style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}>
              {errorMsg}
            </div>
          )}

          {instructions && accounts.length > 0 && (
            <>
              <div className="rounded-lg px-3 py-3" style={{ background: "hsl(var(--brand-warning) / 0.1)", border: "1px solid hsl(var(--brand-warning) / 0.3)" }}>
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "hsl(var(--brand-warning))" }}>Critical - include this reference</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Your wire will not be matched to this invoice unless you put the reference code below in the memo / reference field of your wire.
                </p>
              </div>

              <CopyableField label="Reference (put in wire memo)" value={instructions.reference} highlight />
              <CopyableField label="Amount" value={amountFormatted} />

              {accounts.map((acct, idx) => (
                <div key={idx} className="rounded-lg border p-3 space-y-1" style={{ borderColor: "hsl(var(--border))" }}>
                  <p className="text-xs font-semibold uppercase tracking-wide pb-1" style={{ color: "hsl(var(--primary))" }}>
                    {labelForAccount(acct)}
                  </p>
                  {acct.bankName && <CopyableField label="Bank Name" value={acct.bankName} />}
                  {acct.accountHolderName && <CopyableField label="Beneficiary" value={acct.accountHolderName} />}
                  {acct.accountHolderAddress && <CopyableField label="Beneficiary Address" value={acct.accountHolderAddress} />}
                  {acct.routingNumber && <CopyableField label="Routing Number (ABA)" value={acct.routingNumber} />}
                  {acct.accountNumber && <CopyableField label="Account Number" value={acct.accountNumber} />}
                  {acct.swiftCode && <CopyableField label="SWIFT / BIC" value={acct.swiftCode} />}
                  {acct.iban && <CopyableField label="IBAN" value={acct.iban} />}
                  {acct.sortCode && <CopyableField label="Sort Code" value={acct.sortCode} />}
                </div>
              ))}

              <div className="rounded-lg px-3 py-2 text-xs text-muted-foreground" style={{ background: "hsl(var(--secondary) / 0.4)" }}>
                We've emailed a copy of these details to you. Wires from outside the United States may incur a fee from your bank (typically $15-$45) that is not part of the invoice total. Funds usually arrive within 1-3 business days.
              </div>

              {instructions.hostedInstructionsUrl && (
                <a
                  href={instructions.hostedInstructionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center text-sm underline"
                  style={{ color: "hsl(var(--primary))" }}
                >
                  View Stripe-hosted version
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Inner form (must be inside <Elements> provider) ─────────────────────────

function StripePaymentForm({ invoice, isMock, onSuccess }: {
  invoice: PublicInvoice;
  isMock: boolean;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const isAtClearance = invoice.medicalClearanceStatus === "PENDING";

  // Mock payment (no Stripe keys configured)
  const mockMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/billing/mock-payment-success", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentToken: invoice.paymentToken }),
      });
      if (!res.ok) throw new Error("Mock payment failed");
    },
    onSuccess,
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (isMock) {
      mockMutation.mutate();
      return;
    }

    if (!stripe || !elements) return;
    setProcessing(true);

    // Preserve the chat returnTo across the Stripe redirect so the
    // success state can navigate the parent back to the exact chat.
    const incomingReturnTo = new URLSearchParams(window.location.search).get("returnTo");
    const returnToQS = incomingReturnTo ? `&returnTo=${encodeURIComponent(incomingReturnTo)}` : "";
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/pay/${invoice.paymentToken}?success=1${returnToQS}`,
      },
      redirect: "if_required",
    });

    if (error) {
      setErrorMsg(error.message || "Payment failed. Please try again.");
      setProcessing(false);
    } else {
      onSuccess();
    }
  }, [stripe, elements, isMock, invoice.paymentToken, mockMutation, onSuccess]);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm font-medium">Pay by Card</p>

      {isMock ? (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground bg-muted/30">
          <p className="font-medium mb-1">Development Mode</p>
          <p>Stripe is not configured. Click the button below to simulate a successful payment.</p>
        </div>
      ) : (
        <PaymentElement options={{ layout: "tabs" }} />
      )}

      {errorMsg && (
        <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}>
          {errorMsg}
        </div>
      )}

      <Button
        type="submit"
        className="w-full"
        disabled={(!stripe && !isMock) || processing || mockMutation.isPending}
        style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)", height: "48px", fontSize: "1rem" }}
      >
        {(processing || mockMutation.isPending) ? (
          <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing...</>
        ) : isAtClearance ? (
          `Authorize Hold - ${formatCents(invoice.serviceAmount, invoice.currency)}`
        ) : (
          `Pay Securely - ${formatCents(invoice.serviceAmount, invoice.currency)}`
        )}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Payments are processed securely by Stripe. GoStork never stores your card details.
      </p>
    </form>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PaymentPage() {
  const { paymentToken } = useParams<{ paymentToken: string }>();
  const navigate = useNavigate();
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);
  const [stripePromise] = useState(() => {
    const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    return key ? loadStripe(key) : null;
  });

  // Check for ?success=1 redirect from Stripe
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("success") === "1") {
      setPaymentSuccess(true);
    }
  }, []);

  // Fetch invoice details (public endpoint)
  const { data: invoice, isLoading, error } = useQuery<PublicInvoice>({
    queryKey: ["/api/invoices/pay", paymentToken],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/pay/${paymentToken}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Invoice not found");
      return res.json();
    },
    enabled: !!paymentToken,
    retry: false,
  });

  // Create PaymentIntent once invoice is loaded
  useEffect(() => {
    if (!invoice || invoice.status !== "AWAITING_PAYMENT" || clientSecret) return;
    // PAYMENT_PROCESSING (ACH submitted, awaiting clearance) MUST NOT mint a
    // fresh PaymentIntent - the parent already paid; we just show the
    // pending-state panel below.

    fetch("/api/billing/create-payment-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentToken }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.mock) {
          setIsMock(true);
          setClientSecret("mock");
        } else {
          setClientSecret(data.clientSecret);
        }
      })
      .catch(() => setClientSecret(null));
  }, [invoice, paymentToken, clientSecret]);

  const handleSuccess = useCallback(() => setPaymentSuccess(true), []);

  // ─── Render states ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: "hsl(var(--primary))" }} />
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4 text-center">
        <AlertCircle className="w-12 h-12" style={{ color: "hsl(var(--brand-error))" }} />
        <h1 className="text-lg font-heading font-semibold">Invoice not found</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          This payment link may have expired or is invalid. Please contact GoStork support.
        </p>
      </div>
    );
  }

  if (paymentSuccess || invoice.status === "PAID") {
    // Prefer the chat URL we were redirected from (passed via ?returnTo=) so
    // the parent lands back in the exact chat. Fall back to the generic /chat
    // landing when no returnTo was supplied.
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    const safeReturn = (() => {
      if (!returnTo) return "/chat";
      try {
        const decoded = decodeURIComponent(returnTo);
        // Only accept same-origin paths to avoid open-redirects.
        return decoded.startsWith("/") ? decoded : "/chat";
      } catch {
        return "/chat";
      }
    })();
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4 text-center">
        <CheckCircle2 className="w-14 h-14" style={{ color: "hsl(var(--brand-success))" }} />
        <h1 className="text-xl font-heading font-semibold">Payment Successful!</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          Your payment for {invoice.providerName} has been received. You will receive a confirmation email shortly.
        </p>
        <Button onClick={() => navigate(safeReturn)} style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}>
          Return to Chat
        </Button>
      </div>
    );
  }

  if (invoice.status === "PAYMENT_PROCESSING") {
    const isAch = (invoice.paymentMethod || "").toUpperCase() === "ACH";
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4 text-center">
        <Clock className="w-14 h-14" style={{ color: "hsl(var(--primary))" }} />
        <h1 className="text-xl font-heading font-semibold">Payment Processing</h1>
        <p className="text-sm text-muted-foreground max-w-md">
          {isAch
            ? <>Your ACH bank transfer to <strong>{invoice.providerName}</strong> has been submitted and is clearing with your bank. Funds typically settle within <strong>3-5 business days</strong>. No further action is needed - we'll email you a receipt as soon as the payment clears.</>
            : <>Your payment to <strong>{invoice.providerName}</strong> has been submitted and is processing. We'll email you a receipt as soon as it clears. No further action is needed.</>
          }
        </p>
        <div className="rounded-lg border px-4 py-3 text-xs max-w-md" style={{ background: "hsl(var(--secondary) / 0.4)", borderColor: "hsl(var(--primary) / 0.2)" }}>
          Please do not re-submit this payment - your funds are already on their way.
        </div>
        <Button variant="outline" onClick={() => navigate("/chat")}>Return to Chat</Button>
      </div>
    );
  }

  if (invoice.status === "EXPIRED") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4 text-center">
        <AlertCircle className="w-12 h-12 text-muted-foreground" />
        <h1 className="text-lg font-heading font-semibold">Payment Link Expired</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          The 24-hour hold period has passed. Please contact GoStork to explore next steps.
        </p>
        <Button variant="outline" onClick={() => navigate("/")}>Back to GoStork</Button>
      </div>
    );
  }

  const isAtClearance = invoice.medicalClearanceStatus === "PENDING" && invoice.status === "AWAITING_PAYMENT";

  return (
    <div className="min-h-screen" style={{ background: "hsl(var(--background))" }}>
      {/* Header */}
      <div className="border-b px-4 h-14 flex items-center gap-3" style={{ background: "hsl(var(--background))" }}>
        <span className="font-heading font-semibold text-base" style={{ color: "hsl(var(--primary))" }}>GoStork</span>
        <span className="text-muted-foreground">|</span>
        <span className="text-sm font-medium">Secure Payment</span>
      </div>

      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">

        {invoice.dueAt && <CountdownTimer dueAt={invoice.dueAt} />}

        {isAtClearance && (
          <div className="rounded-lg border px-4 py-4 text-sm space-y-1" style={{ borderColor: "hsl(var(--primary) / 0.3)", background: "hsl(var(--primary) / 0.05)" }}>
            <p className="font-semibold" style={{ color: "hsl(var(--primary))" }}>Secure Vault - No Charge Yet</p>
            <p className="text-muted-foreground">
              Your card will be <strong>authorized only</strong> today. The charge is released to {invoice.providerName} only after your surrogate passes medical clearance. If she fails, your hold is instantly canceled at no cost.
            </p>
          </div>
        )}

        {/* Invoice summary */}
        <div className="rounded-xl border p-5 space-y-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Payment to</p>
            <p className="text-lg font-heading font-semibold mt-0.5">{invoice.providerName}</p>
            {invoice.description && <p className="text-sm text-muted-foreground mt-1">{invoice.description}</p>}
          </div>
          <div className="border-t pt-4 space-y-2">
            {invoice.lineItems && invoice.lineItems.length > 0 ? (
              <>
                {invoice.lineItems.map((li, idx) => (
                  <div key={li.id ?? idx} className="flex justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{lineLabel(li.serviceType)}</p>
                      {li.description && (
                        <p className="text-xs text-muted-foreground truncate">{li.description}</p>
                      )}
                    </div>
                    <span className="font-medium shrink-0">{formatCents(li.amountCents, invoice.currency)}</span>
                  </div>
                ))}
              </>
            ) : (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{invoice.serviceType}</span>
                <span className="font-medium">{formatCents(invoice.serviceAmount, invoice.currency)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-semibold border-t pt-2 mt-2">
              <span>Amount Due Today</span>
              <span style={{ color: "hsl(var(--primary))" }}>{formatCents(invoice.serviceAmount, invoice.currency)}</span>
            </div>
          </div>
        </div>

        {/* GoStork Guarantee */}
        {invoice.isProtected && (
          <div className="flex items-start gap-3 rounded-lg px-4 py-3 text-sm" style={{ background: "hsl(var(--brand-success) / 0.08)", border: "1px solid hsl(var(--brand-success) / 0.25)" }}>
            <Shield className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "hsl(var(--brand-success))" }} />
            <div>
              <p className="font-semibold" style={{ color: "hsl(var(--brand-success))" }}>GoStork Guarantee</p>
              <p className="text-muted-foreground text-xs mt-0.5">
                If your match falls through due to medical clearance failure, GoStork will transfer your deposit to any other agency on our platform - at no extra cost.
              </p>
            </div>
          </div>
        )}

        {/* Stripe Elements payment form */}
        {clientSecret && (
          isMock || !stripePromise ? (
            <StripePaymentForm invoice={invoice} isMock={true} onSuccess={handleSuccess} />
          ) : (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret,
                appearance: {
                  theme: "stripe",
                  variables: {
                    colorPrimary: "hsl(152, 40%, 30%)",
                    borderRadius: "8px",
                  },
                },
              }}
            >
              <StripePaymentForm invoice={invoice} isMock={false} onSuccess={handleSuccess} />
            </Elements>
          )
        )}

        {!clientSecret && invoice.status === "AWAITING_PAYMENT" && (
          <div className="flex justify-center py-4">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/*
          Wire transfer is offered alongside the card form for AWAITING_PAYMENT
          invoices that are NOT escrow holds. customer_balance cannot be
          manual-captured, so it's incompatible with the AT_CLEARANCE flow -
          the backend will reject the request anyway, but hiding the UI is
          cleaner.
        */}
        {invoice.status === "AWAITING_PAYMENT" && !isAtClearance && !isMock && (
          <>
            <div className="flex items-center gap-3 my-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <WireTransferPanel
              paymentToken={invoice.paymentToken}
              cachedInstructions={invoice.wireInstructions || null}
              amountFormatted={`${formatCents(invoice.serviceAmount, invoice.currency)} ${(invoice.currency || "USD").toUpperCase()}`}
            />
          </>
        )}
      </div>
    </div>
  );
}
