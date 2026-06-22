import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { getPhotoSrc } from "@/lib/profile-utils";
import { BoostProfilesCard } from "@/components/sponsorship/sponsorship-wizard";
import {
  Loader2, Sparkles, RefreshCw, User, Search, Award, Stethoscope, BadgeCheck, ChevronDown,
} from "lucide-react";

type SortKey = "name" | "medical-director" | "most-reviewed";

const SORT_LABELS: Record<SortKey, string> = {
  name: "Name (A-Z)",
  "medical-director": "Medical directors first",
  "most-reviewed": "Most reviewed",
};

/**
 * Provider self-serve "Doctors" tab. Mirrors the egg-donor / surrogate profile
 * tabs (Start Sponsorship bar on top + a searchable / filterable records grid)
 * but sourced from ProviderMember rows (doctors) with doctor-relevant filters.
 * Sponsoring works exactly like the donor tabs: the Sparkles toggle adds a
 * doctor to the active DOCTOR bundle, and ?sponsor=<id> drives campaign mode.
 */
export default function DoctorsDatabasePanel({ providerId }: { providerId: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = !!(user as any)?.roles?.includes("GOSTORK_ADMIN");
  const isProvider = !!((user as any)?.providerId);

  const membersUrl = `/api/providers/${providerId}/members`;
  const membersQ = useQuery<any[]>({
    queryKey: [membersUrl],
    queryFn: async () => (await apiRequest("GET", membersUrl)).json(),
    enabled: !!providerId,
  });
  // Only public doctor profiles are marketplace-visible and sponsorable.
  const doctors = useMemo(() => (membersQ.data || []).filter((m) => m.isPublicProfile !== false), [membersQ.data]);

  // ─── Filters ───────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [location, setLocation] = useState("");
  const [acceptingOnly, setAcceptingOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("medical-director");

  const specialtyOptions = useMemo(() => {
    const set = new Set<string>();
    doctors.forEach((d) => (d.specialties || []).forEach((s: string) => s && set.add(s)));
    return Array.from(set).sort();
  }, [doctors]);
  const locationOptions = useMemo(() => {
    const set = new Set<string>();
    doctors.forEach((d) => (d.locations || []).forEach((l: any) => {
      const loc = l.location;
      const label = loc?.city && loc?.state ? `${loc.city}, ${loc.state}` : loc?.state || loc?.city;
      if (label) set.add(label);
    }));
    return Array.from(set).sort();
  }, [doctors]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = doctors.filter((d) => {
      if (q) {
        const hay = [d.name, d.title, ...(d.specialties || [])].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (specialty && !(d.specialties || []).includes(specialty)) return false;
      if (location) {
        const has = (d.locations || []).some((l: any) => {
          const loc = l.location;
          const label = loc?.city && loc?.state ? `${loc.city}, ${loc.state}` : loc?.state || loc?.city;
          return label === location;
        });
        if (!has) return false;
      }
      if (acceptingOnly && d.acceptingNewPatients === false) return false;
      return true;
    });
    rows = [...rows].sort((a, b) => {
      // Sponsored always pins to the top, like the marketplace + donor tabs.
      const aSp = a.sponsoredUntil && new Date(a.sponsoredUntil).getTime() > Date.now() ? 1 : 0;
      const bSp = b.sponsoredUntil && new Date(b.sponsoredUntil).getTime() > Date.now() ? 1 : 0;
      if (aSp !== bSp) return bSp - aSp;
      if (sort === "most-reviewed") return (b.reviewCount || 0) - (a.reviewCount || 0);
      if (sort === "medical-director") {
        const aMd = a.isMedicalDirector ? 1 : 0, bMd = b.isMedicalDirector ? 1 : 0;
        if (aMd !== bMd) return bMd - aMd;
      }
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
    return rows;
  }, [doctors, search, specialty, location, acceptingOnly, sort]);

  // ─── Sponsorship (mirrors the donor ProfileCardGrid) ─────────────────────────
  const [searchParams] = useSearchParams();
  const inCampaignMode = !!searchParams.get("sponsor");
  const showStartSponsorship = isProvider && !isAdmin && !inCampaignMode;
  const sponsorshipTabUrl = isAdmin ? `/admin/providers/${providerId}?tab=sponsorship` : `/account/sponsorship`;
  const campaignId = !isAdmin ? searchParams.get("sponsor") : null;
  const campaignQ = useQuery<any>({
    queryKey: [`/api/sponsorship/campaign/${campaignId}`],
    queryFn: async () => (await apiRequest("GET", `/api/sponsorship/campaign/${campaignId}`)).json(),
    enabled: !!campaignId,
    retry: false,
  });
  const campaign = campaignQ.data && campaignQ.data.slotEntityType === "DOCTOR" ? campaignQ.data : null;
  const campaignItemByEntity = new Map<string, string>((campaign?.items || []).map((it: any) => [it.entityId, it.id]));
  const campaignFull = campaign ? (campaign.slotsUsed ?? 0) >= (campaign.slotsTotal ?? 0) : false;
  const [busyId, setBusyId] = useState<string | null>(null);

  const refetchCampaign = () => { campaignQ.refetch(); queryClient.invalidateQueries({ queryKey: [membersUrl] }); };

  const handleSponsor = async (doctorId: string) => {
    setBusyId(doctorId);
    try {
      if (campaign) {
        const existingItemId = campaignItemByEntity.get(doctorId);
        if (existingItemId) {
          await apiRequest("DELETE", `/api/sponsorship/${campaign.id}/items/${existingItemId}`);
          toast({ title: "Removed from sponsorship" });
        } else {
          // Slots full: the sticky banner already explains this - don't fire a toast.
          if (campaignFull) return;
          await apiRequest("POST", `/api/sponsorship/${campaign.id}/items`, { entityType: "DOCTOR", entityId: doctorId });
          toast({ title: "Added to sponsorship", variant: "success" });
        }
        refetchCampaign();
        return;
      }
      const listUrl = isAdmin ? `/api/admin/sponsorship?providerId=${providerId}` : `/api/sponsorship/mine`;
      const list = await (await apiRequest("GET", listUrl)).json();
      const bundle = (list || []).find((s: any) => s.status === "ACTIVE" && s.productType === "SLOT_BUNDLE" && s.plan?.slotEntityType === "DOCTOR" && (s.slotsUsed ?? 0) < (s.slotsTotal ?? 0));
      if (!bundle) {
        toast({ title: "No open sponsorship slot", description: "Opening the Sponsorship tab to start or manage a plan." });
        navigate(sponsorshipTabUrl);
        return;
      }
      const body = isAdmin ? { providerId, entityType: "DOCTOR", entityId: doctorId } : { entityType: "DOCTOR", entityId: doctorId };
      const itemsUrl = isAdmin ? `/api/admin/sponsorship/${bundle.id}/items` : `/api/sponsorship/${bundle.id}/items`;
      await apiRequest("POST", itemsUrl, body);
      queryClient.invalidateQueries({ queryKey: [membersUrl] });
      toast({ title: "Doctor sponsored", description: `Added to ${bundle.plan?.displayName || "your plan"}.`, variant: "success" });
    } catch (err: any) {
      toast({ title: "Could not update sponsorship", description: err.message, variant: "destructive" });
    } finally { setBusyId(null); }
  };

  if (membersQ.isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="w-4 h-4 animate-spin" /> Loading doctors...</div>;
  }

  return (
    <div>
      {showStartSponsorship && (
        <BoostProfilesCard initialEntityType="DOCTOR" onChanged={() => membersQ.refetch()} className="mb-4" />
      )}

      {campaign && (
        <div className="sticky top-0 md:top-16 z-40 -mx-1 mb-4 relative overflow-hidden rounded-lg border border-accent/40 bg-card shadow-md">
          {/* Opaque card base + accent tint overlay = readable light-purple bar
              that the scrolling cards underneath can't bleed through. */}
          <div className="pointer-events-none absolute inset-0 bg-accent/10" />
          <div className="relative flex items-center justify-between gap-3 flex-wrap px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm">
              <Sparkles className="w-4 h-4 text-accent" />
              <span className="text-foreground">Selecting doctors for <strong>{campaign.planName}</strong></span>
              <Badge variant="secondary">{campaign.slotsUsed}/{campaign.slotsTotal} slots</Badge>
            </div>
            <p className="text-xs hidden md:block">
              {campaignFull
                ? <span className="text-[hsl(var(--brand-warning))]">All slots filled - remove a doctor to add another, or upgrade your tier.</span>
                : <span className="text-muted-foreground inline-flex items-center gap-1">
                    Tap the
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius)] border border-accent/50 bg-accent/10 text-accent"><Sparkles className="w-3 h-3" /></span>
                    on a card to add or remove it.
                  </span>}
            </p>
            <Button size="sm" onClick={() => navigate("/account/sponsorship")} data-testid="button-done-selecting">Done</Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h4 className="font-heading text-sm" data-testid="doctors-table-title">
          Doctor Records ({doctors.length})
          {filtered.length !== doctors.length && (
            <span className="text-muted-foreground font-normal ml-1">- showing {filtered.length}</span>
          )}
        </h4>
        {doctors.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => membersQ.refetch()} disabled={membersQ.isFetching} data-testid="btn-refresh-doctors">
            <RefreshCw className={`w-4 h-4 mr-1 ${membersQ.isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        )}
      </div>

      {/* Filter bar - same pill style as the other tabs, doctor-relevant filters */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by doctor or specialty"
            className="pl-9 rounded-full w-64" data-testid="input-search-doctors" />
        </div>
        <PillSelect value={specialty} onChange={setSpecialty} placeholder="Specialty" options={specialtyOptions} icon={<Stethoscope className="w-4 h-4" />} testid="filter-specialty" />
        {locationOptions.length > 0 && (
          <PillSelect value={location} onChange={setLocation} placeholder="Location" options={locationOptions} testid="filter-location" />
        )}
        <button onClick={() => setAcceptingOnly((v) => !v)} data-testid="filter-accepting"
          className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm transition-colors ${acceptingOnly ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-secondary"}`}>
          <BadgeCheck className="w-4 h-4" /> Accepting new patients
        </button>
        <PillSelect value={sort} onChange={(v) => setSort(v as SortKey)} placeholder="Sort"
          options={(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ value: k, label: SORT_LABELS[k] }))}
          allowClear={false} testid="filter-sort" />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {doctors.length === 0 ? "No doctor profiles yet. Add doctors from the Team tab." : "No doctors match your filters."}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {filtered.map((d) => (
            <DoctorRecordCard
              key={d.id}
              doctor={d}
              sponsored={campaign ? campaignItemByEntity.has(d.id) : (!!d.sponsoredUntil && new Date(d.sponsoredUntil).getTime() > Date.now())}
              busy={busyId === d.id}
              campaignMode={!!campaign}
              onSponsor={() => handleSponsor(d.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PillSelect({ value, onChange, placeholder, options, icon, allowClear = true, testid }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: (string | { value: string; label: string })[];
  icon?: React.ReactNode;
  allowClear?: boolean;
  testid?: string;
}) {
  const norm = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const selectedLabel = norm.find((o) => o.value === value)?.label;
  const active = !!value;
  return (
    <div className="relative inline-flex items-center">
      {icon && <span className="pointer-events-none absolute left-3 text-muted-foreground">{icon}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid}
        className={`appearance-none rounded-full border px-4 py-2 pr-9 text-sm transition-colors cursor-pointer ${icon ? "pl-9" : ""} ${active ? "border-primary text-foreground bg-secondary" : "border-border bg-card text-foreground hover:bg-secondary"}`}>
        {allowClear && <option value="">{placeholder}</option>}
        {norm.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="w-4 h-4 absolute right-3 pointer-events-none text-muted-foreground" />
    </div>
  );
}

function DoctorRecordCard({ doctor, sponsored, busy, campaignMode, onSponsor }: {
  doctor: any;
  sponsored: boolean;
  busy: boolean;
  campaignMode: boolean;
  onSponsor: () => void;
}) {
  const photo = getPhotoSrc((doctor.highResPhotoUrl || doctor.photoUrl) ?? undefined) ?? undefined;
  const specialties: string[] = doctor.specialties || [];
  const loc = doctor.locations?.[0]?.location;
  const locLabel = loc?.city && loc?.state ? `${loc.city}, ${loc.state}` : loc?.state || loc?.city;
  return (
    <div
      onClick={campaignMode ? onSponsor : undefined}
      className={`relative overflow-hidden rounded-2xl border bg-card flex flex-col h-full ${campaignMode ? "cursor-pointer" : ""} ${sponsored ? "border-accent ring-1 ring-accent/40" : "border-border"}`}
      data-testid={`doctor-card-${doctor.id}`}
    >
      {/* Fixed square box via inline aspect-ratio + absolute image, so every card
          gets an identical photo height regardless of the source image's shape. */}
      <div className="relative w-full shrink-0 overflow-hidden bg-secondary" style={{ aspectRatio: "1 / 1" }}>
        {photo ? (
          <img src={photo} alt={doctor.name} className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center"><User className="w-10 h-10 text-muted-foreground" /></div>
        )}
        {sponsored && (
          <Badge className="absolute top-2 left-2 bg-accent text-accent-foreground gap-1"><Sparkles className="w-3 h-3" /> Sponsored</Badge>
        )}
        <button onClick={(e) => { e.stopPropagation(); onSponsor(); }} disabled={busy} data-testid={`button-sponsor-doctor-${doctor.id}`}
          title={campaignMode ? (sponsored ? "Remove from sponsorship" : "Add to sponsorship") : "Sponsor this doctor"}
          className={`absolute top-2 right-2 w-9 h-9 rounded-full flex items-center justify-center shadow-sm transition-colors ${sponsored ? "bg-accent text-accent-foreground" : "bg-card/90 text-foreground hover:bg-card"}`}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        </button>
      </div>
      <div className="p-3 flex flex-col gap-1.5 flex-1">
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <div className="font-heading text-sm text-foreground truncate flex items-center gap-1">
              {doctor.name}
              {doctor.credential && <span className="text-xs font-normal text-muted-foreground">{doctor.credential}</span>}
            </div>
            {doctor.title && <div className="text-xs text-muted-foreground truncate">{doctor.title}</div>}
          </div>
        </div>
        {locLabel && <div className="text-xs text-muted-foreground truncate">{locLabel}</div>}
        <div className="flex flex-wrap gap-1 mt-auto pt-1">
          {doctor.isMedicalDirector && (
            <Badge variant="secondary" className="gap-1 text-[11px]"><Award className="w-3 h-3" /> Medical director</Badge>
          )}
          {specialties.slice(0, 2).map((s) => (
            <Badge key={s} variant="secondary" className="text-[11px]">{s}</Badge>
          ))}
          {specialties.length > 2 && <Badge variant="secondary" className="text-[11px]">+{specialties.length - 2}</Badge>}
        </div>
      </div>
    </div>
  );
}
