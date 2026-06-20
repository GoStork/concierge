import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { apiRequest } from "@/lib/queryClient";
import { Sparkles, Plus, Trash2, Loader2, Check } from "lucide-react";

/**
 * GoStork-admin view of /account/sponsorship: manage the sponsorship PROGRAMS
 * (plans + pricing) that apply to every provider. Create/edit/delete slot-bundle
 * tiers and edit the whole-profile boost prices. This is global config - it is
 * NOT the provider purchase flow (that lives on each provider's own account, and
 * per-provider management is under the admin provider page's Sponsorship tab).
 */
export function SponsorshipPlanManager() {
  const plansQ = useQuery<any[]>({
    queryKey: ["/api/admin/sponsorship/plans"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/sponsorship/plans")).json(),
  });
  const [adding, setAdding] = useState(false);

  const refetch = () => plansQ.refetch();
  const plans = plansQ.data || [];
  const bundles = plans.filter((p) => p.productType === "SLOT_BUNDLE").sort((a, b) => a.sortOrder - b.sortOrder);
  const wholeProfiles = plans.filter((p) => p.productType === "WHOLE_PROFILE").sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="space-y-6" data-testid="sponsorship-plan-manager">
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-accent" />
        <h2 className="text-xl font-heading text-foreground">Sponsorship Programs</h2>
      </div>
      <p className="text-sm text-muted-foreground -mt-4">
        Pricing and slots for every provider. Price changes apply to <strong>new</strong> sponsorships only - existing
        subscriptions keep the price they signed up at.
      </p>

      {plansQ.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>}

      {/* Slot bundles */}
      <Card>
        <CardHeader className="pb-2 flex-row items-center justify-between">
          <CardTitle className="text-base font-semibold text-foreground">Slot bundles</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)} data-testid="button-add-plan">
            <Plus className="w-4 h-4 mr-1" /> Add tier
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {adding && <NewBundleForm onDone={() => { setAdding(false); refetch(); }} onCancel={() => setAdding(false)} />}
          {bundles.map((p) => <PlanRow key={p.id} plan={p} onChanged={refetch} />)}
          {!bundles.length && !plansQ.isLoading && <p className="text-sm text-muted-foreground">No slot-bundle tiers yet.</p>}
        </CardContent>
      </Card>

      {/* Whole-profile */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base font-semibold text-foreground">Whole-profile boosts</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Per-type pricing for boosting a provider's own clinic or agency profile.</p>
          {wholeProfiles.map((p) => <PlanRow key={p.id} plan={p} onChanged={refetch} />)}
          {!wholeProfiles.length && !plansQ.isLoading && <p className="text-sm text-muted-foreground">No whole-profile plans configured.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function PlanRow({ plan, onChanged }: { plan: any; onChanged: () => void }) {
  const isBundle = plan.productType === "SLOT_BUNDLE";
  const [name, setName] = useState(plan.displayName);
  const [price, setPrice] = useState(String((plan.priceCents / 100)));
  const [slots, setSlots] = useState(String(plan.slotCount));
  const [active, setActive] = useState(!!plan.isActive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name !== plan.displayName
    || Math.round(parseFloat(price || "0") * 100) !== plan.priceCents
    || (isBundle && parseInt(slots || "0", 10) !== plan.slotCount)
    || active !== plan.isActive;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body: any = { displayName: name, priceCents: Math.round(parseFloat(price || "0") * 100), isActive: active };
      if (isBundle) body.slotCount = parseInt(slots || "0", 10);
      await apiRequest("PATCH", `/api/admin/sponsorship/plans/${plan.id}`, body);
      onChanged();
    } catch (e: any) { setError(e.message || "Could not save"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const res = await apiRequest("DELETE", `/api/admin/sponsorship/plans/${plan.id}`);
      const data = await res.json();
      if (data.deactivated) setError(data.message || "Plan deactivated (in use).");
      onChanged();
    } catch (e: any) { setError(e.message || "Could not delete"); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-border p-3 space-y-2" data-testid={`plan-${plan.tierKey}`}>
      <div className="flex items-end gap-3 flex-wrap">
        <div className="min-w-[160px]">
          <label className="text-xs text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9" data-testid={`plan-name-${plan.tierKey}`} />
        </div>
        <div className="w-28">
          <label className="text-xs text-muted-foreground">Price / mo ($)</label>
          <NumberInput value={price} onChange={setPrice} className="h-9" data-testid={`plan-price-${plan.tierKey}`} />
        </div>
        {isBundle && (
          <div className="w-24">
            <label className="text-xs text-muted-foreground">Slots</label>
            <NumberInput value={slots} onChange={setSlots} allowDecimal={false} className="h-9" data-testid={`plan-slots-${plan.tierKey}`} />
          </div>
        )}
        <button
          onClick={() => setActive((v) => !v)}
          className={`h-9 px-3 rounded-md text-sm border transition-colors ${active ? "border-[hsl(var(--brand-success))]/40 text-[hsl(var(--brand-success))] bg-[hsl(var(--brand-success))]/10" : "border-border text-muted-foreground bg-muted"}`}
          data-testid={`plan-active-${plan.tierKey}`}
        >
          {active ? "Active" : "Inactive"}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono">{plan.tierKey}</span>
          <Button size="sm" onClick={save} disabled={!dirty || busy} data-testid={`plan-save-${plan.tierKey}`}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Check className="w-4 h-4 mr-1" />Save</>}
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={busy} className="text-destructive hover:text-destructive" data-testid={`plan-delete-${plan.tierKey}`}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-[hsl(var(--brand-warning))]">{error}</p>}
    </div>
  );
}

function NewBundleForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [tierKey, setTierKey] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [slots, setSlots] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      await apiRequest("POST", "/api/admin/sponsorship/plans", {
        productType: "SLOT_BUNDLE",
        tierKey: tierKey.trim().toLowerCase().replace(/\s+/g, "_"),
        displayName: name.trim(),
        priceCents: Math.round(parseFloat(price || "0") * 100),
        slotCount: parseInt(slots || "0", 10),
      });
      onDone();
    } catch (e: any) { setError(e.message || "Could not create"); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-dashed border-primary/40 bg-secondary/30 p-3 space-y-2">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="w-32"><label className="text-xs text-muted-foreground">Key</label><Input value={tierKey} onChange={(e) => setTierKey(e.target.value)} placeholder="enterprise" className="h-9" data-testid="new-plan-key" /></div>
        <div className="min-w-[140px]"><label className="text-xs text-muted-foreground">Name</label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enterprise" className="h-9" data-testid="new-plan-name" /></div>
        <div className="w-28"><label className="text-xs text-muted-foreground">Price / mo ($)</label><NumberInput value={price} onChange={setPrice} className="h-9" data-testid="new-plan-price" /></div>
        <div className="w-24"><label className="text-xs text-muted-foreground">Slots</label><NumberInput value={slots} onChange={setSlots} allowDecimal={false} className="h-9" data-testid="new-plan-slots" /></div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={create} disabled={busy || !tierKey || !name || !price || !slots} data-testid="new-plan-create">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create tier"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
      {error && <p className="text-xs text-[hsl(var(--brand-warning))]">{error}</p>}
    </div>
  );
}
