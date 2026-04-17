import { useState, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText, Loader2 } from "lucide-react";
import type { SessionAgreement } from "./chat-types";

interface AgreementSidebarSectionProps {
  agreement: SessionAgreement | undefined;
  brandColor: string;
  /** The session ID used when generating the agreement. Required when readOnly=false. */
  sessionId: string | null;
  /** Parent's relationship status (used for "skip partner" checkbox). */
  relationshipStatus?: string | null;
  /**
   * When true: button is rendered but disabled, partner form is hidden.
   * Use for admin/GoStork view where only the provider can generate agreements.
   */
  readOnly?: boolean;
  /**
   * Query key prefix used to invalidate session detail after a successful generation.
   * e.g. "/api/provider/concierge-sessions" or "/api/admin/concierge-sessions"
   */
  sessionQueryKey?: string;
}

export function AgreementSidebarSection({
  agreement,
  brandColor,
  sessionId,
  relationshipStatus,
  readOnly = false,
  sessionQueryKey,
}: AgreementSidebarSectionProps) {
  const queryClient = useQueryClient();

  const [partnerRequired, setPartnerRequired] = useState<{
    parent1: { firstName: string; lastName: string; email: string };
    parentRoles: any[];
  } | null>(null);
  const [partnerFields, setPartnerFields] = useState({ firstName: "", lastName: "", email: "" });
  const [partnerFieldError, setPartnerFieldError] = useState<string | null>(null);
  const [skipPartner, setSkipPartner] = useState(false);
  const partnerFormRef = useRef<HTMLDivElement>(null);

  // Poll PandaDoc for signature status every 30s when the agreement is SENT
  const sentAgreementId = agreement?.status === "SENT" ? agreement.id : null;
  useQuery({
    queryKey: ["/api/agreements/sync-status", sentAgreementId],
    queryFn: async () => {
      const res = await fetch(`/api/agreements/${sentAgreementId}/sync-status`, { method: "POST", credentials: "include" });
      if (res.ok && sessionQueryKey && sessionId) {
        queryClient.invalidateQueries({ queryKey: [sessionQueryKey, sessionId] });
      }
      return res.ok ? res.json() : null;
    },
    enabled: !readOnly && !!sentAgreementId,
    refetchInterval: 30000,
    staleTime: 25000,
  });

  const generateAgreementMutation = useMutation({
    mutationFn: async (args: { sessionId: string; skipPartner?: boolean; partnerOverride?: { firstName: string; lastName: string; email: string } }) => {
      const res = await fetch("/api/agreements/generate-from-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "PARTNER_INFO_REQUIRED") {
        setPartnerRequired({ parent1: data.parent1, parentRoles: data.parentRoles });
        setTimeout(() => partnerFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
        return { signal: "PARTNER_INFO_REQUIRED" };
      }
      if (!res.ok) throw new Error(data.message || "Failed to generate agreement");
      if (sessionQueryKey && args.sessionId) {
        queryClient.invalidateQueries({ queryKey: [sessionQueryKey, args.sessionId] });
      }
      return data;
    },
    onSuccess: (data) => {
      if (data?.signal !== "PARTNER_INFO_REQUIRED") {
        setPartnerRequired(null);
        setPartnerFields({ firstName: "", lastName: "", email: "" });
        setPartnerFieldError(null);
        setSkipPartner(false);
      }
    },
  });

  const agr = agreement;
  const signers = Object.entries((agr?.signerStatus ?? {}) as Record<string, any>);
  const isSingle = signers.length <= 1;
  const sorted = [...signers].sort(([, a], [, b]) => (a.signingOrder ?? 999) - (b.signingOrder ?? 999));

  return (
    <div className="border-t pt-4 mt-4" data-testid="agreement-section">
      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Agreement</h4>

      <Button
        size="sm"
        className="w-full gap-1.5 text-xs"
        style={readOnly ? undefined : { backgroundColor: brandColor }}
        onClick={() => {
          if (readOnly || !sessionId || partnerRequired) return;
          setPartnerFields({ firstName: "", lastName: "", email: "" });
          setPartnerFieldError(null);
          setSkipPartner(false);
          generateAgreementMutation.reset();
          generateAgreementMutation.mutate({ sessionId });
        }}
        disabled={readOnly || generateAgreementMutation.isPending || !!partnerRequired}
        data-testid="btn-generate-agreement"
        variant={readOnly ? "outline" : "default"}
      >
        {generateAgreementMutation.isPending && !partnerRequired
          ? <Loader2 className="w-3 h-3 animate-spin" />
          : <FileText className="w-3 h-3" />
        }
        Generate &amp; Send Agreement
      </Button>

      {/* Partner info form - shown when template has 2 parent roles but no 2nd member */}
      {!readOnly && partnerRequired && (
        <div ref={partnerFormRef} className="mt-3 space-y-3 p-3 rounded-[var(--radius)] border bg-muted/40">
          <p className="text-xs font-medium">Second Signer Required</p>
          <p className="text-xs text-muted-foreground">
            This agreement requires 2 signers. We have {partnerRequired.parent1.firstName}'s information. Please add the second signer's details.
          </p>
          <div className="text-xs border rounded-[var(--radius)] p-2 bg-background">
            <span className="font-medium text-muted-foreground">Signer 1:</span> {partnerRequired.parent1.firstName} {partnerRequired.parent1.lastName} ({partnerRequired.parent1.email})
          </div>

          {relationshipStatus === "Partnered" && (
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
              <span className="text-xs text-muted-foreground">Send to {partnerRequired.parent1.firstName} only - skip partner</span>
            </label>
          )}

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

          {partnerFieldError && (
            <p className="text-xs text-destructive">{partnerFieldError}</p>
          )}

          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs h-7"
              onClick={() => {
                setPartnerRequired(null);
                setPartnerFieldError(null);
                setSkipPartner(false);
                generateAgreementMutation.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="flex-1 text-xs h-7"
              style={{ backgroundColor: brandColor }}
              disabled={generateAgreementMutation.isPending}
              onClick={() => {
                if (!sessionId) return;
                if (skipPartner) {
                  setPartnerFieldError(null);
                  generateAgreementMutation.mutate({ sessionId, skipPartner: true });
                } else {
                  if (!partnerFields.firstName.trim() || !partnerFields.lastName.trim() || !partnerFields.email.trim()) {
                    setPartnerFieldError("All fields are required.");
                    return;
                  }
                  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(partnerFields.email)) {
                    setPartnerFieldError("Please enter a valid email address.");
                    return;
                  }
                  setPartnerFieldError(null);
                  generateAgreementMutation.mutate({
                    sessionId,
                    partnerOverride: {
                      firstName: partnerFields.firstName.trim(),
                      lastName: partnerFields.lastName.trim(),
                      email: partnerFields.email.trim(),
                    },
                  });
                }
              }}
            >
              {generateAgreementMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Send Agreement
            </Button>
          </div>
        </div>
      )}

      {generateAgreementMutation.isError && (
        <p className="text-xs text-destructive mt-1.5" data-testid="text-agreement-error">
          {(generateAgreementMutation.error as Error)?.message || "Failed to generate agreement"}
        </p>
      )}

      {/* Agreement status widget */}
      {agr && agr.status !== "DRAFT" && agr.status !== "CREATED" && (() => {
        if (signers.length === 0) {
          const docLabel = agr.status === "SIGNED" ? "Signed" : "Sent";
          const docColor = agr.status === "SIGNED" ? "text-[hsl(var(--brand-success))]" : "text-muted-foreground";
          return (
            <div className="mt-2 rounded-[var(--radius)] border border-border bg-muted/30 px-2.5 py-2 space-y-1.5" data-testid="text-agreement-status">
              <p className={`text-[11px] font-medium ${docColor}`}>{docLabel}</p>
              {agr.status === "SIGNED" && (
                <a
                  href={`/api/agreements/${agr.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-[hsl(var(--primary))] hover:underline"
                >
                  Download PDF
                </a>
              )}
            </div>
          );
        }

        return (
          <div className="mt-2 rounded-[var(--radius)] border border-border bg-muted/30 px-2.5 py-2 space-y-1.5" data-testid="text-agreement-status">
            {sorted.map(([email, s], idx) => {
              const label = isSingle ? "" : `Parent ${idx + 1}`;
              const name = s.firstName ? `${s.firstName}${s.lastName ? " " + s.lastName : ""}` : email;
              const isCompleted = s.completed || agr.status === "SIGNED";
              let stateLabel: string;
              let stateColor: string;
              if (isCompleted) {
                stateLabel = isSingle ? "Signed" : `Signed by ${label}`;
                stateColor = "text-[hsl(var(--brand-success))]";
              } else if (s.viewed) {
                stateLabel = isSingle ? "Opened" : `Opened by ${label}`;
                stateColor = "text-[hsl(var(--brand-warning))]";
              } else {
                stateLabel = isSingle ? "Sent" : `Sent to ${label}`;
                stateColor = "text-muted-foreground";
              }
              return (
                <div key={email} className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground truncate">{name}</span>
                  <span className={`text-[11px] font-medium shrink-0 ${stateColor}`}>{stateLabel}</span>
                </div>
              );
            })}
            {agr.status === "SIGNED" && sorted.length > 0 && (
              <div className="pt-1 border-t border-border flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold text-[hsl(var(--brand-success))]">Fully Signed</p>
                <a
                  href={`/api/agreements/${agr.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-medium text-[hsl(var(--primary))] hover:underline shrink-0"
                >
                  Download PDF
                </a>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
