import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, X, CheckCircle2, ChevronLeft } from "lucide-react";

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

export const TAB_BY_TYPE: Record<string, string> = { EGG_DONOR: "egg-donors", SURROGATE: "surrogates", SPERM_DONOR: "sperm-donors", DOCTOR: "doctors" };
export const NOUN_BY_TYPE: Record<string, string> = { EGG_DONOR: "egg donors", SPERM_DONOR: "sperm donors", SURROGATE: "surrogates", DOCTOR: "doctors" };

/**
 * Responsive overlay shell: centered modal on desktop, bottom drawer on mobile
 * (Tailwind items-end + rounded-t on small screens). Shared by the checkout
 * overlay and the Start Sponsorship wizard so they look and behave identically.
 */
export function ModalShell({ onClose, children, maxWidth = "sm:max-w-md", onBack }: { onClose: () => void; children: React.ReactNode; maxWidth?: string; onBack?: () => void }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50 animate-in fade-in" onClick={onClose} />
      <div className={`relative w-full ${maxWidth} max-h-[92vh] overflow-y-auto bg-card rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 animate-in slide-in-from-bottom-6 sm:zoom-in-95`}>
        {onBack && (
          <button onClick={onBack} className="absolute top-3 left-3 w-8 h-8 rounded-full hover:bg-secondary flex items-center justify-center text-muted-foreground" data-testid="button-modal-back">
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
        <button onClick={onClose} className="absolute top-3 right-3 w-8 h-8 rounded-full hover:bg-secondary flex items-center justify-center text-muted-foreground" data-testid="button-modal-close">
          <X className="w-4 h-4" />
        </button>
        <div className="sm:hidden mx-auto mb-3 h-1.5 w-10 rounded-full bg-border" />
        {children}
      </div>
    </div>
  );
}

/** The post-payment "what's next" step, shared by the checkout overlay + wizard. */
export function CheckoutSuccessStep({ plan, sponsorshipId, onClose }: { plan: any; sponsorshipId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const isBundle = plan?.productType === "SLOT_BUNDLE";
  const tab = TAB_BY_TYPE[plan?.slotEntityType];
  const noun = NOUN_BY_TYPE[plan?.slotEntityType] || "profiles";
  return (
    <div className="text-center space-y-3 py-3">
      <CheckCircle2 className="w-12 h-12 mx-auto text-[hsl(var(--brand-success))]" />
      <h3 className="font-heading text-lg text-foreground">Payment complete</h3>
      {isBundle && tab ? (
        <>
          <p className="text-sm text-muted-foreground">Next step: choose the {noun} you want to sponsor.</p>
          <Button className="w-full" onClick={() => navigate(`/account/${tab}?sponsor=${sponsorshipId}`)} data-testid="button-select-profiles">Select {noun}</Button>
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={onClose}>I'll do this later</button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {isBundle ? `Manage your sponsored ${noun} on the Sponsorship page.` : "Your profile is now boosted in the marketplace."}
          </p>
          <Button className="w-full" onClick={onClose} data-testid="button-checkout-done">Done</Button>
        </>
      )}
    </div>
  );
}

/**
 * Checkout overlay used to resume payment on a pending sponsorship (the
 * "Complete payment" button). Payment then success, in the shared modal shell.
 */
export function SponsorshipCheckoutOverlay({ plan, clientSecret, sponsorshipId, onClose }: {
  plan: any;
  clientSecret: string;
  sponsorshipId: string;
  onClose: () => void;
}) {
  const [paid, setPaid] = useState(false);
  return (
    <ModalShell onClose={onClose}>
      {!paid ? (
        <>
          <h3 className="font-heading text-lg text-foreground mb-1">{plan?.displayName}</h3>
          <p className="text-sm text-muted-foreground mb-4">Complete payment to activate your sponsorship.</p>
          <SponsorshipCheckout clientSecret={clientSecret} onDone={() => setPaid(true)} onCancel={onClose} />
        </>
      ) : (
        <CheckoutSuccessStep plan={plan} sponsorshipId={sponsorshipId} onClose={onClose} />
      )}
    </ModalShell>
  );
}
