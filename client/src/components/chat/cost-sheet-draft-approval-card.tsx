import { useMutation } from "@tanstack/react-query";
import { Receipt } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ApprovalCard, type ApprovalCardLineItem } from "./approval-card";

// Phase 2 cost-sheet draft approval card. Renders inline in the provider
// chat. Parents never see this (filtered by chat-router notIn + the
// ai-router allowedSystemCardTypes allowlist).

interface DraftMsg {
  id: string;
  uiCardData?: {
    sourceCostSheetId?: string;
    sourceCostSheetCategory?: string | null;
    lineItems?: ApprovalCardLineItem[];
    totalCostCents?: number;
    notes?: string | null;
    matchedRuleCount?: number;
    candidates?: Array<{ costSheetId: string; category: string | null; matchedRuleCount: number }>;
    autoDraftedAt?: string;
    resolvedAt?: string | null;
    resolvedAs?: "approved" | "rejected" | null;
    rejectionReason?: string | null;
    resultingQuoteId?: string | null;
  };
}

export interface CostSheetDraftApprovalCardProps {
  msg: DraftMsg;
  sessionId: string;
  // When the user clicks Edit, parent screens may want to open the existing
  // cost-sheet sidebar form pre-filled with these line items. We delegate
  // this via a callback so the conversations page owns the panel state.
  onEdit?: (initial: { lineItems: ApprovalCardLineItem[]; totalCostCents: number; notes: string | null }) => void;
}

export function CostSheetDraftApprovalCard({ msg, sessionId, onEdit }: CostSheetDraftApprovalCardProps) {
  const { toast } = useToast();
  const data = msg.uiCardData || {};
  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const total = typeof data.totalCostCents === "number" ? data.totalCostCents : 0;
  const status: "pending" | "approved" | "rejected" = data.resolvedAs === "approved"
    ? "approved"
    : data.resolvedAs === "rejected"
      ? "rejected"
      : "pending";

  const approveMutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/sessions/${sessionId}/cost-sheet-draft/${msg.id}/approve`, {
        totalCostCents: total,
        notes: data.notes ?? undefined,
        lineItems,
      }),
    onSuccess: () => {
      toast({ title: "Cost sheet sent", description: "The parent has been notified by email + SMS." });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to send", description: err?.message || "Try again or contact support.", variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/sessions/${sessionId}/cost-sheet-draft/${msg.id}/reject`, {}),
    onSuccess: () => {
      toast({ title: "Draft dismissed", description: "Send manually when you're ready." });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to dismiss", description: err?.message || "Try again.", variant: "destructive" });
    },
  });

  const isSubmitting = approveMutation.isPending || rejectMutation.isPending;

  const metadata = [] as Array<{ label: string; value: string }>;
  if (typeof data.matchedRuleCount === "number") {
    metadata.push({ label: "Matched rules", value: String(data.matchedRuleCount) });
  }
  if (Array.isArray(data.candidates) && data.candidates.length > 1) {
    metadata.push({ label: "Other candidates", value: String(data.candidates.length - 1) });
  }

  const subtitle = data.sourceCostSheetCategory
    ? `Auto-picked from: ${data.sourceCostSheetCategory}`
    : "Auto-drafted by Eva from your cost sheet library";

  const resolvedLabel = status === "approved" ? "Sent ✓" : status === "rejected" ? "Dismissed" : undefined;

  return (
    <ApprovalCard
      title="Auto-drafted Cost Sheet"
      subtitle={subtitle}
      icon={<Receipt className="h-4 w-4" />}
      amountCents={total}
      lineItems={lineItems}
      notes={data.notes ?? null}
      metadata={metadata}
      status={status}
      resolvedLabel={resolvedLabel}
      onApprove={status === "pending" ? () => approveMutation.mutate() : undefined}
      onEdit={
        status === "pending" && onEdit
          ? () =>
              onEdit({
                lineItems,
                totalCostCents: total,
                notes: data.notes ?? null,
              })
          : undefined
      }
      onReject={status === "pending" ? () => rejectMutation.mutate() : undefined}
      isSubmitting={isSubmitting}
      testId={`cost-sheet-draft-${msg.id}`}
    />
  );
}
