import { useMutation } from "@tanstack/react-query";
import { useConciergeName } from "@/hooks/use-concierge-name";
import { FileText } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatMoneyCents } from "@/lib/format-money";
import { ApprovalCard, type ApprovalCardLineItem } from "./approval-card";

// Phase 3 invoice draft approval card. Posted in the provider chat when the
// parent clicks "Yes, I'm ready" on the readiness card and the provider has
// invoice auto-draft enabled. Parents never see this (hidden by the
// ai-router allowlist + the preview notIn filters).

export interface InvoiceDraftLineItem {
  serviceType: string;
  serviceTypeLabel?: string;
  description?: string | null;
  amountCents: number;
}

interface DraftMsg {
  id: string;
  uiCardData?: {
    parentName?: string;
    lineItems?: InvoiceDraftLineItem[];
    totalCents?: number;
    referralFeeAmountCents?: number;
    providerPayoutAmountCents?: number;
    quotedTotalCostCents?: number | null;
    description?: string | null;
    resolvedAt?: string | null;
    resolvedAs?: "approved" | "rejected" | "superseded" | null;
    resultingInvoiceId?: string | null;
  };
}

export function InvoiceDraftApprovalCard({
  msg,
  sessionId,
  onEdit,
}: {
  msg: DraftMsg;
  sessionId: string;
  // Opens the invoice compose panel pre-filled; sending from it supersedes
  // this draft server-side (createInvoice flips pending drafts).
  onEdit?: (initial: { lineItems: InvoiceDraftLineItem[]; description: string | null }) => void;
}) {
  const conciergeName = useConciergeName();
  const { toast } = useToast();
  const data = msg.uiCardData || {};
  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const total = typeof data.totalCents === "number" ? data.totalCents : 0;
  const status: "pending" | "approved" | "rejected" = data.resolvedAs === "approved"
    ? "approved"
    : data.resolvedAt
      ? "rejected"
      : "pending";

  const approveMutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/sessions/${sessionId}/invoice-draft/${msg.id}/approve`, {}),
    onSuccess: () => {
      toast({ title: "Invoice sent", description: "The parent has been notified by email + SMS with a secure payment link." });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to send invoice", description: err?.message || "Try again or contact support.", variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/sessions/${sessionId}/invoice-draft/${msg.id}/reject`, {}),
    onSuccess: () => {
      toast({ title: "Draft dismissed", description: "Send an invoice manually when you're ready." });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    },
    onError: (err: any) => {
      toast({ title: "Failed to dismiss", description: err?.message || "Try again.", variant: "destructive" });
    },
  });

  const cardLineItems: ApprovalCardLineItem[] = lineItems.map(li => ({
    label: li.description || li.serviceTypeLabel || li.serviceType,
    amountCents: li.amountCents,
  }));

  const metadata: Array<{ label: string; value: string }> = [];
  if (typeof data.referralFeeAmountCents === "number") {
    metadata.push({ label: "GoStork fee", value: formatMoneyCents(data.referralFeeAmountCents) });
  }
  if (typeof data.providerPayoutAmountCents === "number") {
    metadata.push({ label: "You receive", value: formatMoneyCents(data.providerPayoutAmountCents) });
  }
  if (typeof data.quotedTotalCostCents === "number" && data.quotedTotalCostCents > 0) {
    metadata.push({ label: "Quoted journey total", value: formatMoneyCents(data.quotedTotalCostCents) });
  }

  const resolvedLabel = status === "approved"
    ? "Sent ✓"
    : data.resolvedAs === "superseded"
      ? "Superseded"
      : status === "rejected"
        ? "Dismissed"
        : undefined;

  return (
    <ApprovalCard
      title={data.parentName ? `Auto-drafted invoice for ${data.parentName}` : "Auto-drafted Invoice"}
      subtitle={`Drafted by ${conciergeName} when the parent confirmed they're ready to move forward`}
      icon={<FileText className="h-4 w-4" />}
      amountCents={total}
      lineItems={cardLineItems}
      notes={data.description ?? null}
      metadata={metadata}
      status={status}
      resolvedLabel={resolvedLabel}
      onApprove={status === "pending" ? () => approveMutation.mutate() : undefined}
      onEdit={
        status === "pending" && onEdit
          ? () => onEdit({ lineItems, description: data.description ?? null })
          : undefined
      }
      onReject={status === "pending" ? () => rejectMutation.mutate() : undefined}
      isSubmitting={approveMutation.isPending || rejectMutation.isPending}
      testId={`invoice-draft-${msg.id}`}
    />
  );
}
