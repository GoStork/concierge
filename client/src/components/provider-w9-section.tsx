/**
 * Self-contained W-9 status + actions widget. Extracted from the (now-
 * deleted) Billing Identity section of provider-billing-tab.tsx so the
 * same UI can be mounted on the new Legal Identity tab.
 *
 * Owns: its own W-9 status query + send/fill/resubmit mutations + the
 * inline template-setup panel for admin.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, FileText, Send, Download, Check, ExternalLink, ChevronDown, ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/ui/confirm-bar";
import { W9TemplateConfig } from "./w9-template-config";

interface W9Status {
  formType?: "W9" | "W8BENE";
  formLabel?: string;
  templateConfigured: boolean;
  templateNeedsFields?: boolean;
  templateName: string | null;
  w9Id: string | null;
  status: "NOT_SENT" | "SENT" | "COMPLETED" | "ERROR";
  requestedAt: string | null;
  completedAt: string | null;
}

interface ProviderW9SectionProps {
  providerId: string;
  /** "admin" - admin editing a provider. "provider" - provider editing own row. */
  mode: "admin" | "provider";
  /** Which form the provider owes per the Legal tab's country (the server
   *  answers the same in w9.formType; this lets the label update the moment
   *  the country dropdown changes, before save). */
  formType?: "W9" | "W8BENE";
}

