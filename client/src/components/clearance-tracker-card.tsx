/**
 * In-chat clearance tracker card.
 * Rendered when uiCardType === "clearance_tracker".
 * Used for AT_CLEARANCE surrogacy flow - shows vault status and clearance actions.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Shield, CheckCircle2, XCircle, Loader2, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface ClearanceTrackerData {
  invoiceId: string;
  providerName: string;
  medicalClearanceStatus?: string | null;
  isProtected?: boolean;
  confirmAction?: string;
  failAction?: string;
}

interface ClearanceTrackerCardProps {
  data: ClearanceTrackerData;
  isParent?: boolean;
}

export function ClearanceTrackerCard({ data, isParent = true }: ClearanceTrackerCardProps) {
  const [actionTaken, setActionTaken] = useState(false);
  const [result, setResult] = useState<"cleared" | "failed" | null>(null);

  const clearanceMutation = useMutation({
    mutationFn: async (cleared: boolean) => {
      const res = await fetch("/api/billing/confirm-clearance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ invoiceId: data.invoiceId, cleared }),
      });
      if (!res.ok) throw new Error("Failed to update clearance");
      return res.json();
    },
    onSuccess: (_, cleared) => {
      setActionTaken(true);
      setResult(cleared ? "cleared" : "failed");
    },
  });

  const status = data.medicalClearanceStatus;

  return (
    <div className="rounded-xl border overflow-hidden max-w-sm" style={{ background: "hsl(var(--background))" }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-2 border-b" style={{ background: "hsl(var(--primary) / 0.05)" }}>
        <Lock className="w-4 h-4" style={{ color: "hsl(var(--primary))" }} />
        <div>
          <p className="text-xs text-muted-foreground">GoStork Secure Vault</p>
          <p className="font-semibold text-sm mt-0.5">{data.providerName}</p>
        </div>
      </div>

      <div className="px-4 py-4 space-y-3">
        {/* Vault status */}
        <div className="flex items-start gap-2 text-sm">
          <Shield className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "hsl(var(--brand-success))" }} />
          <p className="text-muted-foreground">
            Your funds are securely held by GoStork. They will only be released to {data.providerName} after medical clearance is confirmed.
          </p>
        </div>

        {/* Current clearance status */}
        {status === "PENDING" && !actionTaken && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "hsl(var(--brand-warning) / 0.1)", color: "hsl(var(--brand-warning))" }}>
            Medical clearance pending - we'll check in with you as the screening progresses
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
            <span>Clearance failed - your hold has been released. GoStork Guarantee is active.</span>
          </div>
        )}

        {/* Parent actions - only when status is PENDING and no action taken */}
        {isParent && status === "PENDING" && !actionTaken && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-muted-foreground font-medium">Has the surrogate passed medical screening?</p>
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
          </div>
        )}
      </div>
    </div>
  );
}
