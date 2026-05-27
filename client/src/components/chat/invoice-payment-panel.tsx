/**
 * In-chat Stripe payment panel.
 *
 * Renders a Stripe PaymentElement inline above the chat composer so the
 * parent can pay an invoice without leaving the chat. Used as the embedded
 * alternative to the separate /pay/:paymentToken page.
 *
 * Lifecycle:
 *   1. Mount with a paymentToken (from the invoice card uiCardData).
 *   2. Fetch the public invoice + create-payment-intent endpoints.
 *   3. Mount <Elements> with the clientSecret returned by the server.
 *   4. User fills card info -> stripe.confirmPayment({ redirect: "if_required" }).
 *   5. On confirmed success, call onSuccess so the chat refetches and the
 *      invoice card flips to PAID + the confirmation message appears.
 *
 * The Stripe webhook (server-side) is the authoritative source of truth for
 * marking the invoice PAID. This panel just drives the card-collection UI -
 * the webhook + reflectPaymentInChat() do the chat-state updates.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Loader2, X, CheckCircle2, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoneyCents as formatCents } from "@/lib/format-money";

interface InvoicePaymentPanelProps {
  paymentToken: string;
  brandColor: string;
  onClose: () => void;
  /** Called once Stripe confirms the payment in the browser. The webhook
   *  fires separately and updates the invoice + posts the confirmation
   *  message; this is the cue for the chat to refetch its messages. */
  onSuccess: () => void;
}

interface PublicInvoiceLine {
  id?: string;
  serviceType: string;
  description?: string | null;
  amountCents: number;
}

interface PublicInvoice {
  invoiceId: string;
  paymentToken: string;
  providerName: string;
  serviceType: string;
  serviceAmount: number;
  currency: string;
  status: string;
  description?: string | null;
  lineItems?: PublicInvoiceLine[];
}

const LINE_TYPE_LABELS: Record<string, string> = {
  SURROGACY: "Surrogacy",
  EGG_DONATION: "Egg Donation",
  SPERM_DONATION: "Sperm Donation",
  IVF_CLINIC: "IVF Clinic",
  OTHER: "Other",
};
function lineLabel(t: string): string {
  return LINE_TYPE_LABELS[(t || "").toUpperCase()] || t || "Service";
}

