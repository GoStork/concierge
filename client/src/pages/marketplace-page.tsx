import { useState, useMemo, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { typeToUrlSlug } from "@/lib/profile-utils";
import { api } from "@shared/routes";
import { type ProviderWithRelations } from "@shared/schema";
import { hasProviderRole } from "@shared/roles";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Loader2, Calendar, MapPin, Award, Heart, Clock, Info, X, Baby, FlaskRound, SlidersHorizontal, ArrowLeft } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { getPhotoSrc } from "@/lib/profile-utils";
import { dedupeProviderLocations } from "@/lib/format-location";
import { formatMoneyDollars } from "@/lib/format-money";
import { matchesFilter, matchesSameSexCoupleRequirement, matchesInternationalRequirement, omniSearch, sortDonors, agencyMatchesFilters } from "@/lib/marketplace-filters";
import { PARENT_TYPE_MAP, DOCTORS_TYPE, PARENT_TYPE_ORDER } from "@/lib/parent-marketplace-types";
import { useAppSelector, useAppDispatch } from "@/store";
import { setMarketplaceSearchQuery, setMarketplaceTab, toggleFavoriteDonor, passDonor, undoPassDonor, loadDonorPreferences, loadProviderPreferences, toggleFavoriteDoctor, passDoctor, undoPassDoctor, toggleFavoriteClinic, passClinic, undoPassClinic, toggleFavoriteAgency, passAgency, undoPassAgency, setShowFavoritesOnly, setShowSkippedOnly, setShowExperiencedOnly, setFilter, clearFilters } from "@/store/uiSlice";
import { MarketplaceFilterBar } from "@/components/marketplace/MarketplaceFilterBar";
import { LocationSearchInput } from "@/components/location-search-input";
import { Tabs as UnderlineTabs, TabsList as UnderlineTabsList, TabsTrigger as UnderlineTabsTrigger } from "@/components/ui/underline-tabs";
import { Drawer as FullDrawer, DrawerContent as FullDrawerContent } from "@/components/ui/drawer";
import { Check as CheckIcon } from "lucide-react";
import { SwipeDeckCard } from "@/components/marketplace/swipe-deck-card";
import { SwipeDeck, type SwipeDeckCardMode, type SwipeDeckCardApi } from "@/components/marketplace/swipe-deck";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { ClinicSwipeCard } from "@/components/marketplace/clinic-swipe-card";
import { DoctorSwipeCard } from "@/components/marketplace/doctor-swipe-card";
import { AgencySwipeCard } from "@/components/marketplace/agency-swipe-card";
import { useMarketplaceViewContext, recordProfileView, recordImpression, useScrollPastView } from "@/lib/profile-views";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  getPhotoList, getMatchedPreferences, buildTitle, buildStatusLabel,
  getDonorTabs, getSurrogateTabs, isSponsored,
  mapDatabaseDonorToSwipeProfile, mapDatabaseSurrogateToSwipeProfile, mapDatabaseSpermDonorToSwipeProfile,
  type DoctorCardData,
} from "@/components/marketplace/swipe-mappers";

import { EggDonorIcon, SurrogateIcon, IvfClinicIcon, AgencyIcon, SpermIcon, DoctorIcon } from "@/components/icons/marketplace-icons";

/**
 * URL params that belong to whichever marketplace tab set them - a search, a
 * sort, a location, or a clinic filter. All cleared on a tab change: nothing a
 * user chose for one profile type should describe another. Only the params that
 * identify the view itself survive (tab, view, filters, clinicView).
 */
