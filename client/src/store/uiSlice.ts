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
  marketplaceSearchQuery: string;
  marketplaceTab: string;
  activeFilters: Record<string, string[]>;
  marketplaceSortBy: string;
  favoritedDonorIds: string[];
  passedDonorIds: string[];
  showFavoritesOnly: boolean;
  showSkippedOnly: boolean;
  showExperiencedOnly: boolean;
  adminProvidersFilters: AdminProvidersFilters;
}

const VALID_TABS = ["egg-donors", "surrogates", "ivf-clinics", "surrogacy-agencies", "sperm-donors"];

function getPersistedTab(): string {
  try {
    const stored = sessionStorage.getItem("marketplaceTab");
    if (stored && VALID_TABS.includes(stored)) return stored;
    const local = localStorage.getItem("marketplaceTab");
    if (local && VALID_TABS.includes(local)) return local;
  } catch {}
  return "egg-donors";
}

const initialState: UiState = {
  sidebarOpen: false,
  marketplaceSearchQuery: "",
  marketplaceTab: getPersistedTab(),
  activeFilters: {},
  marketplaceSortBy: "newest",
  favoritedDonorIds: [],
  passedDonorIds: [],
  showFavoritesOnly: false,
  showSkippedOnly: false,
  showExperiencedOnly: false,
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
    },
    setMarketplaceTab(state, action: PayloadAction<string>) {
      state.marketplaceTab = action.payload;
      state.activeFilters = {};
      state.showFavoritesOnly = false;
      state.showSkippedOnly = false;
      state.showExperiencedOnly = false;
      try {
        sessionStorage.setItem("marketplaceTab", action.payload);
        localStorage.setItem("marketplaceTab", action.payload);
      } catch {}
    },
    setFilter(state, action: PayloadAction<{ key: string; values: string[] }>) {
      state.activeFilters[action.payload.key] = action.payload.values;
    },
    clearFilters(state) {
      state.activeFilters = {};
    },
    setMarketplaceSortBy(state, action: PayloadAction<string>) {
      state.marketplaceSortBy = action.payload;
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
    },
    passDonor(state, action: PayloadAction<string>) {
      if (!state.passedDonorIds.includes(action.payload)) {
        state.passedDonorIds.push(action.payload);
      }
    },
    undoPassDonor(state, action: PayloadAction<string>) {
      state.passedDonorIds = state.passedDonorIds.filter(id => id !== action.payload);
    },
    setShowSkippedOnly(state, action: PayloadAction<boolean>) {
      state.showSkippedOnly = action.payload;
      if (action.payload) state.showFavoritesOnly = false;
    },
    setShowExperiencedOnly(state, action: PayloadAction<boolean>) {
      state.showExperiencedOnly = action.payload;
    },
    setAdminProvidersFilter(state, action: PayloadAction<Partial<AdminProvidersFilters>>) {
      Object.assign(state.adminProvidersFilters, action.payload);
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
  setShowSkippedOnly,
  setShowExperiencedOnly,
  setAdminProvidersFilter,
} = uiSlice.actions;

export default uiSlice.reducer;