export function InvoicePaymentPanel({ paymentToken, brandColor, onClose, onSuccess }: InvoicePaymentPanelProps) {
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stripePromise = useMemo<Promise<Stripe | null> | null>(() => {
    const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    return key ? loadStripe(key) : null;
  }, []);

  // Keep the latest onSuccess in a ref so we can call it from the effect
  // without re-running the effect (and minting a fresh PaymentIntent) when
  // the parent re-renders with a new callback identity.
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  // Fetch invoice + payment intent ONCE per paymentToken. Each
  // create-payment-intent call mints a brand-new Stripe PaymentIntent and
  // overwrites stripePaymentIntentId on the invoice - so we must not call
  // it again on every parent render, or the webhook ends up looking for a
  // PI that has since been overwritten.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/invoices/pay/${paymentToken}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.message || "Invoice not found");
        }
        const data: PublicInvoice = await res.json();
        if (cancelled) return;
        setInvoice(data);

        if (data.status !== "AWAITING_PAYMENT") {
          // Already paid (or expired/cancelled) - just close.
          onSuccessRef.current();
          return;
        }

        const intentRes = await fetch("/api/billing/create-payment-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentToken }),
        });
        const intentData = await intentRes.json();
        if (cancelled) return;
        if (intentData.mock) {
          setIsMock(true);
          setClientSecret("mock");
        } else if (intentData.clientSecret) {
          setClientSecret(intentData.clientSecret);
        } else {
          setError(intentData?.message || "Failed to initialize payment");
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load payment");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paymentToken]);

  return (
    <div
      className="rounded-[var(--radius)] border-2 bg-card overflow-hidden"
      style={{ borderColor: brandColor }}
      data-testid="invoice-payment-panel"
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ background: `${brandColor}0F` }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Shield className="w-4 h-4 shrink-0" style={{ color: brandColor }} />
          <p className="text-sm font-semibold truncate">
            {invoice ? `Pay ${invoice.providerName}` : "Loading payment..."}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close"
          className="h-7 w-7 p-0 shrink-0"
          data-testid="btn-close-invoice-payment-panel"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="p-4">
        {error && (
          <div
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}
          >
            {error}
          </div>
        )}

        {!error && !invoice && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading invoice...
          </div>
        )}

        {/* Line-items summary so the parent confirms what they're paying for
            before entering card details. Falls back to a single Service line
            when no line items are present (legacy invoices). */}
        {invoice && (
          <div className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1">
            {invoice.lineItems && invoice.lineItems.length > 0 ? (
              <>
                {invoice.lineItems.map((li, idx) => (
                  <div key={li.id ?? idx} className="flex justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{lineLabel(li.serviceType)}</p>
                      {li.description && (
                        <p className="text-[11px] text-muted-foreground truncate">{li.description}</p>
                      )}
                    </div>
                    <span className="font-medium shrink-0">{formatCents(li.amountCents, invoice.currency)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold border-t pt-1.5 mt-1">
                  <span>Total</span>
                  <span style={{ color: brandColor }}>{formatCents(invoice.serviceAmount, invoice.currency)}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between font-semibold">
                <span>{invoice.serviceType}</span>
                <span style={{ color: brandColor }}>{formatCents(invoice.serviceAmount, invoice.currency)}</span>
              </div>
            )}
          </div>
        )}

        {invoice && !clientSecret && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
            <Loader2 className="w-4 h-4 animate-spin" />
            Preparing secure payment...
          </div>
        )}

        {invoice && clientSecret && !isMock && stripePromise && (
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <EmbeddedPaymentForm
              invoice={invoice}
              brandColor={brandColor}
              onSuccess={onSuccess}
              onError={setError}
            />
          </Elements>
        )}

        {invoice && isMock && (
          <MockPaymentForm
            invoice={invoice}
            paymentToken={paymentToken}
            brandColor={brandColor}
            onSuccess={onSuccess}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

function EmbeddedPaymentForm({
  invoice,
  brandColor,
  onSuccess,
  onError,
}: {
  invoice: PublicInvoice;
  brandColor: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    onError("");

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      // Stay in the chat. If a payment method requires a redirect (Klarna,
      // Affirm, Cash App, etc) Stripe will still navigate - that's fine.
      redirect: "if_required",
    });

    if (error) {
      onError(error.message || "Payment failed. Please try again.");
      setProcessing(false);
      return;
    }

    if (paymentIntent && (paymentIntent.status === "succeeded" || paymentIntent.status === "requires_capture")) {
      setConfirmed(true);
      // Give the webhook a beat to update the chat, then trigger refetch.
      setTimeout(onSuccess, 800);
    } else {
      // Unusual but not failed - still nudge the chat to refetch.
      setTimeout(onSuccess, 1200);
    }
  };

  if (confirmed) {
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <CheckCircle2 className="w-10 h-10" style={{ color: "hsl(var(--brand-success))" }} />
        <p className="text-sm font-semibold">Payment confirmed!</p>
        <p className="text-xs text-muted-foreground">Updating chat...</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <PaymentElement options={{ layout: "tabs" }} />
      <Button
        type="submit"
        disabled={!stripe || processing}
        className="w-full text-primary-foreground"
        style={{ background: brandColor, borderRadius: "var(--radius)" }}
        data-testid="btn-submit-inline-payment"
      >
        {processing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Processing...
          </>
        ) : (
          `Pay Securely - ${formatCents(invoice.serviceAmount, invoice.currency)}`
        )}
      </Button>
      <p className="text-center text-[11px] text-muted-foreground">
        Payments processed securely by Stripe. GoStork never stores your card details.
      </p>
    </form>
  );
}

function MockPaymentForm({
  invoice,
  paymentToken,
  brandColor,
  onSuccess,
  onError,
}: {
  invoice: PublicInvoice;
  paymentToken: string;
  brandColor: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [processing, setProcessing] = useState(false);

  const handleClick = async () => {
    setProcessing(true);
    onError("");
    try {
      const res = await fetch("/api/billing/mock-payment-success", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentToken }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || "Mock payment failed");
      }
      setTimeout(onSuccess, 600);
    } catch (e: any) {
      onError(e?.message || "Mock payment failed");
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3 text-xs bg-muted/30">
        <p className="font-medium mb-0.5">Development mode</p>
        <p className="text-muted-foreground">
          Stripe is not configured. Click below to simulate a successful payment.
        </p>
      </div>
      <Button
        type="button"
        onClick={handleClick}
        disabled={processing}
        className="w-full text-primary-foreground"
        style={{ background: brandColor, borderRadius: "var(--radius)" }}
      >
        {processing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Simulating...
          </>
        ) : (
          `Simulate Payment - ${formatCents(invoice.serviceAmount, invoice.currency)}`
        )}
      </Button>
    </div>
  );
}
