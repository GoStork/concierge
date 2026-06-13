import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { typeToUrlSlug } from "@/lib/profile-utils";
import { api } from "@shared/routes";
import { type ProviderWithRelations } from "@shared/schema";
import { hasProviderRole } from "@shared/roles";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Loader2, Calendar, MapPin, Award, Heart, Clock, Info, X, Baby, FlaskRound, SlidersHorizontal, ArrowLeft } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { getPhotoSrc } from "@/lib/profile-utils";
import { matchesFilter, matchesSameSexCoupleRequirement, matchesInternationalRequirement, omniSearch, sortDonors } from "@/lib/marketplace-filters";
import { useAppSelector, useAppDispatch } from "@/store";
import { setMarketplaceSearchQuery, setMarketplaceTab, toggleFavoriteDonor, passDonor, undoPassDonor, loadDonorPreferences, loadProviderPreferences, toggleFavoriteDoctor, passDoctor, undoPassDoctor, toggleFavoriteClinic, passClinic, undoPassClinic, setShowFavoritesOnly, setShowSkippedOnly, setShowExperiencedOnly, setFilter, clearFilters } from "@/store/uiSlice";
import { MarketplaceFilterBar } from "@/components/marketplace/MarketplaceFilterBar";
import { LocationSearchInput } from "@/components/location-search-input";
import { Tabs as UnderlineTabs, TabsList as UnderlineTabsList, TabsTrigger as UnderlineTabsTrigger } from "@/components/ui/underline-tabs";
import { Drawer as FullDrawer, DrawerContent as FullDrawerContent } from "@/components/ui/drawer";
import { Check as CheckIcon } from "lucide-react";
import { SwipeDeckCard } from "@/components/marketplace/swipe-deck-card";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { ClinicSwipeCard } from "@/components/marketplace/clinic-swipe-card";
import { useMarketplaceViewContext, recordProfileView, useScrollPastView } from "@/lib/profile-views";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  getPhotoList, getMatchedPreferences, buildTitle, buildStatusLabel,
  getDonorTabs, getSurrogateTabs, buildDoctorCardProps,
  mapDatabaseDonorToSwipeProfile, mapDatabaseSurrogateToSwipeProfile, mapDatabaseSpermDonorToSwipeProfile,
  type DoctorCardData,
} from "@/components/marketplace/swipe-mappers";

import { EggDonorIcon, SurrogateIcon, IvfClinicIcon, AgencyIcon, SpermIcon } from "@/components/icons/marketplace-icons";

// "LGBTQ+ Family Building" intentionally omitted - the dedicated "LGBTQ+ care"
// toggle is the single control for that, so it is not duplicated here.
const SPECIALTY_OPTIONS = [
  "Male Factor Infertility", "PCOS", "Recurrent Pregnancy Loss",
  "Endometriosis", "Diminished Ovarian Reserve", "Egg Freezing", "Fertility Preservation",
  "Egg & Embryo Donation", "Surrogacy & Gestational Carriers", "Reproductive Surgery",
  "Genetic Testing (PGT)", "Tubal Factor",
];


const TABS = [
  { id: "egg-donors", label: "Egg Donors", Icon: EggDonorIcon },
  { id: "surrogates", label: "Surrogates", Icon: SurrogateIcon },
  { id: "ivf-clinics", label: "IVF Clinics", providerTypeName: "IVF Clinic", Icon: IvfClinicIcon },
  { id: "surrogacy-agencies", label: "Surrogacy Agencies", providerTypeName: "Surrogacy Agency", Icon: AgencyIcon },
  { id: "sperm-donors", label: "Sperm Donors", Icon: SpermIcon },
];



