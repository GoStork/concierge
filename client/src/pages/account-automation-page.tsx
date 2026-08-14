/**
 * /account/automation - every automation the org runs, in one place
 * (top to bottom):
 *
 *   #billing    - the deposit-to-agreement pipeline: cost sheet draft on
 *                 booking, invoice draft on parent-ready, agreement mode.
 *   #auto-reply - booking auto-reply rules (moved from its own tab).
 *   #silence    - the silence signal (CRM Phase 9 §5): per-stage quiet
 *                 thresholds, per-service-line on/off, Eva's check-in step.
 *
 * Deep links land on a section via ?section=<id> (URL param per the
 * tab/view-state rule); the Documents tab links here for agreement mode.
 * A provider edits their own org's settings; GoStork admin sees only the
 * silence section, where they edit the platform defaults every org inherits.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NumberInput } from "@/components/ui/number-input";
import ProviderAutoReplyTab from "@/components/provider-auto-reply-tab";
import { SERVICE_LINE_LABELS } from "@/components/parents/parent-crm-ui";
import { JOURNEY_STAGE_ORDER, JOURNEY_STAGE_LABELS, type JourneyStageId } from "@shared/journey-ladder";
import { Loader2, MoonStar, Zap, FileText } from "lucide-react";

interface SilenceSettings {
  isAdmin: boolean;
  enabled: boolean;
  evaEnabled: boolean;
  shadowSince: string | null;
  shadowActive: boolean;
  thresholds: Record<string, number | null>;
  lineEnabled: Record<string, boolean>;
}

interface AutomationDefaultValues {
  autoCostSheetDraft: boolean;
  autoInvoiceDraft: boolean;
  agreementAutomation: string;
}

interface AutomationFeatures {
  isAdminDefaults: boolean;
  defaults: AutomationDefaultValues;
  effective: AutomationDefaultValues;
  /** Org mode only; null = inherit the platform default. */
  overrides?: {
    autoCostSheetDraft: boolean | null;
    autoInvoiceDraft: boolean | null;
    agreementAutomation: string | null;
  };
  legacyAutoAgreementDraft?: boolean;
  gates: Record<string, boolean>;
}

const AGREEMENT_OPTIONS: Array<{ value: string; label: string; description: string }> = [
  {
    value: "off",
    label: "Off - I'll send agreements manually",
    description: "Nothing happens automatically. Send agreements from the + menu in each chat.",
  },
  {
    value: "approval",
    label: "Draft for my approval",
    description: "When a parent's deposit payment clears, your AI concierge drafts the agreement and posts it in the chat for you to approve before it's sent for signature.",
  },
  {
    value: "auto_send",
    label: "Fully automated",
    description: "When a parent's deposit payment clears, the agreement is generated AND sent for signature immediately - no approval step.",
  },
];

function SectionHeading({ id, title, subtitle }: { id: string; title: string; subtitle: string }) {
  return (
    <div id={id} className="scroll-mt-24">
      <h2 className="text-xl font-heading">{title}</h2>
      <p className="text-sm font-ui text-muted-foreground mt-1">{subtitle}</p>
    </div>
  );
}

function GatePausedNote({ active }: { active: boolean }) {
  if (active) return null;
  return (
    <span className="block t-helper" style={{ color: "hsl(var(--brand-warning))" }}>
      Currently paused platform-wide by GoStork - your setting is remembered and takes effect when it resumes.
    </span>
  );
}

// Admin-on-behalf-of mode: the admin provider edit page passes the target
// provider's id and every automation call carries ?providerId=.
const withOrg = (url: string, orgId?: string) =>
  orgId ? `${url}${url.includes("?") ? "&" : "?"}providerId=${encodeURIComponent(orgId)}` : url;

