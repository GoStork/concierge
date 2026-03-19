import { useState, useCallback, useEffect, Fragment } from "react";
import { motion, useAnimation, useMotionValue, useTransform, PanInfo } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronUp, Undo2, X, Heart, Send,
  Check, Flower2, Crown, Award,
} from "lucide-react";
import type { TabSection } from "./swipe-mappers";

export type { TabSection } from "./swipe-mappers";

interface SwipeDeckCardProps {
  id: string;
  photos: string[];
  title: string;
  statusLabel?: string | null;
  isExperienced?: boolean;
  isPremium?: boolean;
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
  onViewFullProfile: () => void;
}

const SWIPE_THRESHOLD = 150;
const SWIPE_EXIT_DISTANCE = 500;

export function SwipeDeckCard({
  id,
  photos,
  title,
  statusLabel,
  isExperienced = false,
  isPremium = false,
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
  onViewFullProfile,
}: SwipeDeckCardProps) {
  const [slideIndex, setSlideIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const controls = useAnimation();
  const x = useMotionValue(0);

  const rotate = useTransform(x, [-SWIPE_EXIT_DISTANCE, 0, SWIPE_EXIT_DISTANCE], [-15, 0, 15]);
  const passOverlayOpacity = useTransform(x, [-SWIPE_THRESHOLD, 0], [0.6, 0]);
  const saveOverlayOpacity = useTransform(x, [0, SWIPE_THRESHOLD], [0, 0.6]);

  const totalSlides = Math.max(photos.length, tabs.length, 1);
  const currentTab = tabs.length > 0 && slideIndex < tabs.length ? tabs[slideIndex] : null;
  const currentPhotoIndex = photos.length > 0 ? slideIndex % photos.length : 0;

  useEffect(() => {
    setSlideIndex(0);
    setIsDragging(false);
    x.set(0);
    controls.set({ x: 0, rotate: 0, opacity: 1 });
  }, [id, x, controls]);

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
    await controls.start({
      x: xTarget,
      rotate: direction === "left" ? -15 : 15,
      opacity: 0,
      transition: { duration: 0.35, ease: "easeOut" },
    });
    if (direction === "left") onPass();
    else onSave();
  }, [controls, onPass, onSave]);

  const handleDragEnd = useCallback((_: any, info: PanInfo) => {
    setIsDragging(false);
    const swipeX = info.offset.x;
    const velocity = info.velocity.x;

    if (swipeX < -SWIPE_THRESHOLD || velocity < -500) {
      animateSwipe("left");
    } else if (swipeX > SWIPE_THRESHOLD || velocity > 500) {
      animateSwipe("right");
    } else {
      controls.start({ x: 0, rotate: 0, opacity: 1, transition: { type: "spring", stiffness: 300, damping: 25 } });
    }
  }, [animateSwipe, controls]);

  const currentPhoto = photos[currentPhotoIndex] || null;

  return (
    <div className="w-full h-full p-[3px]" data-testid={`swipe-card-${id}`}>
      <motion.div
        className={`relative w-full h-full overflow-hidden bg-card select-none rounded-[var(--container-radius)] shadow-lg ${disableSwipe ? "" : "cursor-grab active:cursor-grabbing"} ${isPassed ? "opacity-50 grayscale" : ""}`}
        style={disableSwipe ? undefined : { x, rotate }}
        drag={disableSwipe ? false : "x"}
        dragConstraints={disableSwipe ? undefined : { left: 0, right: 0 }}
        dragElastic={disableSwipe ? undefined : 0.9}
        onDragStart={disableSwipe ? undefined : () => setIsDragging(true)}
        onDragEnd={disableSwipe ? undefined : handleDragEnd}
        animate={disableSwipe ? undefined : controls}
        data-testid={`swipe-card-draggable-${id}`}
      >
        <div
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
              data-testid={`img-swipe-photo-${id}`}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              <span className="text-lg font-heading">No Photo</span>
            </div>
          )}

          <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/50 via-black/20 to-transparent h-28 z-[15] pointer-events-none" />

          <div className="absolute top-0 left-0 right-0 flex gap-1 px-3 pt-3 z-20 pointer-events-none" data-testid={`progress-bars-${id}`}>
            {Array.from({ length: totalSlides }).map((_, i) => (
              <div
                key={i}
                className={`h-[3px] flex-1 rounded-full transition-all duration-200 ${i === slideIndex ? "bg-white" : "bg-white/40"}`}
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
            </>
          )}

          <div className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 ${readOnly ? "pb-6" : "pb-24"} px-4 z-[35] pointer-events-none`}>
            <div className="flex items-center gap-1.5 mb-2">
              {isPremium && (
                <Badge
                  className="bg-[hsl(var(--brand-warning))]/90 text-white font-ui px-2.5 py-1 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 13px)' }}
                  data-testid={`badge-premium-${id}`}
                >
                  <Crown className="w-3 h-3" />
                  Premium
                </Badge>
              )}
              {statusLabel && (
                <Badge
                  className="bg-accent/90 text-accent-foreground font-ui px-2.5 py-1"
                  style={{ fontSize: 'var(--badge-text-size, 13px)' }}
                  data-testid={`badge-status-${id}`}
                >
                  {statusLabel}
                </Badge>
              )}
              {isExperienced && (
                <Badge
                  className="bg-[hsl(var(--brand-warning))]/90 text-white font-ui px-2.5 py-1 gap-1"
                  style={{ fontSize: 'var(--badge-text-size, 13px)' }}
                  data-testid={`badge-experienced-${id}`}
                >
                  <Award className="w-3 h-3" />
                  Experienced
                </Badge>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-heading leading-tight" style={{ fontSize: 'var(--card-title-size, 24px)' }} data-testid={`text-name-${id}`}>
                  {title}
                </h3>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onViewFullProfile(); }}
                className="p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors pointer-events-auto"
                data-testid={`button-view-profile-${id}`}
              >
                <ChevronUp className="w-5 h-5 text-white" />
              </button>
            </div>

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
                        className="bg-primary/25 text-white font-ui px-4 py-2 backdrop-blur-sm flex items-center gap-1.5 border border-primary/30"
                        style={{ fontSize: 'var(--card-overlay-size, 16px)' }}
                        data-testid={`badge-matched-${item.label.replace(/\s+/g, "-").toLowerCase()}`}
                      >
                        {item.label}
                        <Check className="w-3 h-3 text-accent" />
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
                        data-testid={`icon-row-${item.label.replace(/\s+/g, "-").toLowerCase()}`}
                      >
                        {Icon && <Icon className="w-4 h-4 text-accent/80 shrink-0" />}
                        <span className="text-white font-body" style={{ fontSize: 'var(--card-overlay-size, 16px)' }}>{item.label}</span>
                      </div>
                    );
                  })}
                  </div>
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
                            className="bg-white/12 text-white border border-white/10 font-ui px-4 py-2 backdrop-blur-sm flex items-center"
                            style={{ fontSize: 'var(--card-overlay-size, 16px)' }}
                            data-testid={`badge-attr-${item.label.replace(/\s+/g, "-").toLowerCase()}`}
                          >
                            {BubbleIcon && <BubbleIcon className="w-3 h-3 mr-1.5 text-accent/70" />}
                            {item.label}
                          </Badge>
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={`absolute bottom-6 left-0 right-0 px-4 z-[35] flex items-center justify-center gap-3 ${readOnly ? "hidden" : ""}`} data-testid={`action-row-${id}`}>
            {!chatMode && (
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); onUndo?.(); }}
                disabled={!onUndo}
                className="h-12 w-12 rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex sm:hidden items-center justify-center pointer-events-auto disabled:opacity-100 disabled:pointer-events-auto"
                data-testid={`button-undo-${id}`}
              >
                <Undo2 className="!w-7 !h-7 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-undo)" }} strokeWidth={3} />
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); isPassed ? onUndo?.() : (disableSwipe ? onPass() : animateSwipe("left")); }}
              className={`${chatMode ? "h-14 w-14" : "h-16 w-16"} rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center pointer-events-auto`}
              data-testid={`button-pass-${id}`}
            >
              <X className="!w-9 !h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: isPassed ? "var(--swipe-undo)" : "var(--swipe-pass)" }} strokeWidth={3} />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); disableSwipe ? onSave() : animateSwipe("right"); }}
              className={`${chatMode ? "h-14 w-14" : "h-16 w-16"} rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center pointer-events-auto`}
              data-testid={`button-save-${id}`}
            >
              <Heart className="!w-9 !h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-save)" }} strokeWidth={3} fill={isSaved ? "currentColor" : "none"} />
            </Button>

            {!chatMode && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => { e.stopPropagation(); onMessage?.(); }}
                  disabled={!onMessage}
                  className="h-16 w-16 rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] [@media(hover:hover)]:hover:scale-110 [@media(hover:hover)]:hover:brightness-110 active:scale-95 active:translate-y-0.5 active:shadow-[0_4px_8px_rgba(0,0,0,0.5),inset_0_4px_8px_rgba(0,0,0,0.6)] transition-all duration-200 flex items-center justify-center pointer-events-auto disabled:opacity-100 disabled:pointer-events-auto"
                  data-testid={`button-chat-${id}`}
                >
                  <Send className="!w-8 !h-8 sm:!w-9 sm:!h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-chat)" }} strokeWidth={3} />
                </Button>

              </>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
