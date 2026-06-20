import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest } from "@/lib/queryClient";
import { formatMoneyCents } from "@/lib/format-money";
import { getPhotoSrc } from "@/lib/profile-utils";
import { SponsorshipCheckoutOverlay } from "./sponsorship-checkout";
import { StartSponsorshipButton } from "./sponsorship-wizard";
import {
  Sparkles, Eye, Heart, MessageCircle, Flame, TrendingUp, Loader2,
  Plus, X, ChevronDown, ChevronUp, Gift, CreditCard, User,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";

type BillingMode = "AUTO_RENEW" | "ONE_TIME";
type EntityType = "EGG_DONOR" | "SURROGATE" | "SPERM_DONOR" | "DOCTOR";

const SLOT_ENTITY_TYPES: { type: EntityType; label: string }[] = [
  { type: "EGG_DONOR", label: "Egg donors" },
  { type: "SURROGATE", label: "Surrogates" },
  { type: "SPERM_DONOR", label: "Sperm donors" },
  { type: "DOCTOR", label: "Doctors" },
];

const SLOT_TYPE_HEADERS: Record<string, string> = {
  EGG_DONOR: "Egg donor slots",
  SPERM_DONOR: "Sperm donor slots",
  SURROGATE: "Surrogate slots",
  DOCTOR: "Doctor slots",
};

/**
 * Shared sponsorship dashboard + management surface. Mounted standalone in two
 * places: the admin provider-edit "Sponsorship" tab (pass providerId + isAdmin)
 * and the provider self-serve /account/sponsorship page (no providerId).
 */
export function SponsorshipDashboard({ providerId, isAdmin = false }: { providerId?: string; isAdmin?: boolean }) {
  const qc = useQueryClient();

  // URL builders: admin routes carry ?providerId; provider self-serve is implicit.
  const base = isAdmin ? "/api/admin/sponsorship" : "/api/sponsorship";
  const withProvider = (qs = "") => (isAdmin ? `?providerId=${providerId}${qs ? `&${qs}` : ""}` : (qs ? `?${qs}` : ""));

  const plansQ = useQuery<any[]>({ queryKey: ["/api/sponsorship/plans"] });
  const listKey = isAdmin ? [`${base}`, providerId] : ["/api/sponsorship/mine"];
  const listQ = useQuery<any[]>({
    queryKey: listKey,
    queryFn: async () => (await apiRequest("GET", isAdmin ? `${base}${withProvider()}` : "/api/sponsorship/mine")).json(),
    enabled: !isAdmin || !!providerId,
  });
  const analyticsQ = useQuery<any>({
    queryKey: [`${base}/analytics`, providerId],
    queryFn: async () => (await apiRequest("GET", `${base}/analytics${withProvider()}`)).json(),
    enabled: !isAdmin || !!providerId,
  });

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: listKey });
    qc.invalidateQueries({ queryKey: [`${base}/analytics`, providerId] });
  };

  const a = analyticsQ.data;
  const kpis = a?.kpis;

  return (
    <div className="space-y-6" data-testid="sponsorship-dashboard">
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-accent" />
        <h2 className="text-xl font-heading text-foreground">Profile Sponsorship</h2>
      </div>
      <p className="text-sm text-muted-foreground -mt-4">
        Boost your profiles to the top of the marketplace with a "Sponsored" badge and priority in the AI concierge.
      </p>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard icon={<Sparkles className="w-4 h-4" />} label="Active sponsorships" value={kpis?.activeSponsorships ?? 0} />
        <KpiCard icon={<Eye className="w-4 h-4" />} label="Impressions" value={kpis?.totalImpressions ?? 0} hint="while sponsored" />
        <KpiCard icon={<Heart className="w-4 h-4" />} label="Saves" value={kpis?.saves ?? 0} />
        <KpiCard icon={<MessageCircle className="w-4 h-4" />} label="Inquiries" value={kpis?.inquiries ?? 0} hint="about sponsored profiles" />
        <KpiCard icon={<Flame className="w-4 h-4" />} label="Hot leads" value={kpis?.hotLeads ?? 0} hint="while sponsored" />
        <KpiCard icon={<TrendingUp className="w-4 h-4" />} label="Slots used" value={`${kpis?.slotsUsed ?? 0}/${kpis?.slotsTotal ?? 0}`} />
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        All metrics are measured only while you have an active sponsorship. Impressions, saves and inquiries are for your sponsored profiles; hot leads are an account-level signal during the sponsored period.
      </p>

      {/* Trend + funnel */}
      {a && (a.timeSeries?.length > 0 || (kpis?.totalImpressions ?? 0) > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Impressions over time</CardTitle></CardHeader>
            <CardContent className="h-56">
              {a.timeSeries?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={a.timeSeries} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => String(d).slice(5)} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="impressions" stroke="hsl(var(--accent))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <EmptyHint text="No impressions yet in the current period." />}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Engagement funnel</CardTitle></CardHeader>
            <CardContent className="space-y-2 pt-2">
              {(a.funnel || []).map((f: any) => {
                const max = a.funnel[0]?.value || 1;
                const pct = Math.max(2, Math.round((f.value / max) * 100));
                return (
                  <div key={f.stage}>
                    <div className="flex justify-between text-xs mb-1"><span>{f.stage}</span><span className="font-ui">{f.value}</span></div>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Per-profile breakdown */}
      {a?.perProfile?.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Sponsored profile performance</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Profile</TableHead><TableHead>Type</TableHead>
                  <TableHead className="text-right">Impressions</TableHead><TableHead className="text-right">Saves</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.perProfile.slice(0, 20).map((p: any) => (
                  <TableRow key={p.id} data-testid={`perprofile-${p.id}`}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell><Badge variant="secondary">{p.type}</Badge></TableCell>
                    <TableCell className="text-right">{p.impressions}</TableCell>
                    <TableCell className="text-right">{p.saves}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Start a sponsorship. Providers use the guided wizard; GoStork admins
          keep the per-plan Charge / Complimentary grid (a different surface). */}
      {isAdmin ? (
        <PlansSection
          plans={plansQ.data || []}
          isAdmin={isAdmin}
          providerId={providerId}
          base={base}
          onChanged={refetchAll}
        />
      ) : (
        <Card>
          <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="font-heading text-foreground">Boost your profiles</div>
              <p className="text-sm text-muted-foreground">Sponsor egg donors, surrogates, sperm donors, or your whole profile to rank higher in the marketplace.</p>
            </div>
            <StartSponsorshipButton onChanged={refetchAll} />
          </CardContent>
        </Card>
      )}

      {/* Active sponsorships + slot fill */}
      <ActiveSponsorships
        sponsorships={listQ.data || []}
        loading={listQ.isLoading}
        isAdmin={isAdmin}
        providerId={providerId}
        base={base}
        onChanged={refetchAll}
      />

      {/* History */}
      <HistorySection history={a?.history} />
    </div>
  );
}

function KpiCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1">{icon}<span>{label}</span></div>
        <div className="text-2xl font-heading text-foreground">{value}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">{text}</div>;
}

/** apiRequest throws errors like `400: {"message":"..."}`; surface just the message. */
function cleanError(e: any, fallback: string): string {
  const raw = e?.message || "";
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { const j = JSON.parse(m[0]); if (j?.message) return String(j.message); } catch { /* ignore */ }
  }
  return raw.replace(/^\d{3}:\s*/, "") || fallback;
}

// ─── Plans + checkout ────────────────────────────────────────────────────────

function PlansSection({ plans, isAdmin, providerId, base, onChanged }: {
  plans: any[]; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void;
}) {
  const [billingMode, setBillingMode] = useState<BillingMode>("AUTO_RENEW");
  const [checkout, setCheckout] = useState<{ plan: any; clientSecret: string; sponsorshipId: string } | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Saved card (Option B): if present, purchases auto-charge it with no re-entry.
  const pmUrl = isAdmin ? `${base}/payment-method?providerId=${providerId}` : `/api/sponsorship/payment-method`;
  const savedCardQ = useQuery<{ brand: string | null; last4: string | null } | null>({
    queryKey: [pmUrl],
    queryFn: async () => (await apiRequest("GET", pmUrl)).json(),
    enabled: !isAdmin || !!providerId,
    retry: false,
  });
  const savedCard = savedCardQ.data;

  const startCharge = async (plan: any) => {
    setError(null); setNotice(null); setBusyPlan(plan.id);
    try {
      if (isAdmin) {
        // Admin can't enter the provider's card - this sends them a payment
        // request to complete from their own dashboard.
        await apiRequest("POST", `${base}`, { providerId, planId: plan.id, billingMode, mode: "CHARGE" });
        setNotice("Payment request sent. The provider will complete payment from their Sponsorship page, then it activates.");
        onChanged();
        return;
      }
      const res = await apiRequest("POST", `${base}/checkout`, { planId: plan.id, billingMode });
      const data = await res.json();
      if (data.clientSecret) {
        setCheckout({ plan, clientSecret: data.clientSecret, sponsorshipId: data.sponsorshipId });
      } else {
        if (data.activated && data.savedCard?.last4) setNotice(`Charged your saved card ••••${data.savedCard.last4}. Sponsorship is now active.`);
        onChanged();
      }
    } catch (e: any) {
      setError(cleanError(e, "Could not start checkout"));
    } finally { setBusyPlan(null); }
  };

  const grantComp = async (planId: string, months: number) => {
    setError(null); setNotice(null); setBusyPlan(planId);
    try {
      await apiRequest("POST", `${base}`, { providerId, planId, mode: "COMP", months });
      setNotice(`Complimentary sponsorship granted free for ${months} month${months > 1 ? "s" : ""}.`);
      onChanged();
    } catch (e: any) {
      setError(cleanError(e, "Could not grant complimentary sponsorship"));
    } finally { setBusyPlan(null); }
  };

  // Whole-profile plans applicable to THIS provider's service types. A provider
  // that is both an IVF clinic and a surrogacy agency gets both; one that is
  // neither (egg-donor agency, sperm bank) gets none.
  const wpUrl = isAdmin ? `${base}/whole-profile-plans?providerId=${providerId}` : `/api/sponsorship/whole-profile-plans`;
  const wholeProfilePlansQ = useQuery<any[]>({
    queryKey: [wpUrl],
    queryFn: async () => (await apiRequest("GET", wpUrl)).json(),
    enabled: !isAdmin || !!providerId,
    retry: false,
  });
  const applicableWholeKeys = new Set((wholeProfilePlansQ.data || []).map((p: any) => p.tierKey));

  // The slot-fillable entity types this provider actually offers (donors,
  // surrogates, sperm donors, doctors) - drives the dynamic section label.
  const stUrl = isAdmin ? `${base}/slot-entity-types?providerId=${providerId}` : `/api/sponsorship/slot-entity-types`;
  const slotTypesQ = useQuery<{ type: string; label: string }[]>({
    queryKey: [stUrl],
    queryFn: async () => (await apiRequest("GET", stUrl)).json(),
    enabled: !isAdmin || !!providerId,
    retry: false,
  });
  const applicableSlotTypes = (slotTypesQ.data || []).map((t) => t.type);
  const hasClinic = applicableWholeKeys.has("whole_profile_ivf");
  const hasAgency = applicableWholeKeys.has("whole_profile_surrogacy");
  const wholeLabel = `Whole-profile boost (your ${[hasClinic && "clinic", hasAgency && "agency"].filter(Boolean).join(" / ") || "profile"})`;

  // Slot bundles are typed - show one group per sub-profile type the provider
  // offers, each with that type's tiers (egg/sperm donors are large, surrogates
  // and doctors small).
  const allBundles = plans.filter((p) => p.productType === "SLOT_BUNDLE");
  const bundleGroups = applicableSlotTypes
    .map((type) => ({
      type,
      label: SLOT_TYPE_HEADERS[type] || "Slots",
      tiers: allBundles.filter((p) => p.slotEntityType === type).sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .filter((g) => g.tiers.length > 0);
  const wholeProfiles = plans.filter((p) => p.productType === "WHOLE_PROFILE" && applicableWholeKeys.has(p.tierKey));

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Start a sponsorship</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {/* Billing mode toggle */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Billing:</span>
          <div className="inline-flex rounded-lg border border-border overflow-hidden">
            {(["AUTO_RENEW", "ONE_TIME"] as BillingMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setBillingMode(m)}
                className={`px-3 py-1.5 text-sm transition-colors ${billingMode === m ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-secondary"}`}
                data-testid={`billing-mode-${m}`}
              >
                {m === "AUTO_RENEW" ? "Auto-renew monthly" : "One month"}
              </button>
            ))}
          </div>
        </div>

        {savedCard?.last4 && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CreditCard className="w-4 h-4" />
            <span>Paying with your saved card {savedCard.brand ? `${savedCard.brand} ` : ""}••••{savedCard.last4} - no need to re-enter it.</span>
          </div>
        )}
        {notice && <div className="text-sm rounded-lg px-3 py-2" style={{ background: "hsl(var(--brand-success) / 0.1)", color: "hsl(var(--brand-success))" }}>{notice}</div>}
        {error && <div className="text-sm rounded-lg px-3 py-2" style={{ background: "hsl(var(--brand-error) / 0.1)", color: "hsl(var(--brand-error))" }}>{error}</div>}

        {bundleGroups.map((g) => (
          <div key={g.type}>
            <p className="text-base font-semibold text-foreground mb-2">{g.label}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {g.tiers.map((p) => (
                <PlanCard key={p.id} plan={p} busy={busyPlan === p.id} isAdmin={isAdmin}
                  onCharge={() => startCharge(p)} onComp={(months) => grantComp(p.id, months)} />
              ))}
            </div>
          </div>
        ))}

        {wholeProfiles.length > 0 && (
          <div>
            <p className="text-base font-semibold text-foreground mb-2">{wholeLabel}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {wholeProfiles.map((p) => (
                <PlanCard key={p.id} plan={p} busy={busyPlan === p.id} isAdmin={isAdmin}
                  onCharge={() => startCharge(p)} onComp={(months) => grantComp(p.id, months)} />
              ))}
            </div>
          </div>
        )}

      </CardContent>
      {checkout && (
        <SponsorshipCheckoutOverlay
          plan={checkout.plan}
          clientSecret={checkout.clientSecret}
          sponsorshipId={checkout.sponsorshipId}
          onClose={() => { setCheckout(null); onChanged(); setTimeout(() => savedCardQ.refetch(), 2500); }}
        />
      )}
    </Card>
  );
}

function PlanCard({ plan, busy, isAdmin, onCharge, onComp }: { plan: any; busy: boolean; isAdmin: boolean; onCharge: () => void; onComp: (months: number) => void }) {
  const [comping, setComping] = useState(false);
  const [months, setMonths] = useState(1);
  return (
    <div className="rounded-xl border border-border p-4 flex flex-col gap-2 bg-card" data-testid={`plan-${plan.tierKey}`}>
      <div className="flex items-baseline justify-between">
        <span className="font-heading text-foreground">{plan.displayName}</span>
        <span className="font-ui text-foreground">{formatMoneyCents(plan.priceCents, plan.currency)}<span className="text-xs text-muted-foreground">/mo</span></span>
      </div>
      <p className="text-xs text-muted-foreground">
        {plan.productType === "SLOT_BUNDLE" ? `Up to ${plan.slotCount} sponsored profiles` : "Boosts your top-level profile"}
      </p>
      <div className="flex gap-2 mt-auto pt-1">
        <Button size="sm" onClick={onCharge} disabled={busy} data-testid={`button-sponsor-${plan.tierKey}`}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CreditCard className="w-3.5 h-3.5 mr-1" /> {isAdmin ? "Charge" : "Sponsor"}</>}
        </Button>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => setComping((v) => !v)} disabled={busy} data-testid={`button-comp-${plan.tierKey}`}>
            <Gift className="w-3.5 h-3.5 mr-1" /> Complimentary
          </Button>
        )}
      </div>
      {isAdmin && comping && (
        <div className="mt-2 pt-2 border-t border-border flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Free for</span>
          <select value={months} onChange={(e) => setMonths(parseInt(e.target.value, 10))} className="h-8 rounded-md border border-input bg-background px-2 text-sm" data-testid={`comp-months-${plan.tierKey}`}>
            {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m} month{m > 1 ? "s" : ""}</option>)}
          </select>
          <Button size="sm" onClick={() => { onComp(months); setComping(false); }} disabled={busy} data-testid={`comp-grant-${plan.tierKey}`}>Grant free</Button>
          <Button size="sm" variant="ghost" onClick={() => setComping(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

// ─── Active sponsorships + slot fill ─────────────────────────────────────────

function ActiveSponsorships({ sponsorships, loading, isAdmin, providerId, base, onChanged }: {
  sponsorships: any[]; loading: boolean; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void;
}) {
  const active = sponsorships.filter((s) => s.status === "ACTIVE" || s.status === "PENDING_PAYMENT" || s.status === "PAST_DUE");
  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>;
  if (!active.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Your sponsorships</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {active.map((s) => (
          <SponsorshipRow key={s.id} s={s} isAdmin={isAdmin} providerId={providerId} base={base} onChanged={onChanged} />
        ))}
      </CardContent>
    </Card>
  );
}

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))]",
  PENDING_PAYMENT: "bg-[hsl(var(--brand-warning))]/15 text-[hsl(var(--brand-warning))]",
  PAST_DUE: "bg-destructive/15 text-destructive",
  EXPIRED: "bg-muted text-muted-foreground",
  CANCELED: "bg-muted text-muted-foreground",
};

