/**
 * Provider onboarding checklist - the admin's guided path from "just scraped"
 * to "fully live". Renders above the tabs on the admin provider edit page.
 * All statuses are DERIVED server-side (provider-onboarding.controller.ts);
 * nothing here stores checklist state. Hidden entirely at 100%.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  Circle,
  Clock,
  Lock,
  Loader2,
  ChevronDown,
  ChevronUp,
  Send,
  ListChecks,
} from "lucide-react";

type OnboardingStep = {
  key: string;
  group: "created" | "admin_setup" | "provider_setup" | "go_live";
  label: string;
  detail: string;
  status: "done" | "pending" | "waiting_on_provider" | "optional" | "locked";
  deepLink: string;
  isOptional?: boolean;
  manuallyMarkable?: boolean;
  manuallyDone?: boolean;
  /** Progress signal for provider-side steps ("Sent", "Opened 8/31", "Started"). */
  progress?: string;
};

type OnboardingSummary = {
  providerId: string;
  providerName: string;
  steps: OnboardingStep[];
  doneCount: number;
  requiredCount: number;
  percent: number;
  tasksSentAt: string | null;
};

const GROUP_LABELS: Record<OnboardingStep["group"], string> = {
  created: "1. Created",
  admin_setup: "2. GoStork admin setup",
  provider_setup: "3. Provider setup",
  go_live: "4. Go live",
};

function StatusIcon({ status }: { status: OnboardingStep["status"] }) {
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />;
  if (status === "pending") return <Circle className="w-4 h-4 text-[hsl(var(--brand-warning))] shrink-0" />;
  if (status === "waiting_on_provider") return <Clock className="w-4 h-4 text-[hsl(var(--accent))] shrink-0" />;
  if (status === "locked") return <Lock className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
  return <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
}

function statusBadge(status: OnboardingStep["status"]): { label: string; cls: string } | null {
  switch (status) {
    case "pending":
      return { label: "Your turn", cls: "bg-[hsl(var(--brand-warning)/0.15)] text-[hsl(var(--brand-warning))]" };
    case "waiting_on_provider":
      return { label: "Provider", cls: "bg-[hsl(var(--accent)/0.15)] text-[hsl(var(--accent))]" };
    case "optional":
      return { label: "Optional", cls: "bg-secondary text-secondary-foreground" };
    case "locked":
      return { label: "Locked", cls: "bg-muted text-muted-foreground" };
    default:
      return null;
  }
}

