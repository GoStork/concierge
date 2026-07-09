/**
 * Partner-info request card (auto_send agreements, Phase 5/6 polish).
 *
 * Posted when a fully-automated agreement needs the second parent's signer
 * details: the PARENT fills their partner's name + email (or taps "It's
 * just me") and the agreement sends itself - the provider is never pulled
 * in. Parent-facing form only; providers see the providerContent text
 * variant of the message bubble instead.
 */
import { useState } from "react";
import { Loader2, FileSignature, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export function PartnerInfoRequestCard({ data, messageId, sessionId, brandColor, viewerRole }: {
  data: any;
  messageId: string;
  sessionId: string;
  brandColor: string;
  viewerRole?: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"partner" | "single" | null>(null);
  const [resolved, setResolved] = useState<string | null>(data?.resolvedAs || null);

  if (viewerRole === "provider") return null;

  const submit = async (single: boolean) => {
    setBusy(single ? "single" : "partner");
    try {
      const res = await fetch(`/api/sessions/${sessionId}/partner-info/${messageId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(single ? { single: true } : { partnerFirstName: firstName, partnerLastName: lastName, partnerEmail: email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || "Could not send the agreement");
      setResolved(single ? "single" : "partner_added");
      toast({ title: "Agreement sent", description: "Check your email for the signature request.", variant: "success" });
      queryClient.invalidateQueries();
    } catch (e: any) {
      toast({ title: "Could not send", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  if (resolved || data?.resolvedAt) {
    return (
      <div className="rounded-[var(--radius)] border bg-secondary/40 px-4 py-3 max-w-md flex items-center gap-2 text-sm" data-testid="partner-info-resolved">
        <Check className="w-4 h-4" style={{ color: "hsl(var(--brand-success))" }} />
        {resolved === "single" || data?.resolvedAs === "single"
          ? "Sent with you as the only signer."
          : "Partner added - the agreement is on its way to both of you."}
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius)] border-2 bg-background overflow-hidden max-w-md" style={{ borderColor: brandColor }} data-testid="partner-info-request-card">
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
          <FileSignature className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{data?.documentType || "Agreement"} - partner details</p>
          <p className="text-xs text-muted-foreground">Both parents sign; add your partner or continue solo.</p>
        </div>
      </div>
      <div className="px-4 py-3 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Partner first name" value={firstName} onChange={e => setFirstName(e.target.value)} className="text-sm" data-testid="partner-first-name" />
          <Input placeholder="Partner last name" value={lastName} onChange={e => setLastName(e.target.value)} className="text-sm" data-testid="partner-last-name" />
        </div>
        <Input type="email" placeholder="Partner email" value={email} onChange={e => setEmail(e.target.value)} className="text-sm" data-testid="partner-email" />
        <div className="flex gap-2 pt-1">
          <Button size="sm" className="flex-1" disabled={!!busy || !firstName.trim() || !lastName.trim() || !email.trim()} onClick={() => submit(false)} data-testid="partner-info-send">
            {busy === "partner" ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            Add partner and send
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => submit(true)} data-testid="partner-info-single">
            {busy === "single" ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            It's just me
          </Button>
        </div>
      </div>
    </div>
  );
}
