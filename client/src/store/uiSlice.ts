import { createSlice, PayloadAction } from "@reduxjs/toolkit";

interface AdminProvidersFilters {
  searchQuery: string;
  locationSearch: string;
  providerType: string;
  statusFilter: string;
  sortBy: string;
}

interface UiState {
  sidebarOpen: boolean;
  hideBottomNav: boolean;
  marketplaceSearchQuery: string;
  marketplaceTab: string;
  activeFilters: Record<string, string[]>;
  marketplaceSortBy: string;
  favoritedDonorIds: string[];
  passedDonorIds: string[];
  // Phase 6: saved/passed for doctors (keyed by slug) and clinics (keyed by
  // providerId), mirroring the donor favorites mechanism. Persisted server-side
  // via /api/profile-preferences.
  favoritedDoctorSlugs: string[];
  passedDoctorSlugs: string[];
  favoritedClinicIds: string[];
  passedClinicIds: string[];
  favoritedAgencyIds: string[];
  passedAgencyIds: string[];
  showFavoritesOnly: boolean;
  showSkippedOnly: boolean;
  showExperiencedOnly: boolean;
  adminProvidersFilters: AdminProvidersFilters;
}

const VALID_TABS = ["egg-donors", "surrogates", "ivf-clinics", "surrogacy-agencies", "sperm-donors", "doctors"];

const MARKETPLACE_STORAGE_KEY = "marketplaceFilters:v1";

/** Sort a tab starts on. Tabs whose options don't include it (agencies, IVF)
 *  fall back to their own default in MarketplaceFilterBar. */
export const DEFAULT_MARKETPLACE_SORT = "newest";

type PersistedMarketplace = {
  marketplaceSearchQuery: string;
  marketplaceTab: string;
  activeFilters: Record<string, string[]>;
  marketplaceSortBy: string;
  showFavoritesOnly: boolean;
  showSkippedOnly: boolean;
  showExperiencedOnly: boolean;
};

function loadMarketplaceFilters(): PersistedMarketplace {
  const fallback: PersistedMarketplace = {
    marketplaceSearchQuery: "",
    marketplaceTab: "egg-donors",
    activeFilters: {},
    marketplaceSortBy: DEFAULT_MARKETPLACE_SORT,
    showFavoritesOnly: false,
    showSkippedOnly: false,
    showExperiencedOnly: false,
  };
  try {
    const raw = sessionStorage.getItem(MARKETPLACE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const tab = typeof parsed.marketplaceTab === "string" && VALID_TABS.includes(parsed.marketplaceTab) ? parsed.marketplaceTab : fallback.marketplaceTab;
        return {
          marketplaceSearchQuery: typeof parsed.marketplaceSearchQuery === "string" ? parsed.marketplaceSearchQuery : fallback.marketplaceSearchQuery,
          marketplaceTab: tab,
          activeFilters: parsed.activeFilters && typeof parsed.activeFilters === "object" ? parsed.activeFilters : fallback.activeFilters,
          marketplaceSortBy: typeof parsed.marketplaceSortBy === "string" ? parsed.marketplaceSortBy : fallback.marketplaceSortBy,
          showFavoritesOnly: !!parsed.showFavoritesOnly,
          showSkippedOnly: !!parsed.showSkippedOnly,
          showExperiencedOnly: !!parsed.showExperiencedOnly,
        };
      }
    }
    const legacySession = sessionStorage.getItem("marketplaceTab");
    if (legacySession && VALID_TABS.includes(legacySession)) fallback.marketplaceTab = legacySession;
    else {
      const legacyLocal = localStorage.getItem("marketplaceTab");
      if (legacyLocal && VALID_TABS.includes(legacyLocal)) fallback.marketplaceTab = legacyLocal;
    }
  } catch {}
  return fallback;
}

