import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

// Per-provider automation feature flags. GoStork-admin-only.
// Toggle fires PATCH /api/providers/:id/auto-features. All three phases are
// live: cost-sheet draft (Phase 2), invoice draft (Phase 3), agreement draft
// (Phase 5 - note the provider's own Settings > Documents automation setting
// overrides this rollout toggle).

interface AutoFeaturesShape {
  autoCostSheetDraft?: boolean;
  autoInvoiceDraft?: boolean;
  autoAgreementDraft?: boolean;
}

const FLAG_DEFS: Array<{ key: keyof AutoFeaturesShape; label: string; description: string; testId: string }> = [
  {
    key: "autoCostSheetDraft",
    label: "Auto cost-sheet draft on booking",
    description: "Eva drafts a cost sheet when a parent books a consult. Provider approves before send.",
    testId: "switch-auto-cost-sheet-draft",
  },
  {
    key: "autoInvoiceDraft",
    label: "Auto invoice draft on parent-ready",
    description: "Eva drafts the invoice when the parent confirms they're ready. Provider approves before send.",
    testId: "switch-auto-invoice-draft",
  },
  {
    key: "autoAgreementDraft",
    label: "Auto agreement draft on invoice-paid",
    description: "Eva drafts the agreement when the deposit invoice is paid. The provider's own Documents setting can override this (off / approval / fully automated).",
    testId: "switch-auto-agreement-draft",
  },
];

export function ProviderAutoFeaturesCard({
  providerId,
  initial,
}: {
  providerId: string;
  initial: AutoFeaturesShape | null | undefined;
}) {
  const init: AutoFeaturesShape = initial || {};
  const [flags, setFlags] = useState<AutoFeaturesShape>({
    autoCostSheetDraft: init.autoCostSheetDraft === true,
    autoInvoiceDraft: init.autoInvoiceDraft === true,
    autoAgreementDraft: init.autoAgreementDraft === true,
  });
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (patch: Partial<AutoFeaturesShape>) => {
      return apiRequest("PATCH", `/api/providers/${providerId}/auto-features`, patch);
    },
    onSuccess: () => {
      toast({ title: "Automation flags saved" });
    },
    onError: (err: any, patch) => {
      // Roll back the optimistic flip
      const key = Object.keys(patch)[0] as keyof AutoFeaturesShape;
      setFlags(prev => ({ ...prev, [key]: !prev[key] }));
      toast({
        title: "Failed to save",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
    },
  });

  const handleToggle = (key: keyof AutoFeaturesShape, next: boolean) => {
    setFlags(prev => ({ ...prev, [key]: next }));
    mutation.mutate({ [key]: next });
  };

  return (
    <Card className="p-4 bg-secondary/30 border-border">
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium" style={{ fontFamily: "var(--font-display)" }}>
            Automation
          </p>
          <p className="text-xs text-muted-foreground">
            GoStork-only controls. Flip per provider to roll out automations safely.
          </p>
        </div>
        {FLAG_DEFS.map(def => (
          <div key={def.key} className="flex items-center justify-between border-t border-border pt-3">
            <div className="pr-4">
              <p className="text-sm">{def.label}</p>
              <p className="text-xs text-muted-foreground">{def.description}</p>
            </div>
            <Switch
              checked={flags[def.key] === true}
              onCheckedChange={(v) => handleToggle(def.key, v)}
              data-testid={def.testId}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}
