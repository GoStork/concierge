/**
 * Provider - Intended Parent Forms (/provider/parent-forms).
 *
 * Surrogacy agencies see every submitted form from parents connected to
 * them and download the PDF branded with their own logo, in two variants:
 * Full (agency records) and Surrogate Version (private section + contact
 * details stripped - safe to forward to surrogate candidates).
 */
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Download, FileText, Loader2, ShieldCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface IpFormRow {
  responseId: string;
  parentAccountId: string;
  parentNames: string[];
  hasSecondParent: boolean;
  submittedAt: string | null;
}

export default function ProviderParentFormsPage() {
  const { data, isLoading } = useQuery<{ forms: IpFormRow[] }>({
    queryKey: ["/api/provider/ip-forms"],
    refetchOnWindowFocus: true,
  });
  const forms = data?.forms || [];

  const download = (responseId: string, variant: "full" | "surrogate") => {
    window.open(`/api/provider/ip-forms/${responseId}/pdf?variant=${variant}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 pb-24 md:pb-6" data-testid="provider-parent-forms-page">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0">
          <ClipboardList className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-heading font-bold">Intended Parent Forms</h1>
          <p className="t-helper">
            Signed profile forms from your connected families, branded with your agency's logo. Share the Surrogate Version with
            candidates - it excludes the parents' private information and contact details.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : forms.length === 0 ? (
        <Card className="p-8 text-center space-y-2">
          <FileText className="w-8 h-8 text-muted-foreground mx-auto" />
          <p className="font-medium">No submitted forms yet</p>
          <p className="t-helper">
            When a connected family completes and signs their Intended Parent Form, it appears here and you're notified by email.
          </p>
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {forms.map((f) => (
            <div key={f.responseId} className="flex flex-col sm:flex-row sm:items-center gap-3 p-4" data-testid={`ipform-row-${f.responseId}`}>
              <div className="flex-1 min-w-0">
                <p className="font-medium">{f.parentNames.join(" & ") || "Intended Parents"}</p>
                <p className="t-helper">
                  {f.hasSecondParent ? "Two intended parents" : "Single intended parent"}
                  {f.submittedAt ? ` - submitted ${new Date(f.submittedAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="outline" size="sm" onClick={() => download(f.responseId, "full")} data-testid={`ipform-dl-full-${f.responseId}`}>
                  <Download className="w-3.5 h-3.5 mr-1.5" /> Full PDF
                </Button>
                <Button size="sm" onClick={() => download(f.responseId, "surrogate")} data-testid={`ipform-dl-surrogate-${f.responseId}`}>
                  <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Surrogate Version
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
