/**
 * Agency Documents tab.
 * Step 1+2 (upload template, assign signature fields) is delegated to the
 * shared PandaDocTemplateEditor so the W-9 setup flow (used by GoStork admin)
 * picks up the same fixes for free.
 *
 * Phase 5: multi-service providers get one template editor per service
 * (surrogacy contract != egg donation contract); single-service providers
 * keep the original single editor backed by the legacy Provider fields.
 * Also hosts the provider's agreement automation setting (off / approval /
 * fully automated), which overrides the GoStork-admin rollout toggle.
 */

import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText, RefreshCw, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PandaDocTemplateEditor } from "./pandadoc-template-editor";
import { AgreementRows } from "./agreements-list";

interface Agreement {
  id: string;
  status: string;
  documentType: string;
  pandaDocViewUrl: string | null;
  signedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  parentName: string;
  parentEmail: string;
}

interface TemplateRow {
  serviceType: string;
  agreementTemplateUrl: string | null;
  agreementTemplateOriginalName: string | null;
  pandaDocTemplateId: string | null;
}

interface TemplatesResponse {
  serviceTypes: string[];
  legacy: { agreementTemplateUrl: string | null; agreementTemplateOriginalName: string | null; pandaDocTemplateId: string | null };
  templates: TemplateRow[];
  agreementAutomation: string | null;
  adminAutoAgreementDraft: boolean;
}

const SERVICE_LABELS: Record<string, string> = {
  SURROGACY: "Surrogacy Agreement",
  EGG_DONATION: "Egg Donation Agreement",
  SPERM_DONATION: "Sperm Donation Agreement",
  IVF_CLINIC: "Clinic Agreement",
  OTHER: "Agreement",
};

const AUTOMATION_OPTIONS: Array<{ value: string; label: string; description: string }> = [
  {
    value: "off",
    label: "Off - I'll send agreements manually",
    description: "Nothing happens automatically. Send agreements from the + menu in each chat.",
  },
  {
    value: "approval",
    label: "Draft for my approval",
    description: "When a parent's deposit payment clears, Eva drafts the agreement and posts it in the chat for you to approve before it's sent for signature.",
  },
  {
    value: "auto_send",
    label: "Fully automated",
    description: "When a parent's deposit payment clears, the agreement is generated AND sent for signature immediately - no approval step.",
  },
];

function fileNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  return decodeURIComponent(url.split("/").pop()?.split("?")[0] || "agreement-template");
}

