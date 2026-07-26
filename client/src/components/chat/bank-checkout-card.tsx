/**
 * Bank skip-to-checkout card (Phase 6).
 *
 * Posted by Eva ([[BANK_CHECKOUT:DONOR_ID]]) when a parent wants to buy an
 * egg/sperm BANK donor directly. Shows the donor, the bank, and the
 * published total cost, with one Buy button that hits POST /api/bank-checkout
 * - the server creates the 3-way session with the bank, posts the cost
 * sheet, fires the invoice, and we navigate the parent straight there.
 *
 * Rendered by both chat surfaces (concierge-chat-page + SpecialMessageCard)
 * - never fork this card.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ShoppingBag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatMoneyCents } from "@/lib/format-money";

export function BankCheckoutCard({ data, brandColor }: { data: any; brandColor: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const priceCents: number = data.priceCents ?? 0;
  const donorLabel: string = data.donorLabel || "this donor";
  const providerName: string = data.providerName || "the bank";

  const buy = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/bank-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ donorId: data.donorId, donorType: data.donorType, providerId: data.providerId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || "Checkout failed");
      if (body.status === "already_paid") {
        toast({ title: "Already purchased", description: `Your payment for ${donorLabel} is complete.` });
      } else if (body.status === "already_pending") {
        toast({ title: "Invoice already waiting", description: "Your invoice is in the chat - complete the payment there." });
      }
      navigate(`/chat/${body.sessionId}`);
    } catch (e: any) {
      toast({ title: "Checkout failed", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-[var(--radius)] border-2 bg-background overflow-hidden max-w-md"
      style={{ borderColor: brandColor }}
      data-testid="bank-checkout-card"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {data.photoUrl ? (
          <img src={data.photoUrl} alt={donorLabel} className="w-12 h-12 rounded-full object-cover shrink-0" />
        ) : (
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
            <ShoppingBag className="w-5 h-5" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">Donor {donorLabel}</p>
          <p className="t-helper truncate">{providerName} - ready for direct checkout</p>
        </div>
        <p className="text-base font-heading font-bold shrink-0">{formatMoneyCents(priceCents)}</p>
      </div>
      <div className="px-4 pb-3">
        <Button className="w-full" disabled={busy} onClick={buy} data-testid="bank-checkout-buy">
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShoppingBag className="w-4 h-4 mr-2" />}
          Buy Now - {formatMoneyCents(priceCents)}
        </Button>
        <p className="t-helper mt-1.5 text-center">
          Creates your order with {providerName} - cost sheet and invoice arrive in a new chat.
        </p>
      </div>
    </div>
  );
}
