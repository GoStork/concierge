import { useState, useCallback, useEffect, useRef, Fragment } from "react";
import { motion, useAnimation, useMotionValue, useTransform, PanInfo } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowUp, Undo2, X, Heart, Send, ShoppingBag,
  Check, Flower2, Crown, Award, TrendingUp, MapPin, Sparkles, Clock,
  CalendarPlus,
} from "lucide-react";
import type { TabSection } from "./swipe-mappers";
import { getDonorStatusStyle } from "@/lib/donor-status";
import { getLocationFlag } from "@/lib/country-flag";
import { formatLocationDisplay } from "@/lib/format-location";
import { useIsMobile } from "@/hooks/use-mobile";
import { DoctorMonogram, initialsFromName } from "./doctor-monogram";
import { DonorPhotoFallback } from "./donor-photo-fallback";

export type { TabSection } from "./swipe-mappers";

interface SwipeDeckCardProps {
  id: string;
  photos: string[];
  title: string;
  statusLabel?: string | null;
  // Canonical DB status (AVAILABLE | PENDING | MATCHED | SOLD_OUT). Drives
  // the colored status pill so parents instantly see whether the donor is
  // bookable. AVAILABLE renders nothing; PENDING/MATCHED apply to egg
  // donors + surrogates; SOLD_OUT applies to sperm donors and pure Frozen
  // Eggs donors with no inventory left.
  donorStatus?: "AVAILABLE" | "ON_HOLD" | "PENDING" | "MATCHED" | "SOLD_OUT" | null;
  // Phase 4 (surrogates): ISO timestamp while an active 24h match-call hold
  // is running. Renders the "On Hold for 24 Hours" badge - transparent to
  // other parents that she's temporarily reserved.
  onHoldUntil?: string | null;
  // Frozen-lot inventory status, ONLY rendered when a donor is "Fresh &
  // Frozen" (both modes simultaneously) - in that case donorStatus carries
  // the fresh-cycle state and frozenLotStatus carries the frozen-lot
  // state, and the card renders both labelled badges. For pure Fresh
  // Donors leave undefined/null. For pure Frozen Eggs donors, the
  // donorStatus pill already reflects the frozen state - leave this null.
  frozenLotStatus?: "AVAILABLE" | "SOLD_OUT" | null;
  isExperienced?: boolean;
  isPremium?: boolean;
  // Provider/GoStork-admin only: ISO date the profile row was first synced or
  // manually uploaded (EggDonor/Surrogate/SpermDonor.createdAt). Renders an
  // "Added <date>" chip in the badge row. Callers MUST pass null/undefined for
  // parent viewers - parents never see upload dates.
  uploadedAt?: string | null;
  // True while the provider is paying to sponsor (boost) this profile.
  sponsored?: boolean;
  // Always-visible pill in the badge row (e.g. "Top 10%") - used by clinic and
  // doctor cards so a key signal is never hidden behind a tab.
  successBadge?: string | null;
  // A small logo rendered next to the title (clinic logo), since clinics have no
  // face photo of their own. When there are no `photos` the hero falls back to a
  // clean branded background (not a giant logo watermark).
  titleLogoUrl?: string | null;
  // Clinic cards pin a fixed header at the TOP (logo + name + location + badge),
  // visible across all tabs, instead of the donor-style title at the bottom. When
  // set, the bottom title/badge row is suppressed and only the tabs show there.
  pinnedHeader?: {
    logoUrl?: string | null;
    title: string;
    location?: string | null;
    // When set, the header shows a flag per unique country instead of a single
    // city/state line (agency cards span multiple countries). Each entry is a
    // pre-resolved { flag emoji, short country label }.
    countries?: { flag: string; label: string }[] | null;
    badge?: string | null;
    // Amber caution chip (e.g. "May not meet requirements") with an optional
    // hover tooltip listing the reasons.
    warningBadge?: string | null;
    warningDetail?: string | null;
  } | null;
  // Clinics: keep the first slide photo-free (clean branded background) so the
  // header + success rate read clearly; doctor-face photos start on slide 1.
  firstSlidePlain?: boolean;
  // Doctor cards only: the doctor's name. When a doctor has NO headshot, the hero
  // renders a tasteful brand initials monogram (not the clinic logo / a blank
  // box), so a photo-less doctor still reads as a person. Leave null for clinics.
  monogramName?: string | null;
  // Map of photo URL -> a label (e.g. the doctor's name). On the photo slides the
  // pinned header shows this label instead of the title, so each face is named.
  photoLabels?: Record<string, string>;
  tabs: TabSection[];
  disableSwipe?: boolean;
  chatMode?: boolean;
  readOnly?: boolean;
  isSaved?: boolean;
  isPassed?: boolean;
  counterText?: string;
  onPass: () => void;
  onSave: () => void;
  onUndo?: () => void;
  onCompare?: () => void;
  onMessage?: () => void;
  /** Bank skip-to-checkout: renders a Buy button on the action row (Egg/Sperm Bank donors with a published total cost). */
  onCheckout?: () => void;
  onViewFullProfile: () => void;
}

const SWIPE_THRESHOLD = 150;
const SWIPE_EXIT_DISTANCE = 500;

