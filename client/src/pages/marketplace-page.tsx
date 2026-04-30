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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Loader2, Calendar, User, MapPin, Award, Heart, Clock, Info, X, Baby, FlaskRound } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { matchesFilter, matchesSameSexCoupleRequirement, matchesInternationalRequirement, omniSearch, sortDonors } from "@/lib/marketplace-filters";
import { useAppSelector, useAppDispatch } from "@/store";
import { setMarketplaceSearchQuery, setMarketplaceTab, toggleFavoriteDonor, passDonor, undoPassDonor, loadDonorPreferences, setShowFavoritesOnly, setShowSkippedOnly, setShowExperiencedOnly, setFilter } from "@/store/uiSlice";
import { MarketplaceFilterBar } from "@/components/marketplace/MarketplaceFilterBar";
import { Tabs as UnderlineTabs, TabsList as UnderlineTabsList, TabsTrigger as UnderlineTabsTrigger } from "@/components/ui/underline-tabs";
import { SwipeDeckCard } from "@/components/marketplace/swipe-deck-card";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  getPhotoList, getMatchedPreferences, buildTitle, buildStatusLabel,
  getDonorTabs, getSurrogateTabs,
  mapDatabaseDonorToSwipeProfile, mapDatabaseSurrogateToSwipeProfile, mapDatabaseSpermDonorToSwipeProfile,
} from "@/components/marketplace/swipe-mappers";

