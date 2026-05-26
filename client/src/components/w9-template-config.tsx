/**
 * Thin GoStork-admin wrapper around the shared PandaDocTemplateEditor.
 * Persistence target: SiteSettings (single global template every provider signs).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PandaDocTemplateEditor } from "./pandadoc-template-editor";

interface W9TemplateConfigProps {
  /** Called after any successful mutation - lets parent screens refresh
   *  dependent W-9 status queries (e.g. the W-9 row strip on the billing tab). */
  onChange?: () => void;
}

interface W9Template {
  w9TemplateUrl: string | null;
  w9TemplateOriginalName: string | null;
  w9PandaDocTemplateId: string | null;
  w9PandaDocRoles: string | null;
}

export function W9TemplateConfig({ onChange }: W9TemplateConfigProps = {}) {
  const queryClient = useQueryClient();

  const { data: template, isLoading } = useQuery<W9Template>({
    queryKey: ["/api/admin/w9/template"],
    queryFn: async () => {
      const res = await fetch("/api/admin/w9/template", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load W-9 template");
      return res.json();
    },
  });

  const templateUrl = template?.w9TemplateUrl || null;
  const pandaDocTemplateId = template?.w9PandaDocTemplateId || null;
  const templateFilename = template?.w9TemplateOriginalName
    || (templateUrl ? decodeURIComponent(templateUrl.split("/").pop()?.split("?")[0] || "w9-template") : null);

  return (
    <PandaDocTemplateEditor
      templateLabel="W-9 Template"
      uploadHeading="Step 1 - Upload W-9 Form"
      description="Upload the W-9 form (PDF or Word) and assign the signature field. Every provider signs their own copy from their Billing tab."
      fieldInstructions="Open the editor and drag a signature field onto the form, assigning it to the signer role. Click Save when done."
      containerId="pandadoc-w9-editor-container"
      templateUrl={templateUrl}
      pandaDocTemplateId={pandaDocTemplateId}
      templateFilename={templateFilename}
      isLoading={isLoading}
      saveTemplate={async ({ url, originalName }) => {
        const res = await fetch("/api/admin/w9/template", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ url, originalName }),
        });
        if (!res.ok) throw new Error("Failed to save template");
      }}
      deleteTemplate={async () => {
        await fetch("/api/admin/w9/template", { method: "DELETE", credentials: "include" });
      }}
      syncEndpoint="/api/admin/w9/sync-template"
      editorSessionEndpoint="/api/admin/w9/template-editor-session"
      refreshRolesEndpoint="/api/admin/w9/refresh-roles"
      onAfterChange={() => {
        queryClient.invalidateQueries({ queryKey: ["/api/admin/w9/template"] });
        onChange?.();
      }}
    />
  );
}
