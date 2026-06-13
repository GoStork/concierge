# GoStork Explorer "Explode" Redesign - Investigation Brief

**Goal:** Replace the top filter bar (Eggs/Sperm/Surrogates/Clinics pills) with a monday.com-style "explode" animation triggered by a centered Explore button in the bottom tab bar. Tapping fans out 5 provider cards (Eggs, Sperm, Surrogates, IVF Clinics, Doctors); selecting one navigates to that provider like the old pill did.

All facts below verified against the repo on 2026-06-13. This is a read-only investigation brief - no code was changed to produce it.

---

## 1. Framework / animation stack

- **React web (Vite)** - NOT React Native / Expo. From `package.json`: `react ^18.3.1`, `react-dom ^18.3.1`, `vite ^7.3.0`, `framer-motion ^11.18.2`. No `react-native` / `expo` / `reanimated`.
- **Animation library on the Explorer = Framer Motion.** The swipe card (`client/src/components/marketplace/swipe-deck-card.tsx:2`):
  ```ts
  import { motion, useAnimation, useMotionValue, useTransform, PanInfo } from "framer-motion";
  ```
  Card entrance also uses a CSS keyframe: `animate-[slideUp_0.4s_ease-out_forwards]`. Build the explode/fan-out with Framer Motion (already a dependency).

## 2. The Explorer screen component

- **Path:** `client/src/pages/marketplace-page.tsx` (~2,126 lines). Routed at `client/src/App.tsx:133` -> `/marketplace`.
- Contains many sub-components: `MarketplaceFiltersDrawer`, `MobileFilterOverlay`, `DeckTypeSwitcher`, `IvfClinicDeckGrid`, `DoctorDeckGrid`, `DonorGrid`, `MobileSavedGrid`, and default-export `MarketplacePage`.

**Mobile immersive container + top filter bar** (`marketplace-page.tsx:1851`):
```tsx
if (isMobile && (isDonorTab || isIvfTab)) {
  return (
    <div className="fixed inset-x-0 top-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-[60] flex flex-col" style={{ backgroundColor: 'hsl(var(--deck-bg))' }} data-testid="marketplace-mobile-immersive">
      {showFavoritesOnly ? (
        <div className="shrink-0 w-full px-3 pb-2" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)' }}>
          <DeckTypeSwitcher .../>
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
        {/* DonorGrid / IvfClinicDeckGrid / DoctorDeckGrid render here, h-full */}
      </div>
      ...
    </div>
  );
}
```

**The top filter bar = `MobileFilterOverlay`** (`marketplace-page.tsx:1385`; the bar being replaced) - filter icon (left), `DeckTypeSwitcher` pills (center), search icon (right). Core JSX (`:1420-1475`):
```tsx
<button onClick={onOpenFilters} aria-label="Open filters"><SlidersHorizontal/></button>
{searchExpanded
  ? (<input value={searchQuery} onChange={e => dispatch(setMarketplaceSearchQuery(e.target.value))} placeholder="Search..." />)
  : (<DeckTypeSwitcher types={types} activeTab={activeTab} onSelect={onSelectType} theme="dark" />)}
<button onClick={handleSearchToggle} aria-label={searchExpanded ? "Close search" : "Search"}>
  {searchExpanded ? <X/> : <Search/>}
</button>
```

