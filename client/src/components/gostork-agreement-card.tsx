/**
 * Provider-side "GoStork Agreement" section (Agreements page, /account/documents).
 * Shows the org's GoStork Provider Service Agreement: sign it while pending,
 * reopen/download it after signing, and share it by email with anyone
 * (lawyer, partner) via the token-gated public link - recipients need no
 * GoStork account. Inline expandable share section, no dialogs.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { FileSignature, PenLine, Download, ExternalLink, Share2, Loader2, CheckCircle2, Clock } from "lucide-react";

type MyAgreement = { id: string; status: "SENT" | "COMPLETED"; requestedAt: string | null; completedAt: string | null } | null;

export function GostorkAgreementCard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [shareOpen, setShareOpen] = useState(false);
  const [shareEmails, setShareEmails] = useState("");

  const { data } = useQuery<{ agreement: MyAgreement }>({
    queryKey: ["/api/provider/gostork-agreement"],
    queryFn: async () => {
      const res = await fetch("/api/provider/gostork-agreement", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load agreement");
      return res.json();
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const shareMutation = useMutation({
    mutationFn: async () => {
      const emails = shareEmails.split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
      const res = await apiRequest("POST", `/api/provider-agreements/${agreement!.id}/share`, { emails });
      return res.json();
    },
    onSuccess: (d: any) => {
      toast({ title: "Agreement shared", description: `Sent to ${d.shared} recipient(s). They can open it without a GoStork account.`, variant: "success" });
      setShareEmails("");
      setShareOpen(false);
    },
    onError: (e: Error) => toast({ title: "Could not share", description: e.message, variant: "destructive" }),
  });

  const agreement = data?.agreement;
  if (!agreement) return null;
  const signed = agreement.status === "COMPLETED";

  return (
    <section className="space-y-3" data-testid="gostork-agreement-section">
      <div>
        <h2 className="text-lg font-heading flex items-center gap-2">
          <FileSignature className="w-5 h-5 text-primary" /> GoStork Agreement
        </h2>
        <p className="t-helper mt-0.5">
          Your service agreement with GoStork - {signed ? "signed and on file." : "awaiting your signature."}
        </p>
      </div>
      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${signed
            ? "bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))]"
            : "bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]"}`}
          >
            {signed ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
            {signed
              ? `Signed${agreement.completedAt ? ` ${new Date(agreement.completedAt).toLocaleDateString()}` : ""}`
              : "Awaiting your signature"}
          </span>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {!signed ? (
              <Button size="sm" onClick={() => navigate(`/provider-agreement/${agreement.id}`)} data-testid="gostork-agreement-sign">
                <PenLine className="w-3.5 h-3.5 mr-1.5" /> Review & Sign
              </Button>
            ) : (
              <>
                <Button size="sm" variant="outline" onClick={() => navigate(`/provider-agreement/${agreement.id}`)} data-testid="gostork-agreement-open">
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open
                </Button>
                <a href={`/api/provider-agreements/${agreement.id}/download`} target="_blank" rel="noopener noreferrer">
                  <Button size="sm" variant="outline" data-testid="gostork-agreement-download">
                    <Download className="w-3.5 h-3.5 mr-1.5" /> Download
                  </Button>
                </a>
              </>
            )}
            <Button size="sm" variant="outline" onClick={() => setShareOpen(o => !o)} data-testid="gostork-agreement-share-toggle">
              <Share2 className="w-3.5 h-3.5 mr-1.5" /> Share
            </Button>
          </div>
        </div>

        {shareOpen && (
          <div className="border-t pt-4 space-y-2">
            <Label>Share by email</Label>
            <p className="t-helper">
              Recipients get a secure link to view {signed ? "the signed agreement" : "and even sign the agreement"} - no GoStork account needed. Separate multiple addresses with commas.
            </p>
            <div className="flex gap-2 flex-wrap sm:flex-nowrap">
              <Input
                value={shareEmails}
                onChange={e => setShareEmails(e.target.value)}
                placeholder="lawyer@firm.com, partner@agency.com"
                className="flex-1 min-w-[220px]"
                data-testid="gostork-agreement-share-emails"
              />
              <Button
                onClick={() => shareMutation.mutate()}
                disabled={!shareEmails.trim() || shareMutation.isPending}
                data-testid="gostork-agreement-share-send"
              >
                {shareMutation.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Share2 className="w-4 h-4 mr-1.5" />}
                Send
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
