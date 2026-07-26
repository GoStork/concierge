/**
 * In-chat clearance tracker card.
 * Rendered when uiCardType === "clearance_tracker".
 * Used for AT_CLEARANCE surrogacy flow - shows vault status and clearance actions.
 *
 * Shown to BOTH sides of the shared session: the parent sees "your funds",
 * the agency sees "{parent}'s funds". Either side can resolve the screening
 * outcome - the endpoint verifies the caller belongs to this escrow.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Shield, CheckCircle2, XCircle, Loader2, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface ClearanceTrackerData {
  invoiceId: string;
  providerName: string;
  parentName?: string | null;
  medicalClearanceStatus?: string | null;
  isProtected?: boolean;
  confirmAction?: string;
  failAction?: string;
  resolvedAt?: string | null;
  /** How the escrow resolved: "voided" (hold canceled) or "refunded"
   *  (vault funds returned) on failure; "captured"/"released" on success. */
  resolution?: string | null;
}

interface ClearanceTrackerCardProps {
  data: ClearanceTrackerData;
  isParent?: boolean;
}

export function ClearanceTrackerCard({ data, isParent = true }: ClearanceTrackerCardProps) {
  const queryClient = useQueryClient();
  const [actionTaken, setActionTaken] = useState(false);
  const [result, setResult] = useState<"cleared" | "failed" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const clearanceMutation = useMutation({
    mutationFn: async (cleared: boolean) => {
      const res = await fetch("/api/billing/confirm-clearance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ invoiceId: data.invoiceId, cleared }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || "Failed to update clearance");
      }
      return res.json();
    },
    onSuccess: (_, cleared) => {
      setActionTaken(true);
      setActionError(null);
      setResult(cleared ? "cleared" : "failed");
      // The action reshapes the whole session (invoice PAID/voided, new
      // system messages, surrogate status) - refetch everything active.
      queryClient.invalidateQueries();
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const status = data.medicalClearanceStatus;
  const parentLabel = data.parentName || "The parent";

  return (
    <div className="rounded-xl border overflow-hidden max-w-sm" style={{ background: "hsl(var(--background))" }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-2 border-b" style={{ background: "hsl(var(--primary) / 0.05)" }}>
        <Lock className="w-4 h-4" style={{ color: "hsl(var(--primary))" }} />
        <div>
          <p className="t-helper">GoStork Secure Vault</p>
          <p className="font-semibold text-sm mt-0.5">{data.providerName}</p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-3">
        {/* Vault status */}
        <div className="flex items-start gap-2 text-sm">
          <Shield className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "hsl(var(--brand-success))" }} />
          <p className="text-muted-foreground">
            {isParent
              ? `Your funds are securely held by GoStork. They will only be released to ${data.providerName} after medical clearance is confirmed.`
              : `${parentLabel}'s funds are securely held by GoStork. They will be released to you after medical clearance is confirmed.`}
          </p>
        </div>

        {/* Current clearance status */}
        {status === "PENDING" && !actionTaken && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "hsl(var(--brand-warning) / 0.1)", color: "hsl(var(--brand-warning))" }}>
            Medical clearance pending - we'll check in as the screening progresses
          </div>
        )}

        {(status === "CLEARED" || result === "cleared") && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4" />
            <span>Medical clearance confirmed - payment captured</span>
          </div>
        )}

        {(status === "FAILED" || result === "failed") && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "hsl(var(--brand-error))" }}>
            <XCircle className="w-4 h-4" />
            <span>
              {data.resolution === "refunded"
                ? (isParent
                    ? "Clearance failed - your full refund is on its way (5-10 business days). GoStork Guarantee is active."
                    : `Clearance failed - ${parentLabel}'s vaulted deposit has been fully refunded. No funds were released.`)
                : (isParent
                    ? "Clearance failed - your hold has been released. GoStork Guarantee is active."
                    : `Clearance failed - ${parentLabel}'s hold has been released. No funds changed hands.`)}
            </span>
          </div>
        )}

        {/* Resolution actions - either side of the escrow can answer */}
        {status === "PENDING" && !actionTaken && (
          <div className="space-y-2 pt-1">
            <p className="t-helper">Has the surrogate passed medical screening?</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                disabled={clearanceMutation.isPending}
                onClick={() => clearanceMutation.mutate(true)}
                style={{ background: "hsl(var(--brand-success))", color: "#fff", borderRadius: "var(--radius)" }}
              >
                {clearanceMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                Yes, Cleared
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={clearanceMutation.isPending}
                onClick={() => clearanceMutation.mutate(false)}
              >
                <XCircle className="w-3 h-3 mr-1" />
                Failed
              </Button>
            </div>
            {actionError && (
              <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{actionError}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
