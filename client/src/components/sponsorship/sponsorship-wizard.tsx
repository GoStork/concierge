import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { formatMoneyCents } from "@/lib/format-money";
import { ModalShell, SponsorshipCheckout, CheckoutSuccessStep } from "./sponsorship-checkout";
import { Sparkles, Loader2, CreditCard, Check, ChevronRight, Users, UserRound, Stethoscope, Building2, TestTube } from "lucide-react";

type BillingMode = "AUTO_RENEW" | "ONE_TIME";
type EntityType = "EGG_DONOR" | "SURROGATE" | "SPERM_DONOR" | "DOCTOR";

const CATEGORY_META: Record<EntityType, { label: string; subtitle: string; icon: React.ReactNode }> = {
  EGG_DONOR: { label: "Egg Donors", subtitle: "Sponsor individual donor profiles", icon: <UserRound className="w-5 h-5" /> },
  SURROGATE: { label: "Surrogates", subtitle: "Sponsor individual surrogate profiles", icon: <Users className="w-5 h-5" /> },
  SPERM_DONOR: { label: "Sperm Donors", subtitle: "Sponsor individual donor profiles", icon: <TestTube className="w-5 h-5" /> },
  DOCTOR: { label: "Doctors", subtitle: "Sponsor individual doctor profiles", icon: <Stethoscope className="w-5 h-5" /> },
};

/** apiRequest throws errors like `400: {"message":"..."}`; surface just the message. */
function cleanError(e: any, fallback: string): string {
  const raw = e?.message || "";
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (j?.message) return String(j.message); } catch { /* ignore */ } }
  return raw.replace(/^\d{3}:\s*/, "") || fallback;
}

type Step = "category" | "tier" | "payment" | "success";

/**
 * Guided "Start Sponsorship" flow, used both on the Sponsorship tab and on each
 * profile tab (egg donors, surrogates, sperm donors, doctors). Steps:
 *   category (what to sponsor) -> tier (which plan, skipped for whole-profile)
 *   -> payment (Stripe) -> success (pick the specific profiles, or confirm).
 * Provider self-serve only; uses /api/sponsorship/* for the logged-in provider.
 */
