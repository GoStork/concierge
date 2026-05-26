/**
 * Agency Documents tab.
 * Step 1+2 (upload template, assign signature fields) is delegated to the
 * shared PandaDocTemplateEditor so the W-9 setup flow (used by GoStork admin)
 * picks up the same fixes for free.
 */

import { useAuth } from "@/hooks/use-auth";
import { useProvider } from "@/hooks/use-providers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, ExternalLink, RefreshCw } from "lucide-react";
import { PandaDocTemplateEditor } from "./pandadoc-template-editor";

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

function statusBadge(status: string) {
  switch (status) {
    case "SIGNED":
      return (
        <Badge className="bg-[hsl(var(--brand-success)/0.15)] text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success)/0.3)] border">
          Signed
        </Badge>
      );
    case "SENT":
      return (
        <Badge variant="outline" className="text-[hsl(var(--foreground)/0.7)]">
          Sent - Awaiting Signature
        </Badge>
      );
    case "REJECTED":
      return (
        <Badge className="bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)] border">
          Rejected
        </Badge>
      );
    case "EXPIRED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Expired
        </Badge>
      );
    case "CREATED":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Created - Not Sent
        </Badge>
      );
    case "ERROR":
      return (
        <Badge className="bg-destructive/10 text-destructive border-destructive/30 border">
          Error
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function DocumentsTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const providerId = (user as any)?.providerId || "";
  const { data: provider, isLoading: providerLoading } = useProvider(providerId);

  const { data: agreements = [], isLoading: agreementsLoading, refetch } = useQuery<Agreement[]>({
    queryKey: ["/api/agreements"],
    enabled: !!providerId,
  });

  if (providerLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-32 bg-muted rounded-[var(--radius)] animate-pulse" />
      </div>
    );
  }

  const templateUrl = (provider as any)?.agreementTemplateUrl || null;
  const pandaDocTemplateId = (provider as any)?.pandaDocTemplateId || null;
  const templateFilename = (provider as any)?.agreementTemplateOriginalName
    || (templateUrl ? decodeURIComponent(templateUrl.split("/").pop()?.split("?")[0] || "agreement-template") : null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading">Documents & Agreements</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload your agreement template and manage contracts sent to parents.
        </p>
      </div>

      <PandaDocTemplateEditor
        templateLabel="Agreement Template"
        description="Upload your agreement document (PDF or Word). Once uploaded, open the editor to assign signature and date fields to your signers."
        fieldInstructions="Open the editor and drag signature and date fields onto your document. Assign each field to a signer role using the dropdown in the right panel."
        containerId="pandadoc-template-editor-container"
        templateUrl={templateUrl}
        pandaDocTemplateId={pandaDocTemplateId}
        templateFilename={templateFilename}
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
        onAfterChange={() => queryClient.invalidateQueries({ queryKey: ['/api/providers/:id', providerId] })}
      />

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

        {agreementsLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-12 bg-muted rounded animate-pulse" />
            ))}
          </div>
        ) : agreements.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No agreements have been sent yet.
          </p>
        ) : (
          <div className="divide-y">
            {agreements.map(agreement => (
              <div key={agreement.id} className="flex items-center gap-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{agreement.parentName}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(agreement.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    {agreement.signedAt && ` - Signed ${new Date(agreement.signedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </p>
                </div>
                <div className="shrink-0">{statusBadge(agreement.status)}</div>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => navigate(`/agreements/${agreement.id}`)}>
                  <ExternalLink className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