export default function DocumentsTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const providerId = (user as any)?.providerId || "";

  const { data: tpl, isLoading: tplLoading } = useQuery<TemplatesResponse>({
    queryKey: ["/api/agreements/templates"],
    enabled: !!providerId,
  });

  const { data: agreements = [], isLoading: agreementsLoading, refetch } = useQuery<Agreement[]>({
    queryKey: ["/api/agreements"],
    enabled: !!providerId,
  });

  // The provider's effective automation choice: their own setting wins; when
  // unset, the GoStork rollout toggle maps on -> approval, off -> off.
  const effectiveMode = tpl?.agreementAutomation ?? (tpl?.adminAutoAgreementDraft ? "approval" : "off");
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const selectedMode = pendingMode ?? effectiveMode;

  const automationMutation = useMutation({
    mutationFn: async (mode: string) => apiRequest("PUT", "/api/agreements/automation", { mode }),
    onSuccess: () => {
      toast({ title: "Automation setting saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/agreements/templates"] });
    },
    onError: (err: any) => {
      setPendingMode(null);
      toast({ title: "Failed to save", description: err?.message || "Try again.", variant: "destructive" });
    },
  });

  if (tplLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-32 bg-muted rounded-[var(--radius)] animate-pulse" />
      </div>
    );
  }

  const serviceTypes = tpl?.serviceTypes || [];
  const multiService = serviceTypes.length > 1;
  const rowByService = new Map((tpl?.templates || []).map(t => [t.serviceType, t]));

  const invalidateTemplates = () => queryClient.invalidateQueries({ queryKey: ["/api/agreements/templates"] });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading">Documents & Agreements</h1>
        <p className="t-helper mt-1">
          Upload your agreement template{multiService ? "s" : ""} and manage contracts sent to parents.
        </p>
      </div>

      {multiService ? (
        serviceTypes.map(st => {
          const row = rowByService.get(st);
          // First service falls back to the legacy single template so existing
          // providers see their current template where they expect it.
          const isFirst = st === serviceTypes[0];
          const url = row?.agreementTemplateUrl ?? (isFirst && !row ? tpl?.legacy.agreementTemplateUrl ?? null : null);
          const templateId = row?.agreementTemplateUrl
            ? row.pandaDocTemplateId
            : (isFirst && !row ? tpl?.legacy.pandaDocTemplateId ?? null : null);
          const fromLegacy = !row?.agreementTemplateUrl && isFirst && !!tpl?.legacy.agreementTemplateUrl;
          const filename = row?.agreementTemplateOriginalName
            ?? (fromLegacy ? tpl?.legacy.agreementTemplateOriginalName ?? fileNameFromUrl(url) : fileNameFromUrl(url));
          const svcParam = fromLegacy ? "" : `?serviceType=${st}`;
          return (
            <PandaDocTemplateEditor
              key={st}
              templateLabel={`${SERVICE_LABELS[st] || "Agreement"} Template`}
              uploadHeading={`${SERVICE_LABELS[st] || "Agreement"} Template`}
              description={`Upload the agreement parents sign for your ${SERVICE_LABELS[st]?.replace(" Agreement", "").toLowerCase() || "this"} service (PDF or Word). Then open the editor to assign signature and date fields.`}
              fieldInstructions="Open the editor and drag signature and date fields onto your document. Assign each field to a signer role using the dropdown in the right panel."
              containerId={`pandadoc-template-editor-${st}`}
              templateUrl={url}
              pandaDocTemplateId={templateId}
              templateFilename={filename}
              saveTemplate={async ({ url: newUrl, originalName }) => {
                await apiRequest("PUT", `/api/agreements/templates/${st}`, {
                  agreementTemplateUrl: newUrl,
                  agreementTemplateOriginalName: originalName,
                });
              }}
              deleteTemplate={async () => {
                await apiRequest("DELETE", `/api/agreements/template${fromLegacy ? "" : `?serviceType=${st}`}`);
              }}
              syncEndpoint={`/api/agreements/sync-template${svcParam}`}
              editorSessionEndpoint={`/api/agreements/template-editor-session${svcParam}`}
              refreshRolesEndpoint={`/api/agreements/refresh-roles${svcParam}`}
              onAfterChange={invalidateTemplates}
            />
          );
        })
      ) : (
        <PandaDocTemplateEditor
          templateLabel="Agreement Template"
          description="Upload your agreement document (PDF or Word). Once uploaded, open the editor to assign signature and date fields to your signers."
          fieldInstructions="Open the editor and drag signature and date fields onto your document. Assign each field to a signer role using the dropdown in the right panel."
          containerId="pandadoc-template-editor-container"
          templateUrl={tpl?.legacy.agreementTemplateUrl ?? null}
          pandaDocTemplateId={tpl?.legacy.pandaDocTemplateId ?? null}
          templateFilename={tpl?.legacy.agreementTemplateOriginalName ?? fileNameFromUrl(tpl?.legacy.agreementTemplateUrl ?? null)}
          saveTemplate={async ({ url, originalName }) => {
            await apiRequest("PUT", `/api/providers/${providerId}`, {
              agreementTemplateUrl: url,
              agreementTemplateOriginalName: originalName,
              pandaDocTemplateId: null,
            });
          }}
          deleteTemplate={async () => {
            await apiRequest("DELETE", "/api/agreements/template");
          }}
          syncEndpoint="/api/agreements/sync-template"
          editorSessionEndpoint="/api/agreements/template-editor-session"
          refreshRolesEndpoint="/api/agreements/refresh-roles"
          onAfterChange={() => {
            invalidateTemplates();
            queryClient.invalidateQueries({ queryKey: ["/api/providers/:id", providerId] });
          }}
        />
      )}

      {/* Automation - the provider's own choice overrides GoStork's rollout toggle */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-heading">Agreement Automation</h2>
        </div>
        <p className="t-helper">
          Choose what happens when a parent's deposit payment clears.
        </p>
        <div className="space-y-2">
          {AUTOMATION_OPTIONS.map(opt => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-[var(--radius)] border cursor-pointer transition-colors ${
                selectedMode === opt.value ? "border-primary bg-secondary/50" : "border-border hover:bg-secondary/30"
              }`}
            >
              <input
                type="radio"
                name="agreement-automation"
                value={opt.value}
                checked={selectedMode === opt.value}
                onChange={() => {
                  setPendingMode(opt.value);
                  automationMutation.mutate(opt.value);
                }}
                className="mt-0.5 accent-primary"
                data-testid={`radio-agreement-automation-${opt.value}`}
              />
              <span>
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="t-helper block mt-0.5">{opt.description}</span>
              </span>
            </label>
          ))}
        </div>
      </Card>

      {/* Section E - Sent Agreements */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-heading">Sent Agreements</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        <AgreementRows
          isLoading={agreementsLoading}
          emptyText="No agreements have been sent yet."
          items={agreements.map(a => ({
            id: a.id,
            status: a.status,
            documentType: a.documentType,
            createdAt: a.createdAt,
            signedAt: a.signedAt,
            title: a.parentName,
          }))}
        />
      </Card>
    </div>
  );
}
