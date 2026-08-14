/**
 * Provider-facing "GoStork Agreement" card - lives on the Legal Identity tab
 * next to the W-9, the provider's home for GoStork compliance documents.
 * Shows where their GoStork Provider Service Agreement stands, with a sign
 * button while it awaits them and a permanent download once executed.
 * Renders nothing when no agreement has been sent to this provider.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Download, PenLine, FileSignature, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface MyAgreement {
  id: string;
  status: "SENT" | "COMPLETED" | string;
  requestedAt: string | null;
  completedAt: string | null;
}

export function GoStorkAgreementSection() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

  const { data } = useQuery<{ agreement: MyAgreement | null }>({
    queryKey: ["/api/provider/gostork-agreement"],
    queryFn: async () => {
      const res = await fetch("/api/provider/gostork-agreement", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreement");
      return res.json();
    },
  });

  const agreement = data?.agreement;
  if (!agreement) return null;

  const signed = agreement.status === "COMPLETED";

  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/provider-agreements/${agreement.id}/download`, { credentials: "include" });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "GoStork Provider Service Agreement.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Could not download the agreement", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-5" data-testid="gostork-agreement-section">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <FileSignature className="w-4 h-4 text-primary" /> GoStork Agreement
          </h3>
          <p className="t-helper mt-0.5">
            {signed ? (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--brand-success))]" />
                Signed{agreement.completedAt ? ` on ${new Date(agreement.completedAt).toLocaleDateString()}` : ""} - your
                executed Provider Service Agreement with GoStork.
              </span>
            ) : (
              "Your GoStork Provider Service Agreement is ready and waiting for your signature."
            )}
          </p>
        </div>
        {signed ? (
          <Button variant="outline" size="sm" onClick={download} disabled={downloading} data-testid="gostork-agreement-download">
            {downloading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />}
            Download signed copy
          </Button>
        ) : (
          <Button size="sm" onClick={() => navigate(`/provider-agreement/${agreement.id}`)} data-testid="gostork-agreement-sign">
            <PenLine className="w-3.5 h-3.5 mr-1.5" /> Review & sign
          </Button>
        )}
      </div>
    </section>
  );
}