function persistMarketplaceFilters(state: UiState) {
  try {
    const snapshot: PersistedMarketplace = {
      marketplaceSearchQuery: state.marketplaceSearchQuery,
      marketplaceTab: state.marketplaceTab,
      activeFilters: state.activeFilters,
      marketplaceSortBy: state.marketplaceSortBy,
      showFavoritesOnly: state.showFavoritesOnly,
      showSkippedOnly: state.showSkippedOnly,
      showExperiencedOnly: state.showExperiencedOnly,
    };
    sessionStorage.setItem(MARKETPLACE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}
}

const persistedMarketplace = loadMarketplaceFilters();

const initialState: UiState = {
  sidebarOpen: false,
  hideBottomNav: false,
  marketplaceSearchQuery: persistedMarketplace.marketplaceSearchQuery,
  marketplaceTab: persistedMarketplace.marketplaceTab,
  activeFilters: persistedMarketplace.activeFilters,
  marketplaceSortBy: persistedMarketplace.marketplaceSortBy,
  favoritedDonorIds: [],
  passedDonorIds: [],
  favoritedDoctorSlugs: [],
  passedDoctorSlugs: [],
  favoritedClinicIds: [],
  passedClinicIds: [],
  favoritedAgencyIds: [],
  passedAgencyIds: [],
  showFavoritesOnly: persistedMarketplace.showFavoritesOnly,
  showSkippedOnly: persistedMarketplace.showSkippedOnly,
  showExperiencedOnly: persistedMarketplace.showExperiencedOnly,
  adminProvidersFilters: {
    searchQuery: "",
    locationSearch: "",
    providerType: "All",
    statusFilter: "All",
    sortBy: "newest",
  },
};

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    toggleSidebar(state) {
      state.sidebarOpen = !state.sidebarOpen;
    },
    setSidebarOpen(state, action: PayloadAction<boolean>) {
      state.sidebarOpen = action.payload;
    },
    setMarketplaceSearchQuery(state, action: PayloadAction<string>) {
      state.marketplaceSearchQuery = action.payload;
      persistMarketplaceFilters(state);
    },
    setMarketplaceTab(state, action: PayloadAction<string>) {
      // Only reset when the tab actually changes. This action also fires
      // defensively on mount (when the stored tab isn't available to this
      // parent, or a redirect lands on doctors), and those must not wipe a
      // search the user just typed.
      const changed = state.marketplaceTab !== action.payload;
      state.marketplaceTab = action.payload;
      if (changed) {
        // A search or filter belongs to the tab it was entered on. Searching an
        // egg donor's ID and then opening Surrogates used to carry the query
        // across and show "No surrogates found", which reads as an empty
        // marketplace rather than a stale filter.
        state.marketplaceSearchQuery = "";
        state.marketplaceSortBy = DEFAULT_MARKETPLACE_SORT;
        state.activeFilters = {};
        state.showFavoritesOnly = false;
        state.showSkippedOnly = false;
        state.showExperiencedOnly = false;
      }
      try {
        sessionStorage.setItem("marketplaceTab", action.payload);
        localStorage.setItem("marketplaceTab", action.payload);
      } catch {}
      persistMarketplaceFilters(state);
    },
    setFilter(state, action: PayloadAction<{ key: string; values: string[] }>) {
      state.activeFilters[action.payload.key] = action.payload.values;
      persistMarketplaceFilters(state);
    },
    clearFilters(state) {
      state.activeFilters = {};
      persistMarketplaceFilters(state);
    },
    setMarketplaceSortBy(state, action: PayloadAction<string>) {
      state.marketplaceSortBy = action.payload;
      persistMarketplaceFilters(state);
    },
    loadDonorPreferences(state, action: PayloadAction<{ favorited: string[]; skipped: string[] }>) {
      state.favoritedDonorIds = action.payload.favorited;
      state.passedDonorIds = action.payload.skipped;
    },
    toggleFavoriteDonor(state, action: PayloadAction<string>) {
      const id = action.payload;
      const idx = state.favoritedDonorIds.indexOf(id);
      if (idx >= 0) {
        state.favoritedDonorIds.splice(idx, 1);
      } else {
        state.favoritedDonorIds.push(id);
      }
    },
    setShowFavoritesOnly(state, action: PayloadAction<boolean>) {
      state.showFavoritesOnly = action.payload;
      if (action.payload) state.showSkippedOnly = false;
      persistMarketplaceFilters(state);
    },
    passDonor(state, action: PayloadAction<string>) {
      if (!state.passedDonorIds.includes(action.payload)) {
        state.passedDonorIds.push(action.payload);
      }
    },
    undoPassDonor(state, action: PayloadAction<string>) {
      state.passedDonorIds = state.passedDonorIds.filter(id => id !== action.payload);
    },
    // --- Phase 6: doctor + clinic saved/passed (mirror the donor actions) ---
    loadProviderPreferences(state, action: PayloadAction<{ favoritedDoctors: string[]; passedDoctors: string[]; favoritedClinics: string[]; passedClinics: string[]; favoritedAgencies?: string[]; passedAgencies?: string[] }>) {
      state.favoritedDoctorSlugs = action.payload.favoritedDoctors;
      state.passedDoctorSlugs = action.payload.passedDoctors;
      state.favoritedClinicIds = action.payload.favoritedClinics;
      state.passedClinicIds = action.payload.passedClinics;
      state.favoritedAgencyIds = action.payload.favoritedAgencies || [];
      state.passedAgencyIds = action.payload.passedAgencies || [];
    },
    toggleFavoriteDoctor(state, action: PayloadAction<string>) {
      const id = action.payload;
      const idx = state.favoritedDoctorSlugs.indexOf(id);
      if (idx >= 0) state.favoritedDoctorSlugs.splice(idx, 1);
      else state.favoritedDoctorSlugs.push(id);
    },
    passDoctor(state, action: PayloadAction<string>) {
      if (!state.passedDoctorSlugs.includes(action.payload)) state.passedDoctorSlugs.push(action.payload);
    },
    undoPassDoctor(state, action: PayloadAction<string>) {
      state.passedDoctorSlugs = state.passedDoctorSlugs.filter(id => id !== action.payload);
    },
    toggleFavoriteClinic(state, action: PayloadAction<string>) {
      const id = action.payload;
      const idx = state.favoritedClinicIds.indexOf(id);
      if (idx >= 0) state.favoritedClinicIds.splice(idx, 1);
      else state.favoritedClinicIds.push(id);
    },
    passClinic(state, action: PayloadAction<string>) {
      if (!state.passedClinicIds.includes(action.payload)) state.passedClinicIds.push(action.payload);
    },
    undoPassClinic(state, action: PayloadAction<string>) {
      state.passedClinicIds = state.passedClinicIds.filter(id => id !== action.payload);
    },
    toggleFavoriteAgency(state, action: PayloadAction<string>) {
      const id = action.payload;
      const idx = state.favoritedAgencyIds.indexOf(id);
      if (idx >= 0) state.favoritedAgencyIds.splice(idx, 1);
      else state.favoritedAgencyIds.push(id);
    },
    passAgency(state, action: PayloadAction<string>) {
      if (!state.passedAgencyIds.includes(action.payload)) state.passedAgencyIds.push(action.payload);
    },
    undoPassAgency(state, action: PayloadAction<string>) {
      state.passedAgencyIds = state.passedAgencyIds.filter(id => id !== action.payload);
    },
    setShowSkippedOnly(state, action: PayloadAction<boolean>) {
      state.showSkippedOnly = action.payload;
      if (action.payload) state.showFavoritesOnly = false;
      persistMarketplaceFilters(state);
    },
    setShowExperiencedOnly(state, action: PayloadAction<boolean>) {
      state.showExperiencedOnly = action.payload;
      persistMarketplaceFilters(state);
    },
    setAdminProvidersFilter(state, action: PayloadAction<Partial<AdminProvidersFilters>>) {
      Object.assign(state.adminProvidersFilters, action.payload);
    },
    setHideBottomNav(state, action: PayloadAction<boolean>) {
      state.hideBottomNav = action.payload;
    },
  },
});

export const {
  toggleSidebar,
  setSidebarOpen,
  setMarketplaceSearchQuery,
  setMarketplaceTab,
  setFilter,
  clearFilters,
  setMarketplaceSortBy,
  loadDonorPreferences,
  toggleFavoriteDonor,
  setShowFavoritesOnly,
  passDonor,
  undoPassDonor,
  loadProviderPreferences,
  toggleFavoriteDoctor,
  passDoctor,
  undoPassDoctor,
  toggleFavoriteClinic,
  passClinic,
  undoPassClinic,
  toggleFavoriteAgency,
  passAgency,
  undoPassAgency,
  setShowSkippedOnly,
  setShowExperiencedOnly,
  setAdminProvidersFilter,
  setHideBottomNav,
} = uiSlice.actions;

export default uiSlice.reducer;