function SilenceSection({ orgId }: { orgId?: string }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<SilenceSettings>({
    queryKey: ["/api/automation/silence", orgId || "me"],
    queryFn: async () => {
      const res = await fetch(withOrg("/api/automation/silence", orgId), { credentials: "include" });
      if (!res.ok) throw new Error("Could not load automation settings");
      return res.json();
    },
    staleTime: 0,
  });

  const [enabled, setEnabled] = useState(true);
  const [evaEnabled, setEvaEnabled] = useState(true);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setEvaEnabled(data.evaEnabled);
    setThresholds(Object.fromEntries(
      Object.entries(data.thresholds).map(([k, v]) => [k, v === null ? "" : String(v)]),
    ));
    setLines(data.lineEnabled);
    setDirty(false);
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", withOrg("/api/automation/silence", orgId), {
        enabled,
        evaEnabled,
        thresholds: Object.fromEntries(
          Object.entries(thresholds).map(([k, v]) => [k, v === "" ? null : Number(v)]),
        ),
        lineEnabled: lines,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation/silence"] });
      toast({ title: "Automation settings saved" });
      setDirty(false);
    },
    onError: (e: any) => toast({ title: "Could not save", description: e?.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-sm font-ui text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading automation settings...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        id="silence"
        title="Silence signal"
        subtitle={`When a family goes quiet past their stage's threshold, Eva sends one warm check-in in their thread. If the quiet continues, a task lands on the lead owner - and both stop the instant the family replies.${data.isAdmin ? " You are editing the platform defaults; each agency can override them." : ""}`}
      />

      {data.shadowActive && (
        <div className="rounded-[var(--radius)] border border-border bg-secondary p-3 flex items-start gap-2">
          <MoonStar className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(var(--accent))" }} />
          <p className="text-sm font-ui">
            Eva's check-in is in its 7-day shadow period: it records who it would message, and sends
            nothing yet. The coordinator task is live already. Sending starts automatically when the
            window ends.
          </p>
        </div>
      )}

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-3">
        <label className="flex items-center justify-between gap-2 text-sm font-ui">
          <span>Silence automation</span>
          <Switch checked={enabled} onCheckedChange={(v) => { setEnabled(v); setDirty(true); }} data-testid="switch-silence-enabled" />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm font-ui">
          <span>
            Eva's check-in step
            <span className="block t-helper">Off = the coordinator task only, no message to the family.</span>
          </span>
          <Switch checked={evaEnabled} onCheckedChange={(v) => { setEvaEnabled(v); setDirty(true); }} data-testid="switch-silence-eva" />
        </label>
      </div>

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-2">
        <h3 className="text-sm font-heading">Quiet after, per stage</h3>
        <p className="t-helper">Days of quiet before the ladder starts. Leave blank for never.</p>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
          {JOURNEY_STAGE_ORDER.map((stage) => (
            <label key={stage} className="flex items-center justify-between gap-2 text-sm font-ui">
              <span>{JOURNEY_STAGE_LABELS[stage as JourneyStageId]}</span>
              <span className="flex items-center gap-1.5">
                <NumberInput
                  value={thresholds[stage] ?? ""}
                  onChange={(v) => { setThresholds((prev) => ({ ...prev, [stage]: v })); setDirty(true); }}
                  allowDecimal={false}
                  placeholder="never"
                  className="w-20 h-8 text-right"
                  data-testid={`input-threshold-${stage}`}
                />
                <span className="t-helper w-8">days</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-2">
        <h3 className="text-sm font-heading">Service lines</h3>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
          {Object.entries(SERVICE_LINE_LABELS).map(([line, label]) => (
            <label key={line} className="flex items-center justify-between gap-2 text-sm font-ui">
              <span>{label}</span>
              <Switch
                checked={lines[line] !== false}
                onCheckedChange={(v) => { setLines((prev) => ({ ...prev, [line]: v })); setDirty(true); }}
                data-testid={`switch-line-${line}`}
              />
            </label>
          ))}
        </div>
      </div>

      <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="btn-save-automation">
        {save.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
        Save settings
      </Button>
    </div>
  );
}

const MODE_LABELS: Record<string, string> = {
  off: "Off",
  approval: "Draft for approval",
  auto_send: "Fully automated",
};
const USE_DEFAULT = "__default__";

/**
 * The deposit-to-agreement pipeline's three automations, cascading like the
 * silence signal: GoStork admin (no orgId, no own org context) edits the
 * platform defaults; a provider org inherits them until it overrides. Cost
 * sheet and invoice drafts always post an approval card in the chat before
 * anything reaches the parent; agreement mode has its own ladder.
 */
function BillingAutomationSection({ orgId }: { orgId?: string }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useQuery<AutomationFeatures>({
    queryKey: ["/api/automation/features", orgId || "me"],
    queryFn: async () => {
      const res = await fetch(withOrg("/api/automation/features", orgId), { credentials: "include" });
      if (!res.ok) throw new Error("Could not load billing automation settings");
      return res.json();
    },
    staleTime: 0,
  });

  const saveFeature = useMutation({
    mutationFn: async (patch: {
      autoCostSheetDraft?: boolean | null;
      autoInvoiceDraft?: boolean | null;
      agreementAutomation?: string | null;
    }) => apiRequest("PUT", withOrg("/api/automation/features", orgId), patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation/features"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agreements/templates"] });
      toast({ title: "Automation setting saved" });
      setPendingMode(null);
    },
    onError: (e: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation/features"] });
      setPendingMode(null);
      toast({ title: "Could not save", description: e?.message, variant: "destructive" });
    },
  });

  const isDefaultsMode = data?.isAdminDefaults === true;
  // Selected radio: the org's own override, else "approval" when the legacy
  // rollout flag pins it, else "use the GoStork default". Defaults mode just
  // shows the default value itself.
  const settledMode = isDefaultsMode
    ? data?.defaults.agreementAutomation ?? "off"
    : data?.overrides?.agreementAutomation ?? (data?.legacyAutoAgreementDraft ? "approval" : USE_DEFAULT);
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const selectedMode = pendingMode ?? settledMode;

  /** One toggle row that knows whether the org is inheriting or overriding. */
  const FlagRow = ({ flag, title, helper }: {
    flag: "autoCostSheetDraft" | "autoInvoiceDraft";
    title: string;
    helper: string;
  }) => {
    if (!data) return null;
    const override = data.overrides?.[flag] ?? null;
    const defaultOn = data.defaults[flag];
    const checked = isDefaultsMode ? defaultOn : data.effective[flag];
    return (
      <label className="flex items-center justify-between gap-3 text-sm font-ui">
        <span>
          {title}
          <span className="block t-helper">{helper}</span>
          {!isDefaultsMode && (
            override === null ? (
              <span className="block t-helper" data-testid={`inherit-note-${flag}`}>
                Following GoStork's default (currently {defaultOn ? "on" : "off"}).
              </span>
            ) : (
              <span className="block t-helper" data-testid={`override-note-${flag}`}>
                Overriding GoStork's default ({defaultOn ? "on" : "off"}).{" "}
                <button
                  type="button"
                  className="underline text-primary"
                  onClick={(e) => { e.preventDefault(); saveFeature.mutate({ [flag]: null }); }}
                  data-testid={`btn-reset-${flag}`}
                >
                  Reset to default
                </button>
              </span>
            )
          )}
          <GatePausedNote active={data.gates[flag] !== false} />
        </span>
        <Switch
          checked={checked}
          disabled={saveFeature.isPending}
          onCheckedChange={(v) => saveFeature.mutate({ [flag]: v })}
          data-testid={`switch-${flag === "autoCostSheetDraft" ? "auto-cost-sheet" : "auto-invoice"}`}
        />
      </label>
    );
  };

  if (isError) {
    return (
      <div className="space-y-2">
        <SectionHeading
          id="billing"
          title="Documents & billing"
          subtitle="The paperwork pipeline, automated end to end."
        />
        <p className="text-sm font-ui" style={{ color: "hsl(var(--destructive))" }} data-testid="billing-automation-error">
          Could not load billing automation settings{(error as any)?.message ? ` - ${(error as any).message}` : ""}. Reload the page to retry.
        </p>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-sm font-ui text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading billing automation...
      </div>
    );
  }

  const agreementOptions = isDefaultsMode
    ? AGREEMENT_OPTIONS
    : [
        {
          value: USE_DEFAULT,
          label: `Use GoStork default (currently: ${MODE_LABELS[data.defaults.agreementAutomation] || "Off"})`,
          description: "Follow whatever GoStork sets platform-wide. Pick any option below to lock your own choice instead.",
        },
        ...AGREEMENT_OPTIONS,
      ];

  return (
    <div className="space-y-6">
      <SectionHeading
        id="billing"
        title="Documents & billing"
        subtitle={`The paperwork pipeline, automated end to end: a cost sheet when a call is booked, an invoice when the family is ready, and the agreement when their deposit clears.${isDefaultsMode ? " You are editing the platform defaults; each agency can override them." : ""}`}
      />

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-3">
        <FlagRow
          flag="autoCostSheetDraft"
          title="Cost sheet draft on booking"
          helper="When a parent books a consultation, the AI concierge drafts a personalized cost sheet and posts it in the chat for the provider to approve before the family sees it."
        />
        <FlagRow
          flag="autoInvoiceDraft"
          title="Invoice draft on parent-ready"
          helper="When a family signals they are ready to move forward, a deposit invoice is drafted and posted in the chat for the provider to approve before it's sent."
        />
      </div>

      <div className="rounded-[var(--radius)] border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-heading">Agreement automation</h3>
        </div>
        <p className="t-helper">Choose what happens when a parent's deposit payment clears.</p>
        <GatePausedNote active={data.gates.agreementAutomation !== false} />
        <div className="space-y-2">
          {agreementOptions.map(opt => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-[var(--radius)] border cursor-pointer transition-colors ${
                selectedMode === opt.value ? "border-primary bg-secondary/50" : "border-border hover:bg-secondary/30"
              }`}
            >
              <input
                type="radio"
                name="agreement-automation"
                value={opt.value}
                checked={selectedMode === opt.value}
                onChange={() => {
                  setPendingMode(opt.value);
                  saveFeature.mutate({ agreementAutomation: opt.value === USE_DEFAULT ? null : opt.value });
                }}
                className="mt-0.5 accent-primary"
                data-testid={`radio-agreement-automation-${opt.value === USE_DEFAULT ? "default" : opt.value}`}
              />
              <span>
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="t-helper block mt-0.5">{opt.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="t-helper flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5" />
          Agreement templates and signature fields live on the{" "}
          <Link to="/account/documents" className="underline text-primary">Documents tab</Link>.
        </p>
      </div>
    </div>
  );
}

const SECTION_IDS = ["silence", "auto-reply", "billing"] as const;

export default function AccountAutomationPage({ providerId: providerIdProp }: { providerId?: string } = {}) {
  const { user } = useAuth();
  // orgId is set only in admin-on-behalf-of mode (admin provider edit page);
  // providerId keeps its original meaning for the provider's own settings.
  const orgId = providerIdProp;
  const providerId = providerIdProp || (user as any)?.providerId || "";
  const [searchParams] = useSearchParams();
  const section = searchParams.get("section");
  const scrolledRef = useRef<string | null>(null);

  // ?section=<id> scrolls its section into view once per param value. The
  // sections load async, so retry briefly until the anchor exists.
  useEffect(() => {
    if (!section || !(SECTION_IDS as readonly string[]).includes(section)) return;
    if (scrolledRef.current === section) return;
    let tries = 0;
    const attempt = () => {
      const el = document.getElementById(section);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        scrolledRef.current = section;
      } else if (++tries < 20) {
        setTimeout(attempt, 150);
      }
    };
    attempt();
  }, [section]);

  // GoStork staff with no org context edit the platform defaults, so the
  // billing section renders for them even without a linked provider org.
  const isGostorkAdmin = (((user as any)?.roles || []) as string[]).some((r) => r === "GOSTORK_ADMIN" || r === "GOSTORK_CONCIERGE");

  return (
    <div className="space-y-10 max-w-3xl" data-testid="automation-page">
      {(providerId || isGostorkAdmin) && <BillingAutomationSection orgId={orgId} />}
      {providerId && (
        <>
          <div className="border-t border-border" />
          <div id="auto-reply" className="scroll-mt-24">
            <ProviderAutoReplyTab providerId={orgId} />
          </div>
          <div className="border-t border-border" />
        </>
      )}
      <SilenceSection orgId={orgId} />
    </div>
  );
}
