# GoStork Explorer - Donor Card Animation: Investigation Report

> Read-only investigation of the donor card swipe / like / pass animation in the GoStork Explorer.
> No code was changed to produce this report. File/line references point at `main` as of this writing.

## 1. Animation library / technique

**Framer Motion** (`framer-motion` ^11.18.2) drives everything. There is **no** React Spring, no `react-tinder-card`, no `@use-gesture/react`. `vaul` ^1.1.2 is in `package.json` but is **not** used by either card surface (it's for drawers elsewhere).

Import lines:

- `client/src/components/marketplace/swipe-deck-card.tsx:2`
  ```ts
  import { motion, useAnimation, useMotionValue, useTransform, PanInfo } from "framer-motion";
  ```
- `client/src/pages/profile-detail-page.tsx:2`
  ```ts
  import { motion } from "framer-motion";
  ```

The swipe gesture uses Framer's built-in `drag` prop (no external gesture lib); the exit is driven imperatively via `useAnimation()` controls; the drag-reactive tints/stamps use `useMotionValue(x)` + `useTransform`.

## 2. Relevant files

| Role | Path |
|------|------|
| Explorer swipeable card | `client/src/components/marketplace/swipe-deck-card.tsx` (803 lines) |
| Bottom action bar (undo / X / heart / send) | **Inside** `swipe-deck-card.tsx`, lines 744-798 - it is **not** a separate component |
| Like/pass handlers (deck) | `client/src/pages/marketplace-page.tsx` - `handleSave` (942), `handlePass` (951), `goBack` (960) |
| Like/pass exit animation (card) | `swipe-deck-card.tsx` - `animateSwipe` (188), `handleDragEnd` (202) |
| Separate full detail page | `client/src/pages/profile-detail-page.tsx` (1701 lines); routes registered in `App.tsx:138-143` (`/eggdonor/:providerId/:donorId`, `/surrogate/...`, `/spermdonor/...`) |
| Detail-page action bar | `profile-detail-page.tsx:855-884` (its own pass/save/message buttons) |

### Key code

**Exit animation of the outgoing card** (`swipe-deck-card.tsx:188-200`):
```ts
const animateSwipe = useCallback(async (direction: "left" | "right") => {
  const xTarget = direction === "left" ? -SWIPE_EXIT_DISTANCE : SWIPE_EXIT_DISTANCE;
  const yTarget = y.get();
  await controls.start({
    x: xTarget,
    y: yTarget,
    rotate: direction === "left" ? -32 : 32,
    opacity: 0,
    transition: { duration: 0.35, ease: "easeOut" },
  });
  if (direction === "left") onPass();
  else onSave();
}, [controls, onPass, onSave, y]);
```
Constants (lines 77-78): `SWIPE_THRESHOLD = 150`, `SWIPE_EXIT_DISTANCE = 500`.

**Drag-reactive overlay tint + heart/X stamp** (`swipe-deck-card.tsx:127-135` and `453-480`):
```ts
const rotate = useTransform(x, [-SWIPE_EXIT_DISTANCE, 0, SWIPE_EXIT_DISTANCE], [-28, 0, 28]);
const passOverlayOpacity = useTransform(x, [-SWIPE_THRESHOLD, 0], [0.45, 0]);
const saveOverlayOpacity = useTransform(x, [0, SWIPE_THRESHOLD], [0, 0.45]);
const passIconOpacity = useTransform(x, [-SWIPE_THRESHOLD * 1.2, -25, 0], [1, 0, 0]);
const saveIconOpacity = useTransform(x, [0, 25, SWIPE_THRESHOLD * 1.2], [0, 0, 1]);
const passIconScale = useTransform(x, [-SWIPE_THRESHOLD * 1.2, 0], [1.15, 0.6]);
const saveIconScale = useTransform(x, [0, SWIPE_THRESHOLD * 1.2], [0.6, 1.15]);
```
```tsx
{!disableSwipe && (
  <>
    <motion.div className="absolute inset-0 bg-destructive/30 ... z-[5]" style={{ opacity: passOverlayOpacity }} />
    <motion.div className="absolute inset-0 bg-success/30 ... z-[5]"     style={{ opacity: saveOverlayOpacity }} />
    <motion.div className="absolute inset-0 flex items-center justify-center ... z-[40]" style={{ opacity: passIconOpacity }}>
      <motion.div style={{ scale: passIconScale }}>
        <X className="w-48 h-48 text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.7)]" strokeWidth={4} />
      </motion.div>
    </motion.div>
    <motion.div className="absolute inset-0 flex items-center justify-center ... z-[40]" style={{ opacity: saveIconOpacity }}>
      <motion.div style={{ scale: saveIconScale }}>
        <Heart className="w-48 h-48 text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.7)]" strokeWidth={3} fill="currentColor" />
      </motion.div>
    </motion.div>
  </>
)}
```

**The draggable card element** (`swipe-deck-card.tsx:224-233`):
```tsx
<motion.div
  className={`relative w-full h-full overflow-hidden bg-card ... ${isPassed ? "opacity-50 grayscale" : ""}`}
  style={disableSwipe ? undefined : { x, y, rotate }}
  drag={disableSwipe ? false : true}
  dragConstraints={disableSwipe ? undefined : { left: 0, right: 0, top: 0, bottom: 0 }}
  dragElastic={disableSwipe ? undefined : 0.9}
  onDragStart={disableSwipe ? undefined : () => setIsDragging(true)}
  onDragEnd={disableSwipe ? undefined : handleDragEnd}
  animate={disableSwipe ? undefined : controls}
>
```

**Deck handlers** (`marketplace-page.tsx:942-957`):
```ts
const handleSave = (donorId: string) => {
  recordProfileView(donorId, type);
  const isFav = favoritedIds.includes(donorId);
  dispatch(toggleFavoriteDonor(donorId));
  syncPref("favorite", donorId, isFav ? "remove" : "add");
  setHistory((h) => [...h, donorId]);
  setPinFrontId(null);
};
const handlePass = (donorId: string) => {
  recordProfileView(donorId, type);
  dispatch(passDonor(donorId));
  syncPref("skip", donorId, "add");
  setHistory((h) => [...h, donorId]);
  setPinFrontId(null);
};
```
Saving/passing removes the donor from the `filtered` list (favorited + passed are hidden from Explore), which is what makes the stack advance. See the comment at `marketplace-page.tsx:939-941`.

## 3. Two surfaces - confirmed

- **(a) Expanded card in the Explorer stack** -> `SwipeDeckCard` in `client/src/components/marketplace/swipe-deck-card.tsx`. This is the swipeable card with the Overview tab, Age/Country/Anonymous content, and the bottom action bar.
- **(b) Separate full detail page (own URL + spinner)** -> `client/src/pages/profile-detail-page.tsx`, reached by `navigate()` to `/${slug}/:providerId/:donorId`.

**They do NOT share animation code.** Each implements its own:
- (a) uses `useAnimation` controls + drag + motion-value tints/stamps.
- (b) uses simple `motion.div` `initial/animate` fade-and-slide entrances (no drag, no swipe).

There is one **shared convention** but it is effectively inert across the route boundary: both assign `layoutId={`card-hero-${id}`}` to their hero image - (a) at `swipe-deck-card.tsx:237`, (b) at `profile-detail-page.tsx:910`. A Framer shared-layout transition only animates if both nodes are mounted within the same `LayoutGroup`/`AnimatePresence` at the same time. Because (b) is a separate React-Router route, the deck unmounts on navigation, so **this shared-element morph does not actually run** - the matching `layoutId`s are present but currently produce no cross-route animation.

## 4. Current transition behavior (plain terms)

**Overlay / dim on the outgoing card:** There is **no dark/dim** overlay. During a **drag**, two full-bleed *color tints* fade in proportional to drag distance (lines 455-462): red (`bg-destructive/30`) when dragging left/pass, green (`bg-success/30`) when dragging right/save, each ramping `0 -> 0.45` opacity from 0 to the 150px threshold. (Separately, an *already-passed* card in the skipped view renders at `opacity-50 grayscale` via the className at line 225 - that's a static state, not a transition.)

**Heart watermark on like:** Yes (lines 471-478) - a large centered filled `Heart` (`w-48 h-48`, white, heavy drop-shadow), opacity `0 -> 1` and scale `0.6 -> 1.15` as you drag right; the mirror `X` stamp for pass. **Important nuance:** because `animateSwipe` animates the same `x` motion value that feeds these `useTransform`s, the green tint + heart stamp also light up during a **button-triggered** save (heart-button tap), not only during a manual drag.

**How the outgoing card exits:** translate `x` to **+/-500px**, `rotate` **+/-32deg** (left = -32, right = +32), `opacity -> 0`, **duration 0.35s, ease `"easeOut"`** (`animateSwipe`, 188-200). During free drag (before release) the rotation maps to **+/-28deg** at +/-500px (line 127); a sub-threshold release springs back with `type: "spring", stiffness: 300, damping: 25` (`handleDragEnd`, 202-214).

**How the next card appears:** It does **not** animate in. The next card is **pre-rendered static underneath** the top card (z-0, `disableSwipe`) - see section 5. When the top card animates away and is then removed from `filtered`, the underneath card is revealed and the stack re-renders. There is **no cross-dissolve, no scale-up, and no `AnimatePresence`** wrapping the stack - the only motion is the outgoing card's imperative exit, which `await`s to completion *before* `onSave`/`onPass` removes it from the list.

**Detail page (b) between cards:** Yes - it is a **route push + data fetch + spinner + blank state**. Navigation (`marketplace-page.tsx:1041`):
```ts
onViewFullProfile={() => {
  recordProfileView(currentDonor.id, type);
  navigate(`/${typeToUrlSlug(type)}/${currentDonor.providerId}/${currentDonor.id}`,
           { state: { initialPhotoUrl: currentDonor.photoUrl } });
}}
```
Fetch (`profile-detail-page.tsx:639-647`):
```ts
const { data: donor, isLoading } = useQuery<any>({
  queryKey: [`/api/providers/${providerId}/${endpoint}`, donorId],
  queryFn: async () => {
    const res = await fetch(`/api/providers/${providerId}/${endpoint}/${donorId}`, { credentials: "include" });
    if (!res.ok) throw new Error("Donor not found");
    return res.json();
  },
  enabled: !!providerId && !!donorId && !!type,
});
```
Spinner / blank state while loading (`profile-detail-page.tsx:715-721`):
```tsx
if (isLoading) {
  return (
    <div className="flex justify-center p-12">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  );
}
```
The `state: { initialPhotoUrl }` is passed so the page *could* show the photo immediately, but the page still gates the full body behind `isLoading` and renders the centered spinner until the donor fetch resolves.

## 5. Card stack structure

**Mobile: exactly two cards mounted at once.** The next card is mounted underneath the top card but inert (`disableSwipe`, no-op handlers, z-0). Desktop renders a **static grid** of all visible donors (`DonorGridCard`, no swipe). JSX (`marketplace-page.tsx:1000-1046`):
```tsx
<div className="h-full" data-testid="swipe-deck-mobile">
  <div className={`relative h-full w-full ${showSkippedOnly ? "grayscale opacity-60" : ""}`}>
    {nextDonor && nextProfile && (
      <div className="absolute inset-0 z-0" data-testid={`card-next-${nextDonor.id}`}>
        <SwipeDeckCard
          key={`next-${nextDonor.id}`}
          id={nextProfile.id}
          photos={getPhotoList(nextProfile)}
          /* ...static props... */
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
        /* ... */
        isSaved={favoritedIds.includes(currentDonor.id)}
        onPass={() => handlePass(currentDonor.id)}
        onSave={() => handleSave(currentDonor.id)}
        onUndo={history.length > 0 ? goBack : undefined}
        onMessage={() => { /* navigate to /concierge?... */ }}
        onViewFullProfile={() => { /* navigate to detail page */ }}
      />
    </div>
  </div>
</div>
```
Selection of current/next (`marketplace-page.tsx:992-993`):
```ts
const currentDonor = filtered[currentIndex];
const nextDonor = currentIndex + 1 < filtered.length ? filtered[currentIndex + 1] : null;
```

## Summary of the mechanism

The deck is **not** an `AnimatePresence` crossfade stack. It's a two-layer pre-render: the top card is the only interactive one; on like/pass it imperatively animates off-screen (translate +/-500 / rotate +/-32deg / fade, 0.35s easeOut), then the donor is dropped from the `filtered` list, the static underneath card is revealed, and React re-mounts a fresh current+next pair. The full **detail page is a separate route** with its own fetch, spinner, and simple fade/slide entrances - it shares the `card-hero-${id}` `layoutId` with the deck card but, being a separate route, does not currently produce a shared-element morph.
