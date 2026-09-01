/**
 * The provider's OWN onboarding checklist - their second-person view of the
 * same derived steps the GoStork admin tracks (GET /api/provider/onboarding).
 * Rendered at the top of the provider Home page until everything required is
 * done, then disappears. Rows deep-link to the page where the step happens.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import {
  CheckCircle2,
  Circle,
  Lock,
  ChevronDown,
  ChevronUp,
  ListChecks,
} from "lucide-react";

type OwnStep = {
  key: string;
  label: string;
  link: string;
  status: "done" | "pending" | "optional" | "locked";
  isOptional: boolean;
};

type OwnOnboarding = { steps: OwnStep[]; doneCount: number; requiredCount: number; percent: number };

function StatusIcon({ status }: { status: OwnStep["status"] }) {
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />;
  if (status === "locked") return <Lock className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
  if (status === "pending") return <Circle className="w-4 h-4 text-[hsl(var(--brand-warning))] shrink-0" />;
  return <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
}

export function ProviderOwnOnboarding() {
  const navigate = useNavigate();
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);

  const { data } = useQuery<OwnOnboarding>({
    queryKey: ["/api/provider/onboarding"],
    queryFn: async () => {
      const res = await fetch("/api/provider/onboarding", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load onboarding");
      return res.json();
    },
    staleTime: 15_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });

  if (!data) return null;
  if (data.percent >= 100) return null;

  const expanded = manuallyToggled ?? data.percent < 75;

  return (
    <Card className="p-4 border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.03)]" data-testid="provider-own-onboarding">
      <button
        type="button"
        className="w-full flex items-center gap-3 text-left"
        onClick={() => setManuallyToggled(!expanded)}
        data-testid="provider-own-onboarding-toggle"
      >
        <span className="w-9 h-9 rounded-full bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] flex items-center justify-center shrink-0">
          <ListChecks className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium">
            Getting started - {data.doneCount}/{data.requiredCount} steps done
          </span>
          <span className="mt-1 block h-1.5 rounded-full bg-[hsl(var(--primary)/0.12)] overflow-hidden">
            <span
              className="block h-full rounded-full bg-[hsl(var(--primary))] transition-all"
              style={{ width: `${data.percent}%` }}
            />
          </span>
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-0.5">
          {data.steps.map((step) => (
            <button
              key={step.key}
              type="button"
              disabled={step.status === "locked"}
              onClick={() => navigate(step.link)}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius)] text-left hover:bg-[hsl(var(--primary)/0.06)] transition-colors disabled:opacity-60 disabled:hover:bg-transparent"
              data-testid={`provider-own-step-${step.key}`}
            >
              <StatusIcon status={step.status} />
              <span className={`flex-1 min-w-0 text-sm truncate ${step.status === "done" ? "text-muted-foreground line-through decoration-[hsl(var(--brand-success)/0.5)]" : ""}`}>
                {step.label}
              </span>
              {step.isOptional && step.status !== "done" && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-secondary text-secondary-foreground">Optional</span>
              )}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