**The pills = `DeckTypeSwitcher`** (`marketplace-page.tsx:1013`):
```tsx
function DeckTypeSwitcher({ types, activeTab, onSelect, theme }) {
  if (types.length < 2) return null;
  return (
    <div className="flex justify-center gap-1.5 overflow-x-auto scrollbar-hide" data-testid="deck-type-switcher">
      {types.map(t => (
        <button key={t.id} onClick={() => onSelect(t.id)}
          className={`shrink-0 px-4 py-1.5 rounded-full text-[13px] font-medium font-ui ${active ? "bg-white text-[hsl(var(--deck-bg))]" : "bg-white/12 text-white/85"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
```

## 3. The provider filter mechanism

**Tapping a pill is a Redux store update, NOT a route change.** Handler: `onSelect(id)` -> `dispatch(setMarketplaceTab(id))`.

- `activeTab` read from Redux (`marketplace-page.tsx:1485`): `const activeTab = useAppSelector((s) => s.ui.marketplaceTab);`
- Reducer (`client/src/store/uiSlice.ts:140`):
  ```ts
  setMarketplaceTab(state, action: PayloadAction<string>) {
    state.marketplaceTab = action.payload;
    state.activeFilters = {};
    state.showFavoritesOnly = false;
    state.showSkippedOnly = false;
    state.showExperiencedOnly = false;
    try { sessionStorage.setItem("marketplaceTab", action.payload);
          localStorage.setItem("marketplaceTab", action.payload); } catch {}
    persistMarketplaceFilters(state);
  }
  ```
- **Valid tab ids** (`uiSlice.ts:33`): `["egg-donors", "surrogates", "ivf-clinics", "surrogacy-agencies", "sperm-donors"]`
- **Parent-facing pills** = `parentAvailableTypes`, from `PARENT_TYPE_MAP` / `PARENT_TYPE_ORDER` (`marketplace-page.tsx:1005`):
  ```ts
  const PARENT_TYPE_MAP = {
    "Egg Donor":        { id: "egg-donors",   label: "Eggs" },
    "Sperm Donor":      { id: "sperm-donors", label: "Sperm" },
    "Surrogate":        { id: "surrogates",   label: "Surrogates" },
    "Fertility Clinic": { id: "ivf-clinics",  label: "Clinics" },
  };
  const PARENT_TYPE_ORDER = ["egg-donors", "sperm-donors", "surrogates", "ivf-clinics"];
  ```

**To reproduce a pill from the explode picker:** `dispatch(setMarketplaceTab("<id>"))` then (if not already on the page) `navigate('/marketplace')`. The 4 existing parent ids: `egg-donors`, `sperm-donors`, `surrogates`, `ivf-clinics`.

**Doctors = NET-NEW as a top-level entry.** Not in `VALID_TABS`, `TABS`, or `PARENT_TYPE_MAP`. Doctors exist today only as a **sub-view of the `ivf-clinics` tab**, toggled by the `clinicView=doctors` URL search param (via `DoctorDeckGrid` at `marketplace-page.tsx:467` and the toggle inside the filters drawer's `MarketplaceFilterBar`). The data layer is fully built: `search_doctors` / `resolve_doctor_card` (`server/src/mcp-server.ts`), `server/src/lib/doctor-enrichment.ts`, `doctor-profile-page.tsx`, and the doctor swipe card. Options for the 5th card: add a new tab id `"doctors"`, OR have the Doctors card set `ivf-clinics` + `clinicView=doctors`.

## 4. The bottom tab bar

- **Path:** `client/src/components/layout-shell.tsx` (~1,148 lines). The bottom bar is **mobile-only** (`md:hidden`).
- Container + render loop (`:918-1029`):
  ```tsx
  <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden safe-area-bottom px-3 ..."
       style={{ backgroundColor: onMarketplaceDeck ? 'hsl(var(--deck-bg))' : '...', paddingBottom: 'env(safe-area-inset-bottom)' }}>
    <nav style={navGlassStyle} data-testid="nav-bottom-tabs">
      <div className="flex items-stretch justify-around h-[68px] px-2">
        {bottomTabs.map((item) => {
          const handleClick = item.tabId
            ? (e) => { e.preventDefault(); dispatch(setMarketplaceTab(item.tabId!)); navigate('/marketplace'); }
            : undefined;
          return <Link to={item.to} onClick={handleClick} ...><Icon/>{!iconOnly && <span>{item.mobileLabel}</span>}</Link>;
        })}
      </div>
    </nav>
  </div>
  ```
- Items built in `navigation` (`:730-761`), filtered/capped to `bottomTabs` (`:763-776`, `maxBottomTabs = 7`, Profile pinned last).

**Parent (marketplace mode) mobile order:**
1. Discover (`Flame`, `/marketplace`, `mobileOnly`) - the single mobile entry into the deck; "type pills live inside the deck view"
2. Saved (`Heart`, `/marketplace?view=saved`)
3. Chats (`MessageCircle`, `/chat`, badge=unread)
4. Calendar (`Calendar`, `/calendar`)
5. Profile (`User`, `/account`, pinned last)

Notes:
- Marketplace **type tabs as individual bottom items are `desktopOnly`** (`:739-747`); not on mobile.
- **Concierge-enabled parents** skip the entire marketplace block (condition at `layout-shell.tsx:734`): `isParentOnly && !(brandSettings?.enableAiConcierge && brandSettings?.parentExperienceMode !== 'MARKETPLACE_ONLY')`. They get Chats / Calendar / Profile only - NO marketplace entry. If the Explore button must appear for them too, that condition is where it's gated.
- Navigation: marketplace items do `dispatch(setMarketplaceTab(tabId)); navigate('/marketplace')`; everything else is a plain `<Link to={item.to}>`.
- "Discover" (the Flame entry) is the natural home to swap for the centered Explore button.

## 5. Icons

**Have (custom SVG):** `client/src/components/icons/marketplace-icons.tsx` - `EggDonorIcon`, `SurrogateIcon`, `IvfClinicIcon`, `AgencyIcon`, `SpermIcon`. Each takes `{ className }`. Import:
```ts
import { EggDonorIcon, SurrogateIcon, IvfClinicIcon, AgencyIcon, SpermIcon } from "@/components/icons/marketplace-icons";
```
**Missing: `DoctorIcon`** - none in that file. Doctors have only:
- `DoctorMonogram` + `initialsFromName` (`client/src/components/marketplace/doctor-monogram.tsx`) - an initials-on-brand-gradient avatar (not a line icon).
- lucide `Stethoscope` (used for doctor credentials in `swipe-mappers.ts`).

A Doctors tab/card icon is **net-new** - add a `DoctorIcon` to `marketplace-icons.tsx`, or use a lucide glyph (`Stethoscope` / `UserRound`).

## 6. Layout constraints

The mobile Explorer does NOT use top padding for the filter bar - it's a **flex column**: `MobileFilterOverlay` is a `shrink-0` sibling above the deck, and the deck gets `flex-1 min-h-0` (`marketplace-page.tsx:1851`):
```tsx
<div className="fixed inset-x-0 top-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-[60] flex flex-col" style={{ backgroundColor: 'hsl(var(--deck-bg))' }}>
  <MobileFilterOverlay .../>          {/* the bar to remove; occupies the top of the column */}
  <div className="flex-1 min-h-0"> ... deck (h-full) ... </div>
</div>
```
The decks already render full-bleed `h-full` (`clinic-swipe-deck-mobile` / `doctor-swipe-deck-mobile` / `swipe-deck-mobile`). **To make the card full-bleed: remove/replace the `MobileFilterOverlay` element** - the `flex-1` deck then fills the container automatically. The container already reserves `bottom-[calc(88px+env(safe-area-inset-bottom))]` for the bottom tab bar; `MobileFilterOverlay` adds its own top safe-area padding (`paddingTop: 'calc(env(safe-area-inset-top) + 8px)'`, `:1400`). If you drop the bar, ensure the deck/header still clears the status-bar notch.

**Search icon (top-right): mobile only.** It lives only inside `MobileFilterOverlay`, rendered solely in the `isMobile` immersive block (`:1864`). Desktop has no top-right search icon - desktop search is separate inline inputs (IVF filter bar; surrogacy-agencies `<Input placeholder="Search agencies...">` at `:2010`).

---

## Quick wiring summary for the explode button

- Place the centered Explore button in the `bottomTabs` render in `layout-shell.tsx` (swap/augment the `Flame` "Discover" entry).
- On tap: open a Framer Motion overlay that fans out 5 cards: Eggs, Sperm, Surrogates, IVF Clinics, Doctors.
- On card select:
  - Eggs -> `dispatch(setMarketplaceTab("egg-donors"))`
  - Sperm -> `dispatch(setMarketplaceTab("sperm-donors"))`
  - Surrogates -> `dispatch(setMarketplaceTab("surrogates"))`
  - IVF Clinics -> `dispatch(setMarketplaceTab("ivf-clinics"))`
  - Doctors -> `dispatch(setMarketplaceTab("ivf-clinics"))` + set `clinicView=doctors` search param (OR introduce a new `"doctors"` tab id + add it to `VALID_TABS`/render branches)
  - then `navigate('/marketplace')`.
- Remove `MobileFilterOverlay` from the immersive container for a full-bleed card (keep the filter icon / search somewhere if still needed; the search icon is currently mobile-only and lives in that overlay).
- For concierge-enabled parents, relax the gate at `layout-shell.tsx:734` if the Explore button must show.