const TAB_SCOPED_PARAMS = [
  "search", "sortBy", "location", "eggLocation", "surrogateLocation", "spermLocation", "agencyLocation",
  "eggSource", "ageGroup", "insurance", "lgbtq", "ivfHistory", "specialty",
];


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
  { id: "doctors", label: "Doctors", Icon: DoctorIcon },
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
        <p className="t-helper mb-2">
          Choose a team member from {providerName} to schedule with:
        </p>
        {isLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
        ) : members?.length === 0 ? (
          <p className="t-helper py-4 text-center">No team members have booking pages set up yet.</p>
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
                    <p className="t-helper">{m.meetingDuration} min consultation</p>
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
        {(() => {
          const loc = dedupeProviderLocations(provider.locations || [])[0];
          return loc && (
          <p className="t-helper flex items-center gap-1" data-testid={`text-provider-location-${provider.id}`}>
            <MapPin className="w-3.5 h-3.5 shrink-0" />
            {loc.city}{loc.state ? `, ${loc.state}` : ""}
          </p>
          );
        })()}

        {pct !== null && (
          <div data-testid={`ivf-rate-section-${provider.id}`}>
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <span className="text-2xl font-heading text-foreground">{pct}%</span>
              <span className="t-helper">success rate</span>
            </div>
            <p className="t-helper mb-2">{filterLabel}</p>

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
        <p className="t-helper flex items-center gap-1" data-testid={`text-cycles-${provider.id}`}>
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
      // Sponsored clinics stay pinned on top regardless of the chosen sort.
      const aSp = isSponsored(a.provider) ? 1 : 0;
      const bSp = isSponsored(b.provider) ? 1 : 0;
      if (aSp !== bSp) return bSp - aSp;
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
function IvfClinicDeckGrid({ providers, eggSource, ageGroup, isNewPatient, sortBy, onFilteredCountChange }: {
  providers: ProviderWithRelations[] | undefined;
  eggSource: string;
  ageGroup: string;
  isNewPatient: string;
  sortBy: string;
  /** Reports how many clinics are actually rendered, so the header count can
   *  match the deck. Discover hides saved and passed clinics, so the raw list
   *  length is not what the parent sees. */
  onFilteredCountChange?: (count: number) => void;
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const favoritedClinics = useAppSelector((s) => s.ui.favoritedClinicIds);
  const passedClinics = useAppSelector((s) => s.ui.passedClinicIds);
  const showFavoritesOnly = useAppSelector((s) => s.ui.showFavoritesOnly);
  const showSkippedOnly = useAppSelector((s) => s.ui.showSkippedOnly);
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
      // Explore/Discover hides already-saved clinics (they live in the Saved tab).
      if (!showFavoritesOnly && favoritedClinics.includes(p.id)) return false;
      return true;
    });
    const withRates = visible.map((p) => ({ provider: p, rate: pickMatchedRate((p as any).ivfSuccessRates, eggSource) }));
    withRates.sort((a, b) => {
      // Sponsored clinics stay pinned on top regardless of the chosen sort.
      const aSp = isSponsored(a.provider) ? 1 : 0;
      const bSp = isSponsored(b.provider) ? 1 : 0;
      if (aSp !== bSp) return bSp - aSp;
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

  useEffect(() => {
    onFilteredCountChange?.(sorted.length);
  }, [sorted.length, onFilteredCountChange]);

  const goToProfile = (id: string) => {
    const params = new URLSearchParams();
    if (eggSource) params.set("eggSource", eggSource);
    if (ageGroup) params.set("ageGroup", ageGroup);
    if (isNewPatient) params.set("isNewPatient", isNewPatient);
    const qs = params.toString();
    navigate(`/providers/${id}${qs ? `?${qs}` : ""}`);
  };

  const onSave = (id: string) => {
    recordProfileView(id, "clinic" as any);
    const fav = favoritedClinics.includes(id);
    dispatch(toggleFavoriteClinic(id));
    syncPref("favorite", id, fav ? "remove" : "add");
  };
  const onPass = (id: string) => {
    recordProfileView(id, "clinic" as any);
    dispatch(passClinic(id));
    syncPref("skip", id, "add");
  };
  const onUndo = (id: string) => {
    if (passedClinics.includes(id)) { dispatch(undoPassClinic(id)); syncPref("skip", id, "remove"); }
    else if (favoritedClinics.includes(id)) { dispatch(toggleFavoriteClinic(id)); syncPref("favorite", id, "remove"); }
  };

  const renderCard = (p: ProviderWithRelations, mode: SwipeDeckCardMode, api: SwipeDeckCardApi) => (
    <ClinicSwipeCard
      providerId={p.id}
      provider={p}
      eggSource={eggSource}
      ageGroup={ageGroup}
      isNewPatient={isNew}
      disableSwipe={mode !== "active"}
      isSaved={favoritedClinics.includes(p.id)}
      isPassed={passedClinics.includes(p.id)}
      onSave={api.onSave}
      onPass={api.onPass}
      onUndo={mode === "active" ? api.onUndo : (passedClinics.includes(p.id) ? () => onUndo(p.id) : undefined)}
      onViewProfile={() => { recordProfileView(p.id, "clinic" as any); goToProfile(p.id); }}
      onMessage={() => { recordProfileView(p.id, "clinic" as any); navigate(`/concierge?donorId=${p.id}&donorType=clinic&providerId=${p.id}`); }}
    />
  );

  return (
    <SwipeDeck
      items={sorted}
      getKey={(p) => p.id}
      renderCard={renderCard}
      onSave={onSave}
      onPass={onPass}
      onUndo={onUndo}
      onActiveChange={(p) => recordImpression(p.id, "clinic")}
      renderGridItem={(item, card, key) => (
        <GridDwellItem profileId={key} profileType="clinic" testId={`clinic-card-container-${key}`}>{card}</GridDwellItem>
      )}
      resetDeps={[showFavoritesOnly, showSkippedOnly, providers]}
      dim={showSkippedOnly}
      emptyTitle="No clinics found"
      emptySubtitle="Try adjusting your filters or search criteria."
      seenAllTitle="You've seen all clinics!"
      seenAllSubtitle="Adjust your filters or check back later."
      emptyTestId="text-no-clinics"
      seenAllTestId="text-no-more-clinics"
      restartTestId="button-restart-clinic-swipe"
      mobileDeckTestId="clinic-swipe-deck-mobile"
      cardTestIdPrefix="clinic-card"
    />
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
      // Explore/Discover hides already-saved doctors (they live in the Saved tab).
      if (!showFavoritesOnly && favoritedSlugs.includes(d.slug)) return false;
      return true;
    });
  }, [doctors, showFavoritesOnly, favoritedSlugs, showSkippedOnly, passedSlugs]);

  const onSave = (slug: string) => {
    recordProfileView(slug, "doctor" as any);
    const isFav = favoritedSlugs.includes(slug);
    dispatch(toggleFavoriteDoctor(slug));
    syncPref("favorite", slug, isFav ? "remove" : "add");
  };
  const onPass = (slug: string) => {
    recordProfileView(slug, "doctor" as any);
    dispatch(passDoctor(slug));
    syncPref("skip", slug, "add");
  };
  const onUndo = (slug: string) => {
    if (passedSlugs.includes(slug)) { dispatch(undoPassDoctor(slug)); syncPref("skip", slug, "remove"); }
    else if (favoritedSlugs.includes(slug)) { dispatch(toggleFavoriteDoctor(slug)); syncPref("favorite", slug, "remove"); }
  };

  const renderCard = (doctor: DoctorCardData & { slug: string }, mode: SwipeDeckCardMode, api: SwipeDeckCardApi) => (
    <DoctorSwipeCard
      doctor={doctor}
      contextLabel={contextLabel}
      compact={isMobile}
      disableSwipe={mode !== "active"}
      isSaved={favoritedSlugs.includes(doctor.slug)}
      isPassed={passedSlugs.includes(doctor.slug)}
      onSave={api.onSave}
      onPass={api.onPass}
      onUndo={mode === "active" ? api.onUndo : (passedSlugs.includes(doctor.slug) ? () => onUndo(doctor.slug) : undefined)}
      onViewProfile={() => { recordProfileView(doctor.slug, "doctor" as any); navigate(`/doctors/${doctor.slug}`); }}
      onMessage={() => { recordProfileView(doctor.slug, "doctor" as any); navigate(`/concierge?donorId=${doctor.slug}&donorType=doctor`, { state: { doctorCard: doctor } }); }}
    />
  );

  if (loading) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      </div>
    );
  }

  return (
    <SwipeDeck
      items={filtered}
      getKey={(d) => d.slug}
      renderCard={renderCard}
      onSave={onSave}
      onPass={onPass}
      onUndo={onUndo}
      onActiveChange={(d) => recordImpression(d.slug, "doctor")}
      renderGridItem={(item, card, key) => (
        <GridDwellItem profileId={key} profileType="doctor" testId={`doctor-card-container-${key}`}>{card}</GridDwellItem>
      )}
      resetDeps={[showFavoritesOnly, showSkippedOnly, doctors]}
      dim={showSkippedOnly}
      emptyTitle="No doctors found"
      emptySubtitle="Try a different name, specialty, or location."
      seenAllTitle="You've seen all doctors!"
      seenAllSubtitle="Adjust your filters or check back later."
      emptyTestId="text-no-doctors"
      seenAllTestId="text-no-more-doctors"
      restartTestId="button-restart-doctor-swipe"
      mobileDeckTestId="doctor-swipe-deck-mobile"
      cardTestIdPrefix="doctor-card"
    />
  );
}