function ScheduleConsultationDialog({ providerId, providerName, open, onClose }: {
  providerId: string; providerName: string; open: boolean; onClose: () => void;
}) {
  const { data: members, isLoading } = useQuery({
    queryKey: ["/api/calendar/providers", providerId, "booking-members"],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/providers/${providerId}/booking-members`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Schedule a Consultation</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-2">
          Choose a team member from {providerName} to schedule with:
        </p>
        {isLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
        ) : members?.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No team members have booking pages set up yet.</p>
        ) : (
          <div className="space-y-2">
            {members?.map((m: any) => {
              const photoSrc = getPhotoSrc(m.photoUrl);
              return (
                <a
                  key={m.id}
                  href={`/book/${m.slug}`}
                  className="flex items-center gap-3 p-3 rounded-[var(--radius)] border border-border/50 hover:bg-secondary/30 transition-colors"
                  data-testid={`link-book-${m.id}`}
                >
                  {photoSrc ? (
                    <img src={photoSrc} alt="" className="w-10 h-10 rounded-full object-cover" />
                  ) : (
                    <DoctorMonogram name={m.name} size={40} />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-ui truncate">{m.name || "Team Member"}</p>
                    <p className="text-xs text-muted-foreground">{m.meetingDuration} min consultation</p>
                  </div>
                  <Calendar className="w-4 h-4 text-primary shrink-0" />
                </a>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function pickMatchedRate(ivfRates: any[] | undefined, eggSource: string): any | null {
  if (!ivfRates || ivfRates.length === 0) return null;
  const validRates = ivfRates.filter((r: any) => r.successRate != null);
  if (validRates.length === 0) return null;
  if (validRates.length === 1) return validRates[0];
  return validRates.reduce((a: any, b: any) =>
    Number(b.successRate) > Number(a.successRate) ? b : a
  );
}

function getFilterLabel(eggSource: string, ageGroup: string, isNewPatient: string): string {
  const parts: string[] = [];

  if (eggSource === "own_eggs") {
    parts.push("Own eggs");
    const ageLabels: Record<string, string> = {
      under_35: "Under 35",
      "35_37": "35-37",
      "38_40": "38-40",
      over_40: "Over 40",
    };
    parts.push(ageLabels[ageGroup] || ageGroup);
    parts.push(isNewPatient === "true" ? "First-time IVF" : "Prior cycles");
  } else if (eggSource === "donor") {
    parts.push("Donor eggs");
  } else {
    parts.push("Donated embryos");
  }

  return parts.join(" \u00b7 ");
}

function IvfClinicCard({ provider, matchedRate, filterLabel, onSchedule, onNavigate }: {
  provider: ProviderWithRelations;
  matchedRate: any | null;
  filterLabel: string;
  onSchedule: (p: { id: string; name: string }) => void;
  onNavigate: () => void;
}) {
  const pct = matchedRate ? Math.round(Number(matchedRate.successRate) * 100) : null;
  const natAvg = matchedRate ? Math.round(Number(matchedRate.nationalAverage) * 100) : null;
  const isTop10 = matchedRate?.top10pct === true;

  return (
    <Card
      className="group hover:shadow-xl transition-all duration-300 border-border/50 flex flex-col cursor-pointer hover:border-primary/30"
      onClick={onNavigate}
      data-testid={`card-provider-${provider.id}`}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          {provider.logoUrl && (
            <img
              src={getPhotoSrc(provider.logoUrl) || ""}
              alt=""
              className="w-10 h-10 rounded-[var(--radius)] object-contain border border-border/30 bg-background p-0.5 shrink-0"
            />
          )}
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base font-display font-heading text-foreground leading-heading" data-testid={`text-provider-name-${provider.id}`}>
              {provider.name}
            </CardTitle>
          </div>
          {isTop10 && (
            <Badge className="bg-destructive/10 text-destructive border-destructive/30 text-xs shrink-0 gap-0.5" data-testid={`badge-top10-${provider.id}`}>
              <Award className="w-3 h-3" /> Top 10%
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 flex-1 pt-0">
        {provider.locations && provider.locations.length > 0 && (
          <p className="text-sm text-muted-foreground flex items-center gap-1" data-testid={`text-provider-location-${provider.id}`}>
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            {provider.locations[0].city}{provider.locations[0].state ? `, ${provider.locations[0].state}` : ""}
          </p>
        )}

        {pct !== null && (
          <div data-testid={`ivf-rate-section-${provider.id}`}>
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <span className="text-2xl font-heading text-foreground">{pct}%</span>
              <span className="text-sm text-muted-foreground">success rate</span>
            </div>
            <p className="text-xs text-muted-foreground mb-2">{filterLabel}</p>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">This clinic</span>
                <span className="font-ui text-foreground">{pct}%</span>
              </div>
              <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>

              {natAvg !== null && natAvg > 0 && (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">National average</span>
                    <span className="font-ui text-muted-foreground">{natAvg}%</span>
                  </div>
                  <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all"
                      style={{ width: `${Math.min(natAvg, 100)}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-3 border-t border-border/50 flex items-center justify-between">
        <p className="text-xs text-muted-foreground flex items-center gap-1" data-testid={`text-cycles-${provider.id}`}>
          <Clock className="w-3 h-3" />
          {matchedRate?.cycleCount != null ? `${matchedRate.cycleCount.toLocaleString()} cycles reported` : ""}
        </p>
      </CardFooter>
    </Card>
  );
}

function IvfClinicGrid({ providers, eggSource, ageGroup, isNewPatient, sortBy, onSchedule }: {
  providers: ProviderWithRelations[] | undefined;
  eggSource: string;
  ageGroup: string;
  isNewPatient: string;
  sortBy: string;
  onSchedule: (p: { id: string; name: string }) => void;
}) {
  const navigate = useNavigate();
  const filterLabel = getFilterLabel(eggSource, ageGroup, isNewPatient);

  const sorted = useMemo(() => {
    if (!providers) return [];

    const ivfProviders = providers.filter((p) => {
      const matchingServices = p.services?.filter(
        (s: any) => s.status === "APPROVED" && s.providerType?.name === "IVF Clinic"
      ) || [];
      return matchingServices.length > 0;
    });

    const withRates = ivfProviders.map((p) => ({
      provider: p,
      rate: pickMatchedRate((p as any).ivfSuccessRates, eggSource),
    }));

    withRates.sort((a, b) => {
      const aRate = a.rate ? Number(a.rate.successRate) : -1;
      const bRate = b.rate ? Number(b.rate.successRate) : -1;
      const aCycles = a.rate?.cycleCount || 0;
      const bCycles = b.rate?.cycleCount || 0;

      switch (sortBy) {
        case "highest_success":
          return bRate - aRate;
        case "lowest_success":
          return aRate - bRate;
        case "highest_cycles":
          return bCycles - aCycles;
        case "lowest_cycles":
          return aCycles - bCycles;
        case "alphabetical":
          return a.provider.name.localeCompare(b.provider.name);
        default:
          return bRate - aRate;
      }
    });

    return withRates;
  }, [providers, eggSource, sortBy]);

  if (sorted.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground" data-testid="text-no-results">
        <p className="text-lg font-ui">No clinics found</p>
        <p className="text-sm">Try adjusting your filters or search criteria.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[1200px] mx-auto px-6">
      {sorted.map(({ provider, rate }) => (
        <IvfClinicCard
          key={provider.id}
          provider={provider}
          matchedRate={rate}
          filterLabel={filterLabel}
          onSchedule={onSchedule}
          onNavigate={() => {
            const params = new URLSearchParams();
            if (eggSource) params.set("eggSource", eggSource);
            if (ageGroup) params.set("ageGroup", ageGroup);
            if (isNewPatient) params.set("isNewPatient", isNewPatient);
            const qs = params.toString();
            navigate(`/providers/${provider.id}${qs ? `?${qs}` : ""}`);
          }}
        />
      ))}
    </div>
  );
}

// IVF Clinics view: the SAME ClinicSwipeCard the AI matcher uses (cream cover +
// doctor-face tabs + success bars), as a mobile swipe stack / desktop grid, with
// persistent save/pass via /api/profile-preferences (clinic, keyed by providerId).
function IvfClinicDeckGrid({ providers, eggSource, ageGroup, isNewPatient, sortBy }: {
  providers: ProviderWithRelations[] | undefined;
  eggSource: string;
  ageGroup: string;
  isNewPatient: string;
  sortBy: string;
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const isMobile = useIsMobile();
  const favoritedClinics = useAppSelector((s) => s.ui.favoritedClinicIds);
  const passedClinics = useAppSelector((s) => s.ui.passedClinicIds);
  const showFavoritesOnly = useAppSelector((s) => s.ui.showFavoritesOnly);
  const showSkippedOnly = useAppSelector((s) => s.ui.showSkippedOnly);
  const [currentIndex, setCurrentIndex] = useState(0);
  const isNew = isNewPatient !== "false";

  const syncPref = (prefType: "favorite" | "skip", id: string, action: "add" | "remove") => {
    fetch(`/api/profile-preferences/clinic/${prefType}/${id}`, { method: action === "add" ? "POST" : "DELETE", credentials: "include" }).catch(() => {});
  };

  const sorted = useMemo(() => {
    const ivf = (providers || []).filter((p) =>
      (p.services || []).some((s: any) => s.status === "APPROVED" && s.providerType?.name === "IVF Clinic"),
    );
    const visible = ivf.filter((p) => {
      if (showFavoritesOnly && !favoritedClinics.includes(p.id)) return false;
      if (showSkippedOnly && !passedClinics.includes(p.id)) return false;
      if (!showSkippedOnly && passedClinics.includes(p.id)) return false;
      return true;
    });
    const withRates = visible.map((p) => ({ provider: p, rate: pickMatchedRate((p as any).ivfSuccessRates, eggSource) }));
    withRates.sort((a, b) => {
      const aRate = a.rate ? Number(a.rate.successRate) : -1;
      const bRate = b.rate ? Number(b.rate.successRate) : -1;
      const aCycles = a.rate?.cycleCount || 0;
      const bCycles = b.rate?.cycleCount || 0;
      switch (sortBy) {
        case "highest_success": return bRate - aRate;
        case "lowest_success": return aRate - bRate;
        case "highest_cycles": return bCycles - aCycles;
        case "lowest_cycles": return aCycles - bCycles;
        case "alphabetical": return a.provider.name.localeCompare(b.provider.name);
        default: return bRate - aRate;
      }
    });
    return withRates.map((x) => x.provider);
  }, [providers, eggSource, sortBy, showFavoritesOnly, favoritedClinics, showSkippedOnly, passedClinics]);

  useEffect(() => { setCurrentIndex(0); }, [showFavoritesOnly, showSkippedOnly, providers]);

  const goToProfile = (id: string) => {
    const params = new URLSearchParams();
    if (eggSource) params.set("eggSource", eggSource);
    if (ageGroup) params.set("ageGroup", ageGroup);
    if (isNewPatient) params.set("isNewPatient", isNewPatient);
    const qs = params.toString();
    navigate(`/providers/${id}${qs ? `?${qs}` : ""}`);
  };
  const handleSave = (id: string) => {
    const fav = favoritedClinics.includes(id);
    dispatch(toggleFavoriteClinic(id));
    syncPref("favorite", id, fav ? "remove" : "add");
    if (isMobile) setCurrentIndex((p) => p + 1);
  };
  const handlePass = (id: string) => {
    dispatch(passClinic(id));
    syncPref("skip", id, "add");
    if (isMobile) setCurrentIndex((p) => p + 1);
  };

  const renderCard = (p: ProviderWithRelations, swipe: boolean) => (
    <ClinicSwipeCard
      providerId={p.id}
      eggSource={eggSource}
      ageGroup={ageGroup}
      isNewPatient={isNew}
      disableSwipe={!swipe}
      isSaved={favoritedClinics.includes(p.id)}
      isPassed={passedClinics.includes(p.id)}
      onSave={() => handleSave(p.id)}
      onPass={() => handlePass(p.id)}
      onUndo={passedClinics.includes(p.id) ? () => { dispatch(undoPassClinic(p.id)); syncPref("skip", p.id, "remove"); } : undefined}
      onViewProfile={() => goToProfile(p.id)}
    />
  );

  if (sorted.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground" data-testid="text-no-clinics">
        <p className="text-lg font-ui">No clinics found</p>
        <p className="text-sm">Try adjusting your filters or search criteria.</p>
      </div>
    );
  }

  if (isMobile) {
    if (currentIndex >= sorted.length) {
      return (
        <div className="py-16 text-center text-muted-foreground" data-testid="text-no-more-clinics">
          <p className="text-lg font-ui">You've seen all clinics!</p>
          <p className="text-sm mt-2">Adjust your filters or check back later.</p>
          <Button variant="outline" className="mt-4" onClick={() => setCurrentIndex(0)} data-testid="button-restart-clinic-swipe">Start Over</Button>
        </div>
      );
    }
    const current = sorted[currentIndex];
    const next = currentIndex + 1 < sorted.length ? sorted[currentIndex + 1] : null;
    return (
      <div className="h-full" data-testid="clinic-swipe-deck-mobile">
        <div className="relative h-full w-full">
          {next && <div className="absolute inset-0 z-0" data-testid={`clinic-card-next-${next.id}`}>{renderCard(next, false)}</div>}
          <div className="absolute inset-0 z-10" data-testid={`clinic-card-container-${current.id}`}>{renderCard(current, true)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[1200px] mx-auto px-6">
      {sorted.map((p) => (
        <div key={p.id} className={`h-[600px] ${showSkippedOnly ? "grayscale opacity-60" : ""}`} data-testid={`clinic-card-container-${p.id}`}>
          {renderCard(p, false)}
        </div>
      ))}
    </div>
  );
}

// Doctors view: the SAME SwipeDeckCard used by donors/surrogates and the AI
// matcher's doctor card - photo-forward, swipe-to-pass/save on mobile, static
// grid on desktop. Tabs (Matched to you / Clinic & success rate / Specialties /
// Credentials / Languages & visits / Reviews) come from buildDoctorCardProps,
// so the marketplace and the chat render identically. Save/pass persist via
// /api/profile-preferences (doctor, keyed by slug).
function DoctorDeckGrid({ doctors, loading, eggSource, ageGroup, isNewPatient }: {
  doctors: any[] | undefined;
  loading: boolean;
  eggSource: string;
  ageGroup: string;
  isNewPatient: string;
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const isMobile = useIsMobile();
  const favoritedSlugs = useAppSelector((s) => s.ui.favoritedDoctorSlugs);
  const passedSlugs = useAppSelector((s) => s.ui.passedDoctorSlugs);
  const showFavoritesOnly = useAppSelector((s) => s.ui.showFavoritesOnly);
  const showSkippedOnly = useAppSelector((s) => s.ui.showSkippedOnly);
  const [currentIndex, setCurrentIndex] = useState(0);

  const ageLabel = ageGroup === "under_35" ? "Under 35" : ageGroup === "35_37" ? "35-37" : ageGroup === "38_40" ? "38-40" : "Over 40";
  const contextLabel = eggSource === "donor" ? "Donor eggs" : ["Own eggs", ageLabel, isNewPatient === "true" ? "First-time IVF" : "Prior cycles"].join(" · ");

  const syncPref = (prefType: "favorite" | "skip", slug: string, action: "add" | "remove") => {
    const method = action === "add" ? "POST" : "DELETE";
    fetch(`/api/profile-preferences/doctor/${prefType}/${slug}`, { method, credentials: "include" }).catch(() => {});
  };

  const filtered = useMemo(() => {
    return (doctors || []).filter((d) => {
      if (showFavoritesOnly && !favoritedSlugs.includes(d.slug)) return false;
      if (showSkippedOnly && !passedSlugs.includes(d.slug)) return false;
      if (!showSkippedOnly && passedSlugs.includes(d.slug)) return false;
      return true;
    });
  }, [doctors, showFavoritesOnly, favoritedSlugs, showSkippedOnly, passedSlugs]);

  useEffect(() => { setCurrentIndex(0); }, [showFavoritesOnly, showSkippedOnly, doctors]);

  const handleSave = (slug: string) => {
    const isFav = favoritedSlugs.includes(slug);
    dispatch(toggleFavoriteDoctor(slug));
    syncPref("favorite", slug, isFav ? "remove" : "add");
    if (isMobile) setCurrentIndex((p) => p + 1);
  };
  const handlePass = (slug: string) => {
    dispatch(passDoctor(slug));
    syncPref("skip", slug, "add");
    if (isMobile) setCurrentIndex((p) => p + 1);
  };

  const renderCard = (doctor: DoctorCardData & { slug: string }, swipe: boolean) => {
    const { photos, photoLabels, logoSrc, successBadge, tabs, headerLocation, firstSlidePlain } = buildDoctorCardProps(doctor, { contextLabel, compact: isMobile });
    return (
      <SwipeDeckCard
        id={doctor.slug}
        photos={photos}
        photoLabels={photoLabels}
        title={doctor.name}
        pinnedHeader={{ logoUrl: logoSrc, title: doctor.name, location: headerLocation, badge: successBadge }}
        monogramName={doctor.name}
        firstSlidePlain={firstSlidePlain}
        tabs={tabs}
        disableSwipe={!swipe}
        isSaved={favoritedSlugs.includes(doctor.slug)}
        isPassed={passedSlugs.includes(doctor.slug)}
        onSave={() => handleSave(doctor.slug)}
        onPass={() => handlePass(doctor.slug)}
        onUndo={passedSlugs.includes(doctor.slug) ? () => { dispatch(undoPassDoctor(doctor.slug)); syncPref("skip", doctor.slug, "remove"); } : undefined}
        onViewFullProfile={() => navigate(`/doctors/${doctor.slug}`)}
      />
    );
  };

  if (loading) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      </div>
    );
  }
  if (!filtered || filtered.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground" data-testid="text-no-doctors">
        <p className="text-lg font-ui">No doctors found</p>
        <p className="text-sm">Try a different name, specialty, or location.</p>
      </div>
    );
  }

  if (isMobile) {
    if (currentIndex >= filtered.length) {
      return (
        <div className="py-16 text-center text-muted-foreground" data-testid="text-no-more-doctors">
          <p className="text-lg font-ui">You've seen all doctors!</p>
          <p className="text-sm mt-2">Adjust your filters or check back later.</p>
          <Button variant="outline" className="mt-4" onClick={() => setCurrentIndex(0)} data-testid="button-restart-doctor-swipe">
            Start Over
          </Button>
        </div>
      );
    }
    const current = filtered[currentIndex];
    const next = currentIndex + 1 < filtered.length ? filtered[currentIndex + 1] : null;
    return (
      <div className="h-full" data-testid="doctor-swipe-deck-mobile">
        <div className="relative h-full w-full">
          {next && (
            <div className="absolute inset-0 z-0" data-testid={`doctor-card-next-${next.slug}`}>
              {renderCard(next, false)}
            </div>
          )}
          <div className="absolute inset-0 z-10" data-testid={`doctor-card-container-${current.slug}`}>
            {renderCard(current, true)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[1200px] mx-auto px-6">
      {filtered.map((d) => (
        <div key={d.slug} className={`h-[600px] ${showSkippedOnly ? "grayscale opacity-60" : ""}`} data-testid={`doctor-card-container-${d.slug}`}>
          {renderCard(d, false)}
        </div>
      ))}
    </div>
  );
}

function ProviderGrid({ providers, searchQuery, providerTypeName, onSchedule }: {
  providers: ProviderWithRelations[] | undefined;
  searchQuery: string;
  providerTypeName: string;
  onSchedule: (p: { id: string; name: string }) => void;
}) {
  const navigate = useNavigate();
  const filtered = providers
    ?.filter((p) => {
      const matchingServices = p.services?.filter(
        (s: any) => s.status === "APPROVED" && s.providerType?.name === providerTypeName
      ) || [];
      if (matchingServices.length === 0) return false;
      if (!searchQuery) return true;
      return p.name.toLowerCase().includes(searchQuery.toLowerCase());
    });

  if (!filtered || filtered.length === 0) {
    return (
      <div className="py-16 text-center text-muted-foreground" data-testid="text-no-results">
        <p className="text-lg font-ui">No providers found</p>
        <p className="text-sm">Check back soon as we add more verified providers.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[1200px] mx-auto px-6">
      {filtered.map((provider) => (
        <Card key={provider.id} className="group hover:shadow-xl transition-all duration-300 border-border/50 flex flex-col cursor-pointer hover:border-primary/30" onClick={() => navigate(`/providers/${provider.id}`)} data-testid={`card-provider-${provider.id}`}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-3">
              {provider.logoUrl && (
                <img
                  src={getPhotoSrc(provider.logoUrl) || ""}
                  alt=""
                  className="w-10 h-10 rounded-[var(--radius)] object-contain border border-border/30 bg-background p-0.5"
                />
              )}
              <div className="flex-1 min-w-0">
                <CardTitle className="text-lg font-display font-heading text-primary truncate" data-testid={`text-provider-name-${provider.id}`}>
                  {provider.name}
                </CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 flex-1">
            <div className="flex flex-wrap gap-1">
              {provider.services?.filter((s: any) => s.status === "APPROVED").map((s: any) => (
                <Badge key={s.id} variant="secondary" className="text-xs" data-testid={`badge-service-${s.id}`}>
                  {s.providerType?.name || "Service"}
                </Badge>
              ))}
            </div>
            {provider.locations && provider.locations.length > 0 && (
              <p className="text-sm text-muted-foreground flex items-center gap-1" data-testid={`text-provider-location-${provider.id}`}>
                <MapPin className="w-3.5 h-3.5" />
                {provider.locations[0].city}{provider.locations[0].state ? `, ${provider.locations[0].state}` : ""}
              </p>
            )}
          </CardContent>
          <CardFooter className="pt-4 border-t border-border/50 flex gap-2">
            <Button className="flex-1 font-ui" variant="outline" onClick={(e) => { e.stopPropagation(); navigate(`/providers/${provider.id}`); }} data-testid={`button-view-details-${provider.id}`}>
              View Details
            </Button>
            <Button
              className="flex-1 font-ui gap-1"
              onClick={(e) => { e.stopPropagation(); onSchedule({ id: provider.id, name: provider.name }); }}
              data-testid={`button-schedule-${provider.id}`}
            >
              <Calendar className="w-4 h-4" /> Schedule
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}

// Grid-mode card wrapper. Uses an IntersectionObserver (via useScrollPastView)
// to record the profile as "viewed" once it has been on screen for >=1s, so
// the "New" badge clears as the parent scrolls. Tap / save / pass also record
// immediately so the badge disappears the moment the parent engages.
function DonorGridCard({
  donor, profile, tabs, type, viewedIds, previousVisitAt, showSkippedOnly,
  favoritedIds, passedIds, dispatch, navigate, syncPref,
}: {
  donor: any;
  profile: ReturnType<typeof mapDatabaseDonorToSwipeProfile>;
  tabs: any[];
  type: "egg-donor" | "surrogate" | "sperm-donor";
  viewedIds: Set<string>;
  previousVisitAt: Date | null;
  showSkippedOnly: boolean;
  favoritedIds: string[];
  passedIds: string[];
  dispatch: ReturnType<typeof useAppDispatch>;
  navigate: ReturnType<typeof useNavigate>;
  syncPref: (prefType: "favorite" | "skip", donorId: string, action: "add" | "remove") => void;
}) {
  const setScrollRef = useScrollPastView(donor.id, type);
  return (
    <div
      ref={setScrollRef}
      className={`h-[600px] ${showSkippedOnly ? "grayscale opacity-60" : ""}`}
      data-testid={`card-container-${donor.id}`}
    >
      <SwipeDeckCard
        id={profile.id}
        photos={getPhotoList(profile)}
        title={buildTitle(profile)}
        statusLabel={buildStatusLabel(profile, viewedIds, previousVisitAt)}
        donorStatus={profile.donorStatus}
        frozenLotStatus={profile.frozenLotStatus}
        isExperienced={profile.isExperienced}
        isPremium={profile.isPremium}
        tabs={tabs}
        disableSwipe
        isSaved={favoritedIds.includes(donor.id)}
        isPassed={passedIds.includes(donor.id)}
        onPass={() => { recordProfileView(donor.id, type); dispatch(passDonor(donor.id)); syncPref("skip", donor.id, "add"); }}
        onSave={() => { recordProfileView(donor.id, type); const isFav = favoritedIds.includes(donor.id); dispatch(toggleFavoriteDonor(donor.id)); syncPref("favorite", donor.id, isFav ? "remove" : "add"); }}
        onUndo={passedIds.includes(donor.id) ? () => { dispatch(undoPassDonor(donor.id)); syncPref("skip", donor.id, "remove"); } : undefined}
        onMessage={() => { recordProfileView(donor.id, type); navigate(`/concierge?donorId=${donor.id}&donorType=${type}&providerId=${donor.providerId}&photoUrl=${encodeURIComponent(donor.photoUrl || "")}`); }}
        onViewFullProfile={() => { recordProfileView(donor.id, type); navigate(`/${typeToUrlSlug(type)}/${donor.providerId}/${donor.id}`, { state: { initialPhotoUrl: donor.photoUrl } }); }}
      />
    </div>
  );
}

function DonorGrid({ donors, searchQuery, type, onFilteredCountChange, fetchMore, hasNextPage, isFetchingMore }: {
  donors: any[] | undefined;
  searchQuery: string;
  type: "egg-donor" | "surrogate" | "sperm-donor";
  onFilteredCountChange?: (count: number) => void;
  fetchMore?: () => void;
  hasNextPage?: boolean;
  isFetchingMore?: boolean;
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const isMobile = useIsMobile();
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const sortBy = useAppSelector((state) => state.ui.marketplaceSortBy);
  const showFavoritesOnly = useAppSelector((state) => state.ui.showFavoritesOnly);
  const favoritedIds = useAppSelector((state) => state.ui.favoritedDonorIds);
  const passedIds = useAppSelector((state) => state.ui.passedDonorIds);
  const showSkippedOnly = useAppSelector((state) => state.ui.showSkippedOnly);
  const showExperiencedOnly = useAppSelector((state) => state.ui.showExperiencedOnly);
  const [currentIndex, setCurrentIndex] = useState(0);
  const { user } = useAuth();
  const { viewedIds, previousVisitAt } = useMarketplaceViewContext();

  const userCountry = (user as any)?.country || null;
  const userIdentification = (user as any)?.identification || null;

  const filtered = useMemo(() => {
    let result = donors?.filter((d) => {
      if (showFavoritesOnly && !favoritedIds.includes(d.id)) return false;
      if (showSkippedOnly && !passedIds.includes(d.id)) return false;
      if (!showSkippedOnly && passedIds.includes(d.id)) return false;
      if (showExperiencedOnly && !((d as any).isExperienced || (d as any).isPremium)) return false;
      if (!omniSearch(d, searchQuery)) return false;
      if (type === "surrogate") {
        if (!matchesInternationalRequirement(d, userCountry)) return false;
        if (!matchesSameSexCoupleRequirement(d, userIdentification)) return false;
      }
      return Object.entries(activeFilters).every(([key, vals]) =>
        matchesFilter(d, key, vals)
      );
    });
    if (result) result = sortDonors(result, sortBy);
    return result;
  }, [donors, searchQuery, activeFilters, sortBy, showFavoritesOnly, favoritedIds, showSkippedOnly, passedIds, showExperiencedOnly, userCountry, userIdentification]);

  useEffect(() => {
    onFilteredCountChange?.(filtered?.length ?? 0);
  }, [filtered?.length, onFilteredCountChange]);

  // Auto-load next page when filter leaves too few visible results
  useEffect(() => {
    if (fetchMore && hasNextPage && !isFetchingMore && (filtered?.length ?? 0) < 12) {
      fetchMore();
    }
  }, [filtered?.length, fetchMore, hasNextPage, isFetchingMore]);

  // Intersection observer sentinel to load next page as user scrolls near bottom
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sentinelRef.current || !fetchMore || !hasNextPage) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && !isFetchingMore) fetchMore(); },
      { rootMargin: "300px" }
    );
    obs.observe(sentinelRef.current);
    return () => obs.disconnect();
  }, [fetchMore, hasNextPage, isFetchingMore]);

  const userPrefs = useMemo(() => {
    const RANGE_KEYS = new Set(["age", "bmi", "height", "donorCompensation", "maxCost", "baseCompensation", "maxLiveBirths", "maxCSections", "maxMiscarriages", "maxAbortions", "lastDeliveryYear"]);
    const prefs: { key: string; value: string | number | boolean; rangeMin?: number; rangeMax?: number }[] = [];
    for (const [key, vals] of Object.entries(activeFilters)) {
      if (!vals || vals.length === 0) continue;
      if (RANGE_KEYS.has(key)) {
        if (vals.length === 2) {
          prefs.push({ key, value: "range", rangeMin: Number(vals[0]), rangeMax: Number(vals[1]) });
        }
        continue;
      }
      if (key === "agreesToTwins") { prefs.push({ key, value: true }); continue; }
      if (key === "covidVaccinated") { prefs.push({ key, value: true }); continue; }
      for (const v of vals) {
        prefs.push({ key, value: v });
      }
    }
    return prefs;
  }, [activeFilters]);

  useEffect(() => {
    setCurrentIndex(0);
  }, [searchQuery, activeFilters, sortBy, showFavoritesOnly, showSkippedOnly, showExperiencedOnly]);

  useEffect(() => {
    if (!filtered || filtered.length === 0) return;
    const toPreload = filtered.slice(currentIndex, currentIndex + 3);
    for (const d of toPreload) {
      const p = type === "surrogate" ? mapDatabaseSurrogateToSwipeProfile(d) : type === "sperm-donor" ? mapDatabaseSpermDonorToSwipeProfile(d) : mapDatabaseDonorToSwipeProfile(d);
      for (const src of getPhotoList(p)) {
        const img = new Image();
        img.src = src;
      }
    }
  }, [currentIndex, filtered, type]);

  // Deck-mode "scroll-past" equivalent: the moment a card becomes the
  // current one in the swipe deck, the parent is literally looking at it,
  // so record it as viewed. Clears the "New" badge on subsequent visits.
  useEffect(() => {
    if (!isMobile || !filtered || filtered.length === 0) return;
    const current = filtered[currentIndex];
    if (current) recordProfileView(current.id, type);
  }, [isMobile, currentIndex, filtered, type]);

  const mapDonor = (d: any) => {
    if (type === "surrogate") return mapDatabaseSurrogateToSwipeProfile(d);
    if (type === "sperm-donor") return mapDatabaseSpermDonorToSwipeProfile(d);
    return mapDatabaseDonorToSwipeProfile(d);
  };

  if (!filtered || filtered.length === 0) {
    const typeLabel = type === "egg-donor" ? "egg donors" : type === "surrogate" ? "surrogates" : "sperm donors";
    return (
      <div className="flex items-center justify-center h-full text-center text-muted-foreground" data-testid="text-no-results">
        <div>
          <p className="text-lg font-ui">No {typeLabel} found</p>
          <p className="text-sm">Check back soon as more profiles are added.</p>
        </div>
      </div>
    );
  }

  const getTabs = (profile: ReturnType<typeof mapDonor>) => {
    const matched = getMatchedPreferences(profile, userPrefs);
    if (type === "surrogate") return getSurrogateTabs(profile, matched);
    return getDonorTabs(profile, matched, type === "sperm-donor");
  };

  const syncPref = (prefType: "favorite" | "skip", donorId: string, action: "add" | "remove") => {
    const method = action === "add" ? "POST" : "DELETE";
    fetch(`/api/donor-preferences/${prefType}/${donorId}`, { method, credentials: "include" }).catch(() => {});
  };

  const handleSave = (donorId: string) => {
    recordProfileView(donorId, type);
    const isFav = favoritedIds.includes(donorId);
    dispatch(toggleFavoriteDonor(donorId));
    syncPref("favorite", donorId, isFav ? "remove" : "add");
    setCurrentIndex((prev) => prev + 1);
  };

  const handlePass = (donorId: string) => {
    recordProfileView(donorId, type);
    dispatch(passDonor(donorId));
    syncPref("skip", donorId, "add");
  };

  if (isMobile) {
    if (currentIndex >= filtered.length) {
      return (
        <div className="py-16 text-center text-muted-foreground" data-testid="text-no-more">
          <p className="text-lg font-ui">You've seen all profiles!</p>
          <p className="text-sm mt-2">Adjust your filters or check back later.</p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => setCurrentIndex(0)}
            data-testid="button-restart-swipe"
          >
            Start Over
          </Button>
        </div>
      );
    }

    // Pre-load next page when within 10 cards of the end
    if (fetchMore && hasNextPage && !isFetchingMore && filtered.length - currentIndex <= 10) {
      fetchMore();
    }

    const currentDonor = filtered[currentIndex];
    const nextDonor = currentIndex + 1 < filtered.length ? filtered[currentIndex + 1] : null;
    const profile = mapDonor(currentDonor);
    const tabs = getTabs(profile);

    const nextProfile = nextDonor ? mapDonor(nextDonor) : null;
    const nextTabs = nextProfile ? getTabs(nextProfile) : [];

    return (
      <div className="h-full" data-testid="swipe-deck-mobile">
        <div className={`relative h-full w-full ${showSkippedOnly ? "grayscale opacity-60" : ""}`}>
          {nextDonor && nextProfile && (
            <div className="absolute inset-0 z-0" data-testid={`card-next-${nextDonor.id}`}>
              <SwipeDeckCard
                key={`next-${nextDonor.id}`}
                id={nextProfile.id}
                photos={getPhotoList(nextProfile)}
                title={buildTitle(nextProfile)}
                statusLabel={buildStatusLabel(nextProfile, viewedIds, previousVisitAt)}
                donorStatus={nextProfile.donorStatus}
                frozenLotStatus={nextProfile.frozenLotStatus}
                isExperienced={nextProfile.isExperienced}
                isPremium={nextProfile.isPremium}
                tabs={nextTabs}
                disableSwipe
                isSaved={favoritedIds.includes(nextDonor.id)}
                onPass={() => {}}
                onSave={() => {}}
                onViewFullProfile={() => {}}
              />
            </div>
          )}
          <div className="absolute inset-0 z-10" data-testid={`card-container-${currentDonor.id}`}>
            <SwipeDeckCard
              key={currentDonor.id}
              id={profile.id}
              photos={getPhotoList(profile)}
              title={buildTitle(profile)}
              statusLabel={buildStatusLabel(profile, viewedIds, previousVisitAt)}
              donorStatus={profile.donorStatus}
              frozenLotStatus={profile.frozenLotStatus}
              isExperienced={profile.isExperienced}
              isPremium={profile.isPremium}
              tabs={tabs}
              isSaved={favoritedIds.includes(currentDonor.id)}
              onPass={() => handlePass(currentDonor.id)}
              onSave={() => handleSave(currentDonor.id)}
              onUndo={currentIndex > 0 ? () => {
                const prevDonor = filtered[currentIndex - 1];
                if (prevDonor && passedIds.includes(prevDonor.id)) {
                  dispatch(undoPassDonor(prevDonor.id));
                  syncPref("skip", prevDonor.id, "remove");
                }
                if (prevDonor && favoritedIds.includes(prevDonor.id)) {
                  dispatch(toggleFavoriteDonor(prevDonor.id));
                  syncPref("favorite", prevDonor.id, "remove");
                }
                setCurrentIndex((prev) => prev - 1);
              } : undefined}
              onMessage={() => { recordProfileView(currentDonor.id, type); navigate(`/concierge?donorId=${currentDonor.id}&donorType=${type}&providerId=${currentDonor.providerId}&photoUrl=${encodeURIComponent(currentDonor.photoUrl || "")}`); }}
              onViewFullProfile={() => { recordProfileView(currentDonor.id, type); navigate(`/${typeToUrlSlug(type)}/${currentDonor.providerId}/${currentDonor.id}`, { state: { initialPhotoUrl: currentDonor.photoUrl } }); }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-[1200px] mx-auto px-6">
      {filtered.map((donor) => {
        const profile = mapDonor(donor);
        const tabs = getTabs(profile);
        return (
          <DonorGridCard
            key={donor.id}
            donor={donor}
            profile={profile}
            tabs={tabs}
            type={type}
            viewedIds={viewedIds}
            previousVisitAt={previousVisitAt}
            showSkippedOnly={showSkippedOnly}
            favoritedIds={favoritedIds}
            passedIds={passedIds}
            dispatch={dispatch}
            navigate={navigate}
            syncPref={syncPref}
          />
        );
      })}
      {/* Infinite scroll sentinel - load next page when this comes into view */}
      <div ref={sentinelRef} className="col-span-full" />
      {isFetchingMore && (
        <div className="col-span-full flex justify-center py-6">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}


const PARENT_TYPE_MAP: Record<string, { id: string; label: string }> = {
  "Egg Donor": { id: "egg-donors", label: "Eggs" },
  "Sperm Donor": { id: "sperm-donors", label: "Sperm" },
  "Surrogate": { id: "surrogates", label: "Surrogates" },
  "Fertility Clinic": { id: "ivf-clinics", label: "Clinics" },
  // Doctors is a first-class provider type (Path B), not tied to a specific
  // interestedService - it is always offered in the Explore picker.
  "Fertility Doctor": { id: "doctors", label: "Doctors" },
};
const PARENT_TYPE_ORDER = ["egg-donors", "sperm-donors", "surrogates", "ivf-clinics", "doctors"];

function DeckTypeSwitcher({ types, activeTab, onSelect, theme }: {
  types: { id: string; label: string }[];
  activeTab: string;
  onSelect: (id: string) => void;
  theme: "dark" | "light";
}) {
  if (types.length < 2) return null;
  const isDark = theme === "dark";
  return (
    <div
      className="flex justify-center gap-1.5 overflow-x-auto scrollbar-hide"
      data-testid="deck-type-switcher"
    >
      {types.map(t => {
        const active = activeTab === t.id;
        const base = "shrink-0 px-4 py-1.5 rounded-full text-[13px] font-medium font-ui transition-colors duration-150";
        const cls = isDark
          ? (active ? "bg-white text-[hsl(var(--deck-bg))]" : "bg-white/12 text-white/85 hover:bg-white/20")
          : (active ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-secondary");
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`${base} ${cls}`}
            data-testid={`deck-type-${t.id}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function InlineRangeFilter({ filterKey, label, min, max, step = 1, unit = "", formatValue }: {
  filterKey: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  formatValue?: (v: number) => string;
}) {
  const dispatch = useAppDispatch();
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const current = activeFilters[filterKey];
  const hasValue = current && current.length === 2;
  const currentMin = hasValue ? Number(current[0]) : min;
  const currentMax = hasValue ? Number(current[1]) : max;
  const fmt = (v: number) => formatValue ? formatValue(v) : `${v}${unit}`;

  return (
    <div className="py-3 border-b border-border" data-testid={`inline-${filterKey}-filter`}>
      <div className="flex items-center justify-between mb-3">
        <span className="font-ui text-base text-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span className={`font-ui text-sm ${hasValue ? 'text-foreground' : 'text-muted-foreground'}`} data-testid={`${filterKey}-current-value`}>
            {hasValue ? `${fmt(currentMin)}-${fmt(currentMax)}` : 'Any'}
          </span>
          {hasValue && (
            <button
              onClick={() => dispatch(setFilter({ key: filterKey, values: [] }))}
              className="text-muted-foreground hover:text-foreground"
              data-testid={`${filterKey}-reset`}
              aria-label={`Reset ${label}`}
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <Slider
        value={[currentMin, currentMax]}
        min={min}
        max={max}
        step={step}
        onValueChange={(vals) => {
          dispatch(setFilter({ key: filterKey, values: [String(vals[0]), String(vals[1])] }));
        }}
        data-testid={`${filterKey}-slider`}
      />
      <div className="flex justify-between mt-2">
        <span className="font-ui text-xs text-muted-foreground">{fmt(min)}</span>
        <span className="font-ui text-xs text-muted-foreground">{fmt(max)}</span>
      </div>
    </div>
  );
}

function formatHeightInches(v: number) {
  const ft = Math.floor(v / 12);
  const inches = v % 12;
  return `${ft}'${inches}"`;
}

function MobileSavedGrid({ donors, type }: {
  donors: any[];
  type: "egg-donor" | "surrogate" | "sperm-donor";
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const favoritedIds = useAppSelector((s) => s.ui.favoritedDonorIds);
  const filtered = useMemo(
    () => (donors || []).filter((d) => favoritedIds.includes(d.id)),
    [donors, favoritedIds],
  );

  const mapProfile = useCallback((d: any) => {
    if (type === "surrogate") return mapDatabaseSurrogateToSwipeProfile(d);
    if (type === "sperm-donor") return mapDatabaseSpermDonorToSwipeProfile(d);
    return mapDatabaseDonorToSwipeProfile(d);
  }, [type]);

  const slug = type === "surrogate" ? "surrogate" : type === "sperm-donor" ? "spermdonor" : "eggdonor";

  if (filtered.length === 0) {
    return (
      <div className="flex items-center justify-center h-full px-6 text-center" data-testid="saved-empty">
        <div>
          <Heart className="w-12 h-12 mx-auto mb-3 text-white/40" />
          <p className="font-ui text-base text-white/85">No saved profiles yet</p>
          <p className="font-ui text-sm text-white/55 mt-1">Tap the heart on a profile while browsing to save it here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 px-2 pt-2 pb-4 overflow-y-auto h-full content-start" data-testid="saved-grid">
      {filtered.map((donor) => {
        const profile = mapProfile(donor);
        const photo = getPhotoList(profile)[0];
        const title = buildTitle(profile);
        const onOpen = () => navigate(`/${slug}/${donor.providerId}/${donor.id}`);
        return (
          // Padding-bottom hack for a reliable 3:4 aspect ratio across all browsers.
          <div key={donor.id} className="relative w-full" style={{ paddingBottom: '133.333%' }} data-testid={`saved-card-${donor.id}`}>
            <div
              role="button"
              tabIndex={0}
              onClick={onOpen}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(); }}
              className="absolute inset-0 rounded-[var(--radius)] overflow-hidden bg-[hsl(var(--deck-bg-elevated))] shadow-md cursor-pointer"
            >
              {photo ? (
                <img src={photo} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" decoding="async" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-white/60 text-xs font-ui">No Photo</div>
              )}
              <div className="absolute inset-x-0 bottom-0 pt-12 pb-2 px-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent">
                <div className="font-ui text-sm font-medium text-white truncate">{title}</div>
                {profile.age && <div className="font-ui text-xs text-white/80">Age {profile.age}</div>}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch(toggleFavoriteDonor(donor.id));
                }}
                className="absolute top-2 right-2 w-9 h-9 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center hover:bg-black/75 transition-colors"
                data-testid={`saved-remove-${donor.id}`}
                aria-label="Remove from saved"
              >
                <Heart className="w-4 h-4" style={{ color: 'var(--swipe-save)' }} fill="currentColor" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function InlineLocationFilter({ providerType }: { providerType: "egg-donor" | "surrogate" | "sperm-donor" | "ivf-clinic" }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const locationKey = providerType === 'ivf-clinic' ? 'location'
    : providerType === 'surrogate' ? 'surrogateLocation'
    : providerType === 'sperm-donor' ? 'spermLocation'
    : 'eggLocation';
  const urlValue = searchParams.get(locationKey) || '';
  const selected = urlValue ? urlValue.split(',').map(s => s.trim()).filter(Boolean) : [];

  const [query, setQuery] = useState('');

  const writeLocations = useCallback((next: string[]) => {
    const joined = next.join(',');
    setSearchParams(prev => {
      const params = new URLSearchParams(prev);
      if (joined) params.set(locationKey, joined);
      else params.delete(locationKey);
      return params;
    }, { replace: true });
  }, [setSearchParams, locationKey]);

  const addLocation = (loc: string) => {
    if (!loc) return;
    if (selected.includes(loc)) return;
    writeLocations([...selected, loc]);
    setQuery('');
  };

  const removeLocation = (loc: string) => {
    writeLocations(selected.filter(l => l !== loc));
  };

  return (
    <div className="py-3 border-b border-border" data-testid="inline-location-filter">
      <div className="flex items-center justify-between mb-2">
        <span className="font-ui text-base text-foreground">Location</span>
        {selected.length > 0 && (
          <button
            onClick={() => writeLocations([])}
            className="text-muted-foreground hover:text-foreground"
            data-testid="location-reset"
            aria-label="Reset locations"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2" data-testid="selected-locations">
          {selected.map(loc => (
            <span
              key={loc}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium font-ui"
              data-testid={`location-chip-${loc}`}
            >
              {loc}
              <button
                onClick={() => removeLocation(loc)}
                className="hover:text-primary/70"
                aria-label={`Remove ${loc}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <LocationSearchInput
        value={query}
        onValueChange={setQuery}
        onSelect={(commit) => addLocation(commit)}
        placeholder={selected.length > 0 ? "Add another location" : "City, state, or country"}
        inputClassName="bg-muted border-0 font-ui"
        overlayDropdown
        testId="input-location-inline"
        suggestionTestId={(i) => `location-suggestion-${i}`}
      />
    </div>
  );
}

function MarketplaceFiltersDrawer({ providerType, open, onOpenChange, ivfFilterProps }: {
  providerType: "egg-donor" | "surrogate" | "sperm-donor" | "ivf-clinic";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ivfFilterProps?: Record<string, unknown>;
}) {
  const dispatch = useAppDispatch();
  const [searchParams, setSearchParams] = useSearchParams();
  const showSkippedOnly = useAppSelector((state) => state.ui.showSkippedOnly);
  const showExperiencedOnly = useAppSelector((state) => state.ui.showExperiencedOnly);
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const hasAnyFilter =
    Object.values(activeFilters).some(v => Array.isArray(v) && v.length > 0)
    || showSkippedOnly
    || showExperiencedOnly
    || !!searchParams.get('eggLocation')
    || !!searchParams.get('surrogateLocation')
    || !!searchParams.get('spermLocation')
    || !!searchParams.get('location');

  const handleClearAll = useCallback(() => {
    dispatch(clearFilters());
    if (showSkippedOnly) dispatch(setShowSkippedOnly(false));
    if (showExperiencedOnly) dispatch(setShowExperiencedOnly(false));
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('eggLocation');
      next.delete('surrogateLocation');
      next.delete('spermLocation');
      next.delete('location');
      return next;
    }, { replace: true });
  }, [dispatch, setSearchParams, showSkippedOnly, showExperiencedOnly]);

  return (
    <FullDrawer open={open} onOpenChange={onOpenChange} snapPoints={[1]} handleOnly repositionInputs={false} shouldScaleBackground={false} noBodyStyles>
      <FullDrawerContent
        className="h-full mt-0 flex flex-col rounded-t-[var(--radius)]"
        style={{ minHeight: 0 }}
        data-testid="marketplace-filters-drawer"
      >
        <div className="shrink-0 flex items-center gap-3 px-4 pt-2 pb-3 border-b border-border/60">
          {hasAnyFilter ? (
            <button
              onClick={handleClearAll}
              className="shrink-0 h-9 px-3 -ml-3 rounded-full font-ui text-sm text-primary hover:bg-primary/10 transition-colors"
              data-testid="button-clear-all-filters"
            >
              Clear all
            </button>
          ) : (
            <div className="shrink-0 w-9 h-9" aria-hidden />
          )}
          <h1 className="flex-1 text-center font-display text-lg font-heading text-foreground">Filters</h1>
          <button
            onClick={() => onOpenChange(false)}
            className="shrink-0 w-9 h-9 rounded-full bg-foreground hover:opacity-90 flex items-center justify-center transition-colors"
            aria-label="Apply filters"
            data-testid="button-apply-filters"
          >
            <CheckIcon className="w-4 h-4 text-background" strokeWidth={2.5} />
          </button>
        </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {providerType !== "ivf-clinic" && (
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Quick filters</h2>
            <div className="space-y-2">
              <button
                onClick={() => dispatch(setShowExperiencedOnly(!showExperiencedOnly))}
                className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-[var(--radius)] border transition-colors ${showExperiencedOnly ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'}`}
                data-testid="toggle-experienced"
              >
                <div className="flex items-center gap-3">
                  <Award className={`w-5 h-5 ${showExperiencedOnly ? 'text-primary' : 'text-muted-foreground'}`} fill={showExperiencedOnly ? "currentColor" : "none"} />
                  <span className="font-ui text-sm text-foreground">Experienced only</span>
                </div>
                <span className={`text-xs font-medium ${showExperiencedOnly ? 'text-primary' : 'text-muted-foreground'}`}>{showExperiencedOnly ? 'Yes' : 'No'}</span>
              </button>
              <button
                onClick={() => dispatch(setShowSkippedOnly(!showSkippedOnly))}
                className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-[var(--radius)] border transition-colors ${showSkippedOnly ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'}`}
                data-testid="toggle-skipped"
              >
                <div className="flex items-center gap-3">
                  <X className={`w-5 h-5 ${showSkippedOnly ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className="font-ui text-sm text-foreground">Show passed profiles</span>
                </div>
                <span className={`text-xs font-medium ${showSkippedOnly ? 'text-primary' : 'text-muted-foreground'}`}>{showSkippedOnly ? 'Yes' : 'No'}</span>
              </button>
            </div>
          </div>
        )}

        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Preferences</h2>
          <InlineLocationFilter providerType={providerType} />
          {providerType !== "ivf-clinic" && (
            <>
              <InlineRangeFilter filterKey="age" label="Age" min={18} max={45} />
              {providerType !== "surrogate" && (
                <InlineRangeFilter filterKey="height" label="Height" min={48} max={84} formatValue={formatHeightInches} />
              )}
            </>
          )}
          <div className="filter-list-mode">
            <MarketplaceFilterBar providerType={providerType} hideFavorites noResults listMode {...(ivfFilterProps || {})} />
          </div>
        </div>
      </div>

      </FullDrawerContent>
    </FullDrawer>
  );
}

function MobileFilterOverlay({ providerType, hasResults = true, types, activeTab, onSelectType, onOpenFilters }: {
  providerType: "egg-donor" | "surrogate" | "sperm-donor" | "ivf-clinic";
  hasResults?: boolean;
  types: { id: string; label: string }[];
  activeTab: string;
  onSelectType: (id: string) => void;
  onOpenFilters: () => void;
}) {
  const dispatch = useAppDispatch();
  const searchQuery = useAppSelector((state) => state.ui.marketplaceSearchQuery);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSearchToggle = useCallback(() => {
    if (searchExpanded) {
      setSearchExpanded(false);
    } else {
      setSearchExpanded(true);
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [searchExpanded]);

  const handleSearchBlur = useCallback(() => {
    if (!searchQuery) {
      setSearchExpanded(false);
    }
  }, [searchQuery]);

  // Deck container is always dark (deck-bg) regardless of results - use white chrome on top of it
  const iconColor = 'text-white';
  const searchInputBg = 'bg-black/40 backdrop-blur-md text-white placeholder:text-white/50 border-white/15 focus:border-white/30';
  const clearColor = 'text-white/60';

  return (
    <div className="shrink-0 w-full px-3 pb-2" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }} data-testid="mobile-filter-overlay">
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenFilters}
          className="relative shrink-0 w-8 h-8 flex items-center justify-center"
          aria-label="Open filters"
          data-testid="button-open-filters"
        >
          <SlidersHorizontal className={`w-5 h-5 ${iconColor}`} />
        </button>

        {searchExpanded ? (
          <div className="flex-1 relative">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => dispatch(setMarketplaceSearchQuery(e.target.value))}
              onBlur={handleSearchBlur}
              placeholder="Search..."
              className={`w-full h-9 pl-3 pr-8 rounded-full text-sm border outline-none ${searchInputBg}`}
              data-testid="input-search-overlay"
            />
            {searchQuery && (
              <button
                onClick={() => dispatch(setMarketplaceSearchQuery(""))}
                className="absolute right-2.5 top-1/2 -translate-y-1/2"
                data-testid="button-clear-search-overlay"
              >
                <X className={`w-3.5 h-3.5 ${clearColor}`} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex-1 flex justify-center">
            <DeckTypeSwitcher
              types={types}
              activeTab={activeTab}
              onSelect={onSelectType}
              theme="dark"
            />
          </div>
        )}

        <button
          onClick={handleSearchToggle}
          className="relative shrink-0 w-8 h-8 flex items-center justify-center"
          aria-label={searchExpanded ? "Close search" : "Search"}
          data-testid="button-search-toggle"
        >
          {searchExpanded ? (
            <X className={`w-5 h-5 ${iconColor}`} />
          ) : (
            <Search className={`w-5 h-5 ${iconColor}`} />
          )}
        </button>
      </div>
    </div>
  );
}

export default function MarketplacePage() {
  const dispatch = useAppDispatch();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const searchQuery = useAppSelector((state) => state.ui.marketplaceSearchQuery);
  const activeTab = useAppSelector((state) => state.ui.marketplaceTab);
  const activeFilters = useAppSelector((state) => state.ui.activeFilters);
  const showFavoritesOnly = useAppSelector((state) => state.ui.showFavoritesOnly);
  const userRoles = (user as any)?.roles || [];
  const isAdmin = userRoles.includes('GOSTORK_ADMIN');
  const isProviderUser = hasProviderRole(userRoles) && !isAdmin;
  const isParentOnly = userRoles.includes('PARENT') && !isAdmin && !hasProviderRole(userRoles);
  const [scheduleProvider, setScheduleProvider] = useState<{ id: string; name: string } | null>(null);

  // Determine which marketplace tabs a provider can see based on their approved services
  const [providerTabs, setProviderTabs] = useState<string[]>([]);
  useEffect(() => {
    if (!isProviderUser || !(user as any)?.providerId) return;
    fetch(`/api/providers/${(user as any).providerId}/services`, { credentials: "include" })
      .then(res => res.ok ? res.json() : [])
      .then((services: any[]) => {
        const tabs: string[] = [];
        for (const s of services) {
          if (s.status !== "APPROVED") continue;
          const name = (s.providerType?.name || "").toLowerCase();
          if (name.includes("sperm bank") && !tabs.includes("sperm-donors")) tabs.push("sperm-donors");
          if ((name.includes("egg donor") || name.includes("egg bank")) && !tabs.includes("egg-donors")) tabs.push("egg-donors");
          if (name.includes("surrogacy") && !tabs.includes("surrogates")) tabs.push("surrogates");
          if ((name.includes("ivf") || name.includes("clinic")) && !tabs.includes("ivf-clinics")) tabs.push("ivf-clinics");
        }
        setProviderTabs(tabs);
        if (tabs.length > 0 && !tabs.includes(activeTab)) {
          dispatch(setMarketplaceTab(tabs[0]));
        }
      })
      .catch(() => {});
  }, [isProviderUser, (user as any)?.providerId, dispatch]);

  useEffect(() => {
    fetch("/api/donor-preferences", { credentials: "include" })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) dispatch(loadDonorPreferences({ favorited: data.favorited || [], skipped: data.skipped || [] }));
      })
      .catch(() => {});
  }, [dispatch]);

  // Phase 6: load saved/passed doctors + clinics (mirrors donor preferences).
  useEffect(() => {
    fetch("/api/profile-preferences", { credentials: "include" })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) dispatch(loadProviderPreferences({
          favoritedDoctors: data.favoritedDoctors || [],
          passedDoctors: data.passedDoctors || [],
          favoritedClinics: data.favoritedClinics || [],
          passedClinics: data.passedClinics || [],
        }));
      })
      .catch(() => {});
  }, [dispatch]);

  const [searchParams, setSearchParams] = useSearchParams();

  const viewParam = searchParams.get("view");
  // Re-sync on every tab change too: setMarketplaceTab resets showFavoritesOnly,
  // so if we're still on ?view=saved the Saved view would silently flip back to the deck.
  useEffect(() => {
    dispatch(setShowFavoritesOnly(viewParam === "saved"));
  }, [viewParam, activeTab, dispatch]);

  const filtersOpen = searchParams.get("filters") === "1";
  const openFiltersPage = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set("filters", "1");
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const closeFiltersPage = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete("filters");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const parentProfileQuery = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!user && isParentOnly,
    staleTime: 60_000,
  });

  const parentAvailableTypes = useMemo(() => {
    if (!isParentOnly) return [] as { id: string; label: string }[];
    const services = parentProfileQuery.data?.interestedServices ?? [];
    const mapped = services
      .map(s => PARENT_TYPE_MAP[s])
      .filter(Boolean);
    const fallback = Object.values(PARENT_TYPE_MAP);
    const types = mapped.length > 0 ? mapped : fallback;
    return PARENT_TYPE_ORDER
      .map(id => types.find(t => t.id === id))
      .filter(Boolean) as { id: string; label: string }[];
  }, [isParentOnly, parentProfileQuery.data?.interestedServices]);

  useEffect(() => {
    if (!isParentOnly || parentAvailableTypes.length === 0) return;
    // The Explore picker presents all 5 provider types as first-class, so any of
    // them is reachable even when the parent didn't list it as an interest - never
    // bounce them off one of those tabs. Only stale/unknown tabs get redirected.
    if (PARENT_TYPE_ORDER.includes(activeTab)) return;
    if (!parentAvailableTypes.find(t => t.id === activeTab)) {
      dispatch(setMarketplaceTab(parentAvailableTypes[0].id));
    }
  }, [isParentOnly, parentAvailableTypes, activeTab, dispatch]);

  // Deep-link / saved-filter migration: the old Doctors view was a sub-view of the
  // IVF Clinics tab, addressed as ?clinicView=doctors. Doctors is now a first-class
  // tab, so redirect any legacy link to it and strip the stale param.
  useEffect(() => {
    if (searchParams.get("clinicView") === "doctors") {
      const next = new URLSearchParams(searchParams);
      next.delete("clinicView");
      setSearchParams(next, { replace: true });
      dispatch(setMarketplaceTab("doctors"));
    }
  }, [searchParams, setSearchParams, dispatch]);

  const ivfLocation = searchParams.get("location") || "";
  const ivfSearch = searchParams.get("search") || "";
  const eggSource = searchParams.get("eggSource") || "own_eggs";
  const ageGroup = searchParams.get("ageGroup") || "under_35";
  const isNewPatient = searchParams.get("ivfHistory") || "true";
  const sortBy = searchParams.get("sortBy") || "highest_success";
  const insuranceFilter = searchParams.get("insurance") || "";
  const specialtyFilter = searchParams.get("specialty") || "";
  const lgbtqFilter = searchParams.get("lgbtq") === "true";
  const [showCdcInfo, setShowCdcInfo] = useState(false);

  const updateParam = useCallback((key: string, value: string, defaultValue?: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (!value || value === defaultValue) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const setIvfLocation = (v: string) => updateParam("location", v);
  const eggLocation = searchParams.get("eggLocation") || "";
  const surrogateLocation = searchParams.get("surrogateLocation") || "";
  const spermLocation = searchParams.get("spermLocation") || "";
  const setEggLocation = (v: string) => updateParam("eggLocation", v);
  const setSurrogateLocation = (v: string) => updateParam("surrogateLocation", v);
  const setSpermLocation = (v: string) => updateParam("spermLocation", v);
  const donorLocation =
    activeTab === "egg-donors" ? eggLocation :
    activeTab === "surrogates" ? surrogateLocation :
    activeTab === "sperm-donors" ? spermLocation : "";
  useEffect(() => {
    const values = donorLocation
      ? donorLocation.split(",").map(s => s.trim()).filter(Boolean)
      : [];
    dispatch(setFilter({ key: "location", values }));
  }, [donorLocation, dispatch]);
  // Debounce search input to avoid excessive URL updates and API calls
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const [localSearch, setLocalSearch] = useState(ivfSearch);
  useEffect(() => { setLocalSearch(ivfSearch); }, [ivfSearch]);
  const setIvfSearch = (v: string) => {
    setLocalSearch(v);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => updateParam("search", v), 350);
  };
  const setEggSource = (v: string) => updateParam("eggSource", v, "own_eggs");
  const setAgeGroup = (v: string) => updateParam("ageGroup", v, "under_35");
  const setIsNewPatient = (v: string) => updateParam("ivfHistory", v, "true");
  const setSortBy = (v: string) => updateParam("sortBy", v, "highest_success");

  const isProviderTab = activeTab === "ivf-clinics" || activeTab === "surrogacy-agencies";
  const isIvfTab = activeTab === "ivf-clinics";
  const isDoctorTab = activeTab === "doctors";
  const isDonorTab = activeTab === "egg-donors" || activeTab === "surrogates" || activeTab === "sperm-donors";


  const providerQueryParams = isIvfTab
    ? new URLSearchParams(
        Object.entries({
          search: ivfSearch,
          location: ivfLocation,
          eggSource,
          ageGroup,
          ivfHistory: isNewPatient,
          insurance: insuranceFilter,
          lgbtq: lgbtqFilter ? "true" : "",
        }).filter(([, v]) => v)
      ).toString()
    : "";

  const providerUrl = providerQueryParams
    ? `${api.providers.list.path}?${providerQueryParams}`
    : api.providers.list.path;

  const { data: providers, isLoading: providersLoading } = useQuery<ProviderWithRelations[]>({
    queryKey: [api.providers.list.path, ivfSearch, ivfLocation, eggSource, ageGroup, isNewPatient, insuranceFilter, lgbtqFilter],
    queryFn: async () => {
      const res = await fetch(providerUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch providers");
      const data: ProviderWithRelations[] = await res.json();
      return data.filter((p) => p.name !== "GoStork");
    },
    enabled: isProviderTab,
  });

  // Clinics | Doctors view toggle (IVF tab only), stored in the URL.
  const clinicView: "clinics" | "doctors" = isIvfTab && searchParams.get("clinicView") === "doctors" ? "doctors" : "clinics";
  const setClinicView = (v: "clinics" | "doctors") => {
    const next = new URLSearchParams(searchParams);
    if (v === "doctors") next.set("clinicView", "doctors"); else next.delete("clinicView");
    setSearchParams(next, { replace: true });
  };
  const doctorQueryParams = new URLSearchParams(
    Object.entries({
      search: ivfSearch,
      location: ivfLocation,
      insurance: insuranceFilter,
      specialty: specialtyFilter,
      lgbtq: lgbtqFilter ? "true" : "",
      // Success-rate context so each doctor's clinic rate is personalized.
      eggSource,
      ageGroup,
      ivfHistory: isNewPatient === "false" ? "false" : "",
    }).filter(([, v]) => v) as [string, string][],
  ).toString();
  const { data: doctors, isLoading: doctorsLoading } = useQuery<any[]>({
    queryKey: ["/api/providers/marketplace/doctors", ivfSearch, ivfLocation, insuranceFilter, specialtyFilter, lgbtqFilter, eggSource, ageGroup, isNewPatient],
    queryFn: async () => {
      const res = await fetch(`/api/providers/marketplace/doctors${doctorQueryParams ? `?${doctorQueryParams}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch doctors");
      return res.json();
    },
    enabled: isDoctorTab || (isIvfTab && clinicView === "doctors"),
  });

  const setFilterParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next, { replace: true });
  };
  // Parent's own insurance (set in their account) pre-fills the insurance filter.
  const { data: parentProfileForFilter } = useQuery<any>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });
  const myInsurance: string | null = parentProfileForFilter?.insurance || null;

  // Shared IVF filter props - passed to BOTH the inline desktop/mobile bar AND the
  // mobile master "Filters" drawer, so the drawer's controls actually do something
  // (without these the drawer's handlers are undefined and taps are no-ops).
  const ivfFilterProps = {
    ivfLocation,
    onIvfLocationChange: setIvfLocation,
    ivfSearch: localSearch,
    onIvfSearchChange: setIvfSearch,
    ivfEggSource: eggSource,
    onIvfEggSourceChange: setEggSource,
    ivfAgeGroup: ageGroup,
    onIvfAgeGroupChange: setAgeGroup,
    ivfIsNewPatient: isNewPatient,
    onIvfIsNewPatientChange: setIsNewPatient,
    ivfSortBy: sortBy,
    onIvfSortByChange: setSortBy,
    hasIvfLocation: !!ivfLocation,
    ivfInsurance: insuranceFilter,
    onIvfInsuranceChange: (v: string) => setFilterParam("insurance", v || null),
    ivfMyInsurance: myInsurance,
    ivfLgbtqCare: lgbtqFilter,
    onIvfLgbtqCareChange: (v: boolean) => setFilterParam("lgbtq", v ? "true" : null),
    ivfSpecialty: specialtyFilter,
    onIvfSpecialtyChange: (v: string) => setFilterParam("specialty", v || null),
    ivfShowSpecialty: isDoctorTab || clinicView === "doctors",
    ivfSpecialtyOptions: SPECIALTY_OPTIONS,
    ivfClinicView: clinicView,
    onIvfClinicViewChange: setClinicView,
  };

  const ivfClinicCount = useMemo(() => {
    if (!providers || !isIvfTab) return 0;
    return providers.filter((p) =>
      p.services?.some((s: any) => s.status === "APPROVED" && s.providerType?.name === "IVF Clinic")
    ).length;
  }, [providers, isIvfTab]);

  const {
    data: eggDonorPages,
    isLoading: eggLoading,
    fetchNextPage: fetchMoreEggDonors,
    hasNextPage: hasMoreEggDonors,
    isFetchingNextPage: isFetchingMoreEggDonors,
  } = useInfiniteQuery({
    queryKey: ["/api/providers/marketplace/egg-donors"],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await fetch(`/api/providers/marketplace/egg-donors?page=${pageParam}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch egg donors");
      return res.json() as Promise<{ data: any[]; hasMore: boolean; nextPage: number | null }>;
    },
    getNextPageParam: (last) => last.nextPage ?? undefined,
    initialPageParam: 0,
    staleTime: 30_000,
  });
  const eggDonors = useMemo(() => eggDonorPages?.pages.flatMap((p) => p.data) ?? [], [eggDonorPages]);

  const {
    data: surrogatePages,
    isLoading: surrogatesLoading,
    fetchNextPage: fetchMoreSurrogates,
    hasNextPage: hasMoreSurrogates,
    isFetchingNextPage: isFetchingMoreSurrogates,
  } = useInfiniteQuery({
    queryKey: ["/api/providers/marketplace/surrogates"],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await fetch(`/api/providers/marketplace/surrogates?page=${pageParam}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch surrogates");
      return res.json() as Promise<{ data: any[]; hasMore: boolean; nextPage: number | null }>;
    },
    getNextPageParam: (last) => last.nextPage ?? undefined,
    initialPageParam: 0,
    staleTime: 30_000,
  });
  const surrogates = useMemo(() => surrogatePages?.pages.flatMap((p) => p.data) ?? [], [surrogatePages]);

  const {
    data: spermDonorPages,
    isLoading: spermLoading,
    fetchNextPage: fetchMoreSpermDonors,
    hasNextPage: hasMoreSpermDonors,
    isFetchingNextPage: isFetchingMoreSpermDonors,
  } = useInfiniteQuery({
    queryKey: ["/api/providers/marketplace/sperm-donors"],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await fetch(`/api/providers/marketplace/sperm-donors?page=${pageParam}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sperm donors");
      return res.json() as Promise<{ data: any[]; hasMore: boolean; nextPage: number | null }>;
    },
    getNextPageParam: (last) => last.nextPage ?? undefined,
    initialPageParam: 0,
    staleTime: 30_000,
  });
  const spermDonors = useMemo(() => spermDonorPages?.pages.flatMap((p) => p.data) ?? [], [spermDonorPages]);

  const isLoading =
    (activeTab === "ivf-clinics" && providersLoading) ||
    (activeTab === "surrogacy-agencies" && providersLoading) ||
    (activeTab === "egg-donors" && eggLoading) ||
    (activeTab === "surrogates" && surrogatesLoading) ||
    (activeTab === "sperm-donors" && spermLoading) ||
    (isDoctorTab && doctorsLoading);

  // Doctors share the IVF clinics' filter context (success-rate context + the
  // doctor specialty filter), so the Doctors tab uses the same provider-type
  // bucket as IVF Clinics for the filters drawer.
  const currentProviderType = (isIvfTab || isDoctorTab) ? "ivf-clinic" as const :
    activeTab === "surrogates" ? "surrogate" as const :
    activeTab === "sperm-donors" ? "sperm-donor" as const :
    "egg-donor" as const;

  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const onFilteredCountChange = useCallback((count: number) => setFilteredCount(count), []);
  const hasResults = isLoading || (filteredCount === null ? true : filteredCount > 0);

  const filtersDrawerEl = isParentOnly ? (
    <MarketplaceFiltersDrawer
      providerType={currentProviderType}
      open={filtersOpen}
      onOpenChange={(o) => { if (!o) closeFiltersPage(); else openFiltersPage(); }}
      ivfFilterProps={(isIvfTab || isDoctorTab) ? ivfFilterProps : undefined}
    />
  ) : null;

  if (isMobile && (isDonorTab || isIvfTab || isDoctorTab)) {
    return (
      <div className="fixed inset-x-0 top-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-[60] flex flex-col" style={{ backgroundColor: 'hsl(var(--deck-bg))' }} data-testid="marketplace-mobile-immersive">
        {showFavoritesOnly ? (
          <div className="shrink-0 w-full px-3 pb-2" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }} data-testid="saved-type-switcher-mobile">
            <DeckTypeSwitcher
              types={parentAvailableTypes}
              activeTab={activeTab}
              onSelect={(id) => dispatch(setMarketplaceTab(id))}
              theme="dark"
            />
          </div>
        ) : (
          <MobileFilterOverlay
            providerType={currentProviderType}
            hasResults={hasResults}
            types={parentAvailableTypes}
            activeTab={activeTab}
            onSelectType={(id) => dispatch(setMarketplaceTab(id))}
            onOpenFilters={openFiltersPage}
          />
        )}

        <div className="flex-1 min-h-0">
          {isLoading ? (
            <div className="flex justify-center items-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-primary" data-testid="loading-spinner" />
            </div>
          ) : (
            <>
              {activeTab === "egg-donors" && (
                showFavoritesOnly
                  ? <MobileSavedGrid donors={eggDonors} type="egg-donor" />
                  : <DonorGrid donors={eggDonors} searchQuery={searchQuery} type="egg-donor" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreEggDonors} hasNextPage={hasMoreEggDonors} isFetchingMore={isFetchingMoreEggDonors} />
              )}
              {activeTab === "surrogates" && (
                showFavoritesOnly
                  ? <MobileSavedGrid donors={surrogates} type="surrogate" />
                  : <DonorGrid donors={surrogates} searchQuery={searchQuery} type="surrogate" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreSurrogates} hasNextPage={hasMoreSurrogates} isFetchingMore={isFetchingMoreSurrogates} />
              )}
              {activeTab === "sperm-donors" && (
                showFavoritesOnly
                  ? <MobileSavedGrid donors={spermDonors} type="sperm-donor" />
                  : <DonorGrid donors={spermDonors} searchQuery={searchQuery} type="sperm-donor" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreSpermDonors} hasNextPage={hasMoreSpermDonors} isFetchingMore={isFetchingMoreSpermDonors} />
              )}
              {isIvfTab && (
                showFavoritesOnly ? (
                  <div className="flex items-center justify-center h-full px-6 text-center" data-testid="saved-empty-clinics">
                    <div>
                      <Heart className="w-12 h-12 mx-auto mb-3 text-white/40" />
                      <p className="font-ui text-base text-white/85">No saved clinics yet</p>
                      <p className="font-ui text-sm text-white/55 mt-1">Saving clinics is coming soon. For now, browse them on the Discover tab.</p>
                    </div>
                  </div>
                ) : clinicView === "doctors" ? (
                  <DoctorDeckGrid doctors={doctors} loading={doctorsLoading} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} />
                ) : (
                  <IvfClinicDeckGrid providers={providers} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} sortBy={sortBy} />
                )
              )}
              {isDoctorTab && (
                <DoctorDeckGrid doctors={doctors} loading={doctorsLoading} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} />
              )}
            </>
          )}
        </div>

        {scheduleProvider && (
          <ScheduleConsultationDialog
            providerId={scheduleProvider.id}
            providerName={scheduleProvider.name}
            open={!!scheduleProvider}
            onClose={() => setScheduleProvider(null)}
          />
        )}
        {filtersDrawerEl}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(isAdmin || (isProviderUser && providerTabs.length > 1)) && (
        <UnderlineTabs value={activeTab} onValueChange={(val) => dispatch(setMarketplaceTab(val))}>
          <UnderlineTabsList className="overflow-x-auto">
            {(isAdmin ? TABS : TABS.filter(tab => providerTabs.includes(tab.id))).map((tab) => (
              <UnderlineTabsTrigger key={tab.id} value={tab.id} data-testid={`tab-${tab.id}`}>
                <tab.Icon className="w-5 h-5 inline-block" />
                {tab.label}
              </UnderlineTabsTrigger>
            ))}
          </UnderlineTabsList>
        </UnderlineTabs>
      )}

      {/* Mobile + Discover: sliders icon left, type pills center, spacer right */}
      {isParentOnly && isMobile && !showFavoritesOnly && (
        <div className="w-full pt-2 grid grid-cols-[auto_1fr_auto] items-center gap-2">
          <button
            onClick={openFiltersPage}
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-foreground hover:bg-muted transition-colors"
            aria-label="Open filters"
            data-testid="button-open-filters-grid"
          >
            <SlidersHorizontal className="w-5 h-5" />
          </button>
          <DeckTypeSwitcher
            types={parentAvailableTypes}
            activeTab={activeTab}
            onSelect={(id) => dispatch(setMarketplaceTab(id))}
            theme="light"
          />
          <div className="w-9 h-9" aria-hidden />
        </div>
      )}

      {/* Saved view (mobile clinics/agencies or desktop): centered type pills only - no filters */}
      {isParentOnly && showFavoritesOnly && (
        <div className="w-full pt-2">
          <DeckTypeSwitcher
            types={parentAvailableTypes}
            activeTab={activeTab}
            onSelect={(id) => dispatch(setMarketplaceTab(id))}
            theme="light"
          />
        </div>
      )}


      <div className={isAdmin ? "pt-6" : ""}>
        {activeTab !== "surrogacy-agencies" && !showFavoritesOnly && (
          <div className="mb-4" data-testid="marketplace-filter-bar-wrapper">
            <MarketplaceFilterBar
              providerType={currentProviderType}
              {...(isIvfTab ? ivfFilterProps : {
                location: donorLocation,
                onLocationChange:
                  activeTab === "egg-donors" ? setEggLocation :
                  activeTab === "surrogates" ? setSurrogateLocation :
                  setSpermLocation,
                hasLocation: !!donorLocation,
              })}
            />
          </div>
        )}

        {isIvfTab && !showFavoritesOnly && (
          <div className="flex items-center gap-2 relative mb-4">
            <p className="text-sm font-ui text-foreground" data-testid="text-clinic-count">
              <span className="text-primary font-heading">{ivfClinicCount}</span> clinics found
            </p>
            {!ivfLocation && (
              <span className="text-xs text-muted-foreground">
                &middot; Add a location to enable distance sorting
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowCdcInfo(!showCdcInfo)}
              className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
              data-testid="button-toggle-cdc-info"
            >
              <Info className="w-3 h-3" />
            </button>
            {showCdcInfo && (
              <div className="absolute top-full left-0 mt-1 z-20 bg-card border border-border rounded-[var(--radius)] shadow-lg p-3 max-w-sm" data-testid="alert-cdc-info">
                <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                  <li>Patient characteristics affect success rates and may not be comparable between clinics</li>
                  <li>These statistics do not predict your individual chances of success</li>
                  <li>Always consult a physician for personalized medical advice</li>
                  <li>Data source: CDC ART 2022 National Summary Report</li>
                </ul>
              </div>
            )}
          </div>
        )}

        {activeTab === "surrogacy-agencies" && (
          <div className="flex items-center gap-3 mb-4" data-testid="card-search-filters">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                data-testid="input-search"
                className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
                placeholder="Search agencies..."
                value={searchQuery}
                onChange={(e) => dispatch(setMarketplaceSearchQuery(e.target.value))}
              />
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" data-testid="loading-spinner" />
          </div>
        ) : (
          <>
            {isIvfTab && !showFavoritesOnly && !isMobile && (
              <div className="flex justify-center mb-5">
                <div className="inline-flex rounded-full border border-border/60 p-0.5 bg-background" data-testid="toggle-clinic-view">
                  {(["clinics", "doctors"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setClinicView(v)}
                      className={`px-4 py-1.5 text-sm rounded-full transition-colors capitalize ${clinicView === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      data-testid={`toggle-view-${v}`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {isIvfTab && (
              showFavoritesOnly ? (
                <div className="flex items-center justify-center py-20 px-6 text-center" data-testid="saved-empty-clinics">
                  <div>
                    <Heart className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                    <p className="font-ui text-base text-foreground">No saved clinics yet</p>
                    <p className="font-ui text-sm text-muted-foreground mt-1">Saving clinics is coming soon. For now, browse them on the Discover tab.</p>
                  </div>
                </div>
              ) : clinicView === "doctors" ? (
                <DoctorDeckGrid doctors={doctors} loading={doctorsLoading} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} />
              ) : (
                <IvfClinicDeckGrid
                  providers={providers}
                  eggSource={eggSource}
                  ageGroup={ageGroup}
                  isNewPatient={isNewPatient}
                  sortBy={sortBy}
                />
              )
            )}
            {isDoctorTab && (
              <DoctorDeckGrid doctors={doctors} loading={doctorsLoading} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} />
            )}
            {activeTab === "surrogacy-agencies" && (
              showFavoritesOnly ? (
                <div className="flex items-center justify-center py-20 px-6 text-center" data-testid="saved-empty-agencies">
                  <div>
                    <Heart className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                    <p className="font-ui text-base text-foreground">No saved agencies yet</p>
                    <p className="font-ui text-sm text-muted-foreground mt-1">Saving agencies is coming soon. For now, browse them on the Discover tab.</p>
                  </div>
                </div>
              ) : (
                <ProviderGrid
                  providers={providers}
                  searchQuery={searchQuery}
                  providerTypeName="Surrogacy Agency"
                  onSchedule={setScheduleProvider}
                />
              )
            )}
            {activeTab === "egg-donors" && (
              <DonorGrid donors={eggDonors} searchQuery={searchQuery} type="egg-donor" fetchMore={fetchMoreEggDonors} hasNextPage={hasMoreEggDonors} isFetchingMore={isFetchingMoreEggDonors} />
            )}
            {activeTab === "surrogates" && (
              <DonorGrid donors={surrogates} searchQuery={searchQuery} type="surrogate" fetchMore={fetchMoreSurrogates} hasNextPage={hasMoreSurrogates} isFetchingMore={isFetchingMoreSurrogates} />
            )}
            {activeTab === "sperm-donors" && (
              <DonorGrid donors={spermDonors} searchQuery={searchQuery} type="sperm-donor" fetchMore={fetchMoreSpermDonors} hasNextPage={hasMoreSpermDonors} isFetchingMore={isFetchingMoreSpermDonors} />
            )}
          </>
        )}
      </div>

      {scheduleProvider && (
        <ScheduleConsultationDialog
          providerId={scheduleProvider.id}
          providerName={scheduleProvider.name}
          open={!!scheduleProvider}
          onClose={() => setScheduleProvider(null)}
        />
      )}
      {filtersDrawerEl}
    </div>
  );
}