export default function ProviderOnboardingChecklist({
  providerId,
  onNavigateTab,
}: {
  providerId: string;
  /** Switch the edit page to the given ?tab= value. */
  onNavigateTab: (tab: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);

  const { data, isLoading } = useQuery<OnboardingSummary>({
    queryKey: ["/api/admin/providers", providerId, "onboarding"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/providers/${providerId}/onboarding`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load onboarding status");
      return res.json();
    },
    // The global query defaults cache forever, which would freeze the
    // checklist at page-load state while the admin saves fees/scrapers in the
    // tabs below. Poll while mounted so every save is reflected within
    // seconds, whatever tab it came from.
    staleTime: 10_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: 20_000,
  });

  // Manual check-off for optional steps ("nothing to set up here").
  const markMutation = useMutation({
    mutationFn: async ({ key, done }: { key: string; done: boolean }) => {
      const res = await apiRequest(done ? "POST" : "DELETE", `/api/admin/providers/${providerId}/onboarding/steps/${key}/mark-done`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/providers", providerId, "onboarding"] });
    },
    onError: (err: Error) => {
      toast({ title: "Could not update step", description: err.message, variant: "destructive" });
    },
  });

  // Welcome email: login email + set-password link, once agreement + W-9 are in.
  const sendWelcomeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/providers/${providerId}/onboarding/send-welcome`);
      return res.json();
    },
    onSuccess: (d: any) => {
      toast({ title: "Welcome email sent", description: `${d.sent} provider admin(s) received their login and set-password link.`, variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/providers", providerId, "onboarding"] });
    },
    onError: (err: Error) => {
      toast({ title: "Could not send welcome email", description: err.message, variant: "destructive" });
    },
  });

  const sendTasksMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/providers/${providerId}/onboarding/send-tasks`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Onboarding tasks sent", description: "The provider now sees their setup tasks on their Home page.", variant: "success" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/providers", providerId, "onboarding"] });
    },
    onError: (err: Error) => {
      toast({ title: "Could not send tasks", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) return null;
  if (data.percent >= 100) return null;

  // Expanded by default while onboarding is early; collapses to the slim
  // progress bar once past halfway. A manual toggle always wins.
  const expanded = manuallyToggled ?? data.percent < 50;

  const navigate = (deepLink: string) => {
    const tab = /[?&]tab=([^&]+)/.exec(deepLink)?.[1];
    if (!tab) return;
    onNavigateTab(tab);
    // The checklist sits above the tab strip, so switching tabs alone leaves
    // the viewport parked on the checklist - scroll the selected tab (and the
    // content under it) into view once the new panel has rendered.
    requestAnimationFrame(() => {
      const el =
        document.querySelector(`[data-testid="tab-edit-${tab}"]`) ||
        document.querySelector('[role="tablist"]');
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const groups: OnboardingStep["group"][] = ["created", "admin_setup", "provider_setup", "go_live"];

  return (
    <Card className="p-4 mb-4 border-[hsl(var(--primary)/0.25)] bg-[hsl(var(--primary)/0.03)]" data-testid="onboarding-checklist">
      <button
        type="button"
        className="w-full flex items-center gap-3 text-left"
        onClick={() => setManuallyToggled(!expanded)}
        data-testid="onboarding-checklist-toggle"
      >
        <span className="w-9 h-9 rounded-full bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))] flex items-center justify-center shrink-0">
          <ListChecks className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium">
            Onboarding - {data.doneCount}/{data.requiredCount} required steps done
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
        <div className="mt-4 space-y-4">
          {groups.map((group) => {
            const steps = data.steps.filter((s) => s.group === group);
            if (!steps.length) return null;
            return (
              <div key={group}>
                <div className="t-helper font-medium uppercase tracking-wide mb-1.5">{GROUP_LABELS[group]}</div>
                <div className="space-y-1">
                  {steps.map((step) => {
                    const badge = statusBadge(step.status);
                    return (
                      <div
                        key={step.key}
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(step.deepLink)}
                        onKeyDown={(e) => { if (e.key === "Enter") navigate(step.deepLink); }}
                        className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-[var(--radius)] text-left cursor-pointer hover:bg-[hsl(var(--primary)/0.06)] transition-colors"
                        data-testid={`onboarding-step-${step.key}`}
                      >
                        {step.manuallyMarkable ? (
                          // Clickable check: mark an optional step done when there
                          // is nothing to set up in that section (click again to undo).
                          <button
                            type="button"
                            title={step.status === "done" ? (step.manuallyDone ? "Undo - reopen this step" : "Done") : "Mark as done - nothing to set up here"}
                            disabled={markMutation.isPending || (step.status === "done" && !step.manuallyDone)}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (step.status === "done" && !step.manuallyDone) return;
                              markMutation.mutate({ key: step.key, done: step.status !== "done" });
                            }}
                            className="shrink-0 rounded-full hover:scale-110 transition-transform disabled:hover:scale-100"
                            data-testid={`onboarding-mark-${step.key}`}
                          >
                            <StatusIcon status={step.status} />
                          </button>
                        ) : (
                          <StatusIcon status={step.status} />
                        )}
                        <span className="flex-1 min-w-0">
                          <span className={`block text-sm ${step.status === "done" ? "text-muted-foreground line-through decoration-[hsl(var(--brand-success)/0.5)]" : ""}`}>
                            {step.label}
                          </span>
                          <span className="t-helper block truncate">{step.detail}</span>
                        </span>
                        {step.manuallyMarkable && step.status !== "done" && (
                          <button
                            type="button"
                            disabled={markMutation.isPending}
                            onClick={(e) => { e.stopPropagation(); markMutation.mutate({ key: step.key, done: true }); }}
                            className="t-helper shrink-0 text-primary hover:underline"
                            data-testid={`onboarding-mark-link-${step.key}`}
                          >
                            Mark done
                          </button>
                        )}
                        {step.key === "welcome" && step.status === "pending" && (
                          <Button
                            size="sm"
                            className="h-7 shrink-0 text-xs"
                            disabled={sendWelcomeMutation.isPending}
                            onClick={(e) => { e.stopPropagation(); sendWelcomeMutation.mutate(); }}
                            data-testid="onboarding-send-welcome"
                          >
                            {sendWelcomeMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                            Send welcome email
                          </Button>
                        )}
                        {step.progress && (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 bg-secondary text-secondary-foreground" data-testid={`onboarding-progress-${step.key}`}>
                            {step.progress}
                          </span>
                        )}
                        {badge && (
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${badge.cls}`}>{badge.label}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="flex items-center gap-3 pt-1">
            <Button
              size="sm"
              disabled={sendTasksMutation.isPending}
              onClick={() => sendTasksMutation.mutate()}
              data-testid="button-send-onboarding-tasks"
            >
              {sendTasksMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
              {data.tasksSentAt ? "Re-send onboarding tasks" : "Send onboarding tasks to provider"}
            </Button>
            {data.tasksSentAt && (
              <span className="t-helper">Sent {new Date(data.tasksSentAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