// Surrogacy Agencies deck - the SAME shared SwipeDeck + provider card the IVF
// clinics use, so agencies now have an identical swipe / like / pass experience
// (previously a browse-only grid with no save). Detail opens the shared
// ProviderProfilePage (/providers/:id). Success-rate bars are simply absent since
// agencies have none.
function AgencyDeck({ providers, searchQuery }: {
  providers: ProviderWithRelations[] | undefined;
  searchQuery: string;
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { user } = useAuth();
  const parentAccountId = (user as any)?.parentAccountId as string | undefined;
  const favoritedAgencies = useAppSelector((s) => s.ui.favoritedAgencyIds);
  const passedAgencies = useAppSelector((s) => s.ui.passedAgencyIds);
  const showFavoritesOnly = useAppSelector((s) => s.ui.showFavoritesOnly);
  const showSkippedOnly = useAppSelector((s) => s.ui.showSkippedOnly);
  const activeFilters = useAppSelector((s) => s.ui.activeFilters);
  const sortBy = useAppSelector((s) => s.ui.marketplaceSortBy);

  // Parent citizenship for the "Accepts my citizenship" filter.
  const { data: parentProfile } = useQuery<any>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const r = await fetch("/api/parent-profile", { credentials: "include" });
      return r.ok ? r.json() : null;
    },
    staleTime: 60000,
  });
  const parentCountry: string | null = parentProfile?.nationality || parentProfile?.country || null;

  // Parent-matched starting cost per agency - powers the Total Cost filter
  // (every agency's price is needed upfront, so a per-card fetch won't work).
  const { data: startingCosts } = useQuery<Record<string, number>>({
    queryKey: ["/api/costs/agencies/starting-costs", parentAccountId],
    queryFn: async () => {
      const r = await fetch(`/api/costs/agencies/starting-costs?parentAccountId=${parentAccountId}`, { credentials: "include" });
      return r.ok ? r.json() : {};
    },
    enabled: !!parentAccountId,
    staleTime: 60000,
  });

  const syncPref = (prefType: "favorite" | "skip", id: string, action: "add" | "remove") => {
    fetch(`/api/profile-preferences/agency/${prefType}/${id}`, { method: action === "add" ? "POST" : "DELETE", credentials: "include" }).catch(() => {});
  };

  const q = searchQuery.trim().toLowerCase();
  const sorted = useMemo(() => {
    const agencies = (providers || []).filter((p) =>
      (p.services || []).some((s: any) => s.status === "APPROVED" && s.providerType?.name === "Surrogacy Agency"),
    );
    return agencies
      .filter((p) => {
        if (q && !p.name.toLowerCase().includes(q)) return false;
        if (showFavoritesOnly && !favoritedAgencies.includes(p.id)) return false;
        if (showSkippedOnly && !passedAgencies.includes(p.id)) return false;
        if (!showSkippedOnly && passedAgencies.includes(p.id)) return false;
        // Explore/Discover hides already-saved agencies (they live in Saved).
        if (!showFavoritesOnly && favoritedAgencies.includes(p.id)) return false;
        // Active marketplace filters (location, cost, services, twins, lgbtq,
        // citizenship). Attach the parent-matched starting cost so the Total
        // Cost filter has a number to compare against.
        const withCost = { ...p, totalCost: startingCosts?.[p.id] ?? 0 };
        if (!agencyMatchesFilters(withCost, activeFilters, parentCountry)) return false;
        return true;
      })
      .sort((a, b) => {
        const costA = startingCosts?.[a.id] ?? 0;
        const costB = startingCosts?.[b.id] ?? 0;
        switch (sortBy) {
          case "alphabetical_desc": return b.name.localeCompare(a.name);
          // Unpriced agencies sort last for cost orderings (so a $0 placeholder
          // never beats a real price).
          case "cost_asc": return (costA || Infinity) - (costB || Infinity);
          case "cost_desc": return costB - costA;
          case "newest": return new Date((b as any).createdAt || 0).getTime() - new Date((a as any).createdAt || 0).getTime();
          default: return a.name.localeCompare(b.name);
        }
      });
  }, [providers, q, showFavoritesOnly, favoritedAgencies, showSkippedOnly, passedAgencies, activeFilters, parentCountry, startingCosts, sortBy]);

  const onSave = (id: string) => {
    const fav = favoritedAgencies.includes(id);
    dispatch(toggleFavoriteAgency(id));
    syncPref("favorite", id, fav ? "remove" : "add");
  };
  const onPass = (id: string) => { dispatch(passAgency(id)); syncPref("skip", id, "add"); };
  const onUndo = (id: string) => {
    if (passedAgencies.includes(id)) { dispatch(undoPassAgency(id)); syncPref("skip", id, "remove"); }
    else if (favoritedAgencies.includes(id)) { dispatch(toggleFavoriteAgency(id)); syncPref("favorite", id, "remove"); }
  };

  const renderCard = (p: ProviderWithRelations, mode: SwipeDeckCardMode, api: SwipeDeckCardApi) => (
    <AgencySwipeCard
      providerId={p.id}
      provider={p}
      disableSwipe={mode !== "active"}
      isSaved={favoritedAgencies.includes(p.id)}
      isPassed={passedAgencies.includes(p.id)}
      onSave={api.onSave}
      onPass={api.onPass}
      onUndo={mode === "active" ? api.onUndo : (passedAgencies.includes(p.id) ? () => onUndo(p.id) : undefined)}
      onViewProfile={() => navigate(`/providers/${p.id}`)}
      onMessage={() => { recordProfileView(p.id, "agency" as any); navigate(`/concierge?donorId=${p.id}&donorType=agency&providerId=${p.id}`); }}
    />
  );

  return (
    <SwipeDeck
      items={sorted}
      getKey={(p) => p.id}
      renderCard={renderCard}
      onSave={onSave}
      onPass={onPass}
      onUndo={onUndo}
      resetDeps={[showFavoritesOnly, showSkippedOnly, providers, q, activeFilters]}
      dim={showSkippedOnly}
      emptyTitle="No surrogacy agencies found"
      emptySubtitle="Try adjusting your search."
      seenAllTitle="You've seen all agencies!"
      seenAllSubtitle="Adjust your filters or check back later."
      emptyTestId="text-no-agencies"
      seenAllTestId="text-no-more-agencies"
      restartTestId="button-restart-agency-swipe"
      mobileDeckTestId="agency-swipe-deck-mobile"
      cardTestIdPrefix="agency-card"
    />
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
            {(() => {
              const loc = dedupeProviderLocations(provider.locations || [])[0];
              return loc && (
              <p className="t-helper flex items-center gap-1" data-testid={`text-provider-location-${provider.id}`}>
                <MapPin className="w-3.5 h-3.5" />
                {loc.city}{loc.state ? `, ${loc.state}` : ""}
              </p>
              );
            })()}
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

// Grid-mode wrapper. Uses an IntersectionObserver (via useScrollPastView) to
// record the profile as "viewed" once it has been on screen for >=1s, so the
// "New" badge clears as the parent scrolls the desktop grid. The card itself is
// rendered by the shared SwipeDeck and passed in as children.
function DonorGridItem({ donor, type, dim, children }: {
  donor: any;
  type: "egg-donor" | "surrogate" | "sperm-donor";
  dim: boolean;
  children: ReactNode;
}) {
  const setScrollRef = useScrollPastView(donor.id, type);
  return (
    <div
      ref={setScrollRef}
      className="h-[600px]"
      data-testid={`card-container-${donor.id}`}
    >
      {children}
    </div>
  );
}

// Generic desktop-grid dwell wrapper for clinics/doctors. Same Intersection
// observer as DonorGridItem (>=1s on screen -> impression + cleared "New"
// badge), wired through SwipeDeck's `renderGridItem` hook so it ONLY runs on
// the desktop grid - the mobile deck records impressions via `onActiveChange`,
// so this can't double-count. profileType is "clinic" | "doctor".
function GridDwellItem({ profileId, profileType, testId, children }: {
  profileId: string;
  profileType: string;
  testId: string;
  children: ReactNode;
}) {
  const setScrollRef = useScrollPastView(profileId, profileType as any);
  return (
    <div ref={setScrollRef} className="h-[600px]" data-testid={testId}>
      {children}
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
  const { user } = useAuth();
  const { viewedIds, previousVisitAt } = useMarketplaceViewContext();
  // Hook MUST live above the empty-state early return below - calling it
  // conditionally flips the hook count when a filter empties the list.
  const { toast } = useToast();

  const userCountry = (user as any)?.country || null;
  const userIdentification = (user as any)?.identification || null;

  const filtered = useMemo(() => {
    let result = donors?.filter((d) => {
      if (showFavoritesOnly && !favoritedIds.includes(d.id)) return false;
      if (showSkippedOnly && !passedIds.includes(d.id)) return false;
      if (!showSkippedOnly && passedIds.includes(d.id)) return false;
      // Explore/Discover shows only un-acted profiles: hide already-saved ones
      // (they live in the Saved tab), just like passed ones are hidden.
      if (!showFavoritesOnly && favoritedIds.includes(d.id)) return false;
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

  const mapDonor = (d: any) => {
    if (type === "surrogate") return mapDatabaseSurrogateToSwipeProfile(d);
    if (type === "sperm-donor") return mapDatabaseSpermDonorToSwipeProfile(d);
    return mapDatabaseDonorToSwipeProfile(d);
  };

  const getTabs = (profile: ReturnType<typeof mapDonor>) => {
    const matched = getMatchedPreferences(profile, userPrefs);
    if (type === "surrogate") return getSurrogateTabs(profile, matched);
    return getDonorTabs(profile, matched, type === "sperm-donor");
  };

  const syncPref = (prefType: "favorite" | "skip", donorId: string, action: "add" | "remove") => {
    const method = action === "add" ? "POST" : "DELETE";
    fetch(`/api/donor-preferences/${prefType}/${donorId}`, { method, credentials: "include" }).catch(() => {});
  };

  // Saving/passing removes the donor from `filtered` (saved + passed are hidden
  // from Explore), which auto-advances. The shared SwipeDeck owns the index +
  // back-button history; these just commit Redux + server state.
  const onSave = (donorId: string) => {
    recordProfileView(donorId, type);
    const isFav = favoritedIds.includes(donorId);
    dispatch(toggleFavoriteDonor(donorId));
    syncPref("favorite", donorId, isFav ? "remove" : "add");
  };
  const onPass = (donorId: string) => {
    recordProfileView(donorId, type);
    dispatch(passDonor(donorId));
    syncPref("skip", donorId, "add");
  };
  const onUndo = (donorId: string) => {
    if (passedIds.includes(donorId)) { dispatch(undoPassDonor(donorId)); syncPref("skip", donorId, "remove"); }
    else if (favoritedIds.includes(donorId)) { dispatch(toggleFavoriteDonor(donorId)); syncPref("favorite", donorId, "remove"); }
  };

  // When the mobile active card changes: record the view (clears "New" badge),
  // preload the next few cards' photos, and paginate near the end.
  const handleActiveChange = useCallback((donor: any, index: number) => {
    recordProfileView(donor.id, type);
    recordImpression(donor.id, type);
    const toPreload = (filtered || []).slice(index, index + 3);
    for (const d of toPreload) {
      const p = type === "surrogate" ? mapDatabaseSurrogateToSwipeProfile(d) : type === "sperm-donor" ? mapDatabaseSpermDonorToSwipeProfile(d) : mapDatabaseDonorToSwipeProfile(d);
      for (const src of getPhotoList(p)) { const img = new Image(); img.src = src; }
    }
    if (fetchMore && hasNextPage && !isFetchingMore && (filtered?.length ?? 0) - index <= 10) fetchMore();
  }, [filtered, type, fetchMore, hasNextPage, isFetchingMore]);

  // Empty-state early return MUST come after every hook above (incl. the
  // handleActiveChange useCallback) - returning before a hook changes the hook
  // count between renders and throws "Rendered fewer hooks than expected" the
  // moment a filter (e.g. Skipped) empties the list.
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

  // Bank skip-to-checkout: parents can buy Egg Bank / Sperm Bank donors with
  // a published total cost directly - one click creates the session + cost
  // sheet + invoice and lands in the new chat. Agency donors never get this.
  const isParentViewer = !(user as any)?.providerId && !((user as any)?.roles || []).includes("GOSTORK_ADMIN");
  const bankTypeName = type === "egg-donor" ? "Egg Bank" : type === "sperm-donor" ? "Sperm Bank" : null;
  const checkoutFor = (donor: any) => {
    if (!isParentViewer || !bankTypeName) return undefined;
    const isBankDonor = ((donor.provider?.services || []) as any[]).some((sv: any) => sv.providerType?.name === bankTypeName);
    if (!isBankDonor || !(Number(donor.totalCost) > 0)) return undefined;
    return async () => {
      recordProfileView(donor.id, type);
      try {
        const res = await fetch("/api/bank-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ donorId: donor.id, donorType: type, providerId: donor.providerId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.message || "Checkout failed");
        if (body.status === "already_pending") toast({ title: "Invoice already waiting", description: "Complete the payment in the chat." });
        if (body.status === "already_paid") toast({ title: "Already purchased", description: "Your payment for this donor is complete." });
        navigate(`/chat/${body.sessionId}`);
      } catch (e: any) {
        toast({ title: "Checkout failed", description: e?.message, variant: "destructive" });
      }
    };
  };

  const renderCard = (donor: any, mode: SwipeDeckCardMode, api: SwipeDeckCardApi) => {
    const profile = mapDonor(donor);
    const tabs = getTabs(profile);
    return (
      <SwipeDeckCard
        id={profile.id}
        photos={getPhotoList(profile)}
        title={buildTitle(profile)}
        statusLabel={buildStatusLabel(profile, viewedIds, previousVisitAt)}
        donorStatus={profile.donorStatus}
        onHoldUntil={profile.onHoldUntil ?? null}
        frozenLotStatus={profile.frozenLotStatus}
        isExperienced={profile.isExperienced}
        isPremium={profile.isPremium}
        uploadedAt={isParentViewer ? null : profile.createdAt}
        sponsored={profile.sponsored}
        tabs={tabs}
        disableSwipe={mode !== "active"}
        isSaved={favoritedIds.includes(donor.id)}
        isPassed={passedIds.includes(donor.id)}
        onSave={api.onSave}
        onPass={api.onPass}
        onUndo={mode === "active" ? api.onUndo : (passedIds.includes(donor.id) ? () => onUndo(donor.id) : undefined)}
        onMessage={() => { recordProfileView(donor.id, type); navigate(`/concierge?donorId=${donor.id}&donorType=${type}&providerId=${donor.providerId}&photoUrl=${encodeURIComponent(donor.photoUrl || "")}`); }}
        onCheckout={checkoutFor(donor)}
        onViewFullProfile={() => { recordProfileView(donor.id, type); navigate(`/${typeToUrlSlug(type)}/${donor.providerId}/${donor.id}`, { state: { initialPhotoUrl: donor.photoUrl, deckList: (filtered || []).map((d) => ({ id: d.id, providerId: d.providerId, photoUrl: d.photoUrl })), deckIndex: (filtered || []).findIndex((d) => d.id === donor.id) } }); }}
      />
    );
  };

  return (
    <SwipeDeck
      items={filtered}
      getKey={(d) => d.id}
      renderCard={renderCard}
      onSave={onSave}
      onPass={onPass}
      onUndo={onUndo}
      resetDeps={[searchQuery, activeFilters, sortBy, showFavoritesOnly, showSkippedOnly, showExperiencedOnly]}
      dim={showSkippedOnly}
      onActiveChange={handleActiveChange}
      emptyTitle="No profiles found"
      emptySubtitle="Check back soon as more profiles are added."
      seenAllTitle="You've seen all profiles!"
      seenAllSubtitle="Adjust your filters or check back later."
      seenAllTestId="text-no-more"
      restartTestId="button-restart-swipe"
      mobileDeckTestId="swipe-deck-mobile"
      cardTestIdPrefix="card"
      renderGridItem={(donor, card) => (
        <DonorGridItem donor={donor} type={type} dim={showSkippedOnly}>{card}</DonorGridItem>
      )}
      gridFooter={
        <>
          <div ref={sentinelRef} className="col-span-full" />
          {isFetchingMore && (
            <div className="col-span-full flex justify-center py-6">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </>
      }
    />
  );
}


// PARENT_TYPE_MAP / DOCTORS_TYPE / PARENT_TYPE_ORDER now live in the shared
// parent-marketplace-types module (reused by layout-shell's nav). Re-exported via
// the import below.

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
        <span className="t-helper font-ui">{fmt(min)}</span>
        <span className="t-helper font-ui">{fmt(max)}</span>
      </div>
    </div>
  );
}

function formatHeightInches(v: number) {
  const ft = Math.floor(v / 12);
  const inches = v % 12;
  return `${ft}'${inches}"`;
}

// Saved-tab grid, shared by ALL provider types (egg donors, surrogates, sperm
// donors, IVF clinics, doctors) so the Saved view has ONE consistent 2-up card
// design. Each entity is normalized to a single card shape (photo/title/subtitle
// + remove-heart + open route); clinics fall back to their logo, doctors to a
// brand monogram when there's no headshot.
type SavedCard = {
  key: string;
  photo: string | null;
  logo?: string | null;
  monogramName?: string | null;
  title: string;
  subtitle?: string | null;
  onOpen: () => void;
  onRemove: () => void;
};

function MobileSavedGrid({ kind, items }: {
  kind: "egg-donor" | "surrogate" | "sperm-donor" | "clinic" | "doctor";
  items: any[];
}) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const favoritedDonorIds = useAppSelector((s) => s.ui.favoritedDonorIds);
  const favoritedClinicIds = useAppSelector((s) => s.ui.favoritedClinicIds);
  const favoritedDoctorSlugs = useAppSelector((s) => s.ui.favoritedDoctorSlugs);

  const cards: SavedCard[] = useMemo(() => {
    const list = items || [];
    if (kind === "clinic") {
      return list
        .filter((p) => favoritedClinicIds.includes(p.id))
        .map((p) => {
          const members = Array.isArray(p.members) ? p.members.filter((m: any) => m?.isPublicProfile !== false) : [];
          const face = members.map((m: any) => getPhotoSrc(m?.photoUrl)).find(Boolean) || null;
          const loc = dedupeProviderLocations(p.locations || [])[0];
          return {
            key: p.id,
            photo: face,
            logo: getPhotoSrc(p.logoUrl) || null,
            title: p.name,
            subtitle: loc ? [loc.city, loc.state].filter(Boolean).join(", ") : null,
            onOpen: () => navigate(`/providers/${p.id}`),
            onRemove: () => dispatch(toggleFavoriteClinic(p.id)),
          };
        });
    }
    if (kind === "doctor") {
      return list
        .filter((d) => favoritedDoctorSlugs.includes(d.slug))
        .map((d) => ({
          key: d.slug,
          photo: getPhotoSrc(d.photoUrl) || null,
          monogramName: d.name,
          title: d.name,
          subtitle: d.providerName || null,
          onOpen: () => navigate(`/doctors/${d.slug}`),
          onRemove: () => dispatch(toggleFavoriteDoctor(d.slug)),
        }));
    }
    const mapProfile = (d: any) =>
      kind === "surrogate" ? mapDatabaseSurrogateToSwipeProfile(d)
        : kind === "sperm-donor" ? mapDatabaseSpermDonorToSwipeProfile(d)
          : mapDatabaseDonorToSwipeProfile(d);
    const slug = kind === "surrogate" ? "surrogate" : kind === "sperm-donor" ? "spermdonor" : "eggdonor";
    return list
      .filter((d) => favoritedDonorIds.includes(d.id))
      .map((donor) => {
        const profile = mapProfile(donor);
        return {
          key: donor.id,
          photo: getPhotoList(profile)[0] || null,
          title: buildTitle(profile),
          subtitle: profile.age ? `Age ${profile.age}` : null,
          onOpen: () => navigate(`/${slug}/${donor.providerId}/${donor.id}`),
          onRemove: () => dispatch(toggleFavoriteDonor(donor.id)),
        };
      });
  }, [kind, items, favoritedDonorIds, favoritedClinicIds, favoritedDoctorSlugs, navigate, dispatch]);

  if (cards.length === 0) {
    return (
      <div className="flex items-center justify-center h-full px-6 text-center" data-testid="saved-empty">
        <div>
          <Heart className="w-12 h-12 mx-auto mb-3 text-white/40" />
          <p className="font-ui text-base text-white/85">No saved {kind === "clinic" ? "clinics" : kind === "doctor" ? "doctors" : "profiles"} yet</p>
          <p className="font-ui text-sm text-white/55 mt-1">Tap the heart while browsing to save it here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 px-2 pt-2 pb-4 overflow-y-auto h-full content-start" data-testid="saved-grid">
      {cards.map((c) => (
        // Padding-bottom hack for a reliable 3:4 aspect ratio across all browsers.
        <div key={c.key} className="relative w-full" style={{ paddingBottom: '133.333%' }} data-testid={`saved-card-${c.key}`}>
          <div
            role="button"
            tabIndex={0}
            onClick={c.onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') c.onOpen(); }}
            className="absolute inset-0 rounded-[var(--radius)] overflow-hidden bg-[hsl(var(--deck-bg-elevated))] shadow-md cursor-pointer"
          >
            {c.photo ? (
              <img src={c.photo} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" decoding="async" />
            ) : c.logo ? (
              <div className="absolute inset-0 flex items-center justify-center p-4 bg-white"><img src={c.logo} alt="" className="max-w-full max-h-full object-contain" loading="lazy" /></div>
            ) : c.monogramName ? (
              <div className="absolute inset-0 flex items-center justify-center"><DoctorMonogram name={c.monogramName} size={72} /></div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-white/60 text-xs font-ui">No Photo</div>
            )}
            <div className="absolute inset-x-0 bottom-0 pt-12 pb-2 px-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent">
              <div className="font-ui text-sm font-medium text-white truncate">{c.title}</div>
              {c.subtitle && <div className="font-ui text-xs text-white/80 truncate">{c.subtitle}</div>}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); c.onRemove(); }}
              className="absolute top-2 right-2 w-9 h-9 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center hover:bg-black/75 transition-colors"
              data-testid={`saved-remove-${c.key}`}
              aria-label="Remove from saved"
            >
              <Heart className="w-4 h-4" style={{ color: 'var(--swipe-save)' }} fill="currentColor" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function InlineLocationFilter({ providerType }: { providerType: "egg-donor" | "surrogate" | "sperm-donor" | "ivf-clinic" | "surrogacy-agency" }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const locationKey = providerType === 'ivf-clinic' ? 'location'
    : providerType === 'surrogate' ? 'surrogateLocation'
    : providerType === 'sperm-donor' ? 'spermLocation'
    : providerType === 'surrogacy-agency' ? 'agencyLocation'
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

// Explicit Yes/No toggle row, styled like the drawer's "Show passed profiles"
// quick filter so booleans read clearly as on/off (icon + label + Yes/No).
function ToggleRow({ icon: Icon, label, on, onToggle, testId }: {
  icon: any;
  label: string;
  on: boolean;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-[var(--radius)] border transition-colors ${on ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'}`}
      data-testid={testId}
    >
      <div className="flex items-center gap-3">
        <Icon className={`w-5 h-5 ${on ? 'text-primary' : 'text-muted-foreground'}`} />
        <span className="font-ui text-sm text-foreground">{label}</span>
      </div>
      <span className={`text-xs font-medium ${on ? 'text-primary' : 'text-muted-foreground'}`}>{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

// Redux-backed toggle row for an agency boolean filter (one activeFilters key).
function AgencyToggleRow({ icon, label, filterKey, activeFilters, dispatch }: {
  icon: any;
  label: string;
  filterKey: string;
  activeFilters: Record<string, string[]>;
  dispatch: any;
}) {
  const on = (activeFilters[filterKey] || [])[0] === "true";
  return (
    <ToggleRow
      icon={icon}
      label={label}
      on={on}
      onToggle={() => dispatch(setFilter({ key: filterKey, values: on ? [] : ["true"] }))}
      testId={`toggle-${filterKey}`}
    />
  );
}

function MarketplaceFiltersDrawer({ providerType, open, onOpenChange, barFilterProps }: {
  providerType: "egg-donor" | "surrogate" | "sperm-donor" | "ivf-clinic" | "surrogacy-agency";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Extra (non-Redux) filter props forwarded into the bar - IVF context for the
  // clinics/doctors tab, agency service options + parent country for agencies.
  barFilterProps?: Record<string, unknown>;
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
    || !!searchParams.get('agencyLocation')
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
      next.delete('agencyLocation');
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
        {/* Location pinned to the top of every filters drawer. */}
        <div>
          <h2 className="t-micro-label mb-3">Location</h2>
          <InlineLocationFilter providerType={providerType} />
        </div>

        {/* Quick filters: "Show passed profiles" (Skipped) is available for ALL
            types including IVF clinics + doctors. "Experienced only" stays
            donor/surrogate-specific. */}
        <div>
          <h2 className="t-micro-label mb-3">Quick filters</h2>
          <div className="space-y-2">
            {(providerType === "egg-donor" || providerType === "surrogate" || providerType === "sperm-donor") && (
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
            )}
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
            {providerType === "ivf-clinic" && barFilterProps && (
              <ToggleRow
                icon={Heart}
                label="LGBTQ+ care"
                on={!!(barFilterProps as any).ivfLgbtqCare}
                onToggle={() => (barFilterProps as any).onIvfLgbtqCareChange?.(!(barFilterProps as any).ivfLgbtqCare)}
                testId="toggle-ivf-lgbtq"
              />
            )}
          </div>
        </div>

        {providerType === "surrogacy-agency" && (
          <div>
            <h2 className="t-micro-label mb-3">Agency requirements</h2>
            <div className="space-y-2">
              <AgencyToggleRow icon={Baby} label="Twins allowed" filterKey="agencyTwins" activeFilters={activeFilters} dispatch={dispatch} />
              <AgencyToggleRow icon={Heart} label="LGBTQ+ care" filterKey="agencyLgbtq" activeFilters={activeFilters} dispatch={dispatch} />
              {(barFilterProps as any)?.agencyParentCountry && (
                <AgencyToggleRow icon={MapPin} label="Accepts my citizenship" filterKey="agencyCitizenship" activeFilters={activeFilters} dispatch={dispatch} />
              )}
            </div>
          </div>
        )}

        <div>
          <h2 className="t-micro-label mb-3">Preferences</h2>
          {providerType === "surrogacy-agency" && (
            <InlineRangeFilter filterKey="maxCost" label="Total Cost" min={0} max={500000} step={10000} formatValue={formatMoneyDollars} />
          )}
          {(providerType === "egg-donor" || providerType === "surrogate" || providerType === "sperm-donor") && (
            <>
              <InlineRangeFilter filterKey="age" label="Age" min={18} max={45} />
              {providerType !== "surrogate" && (
                <InlineRangeFilter filterKey="height" label="Height" min={48} max={84} formatValue={formatHeightInches} />
              )}
            </>
          )}
          <div className="filter-list-mode">
            <MarketplaceFilterBar providerType={providerType} hideFavorites noResults listMode {...(barFilterProps || {})} />
          </div>
        </div>
      </div>

      </FullDrawerContent>
    </FullDrawer>
  );
}

// Full-bleed deck chrome: the filter (top-left) and search (top-right) controls
// re-mounted as absolutely-positioned overlays ON TOP of the immersive deck, with
// a top scrim for contrast over photos. Replaces the old MobileFilterOverlay top
// bar - the provider type switcher now lives in the Explore explode picker, not
// here. Notch-safe via the top safe-area inset.
function MobileDeckControls({ onOpenFilters }: { onOpenFilters: () => void }) {
  const chip = "pointer-events-auto shrink-0 w-9 h-9 rounded-full bg-black/35 backdrop-blur-md flex items-center justify-center text-white";

  return (
    <div
      className="absolute inset-x-0 top-0 z-30 pointer-events-none"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 24px)' }}
      data-testid="mobile-deck-controls"
    >
      {/* Top scrim so the white chrome reads over light photos */}
      <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/55 to-transparent" />
      {/* px-4 + top offset align the filter chip with the card's top-right expand
          arrow (top-4 right-4), both sitting just below the progress segments. */}
      <div className="relative flex items-center gap-2 px-4">
        <button onClick={onOpenFilters} className={chip} aria-label="Open filters" data-testid="button-open-filters">
          <SlidersHorizontal className="w-5 h-5" />
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
          if (name.includes("surrogacy")) {
            // Surrogacy agencies get BOTH the Surrogates tab (their carriers) and
            // their own "Agency" tab - mirrors clinics getting IVF Clinics + Doctors.
            if (!tabs.includes("surrogates")) tabs.push("surrogates");
            if (!tabs.includes("surrogacy-agencies")) tabs.push("surrogacy-agencies");
          }
          if (name.includes("ivf") || name.includes("clinic")) {
            // Clinics get BOTH the IVF Clinics tab and the Doctors tab (doctors
            // practice at clinics) - mirrors the parent experience. Both are scoped
            // to the provider's own clinic by the marketplace/clinics + /doctors APIs.
            if (!tabs.includes("ivf-clinics")) tabs.push("ivf-clinics");
            if (!tabs.includes("doctors")) tabs.push("doctors");
          }
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
          favoritedAgencies: data.favoritedAgencies || [],
          passedAgencies: data.passedAgencies || [],
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

  // The IVF/clinic tab keeps its search and filters in the URL rather than in
  // Redux, so clearing Redux on a tab change isn't enough - those params would
  // survive a trip through Egg Donors and reappear. Strip them whenever the tab
  // actually changes, never on first render, so a deep link like
  // /marketplace?tab=ivf-clinics&location=NY from the concierge still lands
  // with its filters intact.
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (prevTabRef.current === activeTab) return;
    prevTabRef.current = activeTab;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      let touched = false;
      for (const key of TAB_SCOPED_PARAMS) {
        if (next.has(key)) { next.delete(key); touched = true; }
      }
      return touched ? next : prev;
    }, { replace: true });
  }, [activeTab, setSearchParams]);

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
    const base = mapped.length > 0 ? mapped : fallback;
    // Doctors is offered exactly when IVF Clinics is (doctors practice at clinics).
    const types = base.some(t => t.id === "ivf-clinics") ? [...base, DOCTORS_TYPE] : base;
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
  const agencyLocation = searchParams.get("agencyLocation") || "";
  const setEggLocation = (v: string) => updateParam("eggLocation", v);
  const setSurrogateLocation = (v: string) => updateParam("surrogateLocation", v);
  const setSpermLocation = (v: string) => updateParam("spermLocation", v);
  const setAgencyLocation = (v: string) => updateParam("agencyLocation", v);
  // Location is a single Redux "location" filter shared by every non-IVF tab
  // (donors + surrogacy agencies); the active tab decides which URL param backs
  // it, but they all sync into the same activeFilters key.
  const donorLocation =
    activeTab === "egg-donors" ? eggLocation :
    activeTab === "surrogates" ? surrogateLocation :
    activeTab === "sperm-donors" ? spermLocation :
    activeTab === "surrogacy-agencies" ? agencyLocation : "";
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
    // Clinics now load via the lean /marketplace/clinics endpoint below; this
    // generic (heavy) list only serves the Surrogacy Agencies tab.
    enabled: activeTab === "surrogacy-agencies",
  });

  // Lean clinic cards (mirrors marketplace/doctors): one capped, success-rate-
  // scoped query that the deck + ClinicSwipeCard render from directly, with NO
  // per-card /api/providers/:id refetch - what made the Clinics tab lag before.
  // GoStork-admin "Provider" filter (activeFilters.providerId) - narrows the
  // clinics/doctors decks to specific providers server-side.
  const providerIdFilter = (activeFilters.providerId || []).join(",");
  const clinicQueryParams = new URLSearchParams(
    Object.entries({
      search: ivfSearch,
      location: ivfLocation,
      insurance: insuranceFilter,
      lgbtq: lgbtqFilter ? "true" : "",
      eggSource,
      ageGroup,
      ivfHistory: isNewPatient === "false" ? "false" : "",
      providerId: providerIdFilter,
    }).filter(([, v]) => v) as [string, string][],
  ).toString();
  const { data: clinics, isLoading: clinicsLoading } = useQuery<any[]>({
    queryKey: ["/api/providers/marketplace/clinics", ivfSearch, ivfLocation, insuranceFilter, lgbtqFilter, eggSource, ageGroup, isNewPatient, providerIdFilter],
    queryFn: async () => {
      const res = await fetch(`/api/providers/marketplace/clinics${clinicQueryParams ? `?${clinicQueryParams}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch clinics");
      return res.json();
    },
    enabled: isIvfTab,
  });

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
      providerId: providerIdFilter,
    }).filter(([, v]) => v) as [string, string][],
  ).toString();
  const { data: doctors, isLoading: doctorsLoading } = useQuery<any[]>({
    queryKey: ["/api/providers/marketplace/doctors", ivfSearch, ivfLocation, insuranceFilter, specialtyFilter, lgbtqFilter, eggSource, ageGroup, isNewPatient, providerIdFilter],
    queryFn: async () => {
      const res = await fetch(`/api/providers/marketplace/doctors${doctorQueryParams ? `?${doctorQueryParams}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch doctors");
      return res.json();
    },
    enabled: isDoctorTab,
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

  // Surrogacy-agency filter inputs: the parent's citizenship (powers the
  // "Accepts my citizenship" toggle).
  const agencyParentCountry: string | null =
    parentProfileForFilter?.nationality || parentProfileForFilter?.country || null;
  const agencyFilterProps = {
    location: agencyLocation,
    onLocationChange: setAgencyLocation,
    hasLocation: !!agencyLocation,
    agencyParentCountry,
  };

  // Auto-select the agency LGBTQ+ care filter for LGBTQ+ parents when they open
  // the agencies tab. Applied once per tab entry (ref guard) so a parent who
  // turns it off isn't fought; re-entering the tab re-applies the default.
  const parentIsLgbtq = parentProfileForFilter?.isLGBTQ === true || parentProfileForFilter?.sameSexCouple === true;
  const lgbtqAutoAppliedRef = useRef(false);
  useEffect(() => {
    if (activeTab !== "surrogacy-agencies") { lgbtqAutoAppliedRef.current = false; return; }
    if (lgbtqAutoAppliedRef.current || !parentProfileForFilter) return;
    lgbtqAutoAppliedRef.current = true;
    if (parentIsLgbtq && (activeFilters["agencyLgbtq"] || []).length === 0) {
      dispatch(setFilter({ key: "agencyLgbtq", values: ["true"] }));
    }
  }, [activeTab, parentProfileForFilter, parentIsLgbtq, activeFilters, dispatch]);

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
    ivfShowSpecialty: isDoctorTab,
    ivfSpecialtyOptions: SPECIALTY_OPTIONS,
  };


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
    (activeTab === "ivf-clinics" && clinicsLoading) ||
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
    activeTab === "surrogacy-agencies" ? "surrogacy-agency" as const :
    "egg-donor" as const;

  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const onFilteredCountChange = useCallback((count: number) => setFilteredCount(count), []);

  // What the deck actually renders, not how many the query returned - Discover
  // hides clinics the parent already saved or passed, and a header reading
  // "1 clinics found" above an empty deck looks like the marketplace is broken.
  const ivfClinicCount = useMemo(() => {
    if (!clinics || !isIvfTab) return 0;
    return filteredCount ?? clinics.length;
  }, [clinics, isIvfTab, filteredCount]);
  const hasResults = isLoading || (filteredCount === null ? true : filteredCount > 0);

  // The filters drawer is for everyone who sees the immersive deck (parents,
  // providers, admins) - the sliders button renders for all of them, so the
  // drawer must too (previously parent-only, which left admins' button dead).
  const filtersDrawerEl = (
    <MarketplaceFiltersDrawer
      providerType={currentProviderType}
      open={filtersOpen}
      onOpenChange={(o) => { if (!o) closeFiltersPage(); else openFiltersPage(); }}
      barFilterProps={(isIvfTab || isDoctorTab) ? ivfFilterProps : activeTab === "surrogacy-agencies" ? agencyFilterProps : undefined}
    />
  );

  if (isMobile && (isDonorTab || isIvfTab || isDoctorTab || activeTab === "surrogacy-agencies")) {
    return (
      <div className="fixed inset-x-0 top-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-[60] flex flex-col" style={{ backgroundColor: 'hsl(var(--deck-bg))' }} data-testid="marketplace-mobile-immersive">
        {showFavoritesOnly && (
          <div className="shrink-0 w-full px-3 pb-2" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }} data-testid="saved-type-switcher-mobile">
            <DeckTypeSwitcher
              types={parentAvailableTypes}
              activeTab={activeTab}
              onSelect={(id) => dispatch(setMarketplaceTab(id))}
              theme="dark"
            />
          </div>
        )}

        <div className="flex-1 min-h-0 relative" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
          {!showFavoritesOnly && <MobileDeckControls onOpenFilters={openFiltersPage} />}
          {isLoading ? (
            <div className="flex justify-center items-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-primary" data-testid="loading-spinner" />
            </div>
          ) : (
            <>
              {activeTab === "egg-donors" && (
                showFavoritesOnly
                  ? <MobileSavedGrid kind="egg-donor" items={eggDonors} />
                  : <DonorGrid donors={eggDonors} searchQuery={searchQuery} type="egg-donor" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreEggDonors} hasNextPage={hasMoreEggDonors} isFetchingMore={isFetchingMoreEggDonors} />
              )}
              {activeTab === "surrogates" && (
                showFavoritesOnly
                  ? <MobileSavedGrid kind="surrogate" items={surrogates} />
                  : <DonorGrid donors={surrogates} searchQuery={searchQuery} type="surrogate" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreSurrogates} hasNextPage={hasMoreSurrogates} isFetchingMore={isFetchingMoreSurrogates} />
              )}
              {activeTab === "sperm-donors" && (
                showFavoritesOnly
                  ? <MobileSavedGrid kind="sperm-donor" items={spermDonors} />
                  : <DonorGrid donors={spermDonors} searchQuery={searchQuery} type="sperm-donor" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreSpermDonors} hasNextPage={hasMoreSpermDonors} isFetchingMore={isFetchingMoreSpermDonors} />
              )}
              {isIvfTab && (
                showFavoritesOnly
                  ? <MobileSavedGrid kind="clinic" items={(clinics as any) || []} />
                  : <IvfClinicDeckGrid providers={clinics as any} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} sortBy={sortBy} onFilteredCountChange={onFilteredCountChange} />
              )}
              {isDoctorTab && (
                showFavoritesOnly
                  ? <MobileSavedGrid kind="doctor" items={(doctors as any) || []} />
                  : <DoctorDeckGrid doctors={doctors} loading={doctorsLoading} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} />
              )}
              {activeTab === "surrogacy-agencies" && (
                // Providers see only their OWN agency here; admins see all. Rendered
                // inside the immersive container so the deck has a real height (the
                // desktop-flow render collapsed to 0 height -> blank card).
                <AgencyDeck
                  providers={isProviderUser ? (providers || []).filter((p) => p.id === (user as any)?.providerId) : providers}
                  searchQuery={searchQuery}
                />
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
        {/* Parents get a clean, pills-only saved view; admins/providers keep the
            full filter bar in saved mode (mirrors the skipped/hidden view) so they
            don't lose the tab + filter controls when toggling favorites. */}
        {(!showFavoritesOnly || !isParentOnly) && (
          <div className="mb-4" data-testid="marketplace-filter-bar-wrapper">
            <MarketplaceFilterBar
              providerType={currentProviderType}
              {...((isIvfTab || isDoctorTab) ? ivfFilterProps :
                activeTab === "surrogacy-agencies" ? agencyFilterProps : {
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
              <span className="t-helper">
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
                <ul className="t-helper space-y-0.5 list-disc list-inside">
                  <li>Patient characteristics affect success rates and may not be comparable between clinics</li>
                  <li>These statistics do not predict your individual chances of success</li>
                  <li>Always consult a physician for personalized medical advice</li>
                  <li>Data source: CDC ART 2022 National Summary Report</li>
                </ul>
              </div>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" data-testid="loading-spinner" />
          </div>
        ) : (
          <>
            {isIvfTab && (
              <IvfClinicDeckGrid
                providers={clinics as any}
                eggSource={eggSource}
                ageGroup={ageGroup}
                isNewPatient={isNewPatient}
                sortBy={sortBy}
                onFilteredCountChange={onFilteredCountChange}
              />
            )}
            {isDoctorTab && (
              <DoctorDeckGrid doctors={doctors} loading={doctorsLoading} eggSource={eggSource} ageGroup={ageGroup} isNewPatient={isNewPatient} />
            )}
            {activeTab === "surrogacy-agencies" && (
              // Providers see only their OWN agency profile here (parallel to how a
              // clinic's IVF Clinics tab is scoped to their own clinic); admins see all.
              <AgencyDeck
                providers={isProviderUser ? (providers || []).filter((p) => p.id === (user as any)?.providerId) : providers}
                searchQuery={searchQuery}
              />
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