import { EggDonorIcon, SurrogateIcon, IvfClinicIcon, AgencyIcon, SpermIcon } from "@/components/icons/marketplace-icons";

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
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                      <User className="w-5 h-5" />
                    </div>
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

  const userCountry = (user as any)?.country || null;
  const userIdentification = (user as any)?.identification || null;

  const filtered = useMemo(() => {
    let result = donors?.filter((d) => {
      if (showFavoritesOnly && !favoritedIds.includes(d.id)) return false;
      if (showSkippedOnly && !passedIds.includes(d.id)) return false;
      if (!showSkippedOnly && passedIds.includes(d.id)) return false;
      if (showExperiencedOnly && !(d as any).isExperienced) return false;
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
    const isFav = favoritedIds.includes(donorId);
    dispatch(toggleFavoriteDonor(donorId));
    syncPref("favorite", donorId, isFav ? "remove" : "add");
    setCurrentIndex((prev) => prev + 1);
  };

  const handlePass = (donorId: string) => {
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
        <div className={`relative h-full w-full px-1.5 pb-1 ${showSkippedOnly ? "grayscale opacity-60" : ""}`}>
          {nextDonor && nextProfile && (
            <div className="absolute inset-0 z-0" data-testid={`card-next-${nextDonor.id}`}>
              <SwipeDeckCard
                key={`next-${nextDonor.id}`}
                id={nextProfile.id}
                photos={getPhotoList(nextProfile)}
                title={buildTitle(nextProfile)}
                statusLabel={buildStatusLabel(nextProfile)}
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
              statusLabel={buildStatusLabel(profile)}
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
              onMessage={() => navigate(`/concierge?donorId=${currentDonor.id}&donorType=${type}&providerId=${currentDonor.providerId}&photoUrl=${encodeURIComponent(currentDonor.photoUrl || "")}`)}
              onViewFullProfile={() => navigate(`/${typeToUrlSlug(type)}/${currentDonor.providerId}/${currentDonor.id}`)}
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
          <div key={donor.id} className={`h-[600px] ${showSkippedOnly ? "grayscale opacity-60" : ""}`} data-testid={`card-container-${donor.id}`}>
            <SwipeDeckCard
              id={profile.id}
              photos={getPhotoList(profile)}
              title={buildTitle(profile)}
              statusLabel={buildStatusLabel(profile)}
              isExperienced={profile.isExperienced}
              isPremium={profile.isPremium}
              tabs={tabs}
              disableSwipe
              isSaved={favoritedIds.includes(donor.id)}
              isPassed={passedIds.includes(donor.id)}
              onPass={() => { dispatch(passDonor(donor.id)); syncPref("skip", donor.id, "add"); }}
              onSave={() => { const isFav = favoritedIds.includes(donor.id); dispatch(toggleFavoriteDonor(donor.id)); syncPref("favorite", donor.id, isFav ? "remove" : "add"); }}
              onUndo={passedIds.includes(donor.id) ? () => { dispatch(undoPassDonor(donor.id)); syncPref("skip", donor.id, "remove"); } : undefined}
              onMessage={() => navigate(`/concierge?donorId=${donor.id}&donorType=${type}&providerId=${donor.providerId}&photoUrl=${encodeURIComponent(donor.photoUrl || "")}`)}
              onViewFullProfile={() => navigate(`/${typeToUrlSlug(type)}/${donor.providerId}/${donor.id}`)}
            />
          </div>
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


function MobileFilterOverlay({ providerType, activeFilters, hasResults = true }: {
  providerType: "egg-donor" | "surrogate" | "sperm-donor" | "ivf-clinic";
  activeFilters: Record<string, string[]>;
  hasResults?: boolean;
}) {
  const dispatch = useAppDispatch();
  const searchQuery = useAppSelector((state) => state.ui.marketplaceSearchQuery);
  const showFavoritesOnly = useAppSelector((state) => state.ui.showFavoritesOnly);
  const showSkippedOnly = useAppSelector((state) => state.ui.showSkippedOnly);
  const showExperiencedOnly = useAppSelector((state) => state.ui.showExperiencedOnly);
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

  const iconColor = hasResults ? 'text-white' : 'text-foreground';
  const iconColorMuted = hasResults ? 'text-white/80' : 'text-foreground/60';
  const searchInputBg = hasResults
    ? 'bg-black/40 backdrop-blur-md text-white placeholder:text-white/50 border-white/15 focus:border-white/30'
    : 'bg-muted text-foreground placeholder:text-muted-foreground border-border focus:border-foreground/30';
  const clearColor = hasResults ? 'text-white/60' : 'text-muted-foreground';

  return (
    <div className="absolute top-8 left-0 right-0 z-[70] px-3" data-testid="mobile-filter-overlay">
      <div className="flex items-center gap-2">
        <button
          onClick={handleSearchToggle}
          className="relative shrink-0 w-7 h-7 flex items-center justify-center"
          data-testid="button-search-toggle"
        >
          {searchExpanded ? (
            <X className={`w-5 h-5 ${iconColor}`} />
          ) : (
            <Search className={`w-5 h-5 ${iconColor}`} />
          )}
        </button>

        <div
          className="overflow-hidden transition-all duration-300 ease-in-out"
          style={{ width: searchExpanded ? '100%' : '0px', opacity: searchExpanded ? 1 : 0 }}
        >
          <div className="relative min-w-[160px]">
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
        </div>

        {!searchExpanded && (
          <div className="flex-1 overflow-x-auto scrollbar-hide">
            <div className="flex items-center gap-1.5" data-testid="filter-chips-overlay">
              <button
                onClick={() => dispatch(setShowFavoritesOnly(!showFavoritesOnly))}
                className="shrink-0 w-7 h-7 flex items-center justify-center"
                data-testid="chip-favorites"
              >
                <Heart className={`w-5 h-5 transition-colors ${showFavoritesOnly ? iconColor : iconColorMuted}`} fill={showFavoritesOnly ? "currentColor" : "none"} />
              </button>
              <button
                onClick={() => dispatch(setShowSkippedOnly(!showSkippedOnly))}
                className="shrink-0 w-7 h-7 flex items-center justify-center"
                data-testid="chip-skipped"
              >
                <X className={`w-5 h-5 transition-colors ${showSkippedOnly ? iconColor : iconColorMuted}`} />
              </button>
              {providerType !== "ivf-clinic" && (
                <button
                  onClick={() => dispatch(setShowExperiencedOnly(!showExperiencedOnly))}
                  className="shrink-0 w-7 h-7 flex items-center justify-center"
                  data-testid="chip-experienced"
                >
                  <Award className={`w-5 h-5 transition-colors ${showExperiencedOnly ? iconColor : iconColorMuted}`} fill={showExperiencedOnly ? "currentColor" : "none"} />
                </button>
              )}
              <MarketplaceFilterBar
                providerType={providerType}
                hideFavorites
                inlineMode
                overlayStyle
                noResults={!hasResults}
              />
            </div>
          </div>
        )}
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

  const [searchParams, setSearchParams] = useSearchParams();
  const ivfLocation = searchParams.get("location") || "";
  const ivfSearch = searchParams.get("search") || "";
  const eggSource = searchParams.get("eggSource") || "own_eggs";
  const ageGroup = searchParams.get("ageGroup") || "under_35";
  const isNewPatient = searchParams.get("ivfHistory") || "true";
  const sortBy = searchParams.get("sortBy") || "highest_success";
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
    dispatch(setFilter({ key: "location", values: donorLocation ? [donorLocation] : [] }));
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
  const isDonorTab = activeTab === "egg-donors" || activeTab === "surrogates" || activeTab === "sperm-donors";


  const providerQueryParams = isIvfTab
    ? new URLSearchParams(
        Object.entries({
          search: ivfSearch,
          location: ivfLocation,
          eggSource,
          ageGroup,
          ivfHistory: isNewPatient,
        }).filter(([, v]) => v)
      ).toString()
    : "";

  const providerUrl = providerQueryParams
    ? `${api.providers.list.path}?${providerQueryParams}`
    : api.providers.list.path;

  const { data: providers, isLoading: providersLoading } = useQuery<ProviderWithRelations[]>({
    queryKey: [api.providers.list.path, ivfSearch, ivfLocation, eggSource, ageGroup, isNewPatient],
    queryFn: async () => {
      const res = await fetch(providerUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch providers");
      return res.json();
    },
    enabled: isProviderTab,
  });

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
    (activeTab === "sperm-donors" && spermLoading);

  const currentProviderType = isIvfTab ? "ivf-clinic" as const :
    activeTab === "surrogates" ? "surrogate" as const :
    activeTab === "sperm-donors" ? "sperm-donor" as const :
    "egg-donor" as const;

  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const onFilteredCountChange = useCallback((count: number) => setFilteredCount(count), []);
  const hasResults = isLoading || (filteredCount === null ? true : filteredCount > 0);

  if (isMobile && isDonorTab) {
    return (
      <div className="fixed inset-x-0 top-0 bottom-[calc(78px+env(safe-area-inset-bottom))] z-[60] bg-background flex flex-col" data-testid="marketplace-mobile-immersive">
        <MobileFilterOverlay
          providerType={currentProviderType}
          activeFilters={activeFilters}
          hasResults={hasResults}
        />

        <div className="flex-1 min-h-0">
          {isLoading ? (
            <div className="flex justify-center items-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-primary" data-testid="loading-spinner" />
            </div>
          ) : (
            <>
              {activeTab === "egg-donors" && (
                <DonorGrid donors={eggDonors} searchQuery={searchQuery} type="egg-donor" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreEggDonors} hasNextPage={hasMoreEggDonors} isFetchingMore={isFetchingMoreEggDonors} />
              )}
              {activeTab === "surrogates" && (
                <DonorGrid donors={surrogates} searchQuery={searchQuery} type="surrogate" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreSurrogates} hasNextPage={hasMoreSurrogates} isFetchingMore={isFetchingMoreSurrogates} />
              )}
              {activeTab === "sperm-donors" && (
                <DonorGrid donors={spermDonors} searchQuery={searchQuery} type="sperm-donor" onFilteredCountChange={onFilteredCountChange} fetchMore={fetchMoreSpermDonors} hasNextPage={hasMoreSpermDonors} isFetchingMore={isFetchingMoreSpermDonors} />
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


      <div className={isAdmin ? "pt-6" : ""}>
        {activeTab !== "surrogacy-agencies" && (
          <div className="mb-4" data-testid="marketplace-filter-bar-wrapper">
            <MarketplaceFilterBar
              providerType={currentProviderType}
              {...(isIvfTab ? {
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
              } : {
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

        {isIvfTab && (
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
            {isIvfTab && (
              <IvfClinicGrid
                providers={providers}
                eggSource={eggSource}
                ageGroup={ageGroup}
                isNewPatient={isNewPatient}
                sortBy={sortBy}
                onSchedule={setScheduleProvider}
              />
            )}
            {activeTab === "surrogacy-agencies" && (
              <ProviderGrid
                providers={providers}
                searchQuery={searchQuery}
                providerTypeName="Surrogacy Agency"
                onSchedule={setScheduleProvider}
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
    </div>
  );
}
