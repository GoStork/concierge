import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Unlock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type Release = {
  id: string;
  providerId: string;
  parentAccountId: string;
  reason: "IP_FORM" | "INVOICE" | "AGREEMENT" | "CALLBACK" | "ADMIN";
  releasedAt: string;
  note: string | null;
};

/**
 * Exported so surfaces that render the release STATE (the parent record header
 * says "shared because you sent an invoice") word it the same way this panel
 * does, rather than keeping a second copy that drifts.
 */
export const REASON_LABEL: Record<Release["reason"], string> = {
  IP_FORM: "intake form submitted",
  INVOICE: "invoice sent",
  AGREEMENT: "agreement sent",
  CALLBACK: "callback requested",
  ADMIN: "unlocked by GoStork",
};

/**
 * Admin control for Gate B of the two-tier privacy model.
 *
 * The parent's email and phone stay hidden from a provider until the parent
 * does something that shares them - submits their intake form, or receives an
 * invoice or agreement. That default is deliberately tight, so this is the
 * escape hatch for the cases real coordination needs before any of that exists
 * (a nurse who has to reach a patient, a legal deadline).
 *
 * Only a MANUAL release can be revoked. A release earned by an invoice or a
 * form is a record of a fact - the provider already holds a document with the
 * address printed on it - and deleting the row would not take it back, it would
 * only make this panel lie about who has it.
 *
 * Inline expandable, never a modal (they do not translate to the native apps).
 */
export function ContactReleaseSection({
  providerId,
  parentAccountId,
  // The chat sidebar stacks this mid-rail, so it opens with its own rule.
  // Inside an already-titled section on the parent record that rule reads as a
  // stray line, and with one panel per provider org the heading has to name the
  // org. Defaults keep the monitor byte-identical.
  divider = true,
  heading = "Contact sharing",
  testId = "contact-release",
}: {
  providerId: string | null;
  divider?: boolean;
  heading?: string;
  parentAccountId: string | null;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const key = ["/api/admin/contact-releases", providerId, parentAccountId];

  const { data: releases, isLoading } = useQuery<Release[]>({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/contact-releases?providerId=${encodeURIComponent(providerId || "")}&parentAccountId=${encodeURIComponent(parentAccountId || "")}`,
        { credentials: "include" },
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!providerId && !!parentAccountId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: key });
    // The gates feed every provider-facing surface, so refresh them all.
    queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] });
  };

  const unlock = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/contact-releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ providerId, parentAccountId, note: note.trim() || null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to unlock");
      return res.json();
    },
    onSuccess: () => {
      setOpen(false);
      setNote("");
      invalidate();
      toast({ title: "Contact details unlocked", description: "This provider can now see the parent's email and phone.", variant: "success" as any });
    },
    onError: (e: any) => toast({ title: "Could not unlock", description: e?.message, variant: "destructive" }),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/contact-releases/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to revoke");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Manual unlock revoked", variant: "success" as any });
    },
    onError: (e: any) => toast({ title: "Could not revoke", description: e?.message, variant: "destructive" }),
  });

  if (!providerId || !parentAccountId) return null;
  const release = releases?.[0];

  return (
    <div className={divider ? "border-t pt-4 mt-4" : "pt-1"} data-testid={testId}>
      <h4 className="font-semibold text-sm mb-2" style={{ fontFamily: "var(--font-display)" }}>
        {heading}
      </h4>

      {isLoading ? (
        <p className="t-helper">Checking...</p>
      ) : release ? (
        <div className="flex items-start gap-2">
          <Unlock className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--brand-success))]" />
          <div className="min-w-0 flex-1">
            <p className="t-micro-value">
              Shared - {REASON_LABEL[release.reason] || release.reason}
              {release.releasedAt ? `, ${new Date(release.releasedAt).toLocaleDateString()}` : ""}
            </p>
            {release.note && <p className="t-helper mt-0.5">{release.note}</p>}
            {release.reason === "ADMIN" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 mt-1 t-helper"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(release.id)}
                data-testid={`${testId}-revoke`}
              >
                {revoke.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Revoke this unlock"}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <Lock className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
            <p className="t-micro-value flex-1">
              Hidden. Shared automatically once the parent submits their intake form, or this provider sends an
              invoice or agreement.
            </p>
          </div>
          {!open ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 h-8"
              onClick={() => setOpen(true)}
              data-testid={`${testId}-open`}
            >
              Unlock contact
            </Button>
          ) : (
            <div className="mt-2 rounded-[var(--radius)] bg-secondary p-3">
              <label className="t-helper block mb-1.5" htmlFor={`${testId}-note`}>
                Why is this being unlocked? Recorded on the parent's journey timeline.
              </label>
              <textarea
                id={`${testId}-note`}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. clinic needs to reach them about a medication timing change"
                className="w-full rounded-[var(--radius)] border border-input bg-background px-2 py-1.5 text-sm resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`${testId}-note-input`}
              />
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  className="h-8"
                  disabled={unlock.isPending}
                  onClick={() => unlock.mutate()}
                  data-testid={`${testId}-confirm`}
                >
                  {unlock.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Unlock"}
                </Button>
                <Button variant="ghost" size="sm" className="h-8" onClick={() => { setOpen(false); setNote(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
