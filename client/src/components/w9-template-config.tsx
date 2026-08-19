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
  /** W9 (US entities, default) or W8BENE (foreign entities). Same endpoints,
   *  `?form=` selects the SiteSettings template set. */
  formType?: "W9" | "W8BENE";
}

interface W9Template {
  w9TemplateUrl: string | null;
  w9TemplateOriginalName: string | null;
  w9PandaDocTemplateId: string | null;
  w9PandaDocRoles: string | null;
}

export function W9TemplateConfig({ onChange, formType = "W9" }: W9TemplateConfigProps = {}) {
  const queryClient = useQueryClient();
  const label = formType === "W9" ? "W-9" : "W-8BEN-E";
  const q = `?form=${formType}`;
  const templateKey = `/api/admin/w9/template${q}`;

  const { data: template, isLoading } = useQuery<W9Template>({
    queryKey: [templateKey],
    queryFn: async () => {
      const res = await fetch(templateKey, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load ${label} template`);
      return res.json();
    },
  });

  const templateUrl = template?.w9TemplateUrl || null;
  const pandaDocTemplateId = template?.w9PandaDocTemplateId || null;
  const templateFilename = template?.w9TemplateOriginalName
    || (templateUrl ? decodeURIComponent(templateUrl.split("/").pop()?.split("?")[0] || "w9-template") : null);

  return (
    <PandaDocTemplateEditor
      templateLabel={`${label} Template`}
      uploadHeading={`Step 1 - Upload ${label} Form`}
      description={formType === "W9"
        ? "Upload the W-9 form (PDF or Word) and assign the signature field. Every US provider signs their own copy from their Legal tab."
        : "Upload the W-8BEN-E form (PDF or Word) and assign the signature field. Every NON-US provider signs their own copy from their Legal tab - it certifies foreign status so no US tax ID is needed."}
      fieldInstructions="Open the editor and drag a signature field onto the form, assigning it to the signer role. Click Save when done."
      containerId={`pandadoc-${formType.toLowerCase()}-editor-container`}
      templateUrl={templateUrl}
      pandaDocTemplateId={pandaDocTemplateId}
      templateFilename={templateFilename}
      isLoading={isLoading}
      saveTemplate={async ({ url, originalName }) => {
        const res = await fetch(templateKey, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ url, originalName }),
        });
        if (!res.ok) throw new Error("Failed to save template");
      }}
      deleteTemplate={async () => {
        await fetch(templateKey, { method: "DELETE", credentials: "include" });
      }}
      syncEndpoint={`/api/admin/w9/sync-template${q}`}
      editorSessionEndpoint={`/api/admin/w9/template-editor-session${q}`}
      refreshRolesEndpoint={`/api/admin/w9/refresh-roles${q}`}
      onAfterChange={() => {
        queryClient.invalidateQueries({ queryKey: [templateKey] });
        onChange?.();
      }}
    />
  );
}