export function StartSponsorshipWizard({ onClose, onChanged, initialEntityType }: {
  onClose: () => void;
  onChanged?: () => void;
  initialEntityType?: EntityType;
}) {
  const plansQ = useQuery<any[]>({ queryKey: ["/api/sponsorship/plans"] });
  const slotTypesQ = useQuery<{ type: string; label: string }[]>({
    queryKey: ["/api/sponsorship/slot-entity-types"],
    queryFn: async () => (await apiRequest("GET", "/api/sponsorship/slot-entity-types")).json(),
    retry: false,
  });
  const wholeProfilePlansQ = useQuery<any[]>({
    queryKey: ["/api/sponsorship/whole-profile-plans"],
    queryFn: async () => (await apiRequest("GET", "/api/sponsorship/whole-profile-plans")).json(),
    retry: false,
  });
  const savedCardQ = useQuery<{ brand: string | null; last4: string | null } | null>({
    queryKey: ["/api/sponsorship/payment-method"],
    queryFn: async () => (await apiRequest("GET", "/api/sponsorship/payment-method")).json(),
    retry: false,
  });
  const savedCard = savedCardQ.data;

  const applicableSlotTypes = (slotTypesQ.data || []).map((t) => t.type as EntityType);
  const wholeKeys = new Set((wholeProfilePlansQ.data || []).map((p: any) => p.tierKey));
  const allPlans = plansQ.data || [];
  const wholeProfiles = allPlans.filter((p) => p.productType === "WHOLE_PROFILE" && wholeKeys.has(p.tierKey));
  const tiersFor = (type: EntityType) =>
    allPlans.filter((p) => p.productType === "SLOT_BUNDLE" && p.slotEntityType === type).sort((a, b) => a.sortOrder - b.sortOrder);

  const canPreselect = !!initialEntityType && applicableSlotTypes.includes(initialEntityType);
  const [billingMode, setBillingMode] = useState<BillingMode>("AUTO_RENEW");
  const [step, setStep] = useState<Step>(canPreselect ? "tier" : "category");
  const [selectedType, setSelectedType] = useState<EntityType | null>(canPreselect ? initialEntityType! : null);
  const [selectedPlan, setSelectedPlan] = useState<any | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [sponsorshipId, setSponsorshipId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loading = plansQ.isLoading || slotTypesQ.isLoading || wholeProfilePlansQ.isLoading;
  const noOptions = !loading && applicableSlotTypes.length === 0 && wholeProfiles.length === 0;

  // Create the pending sponsorship + payment intent. If a saved card is charged
  // off-session the backend activates it immediately (no clientSecret) and we
  // jump straight to the success step.
  const startCheckout = async (plan: any) => {
    setBusy(true); setError(null);
    try {
      const res = await apiRequest("POST", "/api/sponsorship/checkout", { planId: plan.id, billingMode });
      const data = await res.json();
      setSelectedPlan(plan);
      setSponsorshipId(data.sponsorshipId || null);
      if (data.clientSecret) { setClientSecret(data.clientSecret); setStep("payment"); }
      else { setStep("success"); onChanged?.(); }
    } catch (e: any) {
      setError(cleanError(e, "Could not start checkout"));
    } finally { setBusy(false); }
  };

  const close = () => { onChanged?.(); onClose(); };
  const back = step === "tier" && !canPreselect
    ? () => { setStep("category"); setSelectedType(null); setSelectedPlan(null); setError(null); }
    : undefined;

  const billingToggle = (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Billing:</span>
      <div className="inline-flex rounded-lg border border-border overflow-hidden">
        {(["AUTO_RENEW", "ONE_TIME"] as BillingMode[]).map((m) => (
          <button key={m} onClick={() => setBillingMode(m)}
            className={`px-3 py-1.5 text-sm transition-colors ${billingMode === m ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
            data-testid={`wizard-billing-${m}`}>
            {m === "AUTO_RENEW" ? "Auto-renew monthly" : "One month"}
          </button>
        ))}
      </div>
    </div>
  );

  const savedCardNote = savedCard?.last4 ? (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <CreditCard className="w-3.5 h-3.5" />
      <span>Paying with your saved card {savedCard.brand ? `${savedCard.brand} ` : ""}••••{savedCard.last4}.</span>
    </div>
  ) : null;

  return (
    <ModalShell onClose={step === "payment" || step === "success" ? close : onClose} onBack={back} maxWidth="sm:max-w-lg">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading sponsorship options...
        </div>
      ) : noOptions ? (
        <div className="text-center space-y-2 py-6">
          <Sparkles className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No sponsorship options are available for your account yet.</p>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      ) : (
        <>
          {/* Step 1: what to sponsor */}
          {step === "category" && (
            <div className="space-y-4">
              <div>
                <h3 className="font-heading text-lg text-foreground flex items-center gap-2"><Sparkles className="w-5 h-5 text-accent" /> Start a sponsorship</h3>
                <p className="text-sm text-muted-foreground mt-0.5">What would you like to sponsor?</p>
              </div>
              {billingToggle}
              {savedCardNote}
              {error && <ErrorNote text={error} />}
              <div className="space-y-2">
                {applicableSlotTypes.map((type) => (
                  <CategoryRow key={type} icon={CATEGORY_META[type].icon} title={CATEGORY_META[type].label}
                    subtitle={CATEGORY_META[type].subtitle}
                    onClick={() => { setSelectedType(type); setSelectedPlan(null); setStep("tier"); setError(null); }}
                    testid={`wizard-category-${type}`} />
                ))}
                {wholeProfiles.map((p) => (
                  <CategoryRow key={p.id} icon={<Building2 className="w-5 h-5" />} title={p.displayName}
                    subtitle={`Boost your whole profile · ${formatMoneyCents(p.priceCents, p.currency)}/mo`}
                    busy={busy && selectedPlan?.id === p.id}
                    onClick={() => startCheckout(p)} testid={`wizard-category-${p.tierKey}`} />
                ))}
              </div>
            </div>
          )}

          {/* Step 2: which tier (slot bundles only) */}
          {step === "tier" && selectedType && (
            <div className="space-y-4">
              <div>
                <h3 className="font-heading text-lg text-foreground">{CATEGORY_META[selectedType].label} sponsorship</h3>
                <p className="text-sm text-muted-foreground mt-0.5">Choose how many profiles you want to feature.</p>
              </div>
              {billingToggle}
              {savedCardNote}
              {error && <ErrorNote text={error} />}
              <div className="space-y-2">
                {tiersFor(selectedType).map((p) => {
                  const selected = selectedPlan?.id === p.id;
                  return (
                    <button key={p.id} onClick={() => setSelectedPlan(p)}
                      className={`w-full text-left rounded-xl border p-4 transition-colors ${selected ? "border-primary ring-1 ring-primary bg-secondary/40" : "border-border hover:bg-secondary/40"}`}
                      data-testid={`wizard-tier-${p.tierKey}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="font-heading text-foreground">{p.displayName}</div>
                          <div className="text-xs text-muted-foreground">Up to {p.slotCount} sponsored profiles</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-ui text-foreground">{formatMoneyCents(p.priceCents, p.currency)}<span className="text-xs text-muted-foreground">/mo</span></span>
                          {selected && <Check className="w-4 h-4 text-primary" />}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <Button className="w-full" disabled={!selectedPlan || busy} onClick={() => selectedPlan && startCheckout(selectedPlan)} data-testid="wizard-to-payment">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CreditCard className="w-4 h-4 mr-1.5" /> Continue to payment</>}
              </Button>
            </div>
          )}

          {/* Step 3: payment */}
          {step === "payment" && clientSecret && (
            <div className="space-y-3">
              <div>
                <h3 className="font-heading text-lg text-foreground">{selectedPlan?.displayName}</h3>
                <p className="text-sm text-muted-foreground">Complete payment to activate your sponsorship.</p>
              </div>
              <SponsorshipCheckout clientSecret={clientSecret} onDone={() => { setStep("success"); onChanged?.(); }} onCancel={close} />
            </div>
          )}

          {/* Step 4: success + next step */}
          {step === "success" && (
            <CheckoutSuccessStep plan={selectedPlan} sponsorshipId={sponsorshipId || ""} onClose={close} />
          )}
        </>
      )}
    </ModalShell>
  );
}