export function ProviderW9Section({ providerId, mode, formType }: ProviderW9SectionProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isProviderMode = mode === "provider";
  const confirm = useConfirm();
  const [showW9Setup, setShowW9Setup] = useState(false);

  const w9GetUrl = isProviderMode ? "/api/provider/w9" : `/api/admin/providers/${providerId}/w9`;
  const { data: w9, isLoading: w9Loading } = useQuery<W9Status>({
    queryKey: [w9GetUrl],
    queryFn: async () => {
      const res = await fetch(w9GetUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load W-9 status");
      return res.json();
    },
  });
  const effectiveForm = formType || w9?.formType || "W9";
  const FORM = effectiveForm === "W9" ? "W-9" : "W-8BEN-E";

  // Auto-open the inline template-setup panel when the admin lands on a
  // provider whose template is uploaded but missing the signature field.
  useEffect(() => {
    if (!isProviderMode && w9?.templateNeedsFields) setShowW9Setup(true);
  }, [w9?.templateNeedsFields, isProviderMode]);

  const w9SendMutation = useMutation({
    mutationFn: async (force?: boolean) => {
      const res = await fetch(`/api/admin/providers/${providerId}/w9/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ force: !!force }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to send W-9 request");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [w9GetUrl] }),
  });

  const w9FillMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provider/w9/fill`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to open W-9");
      return res.json();
    },
    onSuccess: (data: { w9Id: string }) => {
      queryClient.invalidateQueries({ queryKey: [w9GetUrl] });
      if (data?.w9Id) navigate(`/w9/${data.w9Id}`);
    },
  });

  const w9ResubmitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provider/w9/resubmit`, { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to start a new W-9");
      return res.json();
    },
    onSuccess: (data: { w9Id: string }) => {
      queryClient.invalidateQueries({ queryKey: [w9GetUrl] });
      if (data?.w9Id) navigate(`/w9/${data.w9Id}`);
    },
  });

  return (
    <div className="space-y-1.5">
      <Label>{FORM} <span style={{ color: "hsl(var(--brand-error))" }}>*</span></Label>
      {/* Stacks on mobile - one horizontal row starves the title into
          letter-wrap once the completed-state action cluster appears. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-[var(--radius)] border p-3 bg-secondary/40">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <FileText className="w-4 h-4 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{FORM} Form</p>
          <p className="t-helper">
            {w9Loading ? "Loading..."
              : !w9?.templateConfigured && w9?.templateNeedsFields ? (isProviderMode ? "Not available yet" : "Template uploaded - assign signature field to finish setup")
              : !w9?.templateConfigured ? (isProviderMode ? "Not available yet" : `No ${FORM} template configured`)
              : w9.status === "COMPLETED" ? `Completed${w9.completedAt ? ` ${new Date(w9.completedAt).toLocaleDateString()}` : ""}`
              : w9.status === "SENT" ? (isProviderMode ? "Awaiting your signature" : "Sent - awaiting signature")
              : w9.status === "ERROR" ? "Something went wrong - try again"
              : (isProviderMode ? "Ready to fill out" : "Not sent yet")}
            </p>
          </div>
        </div>

        {w9?.status === "COMPLETED" && w9.w9Id && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            <span className="flex items-center gap-1 text-xs font-medium" style={{ color: "hsl(var(--brand-success))" }}>
              <Check className="w-3.5 h-3.5" /> Completed
            </span>
            <Button variant="ghost" size="sm" onClick={() => navigate(`/w9/${w9.w9Id}`)} title="View">
              <ExternalLink className="w-4 h-4" />
            </Button>
            <a
              href={`/api/w9/${w9.w9Id}/download`}
              target="_blank"
              rel="noopener noreferrer"
              title="Download"
              className="inline-flex items-center justify-center h-9 w-9 rounded-[var(--radius)] hover:bg-muted"
            >
              <Download className="w-4 h-4" />
            </a>
            {isProviderMode && (
              <Button
                variant="outline"
                size="sm"
                className="bg-card"
                disabled={w9ResubmitMutation.isPending}
                onClick={() => w9ResubmitMutation.mutate()}
                title={`Submit a new ${FORM}`}
              >
                {w9ResubmitMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}
                Submit new {FORM}
              </Button>
            )}
            {!isProviderMode && (
              <Button
                variant="outline"
                size="sm"
                className="bg-card"
                disabled={w9SendMutation.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Request a new ${FORM} from this provider?`,
                    message: `The current signed ${FORM} will no longer be the active version. It stays in PandaDoc's archive for record-keeping.`,
                    confirmLabel: `Request new ${FORM}`,
                    tone: "warning",
                  });
                  if (ok) w9SendMutation.mutate(true);
                }}
                title={`Ask the provider to fill out a new ${FORM}`}
              >
                {w9SendMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                Request new {FORM}
              </Button>
            )}
          </div>
        )}

        {!isProviderMode && w9?.templateConfigured && w9.status !== "COMPLETED" && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
            {w9.status === "SENT" && w9.w9Id && (
              <Button variant="ghost" size="sm" onClick={() => navigate(`/w9/${w9.w9Id}`)} title="View">
                <ExternalLink className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={w9SendMutation.isPending}
              onClick={() => w9SendMutation.mutate(false)}
            >
              {w9SendMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
              {w9.status === "SENT" ? "Resend" : `Send ${FORM} request`}
            </Button>
          </div>
        )}
        {!isProviderMode && !w9?.templateConfigured && !w9Loading && (
          <Button
            type="button"
            variant={w9?.templateNeedsFields ? "default" : "outline"}
            size="sm"
            onClick={() => setShowW9Setup(s => !s)}
            className="shrink-0 self-start sm:self-auto"
            style={w9?.templateNeedsFields ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" } : undefined}
          >
            {showW9Setup ? <ChevronUp className="w-4 h-4 mr-2" /> : <ChevronDown className="w-4 h-4 mr-2" />}
            {showW9Setup ? "Hide template setup" : w9?.templateNeedsFields ? "Configure signature field" : "Set up template"}
          </Button>
        )}
        {!isProviderMode && w9?.templateConfigured && !w9Loading && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowW9Setup(s => !s)}
            className="shrink-0 self-start sm:self-auto text-muted-foreground"
            title={showW9Setup ? "Hide template setup" : `Edit ${FORM} template`}
          >
            {showW9Setup ? <ChevronUp className="w-4 h-4 mr-1.5" /> : <ChevronDown className="w-4 h-4 mr-1.5" />}
            {showW9Setup ? "Hide template" : "Edit template"}
          </Button>
        )}
        {isProviderMode && w9?.templateConfigured && w9.status !== "COMPLETED" && (
          <Button
            size="sm"
            disabled={w9FillMutation.isPending}
            onClick={() => w9FillMutation.mutate()}
            style={{ background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderRadius: "var(--radius)" }}
            className="shrink-0 self-start sm:self-auto"
          >
            {w9FillMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}
            Fill out {FORM}
          </Button>
        )}
      </div>
      {w9SendMutation.isError && (
        <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{(w9SendMutation.error as Error).message}</p>
      )}
      {w9FillMutation.isError && (
        <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{(w9FillMutation.error as Error).message}</p>
      )}
      {w9ResubmitMutation.isError && (
        <p className="text-xs" style={{ color: "hsl(var(--brand-error))" }}>{(w9ResubmitMutation.error as Error).message}</p>
      )}
      <p className="t-helper">
        {isProviderMode
          ? (effectiveForm === "W9" ? "Complete and sign your W-9 - GoStork needs it before any payouts can be processed. Fields above auto-fill when you sign." : "Complete and sign your W-8BEN-E - GoStork needs it before any payouts can be processed. It certifies your foreign status; no US tax ID is required.")
          : `Send the ${FORM} to the agency to fill and sign, or download it once completed.`}
      </p>

      {!isProviderMode && showW9Setup && (
        <div className="pt-2">
          <W9TemplateConfig formType={effectiveForm} onChange={() => queryClient.invalidateQueries({ queryKey: [w9GetUrl] })} />
        </div>
      )}

    </div>
  );
}
