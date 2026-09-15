/**
 * "Add your partner" card (uiCardData.partnerInvite on an Eva reply).
 *
 * Attached by the server, once per lifetime Eva session, to the reply in which
 * the parent said they are on this journey as a couple. Sends them to the
 * existing Invite Member page (full page, no modal) and resolves itself once
 * the account has a second member. "Not now" is a per-device dismissal.
 * Parent-private: Eva's own session is never shown to providers.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

const DISMISS_PREFIX = "gostork:partner-invite-dismissed:";

export function PartnerInviteCard({ messageId, brandColor }: { messageId?: string; brandColor: string }) {
  const navigate = useNavigate();
  const key = `${DISMISS_PREFIX}${messageId || "unknown"}`;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try { setDismissed(localStorage.getItem(key) === "1"); } catch { /* storage unavailable */ }
  }, [key]);

  const { data: members } = useQuery<{ id: string; name?: string | null }[]>({
    queryKey: ["/api/parent-account/members"],
    staleTime: 30_000,
  });
  const partnerAdded = Array.isArray(members) && members.length > 1;

  if (dismissed && !partnerAdded) return null;

  if (partnerAdded) {
    const partner = members!.find((m, i) => i > 0);
    return (
      <div className="rounded-[var(--radius)] border border-border bg-secondary/40 px-4 py-3 max-w-md flex items-center gap-2 t-helper" data-testid="partner-invite-resolved">
        <Check className="w-4 h-4 shrink-0" style={{ color: "hsl(var(--brand-success))" }} />
        {partner?.name ? `${partner.name} is on your account.` : "Your partner is on your account."}
      </div>
    );
  }

  const dismiss = () => {
    try { localStorage.setItem(key, "1"); } catch { /* noop */ }
    setDismissed(true);
  };

  return (
    <div
      className="rounded-[var(--radius)] border border-border bg-card p-4 max-w-md flex items-start gap-3"
      data-testid="partner-invite-card"
    >
      <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
        <UserPlus className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="t-field-value font-medium">Building this together?</p>
        <p className="t-helper mt-1">
          Add your partner to your account and you will both see the same conversations, Match Calls and documents. They get their own login.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          <Button size="sm" onClick={() => navigate("/users/new?parentAccount=true")} data-testid="btn-partner-invite">
            Add my partner
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss} data-testid="btn-partner-invite-dismiss">
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}
