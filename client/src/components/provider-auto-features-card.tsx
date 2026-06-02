import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

// Phase 2: per-provider automation feature flags. GoStork-admin-only.
// Toggle fires PATCH /api/providers/:id/auto-features. Phase 3 + 4
// flags render as disabled placeholders so admins can see what's coming.

interface AutoFeaturesShape {
  autoCostSheetDraft?: boolean;
  autoInvoiceDraft?: boolean;
  autoAgreementDraft?: boolean;
}

export function ProviderAutoFeaturesCard({
  providerId,
  initial,
}: {
  providerId: string;
  initial: AutoFeaturesShape | null | undefined;
}) {
  const flags: AutoFeaturesShape = initial || {};
  const [autoCostSheetDraft, setAutoCostSheetDraft] = useState<boolean>(flags.autoCostSheetDraft === true);
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (next: boolean) => {
      return apiRequest("PATCH", `/api/providers/${providerId}/auto-features`, {
        autoCostSheetDraft: next,
      });
    },
    onSuccess: () => {
      toast({ title: "Automation flags saved" });
    },
    onError: (err: any) => {
      setAutoCostSheetDraft(prev => !prev);
      toast({
        title: "Failed to save",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
    },
  });

  const handleToggle = (next: boolean) => {
    setAutoCostSheetDraft(next);
    mutation.mutate(next);
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
        <div className="flex items-center justify-between border-t border-border pt-3">
          <div className="pr-4">
            <p className="text-sm">Auto cost-sheet draft on booking</p>
            <p className="text-xs text-muted-foreground">
              Eva drafts a cost sheet when a parent books a consult. Provider approves before send.
            </p>
          </div>
          <Switch
            checked={autoCostSheetDraft}
            onCheckedChange={handleToggle}
            data-testid="switch-auto-cost-sheet-draft"
          />
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <div className="pr-4 opacity-60">
            <p className="text-sm">Auto invoice draft on parent-ready</p>
            <p className="text-xs text-muted-foreground">Phase 3 - coming soon.</p>
          </div>
          <Switch
            checked={false}
            disabled
            onCheckedChange={() => {}}
            data-testid="switch-auto-invoice-draft-placeholder"
            aria-label="Auto invoice draft (coming in Phase 3)"
          />
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <div className="pr-4 opacity-60">
            <p className="text-sm">Auto agreement draft on invoice-paid</p>
            <p className="text-xs text-muted-foreground">Phase 4 - coming soon.</p>
          </div>
          <Switch
            checked={false}
            disabled
            onCheckedChange={() => {}}
            data-testid="switch-auto-agreement-draft-placeholder"
            aria-label="Auto agreement draft (coming in Phase 4)"
          />
        </div>
      </div>
    </Card>
  );
}
