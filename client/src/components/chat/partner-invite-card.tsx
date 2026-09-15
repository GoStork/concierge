/**
 * In-chat "add your partner" form (uiCardData.partnerInvite.form on an Eva reply).
 *
 * Eva asked "add your partner?" as its own turn; the parent said yes; this
 * card is the answer surface. It posts to the existing family-account
 * members endpoint (the partner gets a set-password link, no password is
 * typed here), then hands the conversation back by sending "Invitation sent"
 * as the parent's message so the intake resumes. Nothing leaves the chat.
 * Parent-private: Eva's own session is never shown to providers.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { apiRequest } from "@/lib/queryClient";

export function PartnerInviteCard({ brandColor, onDone }: { brandColor: string; onDone?: (text: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneE164, setPhoneE164] = useState("");
  const [phoneDisplay, setPhoneDisplay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const { data: members } = useQuery<{ id: string; name?: string | null; email?: string }[]>({
    queryKey: ["/api/parent-account/members"],
    staleTime: 30_000,
  });
  const existingPartner = Array.isArray(members) && members.length > 1 ? members[1] : null;

  if (sentTo || existingPartner) {
    const label = sentTo
      ? `Invitation sent to ${sentTo}. They'll get a link to set their password.`
      : existingPartner?.name
        ? `${existingPartner.name} is on your account.`
        : "Your partner is on your account.";
    return (
      <div className="rounded-[var(--radius)] border border-border bg-secondary/40 px-4 py-3 max-w-md flex items-center gap-2 t-helper" data-testid="partner-invite-resolved">
        <Check className="w-4 h-4 shrink-0" style={{ color: "hsl(var(--brand-success))" }} />
        {label}
      </div>
    );
  }

  const valid = name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/parent-account/members", {
        name: name.trim(),
        email: email.trim(),
        mobileNumber: phoneE164 || undefined,
        parentAccountRole: "INTENDED_PARENT_2",
      });
      setSentTo(email.trim());
      queryClient.invalidateQueries({ queryKey: ["/api/parent-account/members"] });
      onDone?.(`Invitation sent to ${name.trim()}`);
    } catch (err: any) {
      const msg = String(err?.message || "");
      setError(/email already in use/i.test(msg)
        ? "That email already has a GoStork account. Ask your partner which email they use, or try another."
        : "Could not send the invitation. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="rounded-[var(--radius)] border border-border bg-card p-4 max-w-md space-y-3" data-testid="partner-invite-card">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
          <UserPlus className="w-5 h-5" />
        </div>
        <p className="t-field-value font-medium">Your partner's details</p>
      </div>
      <div className="space-y-1">
        <label htmlFor="partner-invite-name" className="t-form-label">Full name</label>
        <Input id="partner-invite-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="e.g. Alex Rivera" data-testid="input-partner-name" />
      </div>
      <div className="space-y-1">
        <label htmlFor="partner-invite-email" className="t-form-label">Email</label>
        <Input id="partner-invite-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" placeholder="They'll get the invitation here" data-testid="input-partner-email" />
      </div>
      <div className="space-y-1">
        <label className="t-form-label">Mobile number <span className="t-helper">(optional, for a text too)</span></label>
        <PhoneInput
          value={phoneE164}
          displayValue={phoneDisplay}
          onChange={({ e164, display, isValid }) => { setPhoneE164(isValid ? e164 : ""); setPhoneDisplay(display); }}
          data-testid="input-partner-phone"
        />
      </div>
      {error && <p className="t-helper text-destructive" data-testid="text-partner-invite-error">{error}</p>}
      <p className="t-helper">They choose their own password from the link and verify their own phone when they first sign in.</p>
      <Button type="submit" size="sm" disabled={!valid || busy} data-testid="btn-partner-invite-send">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send invitation"}
      </Button>
    </form>
  );
}
