import { useState } from "react";
import { useConciergeName } from "@/hooks/use-concierge-name";
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
    resolvedAs?: "approved" | "rejected" | "superseded" | null;
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
  const conciergeName = useConciergeName();
  const { toast } = useToast();
  const data = msg.uiCardData || {};
  const d = data as any;
  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const total = typeof data.totalCostCents === "number" ? data.totalCostCents : 0;
  // Any resolvedAt that isn't an approval renders as dismissed-style:
  // "rejected" (provider clicked Reject) or "superseded" (a fresh manual
  // regenerate replaced this card).
  const status: "pending" | "approved" | "rejected" = data.resolvedAs === "approved"
    ? "approved"
    : data.resolvedAt
      ? "rejected"
      : "pending";
  // Attach the original uploaded cost-sheet document to the quote sent
  // to the parent. Default ON - provider can uncheck before approving.
  const [attachFile, setAttachFile] = useState(true);

  const approveMutation = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/sessions/${sessionId}/cost-sheet-draft/${msg.id}/approve`, {
        totalCostCents: total,
        notes: data.notes ?? undefined,
        lineItems,
        attachFile,
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
  if (typeof d.siblingSheetCount === "number" && d.siblingSheetCount > 1) {
    metadata.push({ label: "Matching programs", value: `${d.siblingSheetCount} - approve the right one(s), reject the rest` });
  }

  // Subtitle names the source program + service so the provider can tell
  // sibling drafts apart when several programs match one booking.
  const subtitleParts: string[] = [];
  if (d.programName) subtitleParts.push(d.programName);
  if (d.sourceCostSheetSubTypeLabel) subtitleParts.push(d.sourceCostSheetSubTypeLabel);
  else if (data.sourceCostSheetCategory) subtitleParts.push(data.sourceCostSheetCategory);
  const subtitle = subtitleParts.length > 0
    ? subtitleParts.join(" - ")
    : `Auto-drafted by ${conciergeName} from your cost sheet library`;

  const resolvedLabel = status === "approved"
    ? "Sent ✓"
    : data.resolvedAs === "superseded"
      ? "Superseded"
      : status === "rejected"
        ? "Dismissed"
        : undefined;

  return (
    <ApprovalCard
      title={d.programName ? `Auto-drafted: ${d.programName}` : "Auto-drafted Cost Sheet"}
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
      attachOption={
        d.fileName && d.fileUrl
          ? { fileName: d.fileName, checked: attachFile, onChange: setAttachFile }
          : undefined
      }
    />
  );
}
