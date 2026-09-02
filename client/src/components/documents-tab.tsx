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

import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText, RefreshCw, Zap } from "lucide-react";
import { PandaDocTemplateEditor } from "./pandadoc-template-editor";
import { AgreementRows } from "./agreements-list";
import { AdminProviderAgreements } from "./admin-provider-agreements";

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

function fileNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  return decodeURIComponent(url.split("/").pop()?.split("?")[0] || "agreement-template");
}

export default function DocumentsTab({ providerId: providerIdProp }: { providerId?: string } = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // Admin-on-behalf-of mode: the admin provider edit page passes the target
  // provider's id, and every agreements call carries ?providerId= so the
  // admin sees and edits exactly what that provider sees.
  const adminForProvider = !!providerIdProp;
  const providerId = providerIdProp || (user as any)?.providerId || "";
  const qs = adminForProvider ? `?providerId=${encodeURIComponent(providerId)}` : "";
  const withOrg = (url: string) =>
    adminForProvider ? `${url}${url.includes("?") ? "&" : "?"}providerId=${encodeURIComponent(providerId)}` : url;
  // GoStork admins use this tab to manage the DEFAULT provider service
  // agreement template (stored on the house provider row their account is
  // linked to) and to send/track contracts - not to manage parent agreements.
  // When impersonating a specific provider they get the provider view instead.
  const isGoStorkAdmin = !adminForProvider && !!(user as any)?.roles?.includes?.("GOSTORK_ADMIN");

  const { data: tpl, isLoading: tplLoading } = useQuery<TemplatesResponse>({
    queryKey: ["/api/agreements/templates", providerId || "me"],
    queryFn: async () => {
      const res = await fetch(withOrg("/api/agreements/templates"), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreement templates");
      return res.json();
    },
    enabled: !!providerId,
  });

  const { data: agreements = [], isLoading: agreementsLoading, refetch } = useQuery<Agreement[]>({
    queryKey: ["/api/agreements", providerId || "me"],
    queryFn: async () => {
      const res = await fetch(withOrg("/api/agreements"), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreements");
      return res.json();
    },
    enabled: !!providerId,
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

  const invalidateTemplates = () => queryClient.invalidateQueries({ queryKey: ["/api/agreements/templates", providerId || "me"] });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading">Agreements</h1>
        <p className="t-helper mt-1">
          {isGoStorkAdmin
            ? "Configure the GoStork Provider Service Agreement template, send it to providers, and track every signature."
            : `Upload your agreement template${multiService ? "s" : ""} and manage contracts sent to parents.`}
        </p>
      </div>

      {/* The templates region is the onboarding tour stop for
          "Upload your agency agreement templates". */}
      <div data-onb-anchor="agency-templates" className="space-y-6">
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
          const svcParam = fromLegacy ? qs : `?serviceType=${st}${adminForProvider ? `&providerId=${encodeURIComponent(providerId)}` : ""}`;
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
                await apiRequest("PUT", `/api/agreements/templates/${st}${qs}`, {
                  agreementTemplateUrl: newUrl,
                  agreementTemplateOriginalName: originalName,
                });
              }}
              deleteTemplate={async () => {
                await apiRequest("DELETE", withOrg(`/api/agreements/template${fromLegacy ? "" : `?serviceType=${st}`}`));
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
            await apiRequest("DELETE", withOrg("/api/agreements/template"));
          }}
          syncEndpoint={withOrg("/api/agreements/sync-template")}
          editorSessionEndpoint={withOrg("/api/agreements/template-editor-session")}
          refreshRolesEndpoint={withOrg("/api/agreements/refresh-roles")}
          onAfterChange={() => {
            invalidateTemplates();
            queryClient.invalidateQueries({ queryKey: ["/api/providers/:id", providerId] });
          }}
        />
      )}
      </div>

      {/* GoStork admin: send + track provider service agreements. The parent
          agreement sections below are provider self-service concerns. */}
      {isGoStorkAdmin && <AdminProviderAgreements />}

      {/* GoStork-agreement surfaces for everyone else live on the LEGAL tab,
          which aggregates what GoStork needs legally (W-9 + service
          agreement): the provider self-view card and the admin's
          per-provider send/track table both render there
          (provider-legal-identity-tab.tsx). Only GoStork's own global
          send/track table above stays on this tab. */}

      {/* Agreement automation moved to the consolidated Automation tab. */}
      {!isGoStorkAdmin && (
      <Card className="p-4 flex items-center gap-3" data-testid="card-agreement-automation-pointer">
        <Zap className="w-5 h-5 text-primary shrink-0" />
        <p className="text-sm font-ui">
          Looking for Agreement Automation? It now lives with your other automations on the{" "}
          <Link to="/account/automation?section=billing" className="underline text-primary">
            Automation tab
          </Link>
          .
        </p>
      </Card>
      )}

      {/* Section E - Sent Agreements (parent-facing). Hidden for GoStork
          admins - their provider sends live in the tracking table above. */}
      {!isGoStorkAdmin && (
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-heading">Sent Agency Agreements</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>

        <AgreementRows
          variant="table"
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
      </section>
      )}
    </div>
  );
}