const TAB_BY_TYPE: Record<string, string> = { EGG_DONOR: "egg-donors", SURROGATE: "surrogates", SPERM_DONOR: "sperm-donors" };

function SponsorshipRow({ s, isAdmin, providerId, base, onChanged }: { s: any; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  // Providers pick donors/surrogates/sperm donors in their full profile tab
  // (big cards, filters, search). Doctors and the admin view keep the inline picker.
  const profileTab = TAB_BY_TYPE[s.plan?.slotEntityType as string];
  const useTabPicker = !isAdmin && profileTab;
  const [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState<string | null>(null);
  const isBundle = s.productType === "SLOT_BUNDLE";
  const isPending = s.status === "PENDING_PAYMENT";

  const cancel = async () => {
    setBusy(true);
    try {
      const body = isAdmin ? { providerId, immediate: false } : { immediate: false };
      await apiRequest("POST", `${base}/${s.id}/cancel`, body);
      onChanged();
    } finally { setBusy(false); }
  };

  // Provider-only: complete payment on a pending (e.g. admin-requested) sponsorship.
  const completePayment = async () => {
    setBusy(true);
    try {
      const { clientSecret } = await (await apiRequest("POST", `/api/sponsorship/${s.id}/pay`)).json();
      if (clientSecret) setPayment(clientSecret);
    } finally { setBusy(false); }
  };

  // Discard an unpaid pending sponsorship so the provider can start a fresh one.
  const discard = async () => {
    setBusy(true);
    try {
      const body = isAdmin ? { providerId, immediate: true } : { immediate: true };
      await apiRequest("POST", `${base}/${s.id}/cancel`, body);
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-border p-3" data-testid={`sponsorship-${s.id}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge className={STATUS_STYLES[s.status] || ""}>{s.status.replace("_", " ")}</Badge>
          <span className="font-medium text-foreground">{s.plan?.displayName}</span>
          {s.isComped && <Badge variant="secondary"><Gift className="w-3 h-3 mr-1" />Complimentary</Badge>}
          {isBundle && <span className="text-xs text-muted-foreground">{s.slotsUsed}/{s.slotsTotal} slots</span>}
          {s.currentPeriodEnd && <span className="text-xs text-muted-foreground">renews/ends {new Date(s.currentPeriodEnd).toLocaleDateString()}</span>}
          {s.canceledAt && <span className="text-xs text-muted-foreground">(auto-renew off)</span>}
        </div>
        <div className="flex gap-2">
          {isPending && !isAdmin && !payment && (
            <Button size="sm" onClick={completePayment} disabled={busy} data-testid={`button-complete-payment-${s.id}`}>
              <CreditCard className="w-3.5 h-3.5 mr-1" /> Complete payment
            </Button>
          )}
          {isPending && (
            <Button size="sm" variant="ghost" onClick={discard} disabled={busy} data-testid={`button-discard-${s.id}`}>Discard</Button>
          )}
          {isBundle && useTabPicker && (
            <Button size="sm" variant="ghost" onClick={() => navigate(`/account/${profileTab}?sponsor=${s.id}`)} data-testid={`button-add-profiles-${s.id}`}>
              Add profiles <ChevronDown className="w-4 h-4 ml-1 -rotate-90" />
            </Button>
          )}
          {isBundle && !useTabPicker && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)} data-testid={`button-manage-slots-${s.id}`}>
              Manage slots {expanded ? <ChevronUp className="w-4 h-4 ml-1" /> : <ChevronDown className="w-4 h-4 ml-1" />}
            </Button>
          )}
          {s.status === "ACTIVE" && !s.canceledAt && (
            <Button size="sm" variant="outline" onClick={cancel} disabled={busy}>Cancel auto-renew</Button>
          )}
        </div>
      </div>
      {payment && (
        <SponsorshipCheckoutOverlay plan={s.plan} clientSecret={payment} sponsorshipId={s.id} onClose={() => { setPayment(null); onChanged(); }} />
      )}
      {expanded && isBundle && (
        <SlotManager s={s} isAdmin={isAdmin} providerId={providerId} base={base} onChanged={onChanged} />
      )}
    </div>
  );
}

