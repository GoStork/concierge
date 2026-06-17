import { useEffect, useMemo, useState, useCallback } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";

/**
 * Inline (no-modal) Stripe checkout for a sponsorship. Reuses the same
 * PaymentElement flow as the parent invoice payment page. On success it calls
 * onDone so the dashboard can refetch; the webhook flips the sponsorship ACTIVE.
 */

let stripePromiseCache: Promise<Stripe | null> | null = null;
async function getStripe(): Promise<Stripe | null> {
  if (!stripePromiseCache) {
    const res = await apiRequest("GET", "/api/billing/stripe-key");
    const { publishableKey } = await res.json();
    stripePromiseCache = publishableKey ? loadStripe(publishableKey) : Promise.resolve(null);
  }
  return stripePromiseCache;
}

function CheckoutForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}${window.location.pathname}?sponsored=1` },
      redirect: "if_required",
    });
    if (error) {
      setError(error.message || "Payment failed. Please try again.");
      setProcessing(false);
    } else {
      onDone();
    }
  }, [stripe, elements, onDone]);

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && (
        <div className="rounded-lg px-3 py-2 text-sm" style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}>
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!stripe || processing} data-testid="button-sponsorship-pay">
          {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Pay & activate"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={processing}>Cancel</Button>
      </div>
    </form>
  );
}

export function SponsorshipCheckout({ clientSecret, onDone, onCancel }: {
  clientSecret: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [stripe, setStripe] = useState<Stripe | null>(null);
  const [loading, setLoading] = useState(true);
  const isMock = clientSecret.startsWith("mock_");

  useEffect(() => {
    let alive = true;
    getStripe().then((s) => { if (alive) { setStripe(s); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  // Mock mode (no Stripe keys): the backend already activated the sponsorship.
  if (isMock) {
    return (
      <div className="rounded-lg border border-border bg-secondary/40 p-4 text-sm space-y-3">
        <p className="font-medium">Development mode - Stripe not configured.</p>
        <p className="text-muted-foreground">The sponsorship was activated automatically.</p>
        <Button onClick={onDone} data-testid="button-sponsorship-mock-done">Done</Button>
      </div>
    );
  }

  if (loading || !stripe) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading payment form...</div>;
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <Elements stripe={stripe} options={{ clientSecret, appearance: { theme: "stripe" } }}>
        <CheckoutForm onDone={onDone} onCancel={onCancel} />
      </Elements>
    </div>
  );
}
