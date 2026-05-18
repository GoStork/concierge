/**
 * Public payment page - accessible without authentication.
 * Route: /pay/:paymentToken
 *
 * Renders a Braintree Drop-in UI so the parent can pay by card.
 * The payment token is a random UUID stored on the Invoice record (not the internal Invoice ID)
 * to prevent enumeration.
 */

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, CheckCircle2, Shield, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PublicInvoice {
  id: string;
  paymentToken: string;
  providerName: string;
  serviceType: string;
  description?: string;
  serviceAmount: number;       // cents
  referralFeeAmount: number;   // cents
  currency: string;
  status: string;
  isProtected: boolean;
  dueAt?: string | null;
  braintreePaymentLinkUrl?: string | null;
  medicalClearanceStatus?: string | null;
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

export default function PaymentPage() {
  const { paymentToken } = useParams<{ paymentToken: string }>();
  const navigate = useNavigate();
  const dropinContainerRef = useRef<HTMLDivElement>(null);
  const dropinInstanceRef = useRef<any>(null);
  const [dropinReady, setDropinReady] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch invoice details (public endpoint - no auth)
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

  // Fetch Braintree client token
  const { data: btData } = useQuery<{ clientToken: string }>({
    queryKey: ["/api/billing/braintree-token"],
    queryFn: async () => {
      const res = await fetch("/api/billing/braintree-token");
      if (!res.ok) throw new Error("Failed to load payment form");
      return res.json();
    },
    enabled: !!invoice && invoice.status === "AWAITING_PAYMENT",
  });

  // Initialize Braintree Drop-in when token is available
  useEffect(() => {
    if (!btData?.clientToken || !dropinContainerRef.current || dropinInstanceRef.current) return;

    // Dynamically load Braintree Drop-in script
    const loadDropin = async () => {
      // @ts-ignore - braintree loaded via CDN
      if (!window.braintree) {
        const script = document.createElement("script");
        script.src = "https://js.braintreegateway.com/web/dropin/1.43.0/js/dropin.min.js";
        script.onload = () => initDropin();
        document.head.appendChild(script);
      } else {
        initDropin();
      }
    };

    const initDropin = () => {
      // @ts-ignore
      window.braintree.dropin.create(
        {
          authorization: btData.clientToken,
          container: dropinContainerRef.current,
          card: {
            cardholderName: { required: true },
          },
        },
        (err: any, instance: any) => {
          if (err) {
            setErrorMsg("Failed to load payment form. Please refresh and try again.");
            return;
          }
          dropinInstanceRef.current = instance;
          setDropinReady(true);
        },
      );
    };

    loadDropin();

    return () => {
      if (dropinInstanceRef.current) {
        dropinInstanceRef.current.teardown().catch(() => {});
        dropinInstanceRef.current = null;
      }
    };
  }, [btData?.clientToken]);

  // Submit payment mutation
  const payMutation = useMutation({
    mutationFn: async () => {
      if (!dropinInstanceRef.current) throw new Error("Payment form not ready");
      const { nonce } = await dropinInstanceRef.current.requestPaymentMethod();

      const res = await fetch("/api/billing/submit-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentToken, nonce }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Payment failed. Please try again.");
      }
      return res.json();
    },
    onSuccess: () => {
      setPaymentSuccess(true);
      setErrorMsg(null);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message);
    },
  });

  // ─── Render states ────────────────────────────────────────────────────────

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
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4 text-center">
        <CheckCircle2 className="w-14 h-14" style={{ color: "hsl(var(--brand-success))" }} />
        <h1 className="text-xl font-heading font-semibold">Payment Successful!</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          Your payment for {invoice.providerName} has been received. You will receive a confirmation email shortly.
        </p>
        <Button onClick={() => navigate("/chat")} style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}>
          Return to GoStork
        </Button>
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
        <span className="font-heading font-semibold text-base" style={{ color: "hsl(var(--primary))" }}>
          GoStork
        </span>
        <span className="text-muted-foreground">|</span>
        <span className="text-sm font-medium">Secure Payment</span>
      </div>

      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">

        {/* Countdown timer for surrogacy 24h hold */}
        {invoice.dueAt && <CountdownTimer dueAt={invoice.dueAt} />}

        {/* AT_CLEARANCE explanation */}
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
            <p className="text-sm text-muted-foreground">{invoice.serviceType}</p>
            {invoice.description && <p className="text-sm text-muted-foreground mt-1">{invoice.description}</p>}
          </div>

          <div className="border-t pt-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Service Total</span>
              <span className="font-medium">{formatCents(invoice.serviceAmount, invoice.currency)}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold border-t pt-2 mt-2">
              <span>Amount Due Today</span>
              <span style={{ color: "hsl(var(--primary))" }}>{formatCents(invoice.serviceAmount, invoice.currency)}</span>
            </div>
          </div>
        </div>

        {/* GoStork Guarantee badge */}
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

        {/* Error message */}
        {errorMsg && (
          <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}>
            {errorMsg}
          </div>
        )}

        {/* Braintree Drop-in */}
        <div className="space-y-4">
          <p className="text-sm font-medium">Pay by Card</p>
          <div ref={dropinContainerRef} id="braintree-dropin-container" />

          <Button
            className="w-full"
            disabled={!dropinReady || payMutation.isPending}
            onClick={() => payMutation.mutate()}
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)", height: "48px", fontSize: "1rem" }}
          >
            {payMutation.isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing...</>
            ) : isAtClearance ? (
              `Authorize Hold - ${formatCents(invoice.serviceAmount, invoice.currency)}`
            ) : (
              `Pay Securely - ${formatCents(invoice.serviceAmount, invoice.currency)}`
            )}
          </Button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Payments are processed securely by Braintree (PayPal). GoStork never stores your card details.
        </p>
      </div>
    </div>
  );
}
