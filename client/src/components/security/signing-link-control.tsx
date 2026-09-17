/**
 * Live / expired / switched-off state of a login-free signing link, with the
 * matching action. One component for both the agreement table and the W-9
 * table - the two flows had already been forked once before and re-discovered
 * the same bugs, so this stays shared.
 *
 * Why this exists: those links open an executed contract, or a tax form
 * carrying an EIN or SSN, with no login. They used to be valid forever with no
 * way to switch one off. Expiry is the backstop; this is the control for "that
 * went to the wrong person".
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Link2, Link2Off } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export interface SigningLinkState {
  hasGuestLink?: boolean;
  guestLinkRevokedAt?: string | null;
  guestLinkExpiresAt?: string | null;
}

interface Props extends SigningLinkState {
  /** Endpoint prefix, e.g. "/api/admin/provider-agreements/<id>" or
   *  "/api/admin/providers/<providerId>/w9". */
  basePath: string;
  /** Query keys to refresh after the change. */
  invalidateKeys: string[];
  testIdSuffix: string;
}

export function SigningLinkControl({
  hasGuestLink,
  guestLinkRevokedAt,
  guestLinkExpiresAt,
  basePath,
  invalidateKeys,
  testIdSuffix,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const act = useMutation({
    mutationFn: async (what: "revoke" | "restore") =>
      (await apiRequest("POST", `${basePath}/${what}-link`, {})).json(),
    onSuccess: (_d, what) => {
      setConfirming(false);
      invalidateKeys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast({
        title: what === "revoke" ? "Signing link switched off" : "Signing link back in service",
        description:
          what === "revoke"
            ? "Anyone holding that link now sees the same message as an invalid one. Re-sending mints a fresh link."
            : "The link works again for the next 30 days.",
      });
    },
    onError: (e: any) => toast({ title: "Could not change the link", description: e.message, variant: "destructive" }),
  });

  if (!hasGuestLink) {
    return <span className="t-helper" data-testid={`text-no-link-${testIdSuffix}`}>No link sent</span>;
  }

  const revoked = !!guestLinkRevokedAt;
  const expired = !revoked && !!guestLinkExpiresAt && new Date(guestLinkExpiresAt).getTime() < Date.now();
  const tone = revoked
    ? { background: "hsl(var(--destructive) / 0.12)", color: "hsl(var(--destructive))" }
    : expired
      ? { background: "hsl(var(--brand-warning) / 0.15)", color: "hsl(var(--brand-warning))" }
      : { background: "hsl(var(--brand-success) / 0.15)", color: "hsl(var(--brand-success))" };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className="inline-flex items-center gap-1 text-xs font-ui px-2 py-0.5 rounded-full whitespace-nowrap"
        style={tone}
        data-testid={`badge-link-${testIdSuffix}`}
      >
        {revoked ? <Link2Off className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
        {revoked ? "Switched off" : expired ? "Expired" : "Live"}
      </span>

      {!revoked && guestLinkExpiresAt && !expired && (
        <span className="t-helper whitespace-nowrap">
          until {new Date(guestLinkExpiresAt).toLocaleDateString()}
        </span>
      )}

      {revoked || expired ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => act.mutate("restore")}
          disabled={act.isPending}
          data-testid={`button-restore-link-${testIdSuffix}`}
        >
          {act.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
          Reactivate
        </Button>
      ) : confirming ? (
        <span className="flex items-center gap-1">
          <Button
            size="sm"
            variant="destructive"
            onClick={() => act.mutate("revoke")}
            disabled={act.isPending}
            data-testid={`button-confirm-revoke-${testIdSuffix}`}
          >
            {act.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Switch it off
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(true)}
          data-testid={`button-revoke-link-${testIdSuffix}`}
        >
          Switch off link
        </Button>
      )}
    </div>
  );
}
