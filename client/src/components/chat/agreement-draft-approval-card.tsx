import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileSignature, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ApprovalCard } from "./approval-card";

// Phase 5 agreement draft approval card. Posted in the provider chat when the
// deposit invoice flips to PAID and the provider's automation mode is
// "approval". Parents never see this (system-card allowlist). Approve runs the
// same engine as the manual + menu Agreement panel; when the template needs a
// second signer the partner form appears inline (same UX as the panel).

interface DraftMsg {
  id: string;
  uiCardData?: {
    parentName?: string;
    serviceType?: string | null;
    documentType?: string;
    autoDraftedAt?: string;
    resolvedAt?: string | null;
    resolvedAs?: "approved" | "rejected" | null;
    resultingAgreementId?: string | null;
  };
}

export function AgreementDraftApprovalCard({
  msg,
  sessionId,
}: {
  msg: DraftMsg;
  sessionId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const data = msg.uiCardData || {};
  const docTitle = data.documentType || "Agreement";
  const status: "pending" | "approved" | "rejected" = data.resolvedAs === "approved"
    ? "approved"
    : data.resolvedAt
      ? "rejected"
      : "pending";

  const [partnerRequired, setPartnerRequired] = useState<{
    parent1: { firstName: string; lastName: string; email: string };
  } | null>(null);
  const [partnerFields, setPartnerFields] = useState({ firstName: "", lastName: "", email: "" });
  const [partnerFieldError, setPartnerFieldError] = useState<string | null>(null);
  const [skipPartner, setSkipPartner] = useState(false);
  const partnerFormRef = useRef<HTMLDivElement>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions", sessionId] });
    queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
  };

  const approveMutation = useMutation({
    mutationFn: async (args: { skipPartner?: boolean; partnerOverride?: { firstName: string; lastName: string; email: string } }) => {
      const res = await fetch(`/api/sessions/${sessionId}/agreement-draft/${msg.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(args),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.code === "PARTNER_INFO_REQUIRED") {
        setPartnerRequired({ parent1: body.parent1 });
        setTimeout(() => partnerFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
        return { signal: "PARTNER_INFO_REQUIRED" };
      }
      if (!res.ok) throw new Error(body?.message || "Failed to send agreement");
      return body;
    },
    onSuccess: (body: any) => {
      if (body?.signal === "PARTNER_INFO_REQUIRED") return;
      setPartnerRequired(null);
      toast({ title: "Agreement sent", description: "The first signer has been emailed their signing link." });
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Failed to send agreement", description: err?.message || "Try again or contact support.", variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}/agreement-draft/${msg.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to dismiss");
      return true;
    },
    onSuccess: () => {
      toast({ title: "Draft dismissed", description: "Send the agreement manually from the + menu when you're ready." });
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Failed to dismiss", description: err?.message || "Try again.", variant: "destructive" });
    },
  });

  const isMissingTemplate = /not uploaded an agreement template|assign signature fields/i.test(
    (approveMutation.error as Error | null)?.message || "",
  );

  return (
    <div className="space-y-2">
      <ApprovalCard
        title={data.parentName ? `${docTitle} for ${data.parentName}` : `Auto-drafted ${docTitle}`}
        subtitle="Drafted by Eva when the deposit payment cleared - approve to send it for signature"
        icon={<FileSignature className="h-4 w-4" />}
        status={status}
        resolvedLabel={status === "approved" ? "Sent for signature ✓" : status === "rejected" ? "Dismissed" : undefined}
        onApprove={status === "pending" && !partnerRequired ? () => approveMutation.mutate({}) : undefined}
        onReject={status === "pending" && !partnerRequired ? () => rejectMutation.mutate() : undefined}
        isSubmitting={approveMutation.isPending || rejectMutation.isPending}
        testId={`agreement-draft-${msg.id}`}
      />

      {isMissingTemplate && (
        <p className="text-xs text-destructive max-w-2xl">
          {(approveMutation.error as Error)?.message}{" "}
          <Link
            to="/account/documents"
            className="underline underline-offset-2 font-semibold hover:opacity-80"
            style={{ color: "hsl(var(--primary))" }}
          >
            Configure it in your Documents settings
          </Link>
          .
        </p>
      )}

      {status === "pending" && partnerRequired && (
        <div ref={partnerFormRef} className="max-w-2xl space-y-3 p-3 rounded-[var(--radius)] border bg-secondary/40">
          <p className="text-xs font-medium">Second Signer Required</p>
          <p className="t-helper">
            This agreement requires 2 signers. We have {partnerRequired.parent1.firstName}'s information - add the second signer's details, or send to {partnerRequired.parent1.firstName} only.
          </p>
          <div className="text-xs border rounded-[var(--radius)] p-2 bg-background">
            <span className="font-medium text-muted-foreground">Signer 1:</span>{" "}
            {partnerRequired.parent1.firstName} {partnerRequired.parent1.lastName} ({partnerRequired.parent1.email})
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={skipPartner}
              onChange={e => {
                setSkipPartner(e.target.checked);
                if (e.target.checked) setPartnerFieldError(null);
              }}
              className="rounded border-input accent-primary w-3.5 h-3.5"
            />
            <span className="t-helper">Send to {partnerRequired.parent1.firstName} only - skip partner</span>
          </label>
          {!skipPartner && (
            <div className="space-y-2">
              <p className="text-xs font-medium">Signer 2:</p>
              <div className="flex gap-1.5">
                <Input
                  placeholder="First name"
                  value={partnerFields.firstName}
                  onChange={e => setPartnerFields(f => ({ ...f, firstName: e.target.value }))}
                  className="text-xs h-7"
                />
                <Input
                  placeholder="Last name"
                  value={partnerFields.lastName}
                  onChange={e => setPartnerFields(f => ({ ...f, lastName: e.target.value }))}
                  className="text-xs h-7"
                />
              </div>
              <Input
                placeholder="Email address"
                type="email"
                value={partnerFields.email}
                onChange={e => setPartnerFields(f => ({ ...f, email: e.target.value }))}
                className="text-xs h-7"
              />
            </div>
          )}
          {partnerFieldError && <p className="text-xs text-destructive">{partnerFieldError}</p>}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs h-7"
              onClick={() => {
                setPartnerRequired(null);
                setPartnerFieldError(null);
                setSkipPartner(false);
                approveMutation.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="flex-1 text-xs h-7"
              disabled={approveMutation.isPending}
              onClick={() => {
                if (skipPartner) {
                  setPartnerFieldError(null);
                  approveMutation.mutate({ skipPartner: true });
                  return;
                }
                if (!partnerFields.firstName.trim() || !partnerFields.lastName.trim() || !partnerFields.email.trim()) {
                  setPartnerFieldError("All fields are required.");
                  return;
                }
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(partnerFields.email)) {
                  setPartnerFieldError("Please enter a valid email address.");
                  return;
                }
                setPartnerFieldError(null);
                approveMutation.mutate({
                  partnerOverride: {
                    firstName: partnerFields.firstName.trim(),
                    lastName: partnerFields.lastName.trim(),
                    email: partnerFields.email.trim(),
                  },
                });
              }}
            >
              {approveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Send Agreement
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
