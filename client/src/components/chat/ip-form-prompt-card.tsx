/**
 * Eva's Intended Parent Form nudge card (uiCardType "ip_form_prompt").
 *
 * Posted once per parent account after the first COMPLETED consultation with
 * a surrogacy agency. Parent-private: the server excludes it from every
 * provider-facing feed (same treatment as review_prompt). The card reflects
 * live form status via /api/ip-form so it flips to "Submitted" everywhere
 * once the family finishes.
 */
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";

export function IpFormPromptCard({ data, brandColor }: { data: any; brandColor: string }) {
  const navigate = useNavigate();
  const providerName: string = data?.providerName || "your surrogacy agency";

  const { data: form } = useQuery<{
    response?: { status?: string; hasSecondParent?: boolean };
    sections?: { key: string; sortOrder: number; questions: { id: string }[] }[];
    answers?: { questionId: string }[];
    signatures?: { parentSlot: number }[];
  }>({
    queryKey: ["/api/ip-form"],
    staleTime: 30_000,
  });
  const submitted = form?.response?.status === "SUBMITTED";
  const answers = form?.answers || [];
  const signatures = form?.signatures || [];
  const hasSecondParent = form?.response?.hasSecondParent ?? false;
  const started = answers.length > 0 || signatures.length > 0;
  // Once the second parent has signed (or the sole parent, solo journeys), the
  // only thing left is submit.
  const readyToSubmit = hasSecondParent ? signatures.some((s) => s.parentSlot === 2) : signatures.some((s) => s.parentSlot === 1);

  // Resume point: furthest answered section; once signed, land on the sign page.
  const sections = form?.sections || [];
  const answeredIds = new Set(answers.map((a) => a.questionId));
  let resumeKey: string | null = null;
  let bestOrder = -1;
  for (const s of sections) {
    if (s.questions?.some((q) => answeredIds.has(q.id)) && s.sortOrder > bestOrder) {
      bestOrder = s.sortOrder;
      resumeKey = s.key;
    }
  }
  if (signatures.length && sections.some((s) => s.key === "acknowledgment")) resumeKey = "acknowledgment";
  const openForm = () => navigate(resumeKey ? `/ip-form?section=${encodeURIComponent(resumeKey)}` : "/ip-form");
  const ctaLabel = readyToSubmit ? "Submit My Form" : started ? "Finish My Form" : "Start My Form";

  return (
    <div
      className="rounded-[var(--radius)] border-2 bg-background overflow-hidden max-w-md"
      style={{ borderColor: brandColor }}
      data-testid="ip-form-prompt-card"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground shrink-0" style={{ backgroundColor: brandColor }}>
          <ClipboardList className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Intended Parent Form</p>
          <p className="text-xs text-muted-foreground">
            {submitted ? "Submitted - you're all set!" : `${providerName} shares it with potential surrogates before your match call`}
          </p>
        </div>
      </div>
      <div className="px-4 pb-3">
        {submitted ? (
          <div className="flex items-center gap-2 text-sm" style={{ color: "hsl(var(--brand-success))" }}>
            <CheckCircle2 className="w-4 h-4" /> Completed and signed. {providerName} has been notified.
          </div>
        ) : (
          <>
            <Button className="w-full" onClick={openForm} data-testid="ip-form-prompt-open">
              {ctaLabel}
            </Button>
            <p className="text-[11px] text-muted-foreground mt-1.5 text-center">
              About 20-30 minutes - saves as you go, and both partners can fill it in parallel.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