function SlotManager({ s, isAdmin, providerId, base, onChanged }: { s: any; isAdmin: boolean; providerId?: string; base: string; onChanged: () => void }) {
  // A typed bundle has a single sub-profile type - fill it from that type only.
  const bundleType: EntityType = (s.plan?.slotEntityType as EntityType) || "EGG_DONOR";
  const eligibleUrl = isAdmin
    ? `${base}/eligible-entities?providerId=${providerId}&type=${bundleType}`
    : `/api/sponsorship/eligible-entities?type=${bundleType}`;
  const eligibleQ = useQuery<any[]>({
    queryKey: [eligibleUrl],
    queryFn: async () => (await apiRequest("GET", eligibleUrl)).json(),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const filledIds = new Set((s.items || []).map((it: any) => it.entityId));
  const slotsFull = (s.items?.length || 0) >= s.slotCountSnapshot;
  const nameById = new Map<string, string>(((eligibleQ.data as any[]) || []).map((e: any) => [e.id, e.displayName]));

  const addItem = async (entityId: string) => {
    setBusyId(entityId);
    try {
      const body = isAdmin ? { providerId, entityType: bundleType, entityId } : { entityType: bundleType, entityId };
      await apiRequest("POST", `${base}/${s.id}/items`, body);
      onChanged();
    } finally { setBusyId(null); }
  };
  const removeItem = async (item: any) => {
    setBusyId(item.id);
    try {
      const url = isAdmin ? `${base}/${s.id}/items/${item.id}?providerId=${providerId}` : `/api/sponsorship/${s.id}/items/${item.id}`;
      await apiRequest("DELETE", url);
      onChanged();
    } finally { setBusyId(null); }
  };

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-3">
      {/* Filled slots */}
      {s.items?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {s.items.map((it: any) => (
            <Badge key={it.id} variant="secondary" className="gap-1 pr-1">
              {nameById.get(it.entityId) || it.entityType.replace("_", " ").toLowerCase()}
              <button onClick={() => removeItem(it)} disabled={busyId === it.id} className="ml-1 hover:text-destructive" data-testid={`remove-item-${it.id}`}>
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {slotsFull && <p className="text-xs text-[hsl(var(--brand-warning))]">All slots filled. Remove one to add another.</p>}
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
        {eligibleQ.isLoading && <div className="p-3 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> Loading...</div>}
        {eligibleQ.data?.length === 0 && <div className="p-3 text-sm text-muted-foreground">No profiles of this type.</div>}
        {(eligibleQ.data || []).map((e: any) => {
          const filled = filledIds.has(e.id);
          return (
            <div key={e.id} className="flex items-center justify-between gap-2 px-3 py-2" data-testid={`eligible-${e.id}`}>
              <div className="flex items-center gap-2 min-w-0">
                {e.photoUrl ? (
                  <img src={getPhotoSrc(e.photoUrl ?? undefined) ?? undefined} alt="" className="w-9 h-9 rounded-full object-cover shrink-0 bg-secondary" loading="lazy" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center shrink-0"><User className="w-4 h-4 text-muted-foreground" /></div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                    {e.displayName}{e.sponsored && <Sparkles className="w-3 h-3 text-accent shrink-0" />}
                  </div>
                  {e.subtitle && <div className="text-xs text-muted-foreground truncate">{e.subtitle}</div>}
                </div>
              </div>
              {filled ? (
                <Badge variant="secondary" className="text-xs shrink-0">In this bundle</Badge>
              ) : (
                <Button size="sm" variant="ghost" className="shrink-0" disabled={busyId === e.id || slotsFull} onClick={() => addItem(e.id)} data-testid={`add-eligible-${e.id}`}>
                  {busyId === e.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── History ─────────────────────────────────────────────────────────────────

function HistorySection({ history }: { history?: { sponsorships: any[]; invoices: any[] } }) {
  if (!history?.sponsorships?.length) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-ui">Sponsorship history</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead><TableHead>Status</TableHead><TableHead>Billing</TableHead>
              <TableHead className="text-right">Amount</TableHead><TableHead>Period</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.sponsorships.map((s) => (
              <TableRow key={s.id} data-testid={`history-${s.id}`}>
                <TableCell className="font-medium">{s.tier}{s.isComped && <Gift className="w-3 h-3 inline ml-1" />}</TableCell>
                <TableCell><Badge className={STATUS_STYLES[s.status] || ""}>{String(s.status).replace("_", " ")}</Badge></TableCell>
                <TableCell className="text-xs">{s.billingMode === "AUTO_RENEW" ? "Auto-renew" : "One month"}</TableCell>
                <TableCell className="text-right">{s.isComped ? "Free" : formatMoneyCents(s.priceCents)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {s.currentPeriodStart ? new Date(s.currentPeriodStart).toLocaleDateString() : "-"}
                  {s.currentPeriodEnd ? ` - ${new Date(s.currentPeriodEnd).toLocaleDateString()}` : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