function CategoryRow({ icon, title, subtitle, onClick, busy, testid }: { icon: React.ReactNode; title: string; subtitle: string; onClick: () => void; busy?: boolean; testid?: string }) {
  return (
    <button onClick={onClick} disabled={busy}
      className="w-full flex items-center gap-3 rounded-xl border border-border p-4 text-left hover:bg-secondary/40 transition-colors disabled:opacity-60"
      data-testid={testid}>
      <div className="w-10 h-10 rounded-lg bg-accent/15 text-accent flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="font-heading text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {busy ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
    </button>
  );
}

function ErrorNote({ text }: { text: string }) {
  return <div className="text-sm rounded-lg px-3 py-2" style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}>{text}</div>;
}

const NOUN_BY_ENTITY: Record<EntityType, string> = {
  EGG_DONOR: "egg donors", SURROGATE: "surrogates", SPERM_DONOR: "sperm donors", DOCTOR: "doctors",
};

/**
 * Emphasized promo card that wraps the Start Sponsorship button. Used on the
 * Sponsorship tab and atop each profile tab so the call-to-action stands out
 * with a branded accent background. Pass initialEntityType from a profile tab.
 */
export function BoostProfilesCard({ initialEntityType, onChanged, className }: {
  initialEntityType?: EntityType;
  onChanged?: () => void;
  className?: string;
}) {
  const noun = initialEntityType ? NOUN_BY_ENTITY[initialEntityType] : null;
  const desc = noun
    ? `Sponsor your ${noun} to rank them higher in the marketplace with a "Sponsored" badge and priority in the AI concierge.`
    : `Sponsor egg donors, surrogates, sperm donors, or your whole profile to rank higher in the marketplace.`;
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/15 via-secondary/50 to-card p-5 ${className || ""}`}>
      <div className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-accent/15 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-12 left-12 h-28 w-28 rounded-full bg-primary/10 blur-2xl" />
      <div className="relative flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/20 text-accent">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="font-heading text-base text-foreground">Boost your {noun || "profiles"}</div>
            <p className="max-w-xl text-sm text-muted-foreground">{desc}</p>
          </div>
        </div>
        <StartSponsorshipButton initialEntityType={initialEntityType} onChanged={onChanged} />
      </div>
    </div>
  );
}

/**
 * The single entry point. Renders a "Start Sponsorship" button that opens the
 * wizard. Drop it on the Sponsorship tab and on each profile tab; pass
 * initialEntityType from a profile tab to skip straight to that type's tiers.
 */
export function StartSponsorshipButton({ initialEntityType, label = "Start Sponsorship", onChanged, variant, size, className }: {
  initialEntityType?: EntityType;
  label?: string;
  onChanged?: () => void;
  variant?: any;
  size?: any;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)} data-testid="button-start-sponsorship">
        <Sparkles className="w-4 h-4 mr-1.5" /> {label}
      </Button>
      {open && <StartSponsorshipWizard initialEntityType={initialEntityType} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}