export function SwipeDeckCard({
  id,
  photos,
  title,
  statusLabel,
  donorStatus,
  onHoldUntil,
  frozenLotStatus,
  isExperienced = false,
  isPremium = false,
  uploadedAt = null,
  sponsored = false,
  successBadge = null,
  titleLogoUrl = null,
  pinnedHeader = null,
  firstSlidePlain = false,
  monogramName = null,
  photoLabels,
  tabs,
  disableSwipe = false,
  chatMode = false,
  readOnly = false,
  isSaved = false,
  isPassed = false,
  counterText,
  onPass,
  onSave,
  onUndo,
  onCompare,
  onMessage,
  onCheckout,
  onViewFullProfile,
}: SwipeDeckCardProps) {
  const isMobile = useIsMobile();
  const [slideIndex, setSlideIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  // Some provider/doctor photo URLs are dead (404); track which failed so that
  // slide falls back to the branded background instead of a broken-image icon.
  const [erroredPhotos, setErroredPhotos] = useState<Record<string, boolean>>({});
  const controls = useAnimation();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const photoContainerRef = useRef<HTMLDivElement | null>(null);

  const triggerExpand = useCallback(() => {
    if (isExpanding) return;
    setIsExpanding(true);
    onViewFullProfile();
  }, [isExpanding, onViewFullProfile]);

  const rotate = useTransform(x, [-SWIPE_EXIT_DISTANCE, 0, SWIPE_EXIT_DISTANCE], [-28, 0, 28]);
  const passOverlayOpacity = useTransform(x, [-SWIPE_THRESHOLD, 0], [0.45, 0]);
  const saveOverlayOpacity = useTransform(x, [0, SWIPE_THRESHOLD], [0, 0.45]);

  // Big X / Heart icon overlay on the card while dragging (Tinder-style)
  const passIconOpacity = useTransform(x, [-SWIPE_THRESHOLD * 1.2, -25, 0], [1, 0, 0]);
  const saveIconOpacity = useTransform(x, [0, 25, SWIPE_THRESHOLD * 1.2], [0, 0, 1]);
  const passIconScale = useTransform(x, [-SWIPE_THRESHOLD * 1.2, 0], [1.15, 0.6]);
  const saveIconScale = useTransform(x, [0, SWIPE_THRESHOLD * 1.2], [0.6, 1.15]);

  // Bottom-row buttons: focus the relevant button, fade the others as drag grows
  const FADE_START = 25;
  const FADE_END = 90;
  const passBtnOpacity = useTransform(x, [-FADE_END, -FADE_START, 0, FADE_START, FADE_END], [1, 1, 1, 0.55, 0]);
  const passBtnScale = useTransform(x, [-SWIPE_THRESHOLD, -FADE_START, 0], [1.35, 1.1, 1]);
  const saveBtnOpacity = useTransform(x, [-FADE_END, -FADE_START, 0, FADE_START, FADE_END], [0, 0.55, 1, 1, 1]);
  const saveBtnScale = useTransform(x, [0, FADE_START, SWIPE_THRESHOLD], [1, 1.1, 1.35]);
  const otherBtnOpacity = useTransform(x, [-FADE_END, -FADE_START, 0, FADE_START, FADE_END], [0, 0.8, 1, 0.8, 0]);

  // Drop photos that 404'd so the remaining (working) faces fill every face-slide
  // instead of one slide collapsing to the branded background.
  const usablePhotos = photos.filter((p) => !erroredPhotos[p]);
  // firstSlidePlain (clinics): the first slide shows NO photo (clean branded
  // background) so the logo/name/success rate read clearly; the photos (doctor
  // faces) start on slide 1. In that mode the slide count follows the tabs.
  const totalSlides = firstSlidePlain
    ? Math.max(tabs.length, 1)
    : Math.max(photos.length, tabs.length, 1);
  const currentTab = tabs.length > 0 && slideIndex < tabs.length ? tabs[slideIndex] : null;
  // Per-tab photo mode (clinic card): each tab carries its own background photo
  // (a doctor face) or none (cream clinic tab), instead of the photos[] array.
  const usesTabPhotos = tabs.some((t) => !!t.photo);
  const tabPhoto = usesTabPhotos && currentTab?.photo && !erroredPhotos[currentTab.photo] ? currentTab.photo : null;
  const photoSlide = firstSlidePlain ? slideIndex - 1 : slideIndex;
  // firstSlidePlain (clinics / photo-less doctors): map one face per slide and DO
  // NOT cycle - tabs beyond the available faces get no photo (-1) and fall back to
  // the cream cover, so a photo-less tab matches the clean first tab. Other cards
  // (a single doctor face shown on every tab) keep cycling.
  const currentPhotoIndex = usablePhotos.length > 0 && photoSlide >= 0
    ? (firstSlidePlain ? (photoSlide < usablePhotos.length ? photoSlide : -1) : photoSlide % usablePhotos.length)
    : -1;
  // Cream "cover" panel (logo/monogram + name, content in dark text). Rendered on
  // ANY slide of a firstSlidePlain card that has no photo - slide 0, tabs beyond
  // the face count, and clinics/doctors with no photos at all - so every photo-less
  // tab keeps the same clean cream background as the first tab.
  const isCover = firstSlidePlain && !!pinnedHeader && (usesTabPhotos ? !tabPhoto : currentPhotoIndex < 0);

  useEffect(() => {
    setSlideIndex(0);
    setIsDragging(false);
    x.set(0);
    y.set(0);
    controls.set({ x: 0, y: 0, rotate: 0, opacity: 1 });
  }, [id, x, y, controls]);

  const handleTapLeft = useCallback(() => {
    if (isDragging) return;
    setSlideIndex(prev => (prev <= 0 ? totalSlides - 1 : prev - 1));
  }, [isDragging, totalSlides]);

  const handleTapRight = useCallback(() => {
    if (isDragging) return;
    setSlideIndex(prev => (prev >= totalSlides - 1 ? 0 : prev + 1));
  }, [isDragging, totalSlides]);

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

  const handleDragEnd = useCallback((_: any, info: PanInfo) => {
    setIsDragging(false);
    const swipeX = info.offset.x;
    const velocity = info.velocity.x;

    if (swipeX < -SWIPE_THRESHOLD || velocity < -500) {
      animateSwipe("left");
    } else if (swipeX > SWIPE_THRESHOLD || velocity > 500) {
      animateSwipe("right");
    } else {
      controls.start({ x: 0, y: 0, rotate: 0, opacity: 1, transition: { type: "spring", stiffness: 300, damping: 25 } });
    }
  }, [animateSwipe, controls]);

  const currentPhoto = usesTabPhotos ? tabPhoto : (currentPhotoIndex >= 0 ? (usablePhotos[currentPhotoIndex] || null) : null);

  // Photo-less DOCTOR cards show a brand initials monogram so they still read as a
  // person (not a blank box or the clinic logo). Clinics pass no monogramName.
  const monogramInitials = monogramName ? initialsFromName(monogramName) : "";

  return (
    <div className="w-full h-full p-[3px]" data-testid={`swipe-card-${id}`}>
      <motion.div
        className={`relative w-full h-full overflow-hidden bg-card select-none rounded-[var(--container-radius)] shadow-lg ${disableSwipe ? "" : "cursor-grab active:cursor-grabbing"} ${isPassed ? "opacity-60" : ""}`}
        style={disableSwipe ? undefined : { x, y, rotate }}
        drag={disableSwipe ? false : true}
        dragConstraints={disableSwipe ? undefined : { left: 0, right: 0, top: 0, bottom: 0 }}
        dragElastic={disableSwipe ? undefined : 0.9}
        onDragStart={disableSwipe ? undefined : () => setIsDragging(true)}
        onDragEnd={disableSwipe ? undefined : handleDragEnd}
        animate={disableSwipe ? undefined : controls}
        data-testid={`swipe-card-draggable-${id}`}
      >
        <motion.div
          ref={photoContainerRef}
          layoutId={disableSwipe ? undefined : `card-hero-${id}`}
          transition={{ duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative w-full h-full overflow-hidden bg-muted"
          style={currentPhoto ? { backgroundImage: `url(${currentPhoto})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
        >
          {currentPhoto ? (
            <img
              src={currentPhoto}
              alt={title}
              className="w-full h-full object-cover"
              loading="eager"
              fetchPriority="high"
              decoding="async"
              draggable={false}
              onError={() => { if (currentPhoto) setErroredPhotos((p) => ({ ...p, [currentPhoto]: true })); }}
              data-testid={`img-swipe-photo-${id}`}
            />
          ) : monogramInitials ? (
            // Photo-less doctor: brand initials monogram on a soft brand gradient.
            <div
              className="w-full h-full bg-gradient-to-br from-[hsl(var(--primary))] via-[hsl(var(--primary))] to-[hsl(var(--accent))] flex items-center justify-center"
              data-testid={`hero-monogram-${id}`}
            >
              <span className="font-heading text-white/95 leading-none" style={{ fontSize: 'clamp(72px, 28vw, 160px)' }}>
                {monogramInitials}
              </span>
            </div>
          ) : pinnedHeader ? (
            // Clinic / doctor with no photo: solid cream, IDENTICAL to the clinic
            // cover, so a photo-less doctor card matches the clinic's first tab.
            <div className="w-full h-full bg-secondary" data-testid={`hero-branded-${id}`} />
          ) : (
            // Donor / surrogate with no usable photo: branded anonymous silhouette
            // so the card reads as intentional, never a broken image.
            <DonorPhotoFallback testId={`hero-branded-${id}`} />
          )}

          <div className={`absolute top-0 left-0 right-0 bg-gradient-to-b from-black/50 via-black/20 to-transparent h-28 z-[15] pointer-events-none transition-opacity duration-200 ${isExpanding ? "opacity-0" : "opacity-100"}`} />

          {isCover && pinnedHeader && (
            <div className={`absolute inset-0 z-[38] bg-secondary flex flex-col px-5 pt-9 ${readOnly ? "pb-5" : "pb-24"} pointer-events-none transition-opacity duration-200 ${isExpanding ? "opacity-0" : "opacity-100"}`} data-testid={`cover-${id}`}>
              <button
                onClick={(e) => { e.stopPropagation(); triggerExpand(); }}
                className="absolute top-6 right-4 z-[39] shrink-0 w-9 h-9 rounded-full bg-white hover:bg-white shadow-md border border-border/40 flex items-center justify-center transition-colors pointer-events-auto"
                data-testid={`button-view-profile-${id}`}
              >
                <ArrowUp className="w-5 h-5 text-foreground" strokeWidth={2.5} />
              </button>

              {/* Header is FIXED at the top (shrink-0) so the logo + name + location
                  stay in the exact same place when cycling tabs - only the content
                  below changes. */}
              <div className="shrink-0 flex flex-col items-center text-center gap-2 pt-2">
                {/* The plain cover has neither badge-render path (no photo overlay,
                    and it has a pinnedHeader), so render Sponsored + success here. */}
                {(sponsored || pinnedHeader.badge || pinnedHeader.warningBadge) && (
                  <div className="flex items-center justify-center gap-1.5 flex-wrap">
                    {sponsored && (
                      <Badge className="bg-accent/90 text-accent-foreground font-ui px-2 py-0.5 gap-1" style={{ fontSize: 'var(--badge-text-size, 11px)' }} data-testid={`badge-sponsored-${id}`}>
                        <Sparkles className="w-3 h-3" /> Sponsored
                      </Badge>
                    )}
                    {pinnedHeader.badge && (
                      <Badge className="bg-[hsl(var(--brand-success))]/90 text-white font-ui px-2 py-0.5 gap-1" style={{ fontSize: 'var(--badge-text-size, 11px)' }} data-testid={`badge-success-${id}`}>
                        <TrendingUp className="w-3 h-3" /> {pinnedHeader.badge}
                      </Badge>
                    )}
                    {pinnedHeader.warningBadge && (
                      <span className="relative group/reqs pointer-events-auto">
                        <Badge
                          className="bg-[hsl(var(--brand-warning))]/90 text-white font-ui px-2 py-0.5 gap-1 whitespace-nowrap cursor-help"
                          style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                          data-testid={`badge-requirements-${id}`}
                        >
                          <Clock className="w-3 h-3" /> {pinnedHeader.warningBadge}
                        </Badge>
                        {pinnedHeader.warningDetail && (
                          <span className="hidden group-hover/reqs:block absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-[60] w-64 rounded-[var(--radius)] border bg-popover text-popover-foreground shadow-md p-3 text-xs font-ui text-left normal-case whitespace-normal">
                            {pinnedHeader.warningDetail}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}
                {monogramInitials && !currentPhoto ? (
                  // Photo-less doctor: brand initials avatar instead of the clinic
                  // logo, so the cover reads as a person, not a clinic.
                  <DoctorMonogram name={monogramName} size={88} className="shadow-sm" data-testid={`pinned-monogram-${id}`} />
                ) : pinnedHeader.logoUrl ? (
                  <img src={pinnedHeader.logoUrl} alt="" className="w-[72px] h-[72px] rounded-xl object-contain bg-white p-2 shrink-0 shadow-sm border border-border/30" draggable={false} data-testid={`pinned-logo-${id}`} />
                ) : null}
                <h3 className="text-foreground font-heading leading-snug line-clamp-2 px-2" style={{ fontSize: '20px' }} data-testid={`text-name-${id}`}>
                  {pinnedHeader.title}
                </h3>
                {pinnedHeader.countries && pinnedHeader.countries.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-muted-foreground font-ui px-2" style={{ fontSize: '13px' }} data-testid={`pinned-countries-${id}`}>
                    {pinnedHeader.countries.map((c) => (
                      <span key={c.label} className="flex items-center gap-1 leading-none">
                        {c.flag ? <span className="shrink-0 leading-none">{c.flag}</span> : <MapPin className="w-3.5 h-3.5 shrink-0" />}
                        {c.label}
                      </span>
                    ))}
                  </div>
                ) : pinnedHeader.location && (
                  <p className="text-muted-foreground font-ui flex items-center gap-1" style={{ fontSize: '13px' }}>
                    {getLocationFlag(pinnedHeader.location)
                      ? <span className="shrink-0 leading-none">{getLocationFlag(pinnedHeader.location)}</span>
                      : <MapPin className="w-3.5 h-3.5 shrink-0" />}
                    {formatLocationDisplay(pinnedHeader.location) || pinnedHeader.location}
                  </p>
                )}
              </div>

              {currentTab && (
                // Top-aligned (justify-start) so each tab's section header
                // ("Matched to you" / "Costs" / "Locations" / "Doctors...") sits at
                // the SAME fixed spot right under the logo+name on every tab; the
                // items below grow downward.
                <div className="flex-1 flex flex-col justify-start min-h-0 overflow-hidden mt-4">
                  {currentTab.title && (
                    <p className="text-[hsl(var(--primary))] font-heading mb-1 flex items-center gap-1.5" style={{ fontSize: '15px' }}>
                      <Check className="w-4 h-4 shrink-0" strokeWidth={2.5} />
                      {currentTab.title}
                    </p>
                  )}
                  {currentTab.subtitle && (
                    <p className="text-muted-foreground font-ui mb-2.5" style={{ fontSize: '12px' }}>{currentTab.subtitle}</p>
                  )}

                  {/* success_bars: clinic-vs-national bars (dark) */}
                  {currentTab.layoutType === "success_bars" && currentTab.bars && currentTab.bars.length > 0 && (
                    <div className="space-y-2.5 mb-2.5">
                      {currentTab.bars.map((bar, i) => (
                        <div key={`${bar.label}-${i}`}>
                          <div className="flex items-center justify-between text-foreground mb-1" style={{ fontSize: '13px' }}>
                            <span>{bar.label}</span>
                            <span className="font-ui">{bar.value}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${Math.min(bar.value, 100)}%`, backgroundColor: bar.isClinic ? 'hsl(var(--primary))' : 'hsl(var(--accent))' }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* icon_list: e.g. Costs (dark rows) */}
                  {currentTab.layoutType === "icon_list" && currentTab.items.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {currentTab.items.map((item, i) => {
                        const Icon = item.icon;
                        return (
                          <div key={`${item.label}-${i}`} className="flex items-center gap-2.5" data-testid={`icon-row-${String(item.label).replace(/\s+/g, "-").toLowerCase()}`}>
                            {Icon && <Icon className="w-4 h-4 text-[hsl(var(--accent))] shrink-0" />}
                            <span className="text-foreground font-body" style={{ fontSize: '14px' }}>{item.label}</span>
                            {item.value && <span className="ml-auto pl-2 text-foreground/70 font-ui tabular-nums shrink-0" style={{ fontSize: '14px' }}>{item.value}</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* chips: Locations / Doctors (standard_bubbles), matched reasons,
                      and success_bars reason items - all as dark chips on cream.
                      success_bars reason chips stay desktop-only to save room. */}
                  {((currentTab.layoutType === "standard_bubbles" || currentTab.layoutType === "matched_bubbles") || (currentTab.layoutType === "success_bars" && !isMobile)) && currentTab.items.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-0.5">
                      {currentTab.items.map((item, i) => {
                        const BubbleIcon = item.icon;
                        const showCheck = currentTab.layoutType !== "standard_bubbles";
                        return (
                          <Badge
                            key={`${item.label}-${i}`}
                            className="bg-primary/10 text-foreground font-ui px-3 py-1 inline-flex items-start gap-1.5 border border-primary/20 max-w-full whitespace-normal break-words text-left leading-snug"
                            style={{ fontSize: '13px' }}
                            data-testid={`badge-attr-${String(item.label).replace(/\s+/g, "-").toLowerCase()}`}
                          >
                            {BubbleIcon && <BubbleIcon className="w-3 h-3 text-[hsl(var(--accent))] shrink-0 mt-0.5" />}
                            <span className="min-w-0">{item.label}</span>
                            {showCheck && <Check className="w-3 h-3 text-[hsl(var(--accent))] shrink-0 mt-0.5" />}
                          </Badge>
                        );
                      })}
                    </div>
                  )}

                  {/* sections: several titled groups stacked on one tab (e.g. the
                      agency Overview tab = Overview + Services + Locations). */}
                  {currentTab.layoutType === "sections" && currentTab.groups && (
                    <div className={`flex flex-col ${chatMode ? "gap-4" : "gap-6"} overflow-hidden`}>
                      {currentTab.groups.map((group, gi) => (
                        <div key={`${group.title}-${gi}`}>
                          {group.title && (
                            <p className="text-[hsl(var(--primary))] font-heading mb-1 flex items-center gap-1.5" style={{ fontSize: '15px' }}>
                              <Check className="w-4 h-4 shrink-0" strokeWidth={2.5} />
                              {group.title}
                            </p>
                          )}
                          {group.subtitle && (
                            <p className="text-muted-foreground font-ui mb-2" style={{ fontSize: '12px' }}>{group.subtitle}</p>
                          )}
                          {group.layoutType === "success_bars" ? (
                            <div className="space-y-2.5">
                              {(group.bars || []).map((bar, i) => (
                                <div key={`${bar.label}-${i}`}>
                                  <div className="flex items-center justify-between text-foreground mb-1" style={{ fontSize: '13px' }}>
                                    <span>{bar.label}</span>
                                    <span className="font-ui">{bar.value}%</span>
                                  </div>
                                  <div className="h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
                                    <div className="h-full rounded-full" style={{ width: `${Math.min(bar.value, 100)}%`, backgroundColor: bar.isClinic ? 'hsl(var(--primary))' : 'hsl(var(--accent))' }} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : group.layoutType === "icon_list" ? (
                            <div className="flex flex-col gap-2">
                              {group.items.map((item, i) => {
                                const Icon = item.icon;
                                return (
                                  <div key={`${item.label}-${i}`} className="flex items-center gap-2.5">
                                    {Icon && <Icon className="w-4 h-4 text-[hsl(var(--accent))] shrink-0" />}
                                    <span className="text-foreground font-body" style={{ fontSize: '14px' }}>{item.label}</span>
                                    {item.value && <span className="ml-auto pl-2 text-foreground/70 font-ui tabular-nums shrink-0" style={{ fontSize: '14px' }}>{item.value}</span>}
                                  </div>
                                );
                              })}
                            </div>
                          ) : group.layoutType === "text" ? (
                            <div className="flex flex-col gap-1.5">
                              {group.items.map((item, i) => {
                                const TextIcon = item.icon;
                                return (
                                  <p key={`${item.label}-${i}`} className="text-foreground font-body flex items-center gap-1.5" style={{ fontSize: '14px', lineHeight: 1.5 }}>
                                    {TextIcon && <TextIcon className={`w-4 h-4 shrink-0 ${item.iconClassName || "text-[hsl(var(--accent))]"}`} />}
                                    {item.label}
                                  </p>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {group.items.map((item, i) => {
                                const BubbleIcon = item.icon;
                                return (
                                  <Badge
                                    key={`${item.label}-${i}`}
                                    className="bg-primary/10 text-foreground font-ui px-3 py-1 inline-flex items-start gap-1.5 border border-primary/20 max-w-full whitespace-normal break-words text-left leading-snug"
                                    style={{ fontSize: '13px' }}
                                  >
                                    {BubbleIcon && <BubbleIcon className="w-3 h-3 text-[hsl(var(--accent))] shrink-0 mt-0.5" />}
                                    <span className="min-w-0">{item.label}</span>
                                  </Badge>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {currentTab.layoutType === "matched_compact" && currentTab.matchedStat && (() => {
                    const m = currentTab.matchedStat;
                    const stat = [m.cycles ? `${m.cycles.toLocaleString()} cycles` : null, m.babies ? `${m.babies.toLocaleString()} babies born` : null].filter(Boolean).join(" · ");
                    return (
                      <div>
                        {m.context && <p className="text-foreground font-ui mb-2" style={{ fontSize: '15px' }}>{m.context}</p>}
                        {m.pct != null && (
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className="font-heading text-[hsl(var(--primary))]" style={{ fontSize: '38px', lineHeight: 1 }}>{m.pct}%</span>
                            <span className="text-foreground font-ui" style={{ fontSize: '17px' }}>live births</span>
                            {m.natAvg != null && <span className="ml-auto text-foreground font-ui" style={{ fontSize: '15px' }}>vs {m.natAvg}% national</span>}
                          </div>
                        )}
                        {m.pct != null && m.natAvg != null && (
                          <div className="relative mt-3 h-2 rounded-full bg-foreground/[0.10]">
                            <div className="absolute left-0 top-0 bottom-0 rounded-full" style={{ width: `${Math.min(m.pct, 100)}%`, backgroundColor: 'hsl(var(--primary))' }} />
                            <div className="absolute -top-1 -bottom-1 w-0.5 rounded-full" style={{ left: `${Math.min(m.natAvg, 100)}%`, backgroundColor: 'hsl(var(--accent))' }} />
                          </div>
                        )}
                        {stat && <p className="text-foreground font-ui mt-3 tabular-nums" style={{ fontSize: '16px' }}>{stat} <span className="text-muted-foreground">per year</span></p>}
                      </div>
                    );
                  })()}

                  {/* cost_cards: mini program cards mirroring the profile's cost
                      cards (flag + country, "Program N" pill, name, big total) -
                      no line items. Cheapest-first, capped with a "+N more" note. */}
                  {currentTab.layoutType === "cost_cards" && currentTab.costPrograms && currentTab.costPrograms.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      {currentTab.costPrograms.map((p, i) => {
                        const heading = p.programName || p.country;
                        const showCountry = !!p.country && p.country !== heading;
                        return (
                          <div key={`${p.programName}-${i}`} className="rounded-xl border border-[hsl(var(--brand-success))]/40 px-3 py-1.5" data-testid={`cost-card-${i}`}>
                            <span className="block font-heading text-foreground truncate" style={{ fontSize: '14px' }}>{heading}</span>
                            <div className="flex items-end justify-between gap-2 mt-0.5">
                              <div className="flex items-center gap-1.5 min-w-0">
                                {p.flag && <span className="shrink-0 leading-none" style={{ fontSize: '14px' }} aria-hidden>{p.flag}</span>}
                                {showCountry && <span className="text-foreground/70 font-body truncate" style={{ fontSize: '12px' }}>{p.country}</span>}
                              </div>
                              <span className="font-heading text-[hsl(var(--primary))] shrink-0" style={{ fontSize: '17px', lineHeight: 1 }}>{p.total}</span>
                            </div>
                          </div>
                        );
                      })}
                      {currentTab.costOverflow ? (
                        <p className="text-muted-foreground font-ui text-center mt-0.5" style={{ fontSize: '12px' }}>+{currentTab.costOverflow} more {currentTab.costOverflow === 1 ? "program" : "programs"}</p>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {pinnedHeader && !isCover && (
            <div className={`absolute top-0 left-0 right-0 z-[37] pt-7 px-4 pb-5 bg-gradient-to-b from-black/75 via-black/45 to-transparent pointer-events-none transition-opacity duration-200 ${isExpanding ? "opacity-0" : "opacity-100"}`} data-testid={`pinned-header-${id}`}>
              {/* On the photo slides, label the face with that doctor's name (smaller,
                  fits one line); the clinic name lives on the first/cover slide. */}
              {(() => {
                const faceLabel = currentTab?.faceLabel || (currentPhoto ? photoLabels?.[currentPhoto] : undefined);
                return (
                  <h3 className="text-white font-heading leading-tight line-clamp-2 text-center" style={{ fontSize: 'var(--card-title-size, 24px)' }} data-testid={`text-name-${id}`}>
                    {faceLabel || pinnedHeader.title}
                  </h3>
                );
              })()}
              <div className="flex items-center justify-center gap-2 mt-2">
                {pinnedHeader.logoUrl && (
                  <img src={pinnedHeader.logoUrl} alt="" className="w-7 h-7 rounded-md object-contain bg-white p-0.5 shrink-0 shadow-sm" draggable={false} data-testid={`pinned-logo-${id}`} />
                )}
                {pinnedHeader.countries && pinnedHeader.countries.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-white/80 font-ui min-w-0" style={{ fontSize: '13px' }} data-testid={`pinned-countries-${id}`}>
                    {pinnedHeader.countries.map((c) => (
                      <span key={c.label} className="flex items-center gap-1 leading-none">
                        {c.flag ? <span className="shrink-0 leading-none">{c.flag}</span> : <MapPin className="w-3.5 h-3.5 shrink-0" />}
                        {c.label}
                      </span>
                    ))}
                  </div>
                ) : pinnedHeader.location && (
                  <p className="text-white/80 font-ui flex items-center gap-1 min-w-0" style={{ fontSize: '13px' }}>
                    {getLocationFlag(pinnedHeader.location)
                      ? <span className="shrink-0 leading-none">{getLocationFlag(pinnedHeader.location)}</span>
                      : <MapPin className="w-3.5 h-3.5 shrink-0" />}
                    <span className="truncate">{formatLocationDisplay(pinnedHeader.location) || pinnedHeader.location}</span>
                  </p>
                )}
                {sponsored && (
                  <Badge className="bg-accent/90 text-accent-foreground font-ui px-2 py-0.5 gap-1 shrink-0" style={{ fontSize: 'var(--badge-text-size, 11px)' }} data-testid={`badge-sponsored-${id}`}>
                    <Sparkles className="w-3 h-3" />
                    Sponsored
                  </Badge>
                )}
                {pinnedHeader.badge && (
                  <Badge className="bg-[hsl(var(--brand-success))]/90 text-white font-ui px-2 py-0.5 gap-1 shrink-0" style={{ fontSize: 'var(--badge-text-size, 11px)' }} data-testid={`badge-success-${id}`}>
                    <TrendingUp className="w-3 h-3" />
                    {pinnedHeader.badge}
                  </Badge>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); triggerExpand(); }}
                  className={`ml-auto shrink-0 w-9 h-9 rounded-full bg-white/90 hover:bg-white shadow-md flex items-center justify-center transition-colors pointer-events-auto ${isExpanding ? "opacity-0 pointer-events-none" : "opacity-100"}`}
                  data-testid={`button-view-profile-${id}`}
                >
                  <ArrowUp className="w-5 h-5 text-foreground" strokeWidth={2.5} />
                </button>
              </div>
            </div>
          )}

          <div className={`absolute top-0 left-0 right-0 flex gap-1 px-3 pt-3 z-[40] pointer-events-none transition-opacity duration-200 ${isExpanding ? "opacity-0" : "opacity-100"}`} data-testid={`progress-bars-${id}`}>
            {Array.from({ length: totalSlides }).map((_, i) => (
              <div
                key={i}
                className={`h-[3px] flex-1 rounded-full transition-all duration-200 ${i === slideIndex ? (isCover ? "bg-foreground/70" : "bg-white") : (isCover ? "bg-foreground/20" : "bg-white/40")}`}
                data-testid={`progress-segment-${i}`}
              />
            ))}
          </div>

          {counterText && (
            <div className="absolute top-10 right-3 z-20 pointer-events-none" data-testid={`counter-${id}`}>
              <span className="text-white/70 text-xs font-ui bg-black/30 backdrop-blur-sm px-2 py-0.5 rounded-full">
                {counterText}
              </span>
            </div>
          )}

          <div
            className="absolute top-0 left-0 w-1/2 h-full z-30"
            onClick={handleTapLeft}
            data-testid={`tap-zone-left-${id}`}
          />
          <div
            className="absolute top-0 right-0 w-1/2 h-full z-30"
            onClick={handleTapRight}
            data-testid={`tap-zone-right-${id}`}
          />

          {!disableSwipe && (
            <>
              <motion.div
                className="absolute inset-0 bg-destructive/30 pointer-events-none z-[5]"
                style={{ opacity: passOverlayOpacity }}
              />
              <motion.div
                className="absolute inset-0 bg-success/30 pointer-events-none z-[5]"
                style={{ opacity: saveOverlayOpacity }}
              />
              <motion.div
                className="absolute inset-0 flex items-center justify-center pointer-events-none z-[40]"
                style={{ opacity: passIconOpacity }}
              >
                <motion.div style={{ scale: passIconScale }}>
                  <X className="w-48 h-48 text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.7)]" strokeWidth={4} />
                </motion.div>
              </motion.div>
              <motion.div
                className="absolute inset-0 flex items-center justify-center pointer-events-none z-[40]"
                style={{ opacity: saveIconOpacity }}
              >
                <motion.div style={{ scale: saveIconScale }}>
                  <Heart className="w-48 h-48 text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.7)]" strokeWidth={3} fill="currentColor" />
                </motion.div>
              </motion.div>
            </>
          )}

          <div className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 ${readOnly ? "pb-6" : "pb-24"} px-4 z-[35] pointer-events-none transition-opacity duration-200 ${isExpanding ? "opacity-0" : "opacity-100"}`}>
            {!pinnedHeader && (
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              {sponsored && (
                <Badge
                  className="bg-accent/90 text-accent-foreground font-ui px-2 py-0.5 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                  data-testid={`badge-sponsored-${id}`}
                >
                  <Sparkles className="w-3 h-3" />
                  Sponsored
                </Badge>
              )}
              {successBadge && (
                <Badge
                  className="bg-[hsl(var(--brand-success))]/90 text-white font-ui px-2 py-0.5 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                  data-testid={`badge-success-${id}`}
                >
                  <TrendingUp className="w-3 h-3" />
                  {successBadge}
                </Badge>
              )}
              {isPremium && (
                <Badge
                  className="bg-[hsl(var(--brand-warning))]/90 text-white font-ui px-2 py-0.5 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                  data-testid={`badge-premium-${id}`}
                >
                  <Crown className="w-3 h-3" />
                  Premium
                </Badge>
              )}
              {statusLabel && (
                <Badge
                  className="bg-accent/90 text-accent-foreground font-ui px-2 py-0.5"
                  style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                  data-testid={`badge-status-${id}`}
                >
                  {statusLabel}
                </Badge>
              )}
              {/* Hybrid "Fresh & Frozen" donors carry two independent
                  inventory dimensions, so we render two prefixed badges
                  ("Fresh: ..." and "Frozen: ..."). Pure Fresh Donors and
                  pure Frozen Eggs donors get the single unlabelled badge
                  via the fallback branch below. */}
              {frozenLotStatus != null ? (
                <>
                  {(() => {
                    const freshLabel =
                      donorStatus === "PENDING"  ? "Pending"  :
                      donorStatus === "MATCHED"  ? "Matched"  :
                      donorStatus === "SOLD_OUT" ? "Sold Out" :
                      "Available";
                    const freshBg =
                      donorStatus === "PENDING"  ? "bg-[hsl(var(--brand-warning))]/90 text-white" :
                      donorStatus === "MATCHED"  ? "bg-muted-foreground/80 text-background"      :
                      donorStatus === "SOLD_OUT" ? "bg-destructive/90 text-destructive-foreground" :
                      "bg-[hsl(var(--brand-success))]/90 text-white";
                    return (
                      <Badge
                        className={`font-ui px-2 py-0.5 ${freshBg}`}
                        style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                        data-testid={`badge-fresh-status-${id}`}
                      >
                        Fresh: {freshLabel}
                      </Badge>
                    );
                  })()}
                  {(() => {
                    const frozenLabel = frozenLotStatus === "SOLD_OUT" ? "Sold Out" : "Available";
                    const frozenBg = frozenLotStatus === "SOLD_OUT"
                      ? "bg-destructive/90 text-destructive-foreground"
                      : "bg-[hsl(var(--brand-success))]/90 text-white";
                    return (
                      <Badge
                        className={`font-ui px-2 py-0.5 ${frozenBg}`}
                        style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                        data-testid={`badge-frozen-status-${id}`}
                      >
                        Frozen: {frozenLabel}
                      </Badge>
                    );
                  })()}
                </>
              ) : donorStatus && donorStatus !== "AVAILABLE" && (() => {
                const ds = getDonorStatusStyle(donorStatus)!;
                const pillBg =
                  donorStatus === "PENDING"  ? "bg-[hsl(var(--brand-warning))]/90 text-white" :
                  donorStatus === "ON_HOLD"  ? "bg-[hsl(var(--brand-warning))]/90 text-white" :
                  donorStatus === "SOLD_OUT" ? "bg-destructive/90 text-destructive-foreground" :
                  /* MATCHED */                "bg-muted-foreground/80 text-background";
                return (
                  <Badge
                    className={`font-ui px-2 py-0.5 ${pillBg}`}
                    style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                    data-testid={`badge-donor-status-${id}`}
                    title={ds.description}
                  >
                    {ds.label}
                  </Badge>
                );
              })()}
              {/* Active 24h match-call hold - visible to everyone by design */}
              {onHoldUntil && new Date(onHoldUntil) > new Date() && (
                <Badge
                  className="bg-[hsl(var(--brand-warning))]/90 text-white font-ui px-2 py-0.5 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                  data-testid={`badge-on-hold-${id}`}
                  title="Another family just completed a match call - she's reserved while they decide."
                >
                  <Clock className="w-3 h-3" />
                  On Hold for 24 Hours
                </Badge>
              )}
              {isExperienced && (
                <Badge
                  className="bg-[hsl(var(--brand-warning))]/90 text-white font-ui px-2 py-0.5 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                  data-testid={`badge-experienced-${id}`}
                >
                  <Award className="w-3 h-3" />
                  Experienced
                </Badge>
              )}
              {uploadedAt && (
                <Badge
                  className="bg-secondary/90 text-secondary-foreground font-ui px-2 py-0.5 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 11px)' }}
                  data-testid={`badge-uploaded-${id}`}
                  title="Date this profile was synced or manually uploaded (visible to providers and GoStork admins only)"
                >
                  <CalendarPlus className="w-3 h-3" />
                  Added {new Date(uploadedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </Badge>
              )}
            </div>
            )}

            {!pinnedHeader && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {titleLogoUrl && (
                  <img
                    src={titleLogoUrl}
                    alt=""
                    className="w-10 h-10 rounded-md object-contain bg-white/95 p-1 shrink-0 shadow-sm"
                    draggable={false}
                    data-testid={`title-logo-${id}`}
                  />
                )}
                <h3 className="text-white font-heading leading-tight line-clamp-2" style={{ fontSize: 'var(--card-title-size, 24px)' }} data-testid={`text-name-${id}`}>
                  {title}
                </h3>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); triggerExpand(); }}
                className="shrink-0 w-9 h-9 rounded-full bg-white/90 hover:bg-white shadow-md flex items-center justify-center transition-colors pointer-events-auto"
                data-testid={`button-view-profile-${id}`}
              >
                <ArrowUp className="w-5 h-5 text-foreground" strokeWidth={2.5} />
              </button>
            </div>
            )}

            <div className="mt-3" data-testid={`tab-data-${id}`}>
              {currentTab && currentTab.items.length > 0 && currentTab.layoutType === "matched_bubbles" && (
                <div>
                  {currentTab.title && (
                    <p className="text-white font-heading mb-2 flex items-center gap-1.5" style={{ fontSize: 'var(--card-overlay-size, 16px)' }} data-testid="text-matched-title">
                      <Check className="w-4 h-4 text-accent" />
                      {currentTab.title}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5" data-testid={`matched-prefs-${id}`}>
                    {currentTab.items.map((item, i) => (
                      <Badge
                        key={`${item.label}-${i}`}
                        className="bg-primary/25 text-white font-ui px-4 py-2 backdrop-blur-sm inline-flex items-start gap-1.5 border border-primary/30 max-w-full whitespace-normal break-words text-left leading-snug"
                        style={{ fontSize: 'var(--card-overlay-size, 16px)' }}
                        data-testid={`badge-matched-${String(item.label).replace(/\s+/g, "-").toLowerCase()}`}
                      >
                        <span className="min-w-0">{item.label}</span>
                        <Check className="w-3 h-3 text-accent shrink-0 mt-1" />
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {currentTab && currentTab.items.length > 0 && currentTab.layoutType === "icon_list" && (
                <div>
                  {currentTab.title && (
                    <p className="text-white font-heading mb-2 flex items-center gap-1.5" style={{ fontSize: 'var(--card-overlay-size, 16px)' }} data-testid="text-iconlist-title">
                      <Flower2 className="w-4 h-4 text-white/80" />
                      {currentTab.title}
                    </p>
                  )}
                  <div className="flex flex-col gap-2.5">
                  {currentTab.items.map((item, i) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={`${item.label}-${i}`}
                        className="flex items-center gap-2.5"
                        data-testid={`icon-row-${String(item.label).replace(/\s+/g, "-").toLowerCase()}`}
                      >
                        {Icon && <Icon className="w-4 h-4 text-white/80 shrink-0" />}
                        <span className="text-white font-body" style={{ fontSize: 'var(--card-overlay-size, 16px)' }}>{item.label}</span>
                        {item.value && <span className="ml-auto pl-2 text-white/80 font-ui tabular-nums shrink-0" style={{ fontSize: 'var(--card-overlay-size, 16px)' }}>{item.value}</span>}
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}

              {currentTab && currentTab.layoutType === "success_bars" && (
                <div>
                  {currentTab.title && (
                    <p className="text-white font-heading mb-0.5 flex items-center gap-1.5" style={{ fontSize: 'var(--card-overlay-size, 16px)' }} data-testid="text-success-title">
                      <Check className="w-4 h-4 text-accent" />
                      {currentTab.title}
                    </p>
                  )}
                  {currentTab.subtitle && (
                    <p className="text-white/70 font-ui mb-2" style={{ fontSize: '12px' }}>{currentTab.subtitle}</p>
                  )}
                  {currentTab.bars && currentTab.bars.length > 0 && (
                    <div className="space-y-1.5 mb-3" data-testid={`success-bars-${id}`}>
                      {currentTab.bars.map((bar, i) => (
                        <div key={`${bar.label}-${i}`}>
                          <div className="flex items-center justify-between text-white/90 mb-0.5" style={{ fontSize: '13px' }}>
                            <span>{bar.label}</span>
                            <span className="font-ui">{bar.value}%</span>
                          </div>
                          <div className="h-2 rounded-full bg-white/20 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{ width: `${Math.min(bar.value, 100)}%`, backgroundColor: bar.isClinic ? 'hsl(var(--primary))' : 'hsl(var(--accent))' }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {!isMobile && currentTab.items.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {currentTab.items.map((item, i) => (
                        <Badge
                          key={`${item.label}-${i}`}
                          className="bg-primary/25 text-white font-ui px-3 py-1.5 backdrop-blur-sm inline-flex items-start gap-1.5 border border-primary/30 max-w-full whitespace-normal break-words text-left leading-snug"
                          style={{ fontSize: 'var(--card-overlay-size, 16px)' }}
                          data-testid={`badge-matched-${String(item.label).replace(/\s+/g, "-").toLowerCase()}`}
                        >
                          <span className="min-w-0">{item.label}</span>
                          <Check className="w-3 h-3 text-accent shrink-0 mt-1" />
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {currentTab && currentTab.items.length > 0 && currentTab.layoutType === "standard_bubbles" && (
                <div>
                  {currentTab.title && (
                    <p className="text-white font-heading mb-2 flex items-center gap-1.5" style={{ fontSize: 'var(--card-overlay-size, 16px)' }} data-testid="text-section-title">
                      <Flower2 className="w-4 h-4 text-white/80" />
                      {currentTab.title}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {currentTab.items.map((item, i) => {
                      const BubbleIcon = item.icon;
                      return (
                        <Fragment key={`${item.label}-${i}`}>
                          {item.lineBreakBefore && <div className="w-full" />}
                          <Badge
                            variant="secondary"
                            className="bg-white/12 text-white border border-white/10 font-ui px-4 py-2 backdrop-blur-sm inline-flex items-start gap-1.5 max-w-full whitespace-normal break-words text-left leading-snug"
                            style={{ fontSize: 'var(--card-overlay-size, 16px)' }}
                            data-testid={`badge-attr-${String(item.label).replace(/\s+/g, "-").toLowerCase()}`}
                          >
                            {BubbleIcon && <BubbleIcon className="w-3 h-3 mt-1 text-white/80 shrink-0" />}
                            <span className="min-w-0">{item.label}</span>
                          </Badge>
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              )}

              {currentTab && currentTab.layoutType === "sections" && currentTab.groups && (
                <div className={`flex flex-col ${chatMode ? "gap-4" : "gap-6"}`}>
                  {currentTab.groups.map((group, gi) => (
                    <div key={`${group.title}-${gi}`}>
                      {group.title && (
                        <p className="text-white font-heading mb-2 flex items-center gap-1.5" style={{ fontSize: 'var(--card-overlay-size, 16px)' }}>
                          <Flower2 className="w-4 h-4 text-white/80" />
                          {group.title}
                        </p>
                      )}
                      {group.subtitle && (
                        <p className="text-white/70 font-ui mb-2" style={{ fontSize: '12px' }}>{group.subtitle}</p>
                      )}
                      {group.layoutType === "success_bars" ? (
                        <div className="space-y-1.5">
                          {(group.bars || []).map((bar, i) => (
                            <div key={`${bar.label}-${i}`}>
                              <div className="flex items-center justify-between text-white/90 mb-0.5" style={{ fontSize: '13px' }}>
                                <span>{bar.label}</span>
                                <span className="font-ui">{bar.value}%</span>
                              </div>
                              <div className="h-2 rounded-full bg-white/20 overflow-hidden">
                                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(bar.value, 100)}%`, backgroundColor: bar.isClinic ? 'hsl(var(--primary))' : 'hsl(var(--accent))' }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : group.layoutType === "icon_list" ? (
                        <div className="flex flex-col gap-2">
                          {group.items.map((item, i) => {
                            const Icon = item.icon;
                            return (
                              <div key={`${item.label}-${i}`} className="flex items-center gap-2.5">
                                {Icon && <Icon className="w-4 h-4 text-white/80 shrink-0" />}
                                <span className="text-white font-body" style={{ fontSize: 'var(--card-overlay-size, 16px)' }}>{item.label}</span>
                                {item.value && <span className="ml-auto pl-2 text-white/80 font-ui tabular-nums shrink-0" style={{ fontSize: 'var(--card-overlay-size, 16px)' }}>{item.value}</span>}
                              </div>
                            );
                          })}
                        </div>
                      ) : group.layoutType === "text" ? (
                        <div className="flex flex-col gap-1.5">
                          {group.items.map((item, i) => {
                            const TextIcon = item.icon;
                            return (
                              <p key={`${item.label}-${i}`} className="text-white font-body flex items-center gap-1.5" style={{ fontSize: 'var(--card-overlay-size, 16px)', lineHeight: 1.5 }}>
                                {TextIcon && <TextIcon className={`w-4 h-4 shrink-0 ${item.iconClassName || "text-white/80"}`} />}
                                {item.label}
                              </p>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {group.items.map((item, i) => {
                            const BubbleIcon = item.icon;
                            return (
                              <Badge
                                key={`${item.label}-${i}`}
                                variant="secondary"
                                className="bg-white/12 text-white border border-white/10 font-ui px-4 py-2 backdrop-blur-sm inline-flex items-start gap-1.5 max-w-full whitespace-normal break-words text-left leading-snug"
                                style={{ fontSize: 'var(--card-overlay-size, 16px)' }}
                              >
                                {BubbleIcon && <BubbleIcon className="w-3 h-3 mt-1 text-white/80 shrink-0" />}
                                <span className="min-w-0">{item.label}</span>
                              </Badge>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {currentTab && currentTab.layoutType === "matched_compact" && currentTab.matchedStat && (() => {
                const m = currentTab.matchedStat;
                const stat = [m.cycles ? `${m.cycles.toLocaleString()} cycles` : null, m.babies ? `${m.babies.toLocaleString()} babies born` : null].filter(Boolean).join(" · ");
                return (
                  <div>
                    {m.context && <p className="text-white font-ui mb-2" style={{ fontSize: '15px' }}>{m.context}</p>}
                    {m.pct != null && (
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-white font-heading" style={{ fontSize: '42px', lineHeight: 1 }}>{m.pct}%</span>
                        <span className="text-white font-ui" style={{ fontSize: '17px' }}>live births</span>
                        {m.natAvg != null && <span className="ml-auto text-white font-ui" style={{ fontSize: '15px' }}>vs {m.natAvg}% national</span>}
                      </div>
                    )}
                    {m.pct != null && m.natAvg != null && (
                      <div className="relative mt-3 h-2 rounded-full bg-white/25">
                        <div className="absolute left-0 top-0 bottom-0 rounded-full" style={{ width: `${Math.min(m.pct, 100)}%`, backgroundColor: 'hsl(var(--primary))' }} />
                        <div className="absolute -top-1 -bottom-1 w-0.5 rounded-full" style={{ left: `${Math.min(m.natAvg, 100)}%`, backgroundColor: 'hsl(var(--accent))' }} />
                      </div>
                    )}
                    {stat && <p className="text-white font-ui mt-3 tabular-nums" style={{ fontSize: '16px' }}>{stat} <span className="text-white/80">per year</span></p>}
                  </div>
                );
              })()}

              {/* cost_cards over a photo: same mini program cards as the cream
                  variant but glassy white-on-dark. */}
              {currentTab && currentTab.layoutType === "cost_cards" && currentTab.costPrograms && currentTab.costPrograms.length > 0 && (
                <div>
                  {currentTab.title && (
                    <p className="text-white font-heading mb-2 flex items-center gap-1.5" style={{ fontSize: 'var(--card-overlay-size, 16px)' }}>
                      <Flower2 className="w-4 h-4 text-white/80" />
                      {currentTab.title}
                    </p>
                  )}
                  <div className="flex flex-col gap-1.5">
                    {currentTab.costPrograms.map((p, i) => {
                      const heading = p.programName || p.country;
                      const showCountry = !!p.country && p.country !== heading;
                      return (
                        <div key={`${p.programName}-${i}`} className="rounded-xl border border-white/30 bg-black/25 backdrop-blur-sm px-3 py-1.5" data-testid={`cost-card-${i}`}>
                          <span className="block font-heading text-white truncate" style={{ fontSize: '14px' }}>{heading}</span>
                          <div className="flex items-end justify-between gap-2 mt-0.5">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {p.flag && <span className="shrink-0 leading-none" style={{ fontSize: '14px' }} aria-hidden>{p.flag}</span>}
                              {showCountry && <span className="text-white/75 font-body truncate" style={{ fontSize: '12px' }}>{p.country}</span>}
                            </div>
                            <span className="font-heading text-white shrink-0" style={{ fontSize: '17px', lineHeight: 1 }}>{p.total}</span>
                          </div>
                        </div>
                      );
                    })}
                    {currentTab.costOverflow ? (
                      <p className="text-white/80 font-ui text-center mt-0.5" style={{ fontSize: '12px' }}>+{currentTab.costOverflow} more {currentTab.costOverflow === 1 ? "program" : "programs"}</p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={`absolute bottom-6 left-0 right-0 px-4 z-[39] flex items-center justify-center gap-3 ${readOnly ? "hidden" : ""} transition-opacity duration-200 ${isExpanding ? "opacity-0 pointer-events-none" : "opacity-100"}`} data-testid={`action-row-${id}`}>
            {!chatMode && !disableSwipe && (
              <motion.div style={{ opacity: otherBtnOpacity }} className="pointer-events-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => { e.stopPropagation(); onUndo?.(); }}
                  disabled={!onUndo}
                  className="h-12 w-12 rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center disabled:opacity-100 disabled:pointer-events-auto"
                  data-testid={`button-undo-${id}`}
                >
                  <Undo2 className="!w-7 !h-7 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-undo)" }} strokeWidth={3} />
                </Button>
              </motion.div>
            )}

            <motion.div style={disableSwipe ? undefined : { opacity: passBtnOpacity, scale: passBtnScale }} className="pointer-events-auto">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); isPassed ? onUndo?.() : (disableSwipe ? onPass() : animateSwipe("left")); }}
                className={`${chatMode ? "h-14 w-14" : "h-16 w-16"} rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center`}
                data-testid={isPassed ? `button-undo-${id}` : `button-pass-${id}`}
              >
                {/* In the skipped/hidden view a passed card's primary action is to
                    bring it BACK, so show the rounded yellow Back (undo) icon - the
                    same affordance as the mobile deck - instead of a yellow X. */}
                {isPassed ? (
                  <Undo2 className="!w-9 !h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-undo)" }} strokeWidth={3} />
                ) : (
                  <X className="!w-9 !h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-pass)" }} strokeWidth={3} />
                )}
              </Button>
            </motion.div>

            <motion.div style={disableSwipe ? undefined : { opacity: saveBtnOpacity, scale: saveBtnScale }} className="pointer-events-auto">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); disableSwipe ? onSave() : animateSwipe("right"); }}
                className={`${chatMode ? "h-14 w-14" : "h-16 w-16"} rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center`}
                data-testid={`button-save-${id}`}
              >
                <Heart className="!w-9 !h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-save)" }} strokeWidth={3} fill={isSaved ? "currentColor" : "none"} />
              </Button>
            </motion.div>

            {!chatMode && (
              <motion.div style={disableSwipe ? undefined : { opacity: otherBtnOpacity }} className="pointer-events-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => { e.stopPropagation(); onMessage?.(); }}
                  disabled={!onMessage}
                  className="h-16 w-16 rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center disabled:opacity-100 disabled:pointer-events-auto"
                  data-testid={`button-chat-${id}`}
                >
                  <Send className="!w-8 !h-8 sm:!w-9 sm:!h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-chat)" }} strokeWidth={3} />
                </Button>
              </motion.div>
            )}

            {!chatMode && onCheckout && (
              <motion.div style={disableSwipe ? undefined : { opacity: otherBtnOpacity }} className="pointer-events-auto">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => { e.stopPropagation(); onCheckout(); }}
                  className="h-16 w-16 rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center"
                  title="Buy now - direct checkout"
                  data-testid={`button-checkout-${id}`}
                >
                  <ShoppingBag className="!w-8 !h-8 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "hsl(var(--brand-success))" }} strokeWidth={3} />
                </Button>
              </motion.div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
