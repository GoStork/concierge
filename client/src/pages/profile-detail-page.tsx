import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { motion, useAnimation } from "framer-motion";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { typeToUrlSlug, deriveTypeFromPath, resolveSurrogateFields, resolveEggDonorFields, resolveSpermDonorFields, getPhotoSrc } from "@/lib/profile-utils";
import { formatMoneyDollars } from "@/lib/format-money";
import { formatFieldLabel } from "@/lib/format-label";
import { formatLocationDisplay } from "@/lib/format-location";
import { cleanCityState } from "@/lib/country-flag";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { hasProviderRole, hasAnyRole, GOSTORK_ROLES } from "@shared/roles";
import { ClinicCostProgramsSection } from "@/components/clinic-cost-programs-section";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ProfileSection } from "@/components/ui/profile-section";
import {
  Field, FieldValue, FieldGrid, MicroField, isWideField,
  PromptBlock, PromptStack, PromptEyebrow, PromptAnswer,
  AttributeChip, ChipRow, toChipParts,
} from "@/components/ui/field";
import { DonorPhotoFallback } from "@/components/marketplace/donor-photo-fallback";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAppDispatch, useAppSelector } from "@/store";
import { toggleFavoriteDonor, passDonor } from "@/store/uiSlice";
import { recordProfileView, recordProfileOpen } from "@/lib/profile-views";
import {
  ArrowLeft,
  ArrowDown,
  Loader2,
  User,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  X,
  Heart,
  Send,
  Play,
  Pencil,
  Check,
} from "lucide-react";

function isEmbedVideo(url: string): boolean {
  return /vimeo\.com|youtube\.com|youtu\.be/i.test(url);
}

/**
 * True when there is an in-app history entry to go back to. React Router v6
 * stamps an incrementing `idx` onto history.state, so idx > 0 means we pushed
 * our way here. On a deep link / hard refresh / shared URL idx is 0 (or absent)
 * and `navigate(-1)` is a silent no-op - the caller must send the user
 * somewhere explicit instead.
 */
function hasInAppHistory(): boolean {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === "number" && idx > 0;
}

function isDirectVideo(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

function isIframeVideo(url: string): boolean {
  return /embed|player|iframe/i.test(url) && !isDirectVideo(url);
}

function getEmbedUrl(url: string): string {
  const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  const ytMatch = url.match(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;
  return url;
}

function PhotoGalleryBar({ photos: rawPhotos, videoUrl, showFallback = false }: { photos: string[]; videoUrl?: string | null; showFallback?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  // Drop any photo whose URL 404s so a dead link never renders as a broken image.
  const [errored, setErrored] = useState<Record<string, boolean>>({});
  const photos = rawPhotos.filter((p) => !errored[p]);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(true);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeftArrow(el.scrollLeft > 10);
    setShowRightArrow(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener("scroll", updateArrows, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", updateArrows); ro.disconnect(); };
  }, [updateArrows, photos.length]);

  useEffect(() => {
    if (lightboxIdx === null && !showVideo) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showVideo) setShowVideo(false);
        else setLightboxIdx(null);
      } else if (lightboxIdx !== null) {
        if (e.key === "ArrowRight" && lightboxIdx < photos.length - 1) setLightboxIdx(lightboxIdx + 1);
        else if (e.key === "ArrowLeft" && lightboxIdx > 0) setLightboxIdx(lightboxIdx - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxIdx, showVideo, photos.length]);

  const scroll = useCallback((dir: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.7;
    el.scrollBy({ left: dir === "left" ? -amount : amount, behavior: "smooth" });
  }, []);

  if (photos.length === 0 && !videoUrl) {
    if (!showFallback) return null;
    // Anonymous / photo-less donor: branded silhouette instead of an empty hero.
    return (
      <div className="h-[280px] w-full max-w-[420px] rounded-[var(--radius)] overflow-hidden" data-testid="photo-gallery-fallback">
        <DonorPhotoFallback />
      </div>
    );
  }

  return (
    <>
      <div className="relative group" data-testid="photo-gallery-bar">
        {showLeftArrow && (
          <button
            onClick={() => scroll("left")}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-opacity opacity-0 group-hover:opacity-100"
            data-testid="gallery-scroll-left"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}
        {showRightArrow && (
          <button
            onClick={() => scroll("right")}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-opacity opacity-0 group-hover:opacity-100"
            data-testid="gallery-scroll-right"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
        <div
          ref={scrollRef}
          className="flex gap-1.5 overflow-x-auto scroll-smooth gallery-scroll"
          style={{ scrollSnapType: "x mandatory", scrollbarWidth: "none" }}
          data-testid="gallery-scroll-container"
        >
          {videoUrl && (
            <button
              onClick={() => setShowVideo(true)}
              className="shrink-0 cursor-pointer overflow-hidden rounded-[var(--radius)] focus:outline-none focus:ring-2 focus:ring-primary/40 relative"
              style={{ scrollSnapAlign: "start" }}
              data-testid="gallery-video-thumb"
            >
              {photos.length > 0 ? (
                <img
                  src={photos[0]}
                  alt="Video thumbnail"
                  className="h-[280px] w-[220px] object-cover brightness-75"
                  onError={() => setErrored((e) => ({ ...e, [photos[0]]: true }))}
                />
              ) : (
                <div className="h-[280px] w-[220px] bg-foreground/90" />
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <div className="w-14 h-14 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                  <Play className="w-7 h-7 text-primary ml-0.5" fill="currentColor" />
                </div>
                <span className="text-white text-sm font-ui drop-shadow-lg">Play Video</span>
              </div>
            </button>
          )}
          {photos.map((url, idx) => (
            <button
              key={idx}
              onClick={() => setLightboxIdx(idx)}
              className="shrink-0 cursor-pointer overflow-hidden rounded-[var(--radius)] focus:outline-none focus:ring-2 focus:ring-primary/40"
              style={{ scrollSnapAlign: "start" }}
              data-testid={`gallery-photo-${idx}`}
            >
              <img
                src={url}
                alt={`Photo ${idx + 1}`}
                className="h-[280px] w-auto min-w-[180px] max-w-[260px] object-cover hover:scale-105 transition-transform duration-300"
                loading={idx < 5 ? "eager" : "lazy"}
                onError={() => setErrored((e) => ({ ...e, [url]: true }))}
              />
            </button>
          ))}
        </div>
      </div>

      {showVideo && videoUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setShowVideo(false)}
          data-testid="video-overlay"
        >
          <button
            onClick={(e) => { e.stopPropagation(); setShowVideo(false); }}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors z-10"
            data-testid="video-close"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="w-[90vw] max-w-[900px] aspect-video" onClick={(e) => e.stopPropagation()}>
            {isEmbedVideo(videoUrl) ? (
              <iframe
                src={getEmbedUrl(videoUrl)}
                className="w-full h-full rounded-[var(--radius)] shadow-2xl"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                data-testid="video-player-iframe"
              />
            ) : isIframeVideo(videoUrl) ? (
              <iframe
                src={videoUrl}
                className="w-full h-full rounded-[var(--radius)] shadow-2xl"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                data-testid="video-player-iframe"
              />
            ) : (
              <video
                src={isDirectVideo(videoUrl) ? videoUrl : `/api/uploads/proxy?url=${encodeURIComponent(videoUrl)}`}
                controls
                autoPlay
                className="w-full h-full rounded-[var(--radius)] shadow-2xl bg-black"
                data-testid="video-player"
              />
            )}
          </div>
        </div>
      )}

      {lightboxIdx !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxIdx(null)}
          data-testid="lightbox-overlay"
        >
          <button
            onClick={(e) => { e.stopPropagation(); setLightboxIdx(null); }}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors z-10"
            data-testid="lightbox-close"
          >
            <X className="w-5 h-5" />
          </button>
          {lightboxIdx > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIdx(lightboxIdx - 1); }}
              className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors z-10"
              data-testid="lightbox-prev"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}
          {lightboxIdx < photos.length - 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIdx(lightboxIdx + 1); }}
              className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-colors z-10"
              data-testid="lightbox-next"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}
          <img
            src={photos[lightboxIdx]}
            alt={`Photo ${lightboxIdx + 1}`}
            className="max-h-[85vh] max-w-[90vw] object-contain rounded-[var(--radius)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            data-testid="lightbox-image"
          />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-sm" data-testid="lightbox-counter">
            {lightboxIdx + 1} / {photos.length}
          </div>
        </div>
      )}
    </>
  );
}

const HIDDEN_PROFILE_KEYS = new Set([
  "photoUrl", "profileUrl", "externalId", "status", "Video URL", "Photos", "All Photos",
  "_sections", "_tables", "profileData", "Letter to Intended Parents", "Letter Title",
  "Original PDF", "Source", "Source File", "Agency ID", "Agency I D", "Surrogate ID",
  "Surrogate I D", "Donor ID", "Donor I D",
  // Photo/video metadata - should render as gallery, not as text fields
  "photoCount", "photo count", "hasVideo", "has video", "additionalPhotos",
  // lowercase "photos" key stored by some scrapers - same data as the DB photos[] column
  "photos",
  // Internal sync/dedupe fingerprints - never user-facing
  "cardHash", "Card Hash", "card_hash", "cardhash",
  // Internal IDs and audit timestamps that occasionally leak from scraped payloads
  "id", "providerId", "parentAccountId", "createdAt", "updatedAt", "deletedAt",
  "lastSyncedAt", "lastScrapedAt", "lastViewedAt", "isDeleted",
  // Donation Types is surfaced in the Summary card (right column, above "Available for")
  // for sperm donors; hide here so it doesn't duplicate in Additional Details.
  "donationTypes", "Donation Types", "Donation Type", "Type of Donation",
]);

const AGENCY_COMMENT_PATTERN = /^(agency\s*(comment|recommendation|note)s?|recommendation\s*points?)$/i;

/**
 * Collapses whitespace and case so two copies of the same prose compare equal.
 * Scraped profiles often carry the same letter in both a structured field and a
 * plain one, differing only in CRLF/paragraph breaks.
 */
function normalizeProse(text: string): string {
  return String(text).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Answers that decline the question rather than answer it. A field holding one
 * of these tells a reader nothing on its own.
 */
const NON_ANSWER_PATTERN =
  /^(no|nope|none|n\/?a|nothing|not at (the|this) (moment|time)|not applicable|-{1,2}|—)[.!]?$/i;

/** True when an answer actually carries information. */
function isSubstantiveAnswer(value: any): boolean {
  if (typeof value !== "string") return value != null && value !== "";
  const trimmed = value.trim();
  return trimmed !== "" && !NON_ANSWER_PATTERN.test(trimmed);
}

/**
 * Field labels that appear in more than one section, with where each lives.
 * Providers reuse a label for two different questions more often than you would
 * expect, so the profile has to reconcile them at render time.
 */
function collectDuplicateLabels(
  sections: Record<string, any>,
): Map<string, { section: string; value: any }[]> {
  const byLabel = new Map<string, { section: string; value: any }[]>();
  for (const [sectionName, sectionData] of Object.entries(sections)) {
    if (typeof sectionData !== "object" || sectionData === null || Array.isArray(sectionData)) continue;
    for (const [label, value] of Object.entries(sectionData)) {
      if (label.startsWith("_")) continue;
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push({ section: sectionName, value });
    }
  }
  for (const [label, hits] of byLabel) {
    if (hits.length < 2) byLabel.delete(label);
  }
  return byLabel;
}

/**
 * Sections that are a person talking, not a data table. Every entry in these
 * renders as a PromptBlock (small accent eyebrow + large prose answer) no
 * matter how short the answer is - the question is scaffolding, the answer is
 * her voice. Everything else renders as a Field pair, where the value is the
 * thing being scanned for.
 */
const PERSONALITY_SECTION_PATTERN =
  /(things\s*about\s*me|about\s*me|letter|personal|interests|hobbies|favorites?|my\s*story|why\s*i|motivation|self\s*description|in\s*her\s*own\s*words|message\s*to)/i;

const IMAGE_KEYS = new Set([
  "All Photos", "Genetic Report Images",
]);

const PHOTO_GALLERY_KEYS = new Set([
  "All Photos", "Photos",
]);

const LONG_TEXT_KEYS = new Set([
  "Donor Overview",
]);

function isImageArray(key: string, value: any): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return IMAGE_KEYS.has(key) ||
    value.every((v: any) => typeof v === "string" && /\.(jpg|jpeg|png|gif|webp|heic|svg)/i.test(v));
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    AVAILABLE: "bg-[hsl(var(--brand-success)/0.12)] text-[hsl(var(--brand-success))] border-[hsl(var(--brand-success)/0.3)]",
    PENDING: "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)]",
    MATCHED: "bg-accent/15 text-accent-foreground border-accent/30",
    UNAVAILABLE: "bg-destructive/15 text-destructive border-destructive/30",
    SOLD_OUT: "bg-destructive/15 text-destructive border-destructive/30",
    INACTIVE: "bg-muted text-foreground border-border",
  };
  return (
    <Badge variant="outline" className={`text-xs ${styles[status] || "bg-muted text-muted-foreground"}`} data-testid={`badge-status-${status}`}>
      {status?.replace(/_/g, " ") || "Unknown"}
    </Badge>
  );
}

const TYPE_ENDPOINTS: Record<string, string> = {
  "egg-donor": "egg-donors",
  surrogate: "surrogates",
  "sperm-donor": "sperm-donors",
};

function getMandatoryFields(donor: any, type: string): { label: string; value: string }[] {
  const V = (val: any) => (val != null && val !== "") ? String(val) : "-";
  const profileData = donor.profileData || {};

  // Recover the city the scraper dropped (kept in profileData) and normalize to
  // the consistent "City, ST" form - same logic the marketplace card uses, so the
  // detail page no longer shows just the bare state.
  const richLoc = profileData?.["Location"] ?? profileData?.["Current City"] ?? null;
  const locDisplay = (raw: any) =>
    formatLocationDisplay(cleanCityState(typeof richLoc === "string" ? richLoc : null, raw ?? null)) || V(raw);

  const fmtUSD = (val: number | null | undefined) => val != null ? formatMoneyDollars(Number(val)) : "-";
  const fmtTotalCost = (tc: { min: number; max: number } | null | undefined) => {
    if (!tc) return "-";
    if (tc.min === tc.max || tc.max === 0) return fmtUSD(tc.min);
    return `${fmtUSD(tc.min)} – ${fmtUSD(tc.max)}`;
  };

  if (type === "egg-donor") {
    const r = resolveEggDonorFields(donor);
    return [
      { label: "Age", value: V(r.age) },
      { label: "Education Level", value: V(r.education) },
      { label: "Eye Color", value: V(r.eyeColor) },
      { label: "Location", value: locDisplay(r.location) },
      { label: "Hair Color", value: V(r.hairColor) },
      { label: "Donation Types", value: V(r.donationTypes) },
      { label: "Race", value: V(r.race) },
      { label: "Relationship Status", value: V(r.relationshipStatus) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Occupation", value: V(r.occupation) },
      { label: "Religion", value: V(r.religion) },
      { label: "Egg Donor Compensation", value: fmtUSD(r.resolvedCompensation ?? r.donorCompensation) },
      { label: "Height", value: V(r.height) },
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCost(r.calculatedTotalCost) : (r.totalCost ? fmtUSD(r.totalCost) : "-") },
      { label: "Weight", value: V(r.weight) },
      { label: "Blood Type", value: V(r.bloodType) },
    ];
  } else if (type === "surrogate") {
    const B = (val: boolean | null) => val === true ? "Yes" : val === false ? "No" : "-";
    const r = resolveSurrogateFields(donor);
    return [
      { label: "Age", value: V(r.age) },
      { label: "Location", value: locDisplay(r.location) },
      { label: "BMI", value: V(r.bmi) },
      { label: "Race", value: V(r.race) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Religion", value: V(r.religion) },
      { label: "Education", value: V(r.education) },
      { label: "Occupation", value: V(r.occupation) },
      { label: "Relationship Status", value: V(r.relationshipStatus) },
      { label: "COVID Vaccinated", value: B(r.covidVaccinated) },
      { label: "Live Births", value: r.liveBirths != null ? String(r.liveBirths) : "-" },
      { label: "C-Sections", value: r.cSections != null ? String(r.cSections) : "-" },
      { label: "Miscarriages", value: r.miscarriages != null ? String(r.miscarriages) : "-" },
      { label: "Abortions", value: "0" },
      { label: "Agrees to Abortion", value: B(r.agreesToAbortion) },
      { label: "Last Delivery Year", value: V(r.lastDeliveryYear) },
      { label: "Twins", value: B(r.agreesToTwins) },
      { label: "Selective Reduction", value: B(r.agreesToSelectiveReduction) },
      { label: "Same Sex Couple", value: B(r.openToSameSexCouple) },
      { label: "International Parents", value: B(r.agreesToInternationalParents) },
      { label: "Base Compensation", value: fmtUSD(r.resolvedCompensation ?? r.baseCompensation) },
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCost(r.calculatedTotalCost) : (r.totalCostMin ? `${fmtUSD(r.totalCostMin)}${r.totalCostMax && r.totalCostMax !== r.totalCostMin ? ` – ${fmtUSD(r.totalCostMax)}` : ""}` : "-") },
    ];
  } else {
    const r = resolveSpermDonorFields(donor);
    const vialCostItems = (() => {
      if (r.vialCosts && r.vialCosts.length > 0) {
        return r.vialCosts.map((vc: { label: string; cost: number }) => ({ label: vc.label, value: fmtUSD(vc.cost) }));
      } else if (r.totalCost) {
        return [{ label: "Vial Cost", value: fmtUSD(r.totalCost) }];
      }
      return [];
    })();
    // Left-column items first (1..ceil(N/2)), then right-column items (rest).
    // Cost fields go at the very end so they land in the bottom of the right column.
    // The renderer interleaves [left..., right...] into the 2-col grid.
    return [
      // Left column (top to bottom)
      // Guard junk ages from a bad scrape (e.g. a stored -1976) - show "-" instead.
      { label: "Age", value: (Number.isFinite(Number(r.age)) && Number(r.age) >= 18 && Number(r.age) <= 99) ? V(r.age) : "-" },
      { label: "Type", value: V(r.donorType) },
      { label: "Race", value: V(r.race) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Hair Color", value: V(r.hairColor) },
      { label: "Eye Color", value: V(r.eyeColor) },
      { label: "Religion", value: V(r.religion) },
      { label: "Education", value: V(r.education) },
      { label: "Occupation", value: V(r.occupation) },
      // Right column (top to bottom) - costs at very end
      { label: "Location", value: locDisplay(r.location) },
      { label: "Height", value: V(r.height) },
      { label: "Weight", value: V(r.weight) },
      { label: "Donation Types", value: V(r.donationTypes) },
      ...(vialCostItems.length > 0
        ? [{ label: "Available for", value: r.vialTypes.length > 0 ? r.vialTypes.join(", ") : "-" }, ...vialCostItems]
        : [{ label: "Available for", value: r.vialTypes.length > 0 ? r.vialTypes.join(", ") : "-" }]),
    ];
  }
}

function MobilePhotoViewer({ photos: rawPhotos, videoUrl, showFallback = false }: { photos: string[]; videoUrl?: string | null; showFallback?: boolean }) {
  // Drop any photo whose URL 404s so a dead link never renders as a broken image.
  const [errored, setErrored] = useState<Record<string, boolean>>({});
  const photos = rawPhotos.filter((p) => !errored[p]);
  const slides = useMemo(() => {
    const out: { kind: "photo" | "video"; url: string }[] = [];
    if (videoUrl) out.push({ kind: "video", url: videoUrl });
    photos.forEach((p) => out.push({ kind: "photo", url: p }));
    return out;
  }, [photos, videoUrl]);
  const total = slides.length;
  const [idx, setIdx] = useState(0);
  const [showVideo, setShowVideo] = useState(false);
  const [lightbox, setLightbox] = useState(false);

  const goLeft = useCallback(() => setIdx((p) => (p <= 0 ? total - 1 : p - 1)), [total]);
  const goRight = useCallback(() => setIdx((p) => (p >= total - 1 ? 0 : p + 1)), [total]);

  if (total === 0) {
    if (!showFallback) return null;
    // Anonymous / photo-less donor: full-bleed branded silhouette hero.
    return (
      <div
        className="relative bg-muted overflow-hidden"
        style={{
          width: "100vw",
          marginLeft: "calc(50% - 50vw)",
          marginRight: "calc(50% - 50vw)",
          marginTop: "4px",
          height: "min(60vh, 480px)",
        }}
        data-testid="mobile-photo-fallback"
      >
        <DonorPhotoFallback />
      </div>
    );
  }
  // Clamp if the active slide was dropped after an image error.
  const safeIdx = Math.min(idx, total - 1);
  if (safeIdx !== idx) setIdx(safeIdx);
  const current = slides[safeIdx];

  return (
    <>
      <div
        className="relative bg-muted overflow-hidden"
        style={{
          width: "100vw",
          marginLeft: "calc(50% - 50vw)",
          marginRight: "calc(50% - 50vw)",
          marginTop: "4px",
          height: "min(75vh, 640px)",
        }}
        data-testid="mobile-photo-viewer"
      >
        {current.kind === "photo" ? (
          <img
            src={current.url}
            alt={`Photo ${safeIdx + 1}`}
            className="w-full h-full object-cover"
            loading="eager"
            decoding="async"
            draggable={false}
            onError={() => setErrored((e) => ({ ...e, [current.url]: true }))}
            data-testid={`mobile-photo-${safeIdx}`}
          />
        ) : (
          <>
            {photos[0] ? (
              <img src={photos[0]} alt="Video thumbnail" className="w-full h-full object-cover brightness-75" onError={() => setErrored((e) => ({ ...e, [photos[0]]: true }))} />
            ) : (
              <div className="w-full h-full bg-foreground/90" />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
              <div className="w-16 h-16 rounded-full bg-white/90 flex items-center justify-center shadow-lg">
                <Play className="w-8 h-8 text-primary ml-0.5" fill="currentColor" />
              </div>
              <span className="text-white text-sm font-ui drop-shadow-lg">Play Video</span>
            </div>
          </>
        )}

        <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/50 via-black/20 to-transparent h-20 z-[15] pointer-events-none" />

        <div className="absolute top-0 left-0 right-0 flex gap-1 px-3 pt-3 z-20 pointer-events-none" data-testid="mobile-photo-progress">
          {Array.from({ length: total }).map((_, i) => (
            <div
              key={i}
              className={`h-[3px] flex-1 rounded-full transition-all duration-200 ${i === idx ? "bg-white" : "bg-white/40"}`}
            />
          ))}
        </div>

        <div
          className="absolute top-0 left-0 w-1/2 h-full z-30"
          onClick={() => { if (current.kind === "photo") goLeft(); else goLeft(); }}
          data-testid="mobile-photo-tap-left"
        />
        <div
          className="absolute top-0 right-0 w-1/2 h-full z-30"
          onClick={() => {
            if (current.kind === "video") setShowVideo(true);
            else goRight();
          }}
          data-testid="mobile-photo-tap-right"
        />
        {current.kind === "photo" && (
          <button
            onClick={(e) => { e.stopPropagation(); setLightbox(true); }}
            className="absolute bottom-3 right-3 z-40 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white"
            aria-label="Expand photo"
            data-testid="mobile-photo-expand"
          >
            <ChevronRight className="w-4 h-4 rotate-45" />
          </button>
        )}
        {current.kind === "video" && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowVideo(true); }}
            className="absolute inset-0 z-40 pointer-events-none"
            aria-hidden
            data-testid="mobile-video-trigger"
          />
        )}
      </div>

      {showVideo && videoUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setShowVideo(false)}
          data-testid="mobile-video-overlay"
        >
          <button
            onClick={(e) => { e.stopPropagation(); setShowVideo(false); }}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white z-10"
            data-testid="mobile-video-close"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="w-[92vw] max-w-[900px] aspect-video" onClick={(e) => e.stopPropagation()}>
            {isEmbedVideo(videoUrl) ? (
              <iframe src={getEmbedUrl(videoUrl)} className="w-full h-full rounded-[var(--radius)] shadow-2xl" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
            ) : isIframeVideo(videoUrl) ? (
              <iframe src={videoUrl} className="w-full h-full rounded-[var(--radius)] shadow-2xl" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
            ) : (
              <video src={isDirectVideo(videoUrl) ? videoUrl : `/api/uploads/proxy?url=${encodeURIComponent(videoUrl)}`} controls autoPlay className="w-full h-full rounded-[var(--radius)] shadow-2xl bg-black" />
            )}
          </div>
        </div>
      )}

      {lightbox && current.kind === "photo" && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setLightbox(false)}
          data-testid="mobile-lightbox"
        >
          <button
            onClick={(e) => { e.stopPropagation(); setLightbox(false); }}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white z-10"
            data-testid="mobile-lightbox-close"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={current.url}
            alt={`Photo ${idx + 1}`}
            className="max-h-[90vh] max-w-[95vw] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

interface ProfileCardProps {
  providerId?: string;
  donorId?: string;
  type?: string;
  /** Hero photo passed from the deck so the card renders instantly, before the
   *  donor query resolves - this is what kills the spinner between profiles. */
  initialPhotoUrl?: string;
  /** Back button handler, owned by the wrapper so it knows the deck context. */
  onBack?: () => void;
}

/**
 * One donor profile surface. Identity comes from props (not useParams) so the
 * wrapper can mount two at once (a Tinder-style stack) and prefetch the next.
 * The mobile action bar lives in the wrapper (DonorProfilePage) so it stays put
 * while this card is thrown off-screen.
 */
function ProfileCard({ providerId, donorId, type, initialPhotoUrl, onBack }: ProfileCardProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const isMobile = useIsMobile();

  const chatState = location.state as { fromChat?: boolean; matchReasons?: string[]; chatPath?: string } | null;
  const fromChat = chatState?.fromChat === true;
  const matchReasons = chatState?.matchReasons || [];
  const chatPath = chatState?.chatPath || "/concierge";

  const handleBack = useCallback(() => {
    if (onBack) { onBack(); return; }
    if (fromChat) {
      navigate(chatPath);
    } else {
      const isAdmin = window.location.pathname.startsWith("/admin/");
      if (!isAdmin) {
        if (hasInAppHistory()) navigate(-1);
        else navigate("/marketplace", { replace: true });
      } else {
        navigate(`/admin/providers/${providerId}?tab=${TYPE_ENDPOINTS[type || "egg-donor"]}`);
      }
    }
  }, [onBack, fromChat, chatPath, navigate, providerId, type]);

  const endpoint = TYPE_ENDPOINTS[type || ""] || "egg-donors";

  const { data: donor, isLoading } = useQuery<any>({
    queryKey: [`/api/providers/${providerId}/${endpoint}`, donorId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}/${endpoint}/${donorId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Donor not found");
      return res.json();
    },
    enabled: !!providerId && !!donorId && !!type,
  });

  const { data: provider } = useQuery<any>({
    queryKey: ["/api/providers", providerId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!providerId,
  });

  const allPhotos = useMemo(() => {
    if (!donor) return [];
    const urls: string[] = [];
    const DYNAMIC_PHOTO_PATHS = /DonorPhoto|donorphoto|Photo\/Get|photo\/get|PhotoHandler|photohandler|DonorImage|donorimage|\/Photo\?|\/Image\?/i;
    const isValidPhoto = (url: string) => {
      if (!url || typeof url !== "string") return false;
      if (/\.(jpg|jpeg|png|gif|webp|heic|svg|bmp|tiff?|avif)/i.test(url)) return true;
      try {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith(".blob") && /s3[.\-].*amazonaws\.com/i.test(parsed.hostname)) return true;
        if (/storage\.googleapis\.com/i.test(parsed.hostname)) return true;
        if (DYNAMIC_PHOTO_PATHS.test(parsed.pathname + parsed.search)) return true;
      } catch {
        if (DYNAMIC_PHOTO_PATHS.test(url)) return true;
      }
      return false;
    };
    const addPhoto = (url: string) => {
      const proxied = getPhotoSrc(url);
      if (proxied && !urls.includes(proxied) && isValidPhoto(url)) urls.push(proxied);
    };
    if (donor.photoUrl) addPhoto(donor.photoUrl);
    if (Array.isArray(donor.photos)) {
      donor.photos.forEach((url: string) => addPhoto(url));
    }
    const rawPd = donor.profileData || {};
    const nestedPdPhotos = rawPd["profileData"] as Record<string, any> | undefined;
    const pd = nestedPdPhotos && typeof nestedPdPhotos === "object" && nestedPdPhotos["_sections"]
      ? { ...rawPd, ...nestedPdPhotos, profileData: undefined }
      : rawPd;
    Object.entries(pd)
      .filter(([key]) => PHOTO_GALLERY_KEYS.has(key))
      .forEach(([, value]) => {
        if (Array.isArray(value)) {
          value.forEach((url: string) => addPhoto(url));
        } else if (typeof value === "string" && value.length > 0) {
          addPhoto(value);
        }
      });
    const sections = pd["_sections"] as Record<string, any> | undefined;
    if (sections?.["Photos"]) {
      const sPhotos = sections["Photos"];
      if (Array.isArray(sPhotos)) sPhotos.forEach((url: string) => addPhoto(url));
      else if (typeof sPhotos === "string") addPhoto(sPhotos);
    }
    return urls;
  }, [donor]);

  const donorVideoUrl = useMemo(() => {
    if (!donor) return null;
    if (donor.videoUrl) return donor.videoUrl;
    const pd = donor.profileData || {};
    if (pd["Video URL"]) return pd["Video URL"] as string;
    return null;
  }, [donor]);

  // Spinner only on a genuine COLD load (no preloaded hero). When the deck hands
  // us initialPhotoUrl, we render the hero instantly and let the body fill in
  // once the (usually already-prefetched) query resolves - no spinner, no blank
  // gap between profiles.
  if (isLoading && !initialPhotoUrl) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!donor) {
    // Have a hero photo from the deck but the donor body hasn't arrived yet:
    // show the photo full-bleed (no spinner) so a thrown-to card reveals cleanly.
    if (initialPhotoUrl) {
      return (
        <div className="space-y-6 w-full pb-32 md:pb-0" data-testid="profile-card-hero-pending">
          {isMobile
            ? <MobilePhotoViewer photos={[initialPhotoUrl]} />
            : <PhotoGalleryBar photos={[initialPhotoUrl]} />}
        </div>
      );
    }
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => {
          if (fromChat) {
            navigate(chatPath);
          } else {
            const isAdmin = window.location.pathname.startsWith("/admin/");
            if (!isAdmin) {
              navigate(-1);
            } else {
              navigate(`/admin/providers/${providerId}?tab=${TYPE_ENDPOINTS[type || "egg-donor"]}`);
            }
          }
        }} data-testid="link-back-provider">
          <ArrowLeft className="w-4 h-4 mr-2" /> {fromChat ? "Back to Chat" : !window.location.pathname.startsWith("/admin/") ? "Back to Marketplace" : `Back to ${provider?.name || "Provider"}`}
        </Button>
        <p className="text-muted-foreground text-center py-8" data-testid="text-not-found">Donor profile not found.</p>
      </div>
    );
  }

  const typeLabel = type === "egg-donor" ? "Egg Donor" : type === "surrogate" ? "Surrogate" : "Sperm Donor";
  const rawId = donor.externalId || donor.id.slice(0, 8);
  const displayId = rawId.startsWith("pdf-") ? rawId.replace(/^pdf-/, "") : rawId;
  const mandatoryFields = getMandatoryFields(donor, type || "egg-donor");

  const rawProfileData = donor.profileData || {};
  const nestedPd = rawProfileData["profileData"] as Record<string, any> | undefined;
  const profileData = nestedPd && typeof nestedPd === "object" && nestedPd["_sections"]
    ? { ...rawProfileData, ...nestedPd, profileData: undefined }
    : rawProfileData;
  const allEntries = Object.entries(profileData).filter(([key]) => !HIDDEN_PROFILE_KEYS.has(key) && key !== "Profile Details" && key !== "profileData");
  const profileDetails = (profileData["Profile Details"] || profileData["_sections"]) as Record<string, Record<string, any>> | undefined;

  const sectionFieldKeys = new Set<string>();
  if (profileDetails) {
    Object.values(profileDetails).forEach((sectionData: any) => {
      if (typeof sectionData === "object" && sectionData !== null && !Array.isArray(sectionData)) {
        Object.keys(sectionData).forEach((k) => sectionFieldKeys.add(k));
      }
    });
  }

  const longTextEntries = allEntries.filter(([key, value]) =>
    (LONG_TEXT_KEYS.has(key) || (typeof value === "string" && value.length > 120)) && !sectionFieldKeys.has(key)
  );
  const imageEntries = allEntries.filter(([key, value]) => isImageArray(key, value));
  const documentImageEntries = imageEntries.filter(([key]) => !PHOTO_GALLERY_KEYS.has(key));

  const fieldEntries = allEntries.filter(
    ([key, value]) =>
      !LONG_TEXT_KEYS.has(key) &&
      !(typeof value === "string" && value.length > 120) &&
      !isImageArray(key, value) &&
      value !== null &&
      value !== undefined &&
      value !== "" &&
      typeof value !== "object" &&
      !sectionFieldKeys.has(key),
  );

  const headerMeta: string[] = [];
  if (donor.status) headerMeta.push(donor.status);
  if (donor.location) {
    const richLoc = profileData?.["Location"] ?? profileData?.["Current City"] ?? null;
    headerMeta.push(formatLocationDisplay(cleanCityState(typeof richLoc === "string" ? richLoc : null, donor.location)) || formatLocationDisplay(donor.location)!);
  }
  if (type === "sperm-donor") {
    // Show all matching vial cost programs from the cost sheet
    const vialCosts: { label: string; cost: number }[] = Array.isArray(donor.vialCosts) ? donor.vialCosts : [];
    if (vialCosts.length > 0) {
      vialCosts.forEach(vc => headerMeta.push(`${vc.label}: ${formatMoneyDollars(Number(vc.cost))}`));
    } else if (donor.totalCost) {
      headerMeta.push(`Vial Cost: ${formatMoneyDollars(Number(donor.totalCost))}`);
    }
  } else if (donor.calculatedTotalCost) {
    const tc = donor.calculatedTotalCost;
    if (tc.min === tc.max || tc.max === 0) {
      headerMeta.push(`Total Cost: ${formatMoneyDollars(Number(tc.min))}`);
    } else {
      headerMeta.push(`Total Cost: ${formatMoneyDollars(Number(tc.min))} – ${formatMoneyDollars(Number(tc.max))}`);
    }
  } else if (donor.totalCost) {
    headerMeta.push(`Total Cost: ${formatMoneyDollars(Number(donor.totalCost))}`);
  }
  if (donor.donationTypes) headerMeta.push(`Types of Donation: ${donor.donationTypes}`);

  return (
    <div className="space-y-6 w-full pb-32 md:pb-0">
      {isMobile && (
        <>
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, delay: 0.08, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="sticky top-0 z-40 bg-background border-b border-border/40 flex items-center justify-between gap-3 py-3"
            style={{
              marginLeft: "calc(50% - 50vw)",
              marginRight: "calc(50% - 50vw)",
              paddingLeft: "calc(50vw - 50% + 1rem)",
              // Reserve the lane the floating close button (rendered by the page
              // wrapper, outside this animated card) occupies.
              paddingRight: "calc(50vw - 50% + 3.75rem)",
            }}
            data-testid="mobile-detail-header"
          >
            <div className="flex-1 min-w-0">
              <h1 className="font-display text-2xl font-heading text-foreground leading-tight" data-testid="text-donor-title-mobile">
                {typeLabel} #{displayId}
              </h1>
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <StatusBadge status={donor.status} />
                {donor.donorType && (
                  <Badge variant="outline" className="text-xs" data-testid="badge-donor-type-mobile">{donor.donorType}</Badge>
                )}
                {donor.isExperienced && (
                  <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)]" data-testid="badge-experienced-mobile">
                    Experienced
                  </Badge>
                )}
                {type === "sperm-donor" && Array.isArray(donor.vialTypes) && donor.vialTypes.length > 0 && (
                  <Badge variant="outline" className="text-xs" data-testid="badge-vial-types-mobile">Available for: {donor.vialTypes.join(", ")}</Badge>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
      <div className={`flex items-center justify-between ${isMobile ? "hidden" : ""}`}>
        <Button variant="ghost" onClick={handleBack} data-testid="link-back-provider">
          <ArrowLeft className="w-4 h-4 mr-2" /> {fromChat ? "Back to Chat" : !window.location.pathname.startsWith("/admin/") ? "Back to Marketplace" : `Back to ${provider?.name || "Provider"}`}
        </Button>
        {user && !user.roles?.includes("PARENT") && (
          <Button
            onClick={() => navigate(`/admin/providers/${providerId}/${typeToUrlSlug(type || "egg-donor")}/${donorId}/edit`)}
            data-testid="button-edit-donor"
          >
            <Pencil className="w-4 h-4 mr-2" /> Edit Profile
          </Button>
        )}
      </div>

      {isMobile
        ? (
          <motion.div
            layoutId={`card-hero-${donorId}`}
            transition={{ duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] }}
          >
            <MobilePhotoViewer photos={allPhotos} videoUrl={donorVideoUrl} showFallback />
          </motion.div>
        )
        : <PhotoGalleryBar photos={allPhotos} videoUrl={donorVideoUrl} showFallback />}

      <div className={isMobile ? "hidden" : ""}>
        <h1 className="font-display text-2xl font-heading text-foreground" data-testid="text-donor-title">
          {typeLabel} #{displayId}
        </h1>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          <StatusBadge status={donor.status} />
          {donor.isExperienced && (
            <Badge variant="outline" className="text-xs bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)]" data-testid="badge-experienced">
              Experienced
            </Badge>
          )}
          {donor.donorType && (
            <Badge variant="outline" className="text-xs">{donor.donorType}</Badge>
          )}
          {type === "sperm-donor" && Array.isArray(donor.vialTypes) && donor.vialTypes.length > 0 && (
            <Badge variant="outline" className="text-xs">Available for: {donor.vialTypes.join(", ")}</Badge>
          )}
        </div>
        {donor.profileUrl && user && (
          hasAnyRole(user.roles || [], [...GOSTORK_ROLES]) ||
          (hasProviderRole(user.roles || []) && user.providerId === providerId)
        ) && (
          <a
            href={donor.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline flex items-center gap-1 mt-1"
            data-testid="link-donor-profile-external"
          >
            <ExternalLink className="h-3.5 w-3.5" /> {donor.externalId?.startsWith("pdf-") ? "View PDF" : "View on Provider Site"}
          </a>
        )}
      </div>

      {fromChat && matchReasons.length > 0 && (
        <Card className="overflow-hidden border-primary/20 bg-primary/5" data-testid="section-match-reasons">
          <div className="p-4 space-y-2">
            <p className="t-micro-label">Why This Match</p>
            {matchReasons.map((reason, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <Check className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                <span>{reason}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <ProfileSection title="Summary" data-testid="section-summary">
          <div className="grid grid-cols-2 gap-x-12 gap-y-3">
            {(() => {
              // For sperm donors, fields are ordered [left-col items..., right-col items...].
              // Interleave them so the CSS grid places each pair side-by-side.
              if (type === "sperm-donor") {
                const half = Math.ceil(mandatoryFields.length / 2);
                const left = mandatoryFields.slice(0, half);
                const right = mandatoryFields.slice(half);
                return left.flatMap((item, i) => right[i] !== undefined ? [item, right[i]] : [item]);
              }
              return mandatoryFields;
            })().map(({ label, value }) => (
              <Field
                key={label}
                label={label}
                value={value}
                data-testid={`field-${label.toLowerCase().replace(/\s+/g, "-")}`}
              />
            ))}
          </div>
      </ProfileSection>

      {/* Parent-facing cost programs for this profile's parent agency / bank.
          Reuses the same component used on the provider profile page so the
          card layout, matching logic, and "Finish your profile" / "Request a
          custom quote" fallbacks behave identically across IVF clinics,
          surrogacy agencies, egg donor agencies / banks, and sperm banks. The
          providerId here is the agency / bank that owns the donor or surrogate.
          hasIvfClinicService is the "enable" flag - we pass true because we
          only land on this page through a fertility provider in the first
          place; the server's matcher decides which (if any) programs apply. */}
      {providerId && (user as any)?.parentAccountId && (
        // Always pass the donor type. Two server-side effects:
        //   1. The matcher treats "viewing this profile" as an implicit need
        //      ("sperm_donor" / "egg_donor" / "surrogacy") and adds it to the
        //      parent's needs, even if the IP profile doesn't yet declare it.
        //      Without this, a parent who hasn't completed their profile would
        //      see "no matching programs" on a sperm donor profile while the
        //      sperm bank actually has 5 approved sperm-donor programs.
        //   2. For surrogates and FRESH egg donors, the server replaces the
        //      program's generic compensation range with that person's actual
        //      comp (Surrogate.baseCompensation / EggDonor.donorCompensation).
        //      Frozen egg donors / sperm donors are flat-product pricing, so
        //      the server skips the swap there.
        <ClinicCostProgramsSection
          providerId={providerId}
          parentAccountId={(user as any)?.parentAccountId ?? null}
          hasIvfClinicService={true}
          specificDonorId={donorId}
          specificDonorType={type}
        />
      )}

      {profileDetails && Object.keys(profileDetails).length > 0 && (() => {
        const pd = profileDetails as Record<string, any>;
        const merged = new Map<string, { fields: [string, any][]; tables: [string, any[]][] }>();
        const consumed = new Set<string>();

        const rawSectionNames = Object.keys(pd).filter((n) => n !== "Photos" && n !== "All Photos");
        const prioritySections = ["Pregnancy History", "Support System", "Donation History"];
        const filteredNames = rawSectionNames.filter((n) => {
          if (n.endsWith(":")) {
            const withoutColon = n.slice(0, -1);
            if (rawSectionNames.includes(withoutColon)) return false;
          }
          return true;
        });

        const isSurrogate = /surrogate/i.test(donor?.externalId || "") || /surrogate/i.test(location.pathname);
        if (isSurrogate && !filteredNames.includes("Support System")) {
          const supportPattern = /support|supportive|childcare|child\s*care|bedrest|bed\s*rest|who\s*will\s*help|caretaker|care\s*taker/i;
          const supportFields: Record<string, any> = {};
          for (const secName of filteredNames) {
            const secData = pd[secName];
            if (typeof secData !== "object" || secData === null || Array.isArray(secData)) continue;
            const kvEntries = Object.entries(secData);
            for (const [k, v] of kvEntries) {
              if (supportPattern.test(k) && typeof v === "string") {
                supportFields[k] = v;
              }
            }
          }
          if (Object.keys(supportFields).length > 0) {
            pd["Support System"] = supportFields;
            filteredNames.push("Support System");
            for (const secName of filteredNames) {
              if (secName === "Support System") continue;
              const secData = pd[secName];
              if (typeof secData !== "object" || secData === null || Array.isArray(secData)) continue;
              for (const k of Object.keys(supportFields)) {
                delete (secData as Record<string, any>)[k];
              }
            }
          }
        }

        // A provider's own intake form can label two different questions
        // identically. Genesis has an "Ethnicity" trait in Physical Traits
        // ("Peruvian 50%, English 25%, Irish 25%") AND a separate follow-up
        // question, also labelled "Ethnicity", that most donors answer "No" -
        // both are on their page and both are scraped faithfully. Rendering
        // "Ethnicity: No" beside the real one reads as a data error.
        //
        // Drop the empty twin ONLY when it carries no information AND the same
        // label has substance elsewhere on the profile. A follow-up with a real
        // answer ("We are 100% Venezuelan") is kept - that is content a parent
        // wants, whatever the agency chose to call the field.
        for (const [label, hits] of collectDuplicateLabels(pd)) {
          if (!hits.some((h: { value: any }) => isSubstantiveAnswer(h.value))) continue;
          for (const hit of hits) {
            if (isSubstantiveAnswer(hit.value)) continue;
            delete (pd[hit.section] as Record<string, any>)[label];
          }
        }

        const letterPattern = /^(letter\s*(to\s*intended\s*parents?)?|about\s*myself|her\s*story|personal\s*statement|message\s*to\s*(intended\s*)?parents?)$/i;
        const letterParts: string[] = [];
        let letterTitle: string | null = null;
        for (const secName of filteredNames) {
          if (!letterPattern.test(secName)) continue;
          const secData = pd[secName];
          if (typeof secData === "string" && secData.trim()) {
            letterParts.push(secData.trim());
            consumed.add(secName);
          } else if (typeof secData === "object" && secData !== null && !Array.isArray(secData)) {
            const secLetterText = secData._letterText ? String(secData._letterText) : null;
            if (secLetterText) {
              letterParts.push(secLetterText);
              if (secData._letterTitle) letterTitle = String(secData._letterTitle);
            }
            // Scrapers routinely store the letter TWICE in one section: once as
            // _letterText/_letterTitle, and once as an ordinary field keyed by
            // the letter's own title ("Why I'm an Egg Donor": "<same text>").
            // Stripping only the underscore keys left that copy behind, the
            // section survived, and the letter rendered a second time as its own
            // card. Drop any field whose text is the letter we just harvested.
            const normalizedLetter = secLetterText ? normalizeProse(secLetterText) : null;
            const remaining: Record<string, any> = {};
            let hasRemaining = false;
            for (const [k, v] of Object.entries(secData)) {
              if (k === "_letterText" || k === "_letterTitle") continue;
              if (normalizedLetter && typeof v === "string" && normalizeProse(v) === normalizedLetter) continue;
              remaining[k] = v;
              hasRemaining = true;
            }
            if (!hasRemaining) {
              consumed.add(secName);
            } else {
              pd[secName] = remaining;
            }
          }
        }
        const letterContent = letterParts.join("\n\n") || null;

        const agencyCommentParts: string[] = [];
        if (isSurrogate) {
          for (const secName of filteredNames) {
            if (!AGENCY_COMMENT_PATTERN.test(secName)) continue;
            const secData = pd[secName];
            if (typeof secData === "string" && secData.trim()) {
              agencyCommentParts.push(secData.trim());
              consumed.add(secName);
            } else if (Array.isArray(secData)) {
              const joined = secData.filter((v: any) => typeof v === "string" && v.trim()).join("\n");
              if (joined) agencyCommentParts.push(joined);
              consumed.add(secName);
            }
            // Structured objects (key/value Q&A) are NOT treated as agency-comment
            // prose - flattening them drops every field label. Leave them unconsumed
            // so they render through the normal key/value section path with labels intact.
          }
        }
        const agencyCommentContent = agencyCommentParts.join("\n\n") || null;

        const letterAnchorSection = isSurrogate ? "Support System" : "Donation History";

        const sectionNames = [
          ...prioritySections.filter((s) => filteredNames.includes(s)),
          ...filteredNames.filter((s) => !prioritySections.includes(s)),
        ];

        const anchorIdx = sectionNames.indexOf(letterAnchorSection);
        if (letterContent && anchorIdx >= 0) {
          sectionNames.splice(anchorIdx + 1, 0, "__LETTER__");
        } else if (letterContent) {
          const firstNonPriority = sectionNames.findIndex((s) => !prioritySections.includes(s));
          if (firstNonPriority >= 0) {
            sectionNames.splice(firstNonPriority, 0, "__LETTER__");
          } else {
            sectionNames.push("__LETTER__");
          }
        }

        if (agencyCommentContent) {
          const letterIdx = sectionNames.indexOf("__LETTER__");
          if (letterIdx >= 0) {
            sectionNames.splice(letterIdx + 1, 0, "__AGENCY_COMMENTS__");
          } else {
            const agencyAnchorIdx = sectionNames.indexOf(letterAnchorSection);
            if (agencyAnchorIdx >= 0) {
              sectionNames.splice(agencyAnchorIdx + 1, 0, "__AGENCY_COMMENTS__");
            } else {
              sectionNames.push("__AGENCY_COMMENTS__");
            }
          }
        }

        for (const name of sectionNames) {
          if (name === "__LETTER__" || name === "__AGENCY_COMMENTS__") continue;
          const data = pd[name];
          if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
            const parentName = name.replace(/ Details$/, "");
            if (parentName !== name && pd[parentName] && typeof pd[parentName] === "object" && !Array.isArray(pd[parentName])) {
              if (!merged.has(parentName)) merged.set(parentName, { fields: [], tables: [] });
              merged.get(parentName)!.tables.push([name, data]);
              consumed.add(name);
            }
          }
        }

        return sectionNames.filter((n) => !consumed.has(n)).map((sectionName) => {
          if (sectionName === "__LETTER__" && letterContent) {
            return (
              <ProfileSection key="letter-to-intended-parents" title="Letter to Intended Parents" data-testid="section-letter-to-intended-parents">
                  {letterTitle && <PromptEyebrow>{letterTitle}</PromptEyebrow>}
                  <PromptAnswer>{letterContent}</PromptAnswer>
              </ProfileSection>
            );
          }
          if (sectionName === "__AGENCY_COMMENTS__" && agencyCommentContent) {
            return (
              <ProfileSection key="agency-comments" title="Agency Comments" data-testid="section-agency-comments">
                  <PromptAnswer>{agencyCommentContent}</PromptAnswer>
              </ProfileSection>
            );
          }
          const sectionData = pd[sectionName];
          const extra = merged.get(sectionName);

          if (Array.isArray(sectionData) && sectionData.length > 0 && typeof sectionData[0] === "object") {
            const colSet = new Set<string>();
            sectionData.forEach((row: Record<string, any>) => Object.keys(row).forEach((k) => colSet.add(k)));
            const columns = Array.from(colSet);
            const arrDisplayName = sectionName.endsWith(":") ? sectionName.slice(0, -1) : sectionName;
            const ROW_HEADER_PATTERN_ARR = /^(relation|name|label|role|title|child|member)/i;
            const useMobileCards = columns.length >= 4;
            return (
              <ProfileSection key={sectionName} title={arrDisplayName} data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                  {useMobileCards && (
                    <div className="md:hidden space-y-3" data-testid={`array-mobile-cards-${arrDisplayName}`}>
                      {sectionData.map((row: Record<string, any>, ri: number) => {
                        const headerCol = columns.find((c) => ROW_HEADER_PATTERN_ARR.test(c)) || columns[0];
                        const headerValue = String(row[headerCol] ?? "").trim() || `#${ri + 1}`;
                        const otherCols = columns.filter((c) => c !== headerCol);
                        return (
                          <div key={ri} className="rounded-[var(--radius)] border border-border/60 bg-secondary/30 p-3">
                            <p className="t-field-value font-heading mb-2">{headerValue}</p>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                              {otherCols.map((col) => {
                                const val = String(row[col] ?? "").trim();
                                if (!val || val === "-") return null;
                                return (
                                  <div key={col} className="min-w-0">
                                    <p className="t-micro-label">{col}</p>
                                    <p className="t-micro-value break-words">{val}</p>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className={useMobileCards ? "hidden md:block" : ""}>
                    <table className="w-full text-sm table-fixed">
                      <thead>
                        <tr className="border-b border-border">
                          {columns.map((col) => (
                            <th key={col} className="t-micro-label text-left py-2 pr-3">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sectionData.map((row: Record<string, any>, ri: number) => (
                          <tr key={ri} className="border-b border-border/50 last:border-0">
                            {columns.map((col) => (
                              <td key={col} className="py-2 pr-3 text-foreground break-words">{String(row[col] ?? "")}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
              </ProfileSection>
            );
          }
          if (typeof sectionData === "string" && sectionData.trim()) {
            const displayName = sectionName.endsWith(":") ? sectionName.slice(0, -1) : sectionName;
            return (
              <ProfileSection key={sectionName} title={displayName} data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                  <p className="t-prompt-answer whitespace-pre-line">{sectionData}</p>
              </ProfileSection>
            );
          }
          if (typeof sectionData !== "object" || sectionData === null) return null;
          const kvData = sectionData as Record<string, any>;

          const PREGNANCY_ROW_KEYS = /^(DOB|Sex|Length|Weight|Delivery|Gestation|Birth\s*(weight|length)|Weeks\s*delivered|Child.*name|Health|Vaginal|C.Section|surrogate\s*delivery)/i;
          if (/pregnancy\s*history/i.test(sectionName) && !Array.isArray(kvData["Details per pregnancy"]) && !Array.isArray(kvData["Entries"])) {
            const rowKeys = Object.keys(kvData).filter((k) => PREGNANCY_ROW_KEYS.test(k) && typeof kvData[k] !== "object");
            if (rowKeys.length >= 3) {
              const metaKeys = Object.keys(kvData).filter((k) => !PREGNANCY_ROW_KEYS.test(k) && k !== "_letterText" && k !== "_letterTitle");
              const row: Record<string, any> = {};
              for (const k of rowKeys) row[k] = kvData[k];
              const displayName = sectionName.endsWith(":") ? sectionName.slice(0, -1) : sectionName;
              return (
                <ProfileSection key={sectionName} title={displayName} contentClassName="p-6 space-y-3" data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                    {metaKeys.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-3">
                        {metaKeys.map((k) => (
                          <div key={k}>
                            <p className="t-field-label">{k}</p>
                            <p className="t-field-value">{String(kvData[k] ?? "")}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="overflow-x-auto -mx-6 px-6">
                      <table className="w-full text-sm table-auto">
                        <thead>
                          <tr className="border-b border-border">
                            {rowKeys.map((col) => (
                              <th key={col} className="t-micro-label text-left py-2 pr-4 whitespace-nowrap">{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b border-border/50 last:border-0">
                            {rowKeys.map((col) => (
                              <td key={col} className="py-2 pr-4 text-foreground whitespace-nowrap">{String(row[col] ?? "")}</td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                </ProfileSection>
              );
            }
          }

          const tableEntries: [string, any[]][] = [];
          const fieldEntries2: [string, any][] = [];
          let sectionLetterText: string | null = null;
          let sectionLetterTitle: string | null = null;

          const flatObjKeys: string[] = [];
          for (const [k, v] of Object.entries(kvData)) {
            if (typeof v === "object" && v !== null && !Array.isArray(v)) {
              const vals = Object.values(v);
              const hasNestedObj = vals.some((cv) => typeof cv === "object" && cv !== null);
              if (!hasNestedObj && vals.length >= 2) {
                flatObjKeys.push(k);
              }
            }
          }
          const consumedByTable = new Set<string>();
          if (flatObjKeys.length >= 2) {
            const allCols = new Set<string>();
            flatObjKeys.forEach((k) => Object.keys(kvData[k]).forEach((c) => allCols.add(c)));
            const shared = [...allCols].filter((c) => flatObjKeys.filter((k) => c in kvData[k]).length >= flatObjKeys.length * 0.4);
            if (shared.length >= 2) {
              const rows = flatObjKeys.map((k) => {
                const row: Record<string, any> = { Label: k };
                for (const c of shared) row[c] = kvData[k][c] ?? "";
                return row;
              });
              tableEntries.push([sectionName, rows]);
              flatObjKeys.forEach((k) => consumedByTable.add(k));
            }
          }

          for (const [k, v] of Object.entries(kvData)) {
            if (k === "_letterText") { sectionLetterText = String(v); continue; }
            if (k === "_letterTitle") { sectionLetterTitle = String(v); continue; }
            if (HIDDEN_PROFILE_KEYS.has(k)) continue;
            if (consumedByTable.has(k)) continue;
            if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
              tableEntries.push([k, v]);
            } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
              const childValues = Object.values(v);
              const childObjects = childValues.filter((cv) => typeof cv === "object" && cv !== null && !Array.isArray(cv));
              if (childObjects.length >= 2) {
                const rows = Object.entries(v)
                  .filter(([, cv]) => typeof cv === "object" && cv !== null && !Array.isArray(cv))
                  .map(([label, cv]) => ({ Label: label, ...(cv as Record<string, any>) }));
                tableEntries.push([k, rows]);
                const nonObjEntries = Object.entries(v).filter(([, cv]) => typeof cv !== "object" || cv === null || Array.isArray(cv));
                for (const [sk, sv] of nonObjEntries) {
                  fieldEntries2.push([sk, sv]);
                }
              } else {
                for (const [sk, sv] of Object.entries(v)) {
                  if (HIDDEN_PROFILE_KEYS.has(sk)) continue;
                  fieldEntries2.push([sk, sv]);
                }
              }
            } else {
              fieldEntries2.push([k, v]);
            }
          }
          if (extra) {
            tableEntries.push(...extra.tables);
          }

          const deliveryPattern = /^(First|Second|Third|Fourth|Fifth|Sixth|1st|2nd|3rd|4th|5th|6th|\d+(?:st|nd|rd|th))\s+Delivery\s*[\-–:]\s*/i;
          const deliveryFields = fieldEntries2.filter(([k]) => deliveryPattern.test(k));
          if (deliveryFields.length >= 2) {
            const deliveryGroups = new Map<string, Record<string, any>>();
            for (const [k, v] of deliveryFields) {
              const match = k.match(deliveryPattern);
              if (!match) continue;
              const prefix = match[1];
              const field = k.replace(deliveryPattern, "").trim();
              if (!deliveryGroups.has(prefix)) deliveryGroups.set(prefix, { Delivery: prefix });
              deliveryGroups.get(prefix)![field || k] = typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "");
            }
            if (deliveryGroups.size >= 1) {
              const rows = Array.from(deliveryGroups.values());
              tableEntries.push(["Delivery History", rows]);
              const deliveryKeySet = new Set(deliveryFields.map(([k]) => k));
              const remaining = fieldEntries2.filter(([k]) => !deliveryKeySet.has(k));
              fieldEntries2.length = 0;
              fieldEntries2.push(...remaining);
            }
          }

          const childPattern = /^(\d+(?:st|nd|rd|th)\s+Child|(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth)\s+Child)\s*[\-–:]\s*/i;
          const plainChildPattern = /^(\d+(?:st|nd|rd|th)\s+Child|(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth)\s+Child)$/i;
          const childFields = fieldEntries2.filter(([k]) => childPattern.test(k) || plainChildPattern.test(k));
          if (childFields.length >= 2) {
            const childGroups = new Map<string, Record<string, any>>();
            for (const [k, v] of childFields) {
              const plainMatch = k.match(plainChildPattern);
              if (plainMatch) {
                const prefix = plainMatch[1];
                if (!childGroups.has(prefix)) childGroups.set(prefix, { Child: prefix });
                childGroups.get(prefix)!["Gender"] = typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "");
                continue;
              }
              const match = k.match(childPattern);
              if (!match) continue;
              const prefix = match[1];
              const field = k.replace(childPattern, "").trim();
              if (!childGroups.has(prefix)) childGroups.set(prefix, { Child: prefix });
              childGroups.get(prefix)![field || k] = typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "");
            }
            if (childGroups.size >= 2) {
              const rows = Array.from(childGroups.values());
              tableEntries.push(["Children", rows]);
              const childKeySet = new Set(childFields.map(([k]) => k));
              const remaining = fieldEntries2.filter(([k]) => !childKeySet.has(k));
              fieldEntries2.length = 0;
              fieldEntries2.push(...remaining);
            }
          }

          const objEntries = fieldEntries2.filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v));
          if (objEntries.length >= 3) {
            const allKeys = new Set<string>();
            objEntries.forEach(([, v]) => Object.keys(v).forEach((k) => allKeys.add(k)));
            const sharedCount = [...allKeys].filter((k) => objEntries.filter(([, v]) => k in v).length >= objEntries.length * 0.5).length;
            if (sharedCount >= 3) {
              const sharedCols = [...allKeys].filter((k) => objEntries.filter(([, v]) => k in v).length >= objEntries.length * 0.5);
              const rows = objEntries.map(([label, v]) => {
                const row: Record<string, any> = { Relation: label };
                for (const col of sharedCols) row[col] = v[col] ?? "";
                return row;
              });
              tableEntries.push([sectionName, rows]);
              const objKeys = new Set(objEntries.map(([k]) => k));
              const remaining = fieldEntries2.filter(([k]) => !objKeys.has(k));
              fieldEntries2.length = 0;
              fieldEntries2.push(...remaining);
            }
          }

          if (fieldEntries2.length === 0 && tableEntries.length === 0 && !sectionLetterText) return null;

          const TRANSPOSE_SECTION = /pregnancy|deliver|children/i;
          const TRANSPOSE_LABEL_COL = /^(label|child|delivery|dob|date)/i;

          const renderTable = (rows: any[], label?: string, sectionCtx?: string) => {
            const colSet = new Set<string>();
            rows.forEach((row: Record<string, any>) => Object.keys(row).forEach((k) => colSet.add(k)));
            const COL_RENAME: Record<string, string> = {
              "Was this a surrogate delivery?": "Surrogacy?",
            };
            const COL_RENAME_PATTERN: [RegExp, string][] = [
              [/surrogate\s*deliver/i, "Surrogacy?"],
              [/delivery.*single.*surrogate/i, "Surrogacy?"],
            ];
            const renameCol = (col: string) => {
              if (COL_RENAME[col]) return COL_RENAME[col];
              for (const [pat, replacement] of COL_RENAME_PATTERN) {
                if (pat.test(col)) return replacement;
              }
              return col;
            };
            const LONG_COL_PATTERN = /^(notes|comments|description|details|complications|additional)/i;
            const SHORT_COL_PATTERN = /^(label|sex|weight|gestation|dob|surroga)/i;
            const allCols = Array.from(colSet);
            const longCols = allCols.filter((c) => LONG_COL_PATTERN.test(c));
            const shortCols = allCols.filter((c) => !LONG_COL_PATTERN.test(c));
            const cols = [...shortCols, ...longCols];
            const hasLongCol = longCols.length > 0;
            const getColStyle = (col: string): React.CSSProperties => {
              if (LONG_COL_PATTERN.test(col)) return { width: "35%" };
              if (SHORT_COL_PATTERN.test(col)) return { width: hasLongCol ? "auto" : undefined };
              return {};
            };

            const shouldTranspose = rows.length >= 1 && cols.length >= 4 &&
              TRANSPOSE_SECTION.test(sectionCtx || label || "");

            if (shouldTranspose) {
              const labelCol = cols.find(c => TRANSPOSE_LABEL_COL.test(c));
              const attrCols = cols.filter(c => c !== labelCol);
              const headerLabels = rows.map((row, i) => {
                if (labelCol && row[labelCol]) return String(row[labelCol]);
                return `#${i + 1}`;
              });

              return (
                <div key={label || "table"} className="mt-4">
                  {label && <p className="t-field-label mb-2">{label}</p>}
                  <div className="md:hidden overflow-x-auto -mx-6 px-6">
                    <table className="w-full text-sm table-auto" style={{ minWidth: 0 }}>
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-left py-2 pr-2 text-sm font-ui text-foreground" style={{ width: '25%', minWidth: 70 }}></th>
                          {headerLabels.map((h, i) => (
                            <th key={i} className="t-micro-label text-left py-2 px-1" style={{ minWidth: 50 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {attrCols.map((attr) => (
                          <tr key={attr} className="border-b border-border/50 last:border-0">
                            <td className="t-micro-label py-2 pr-2">{renameCol(attr)}</td>
                            {rows.map((row, ri) => (
                              <td key={ri} className="py-2 px-1 text-foreground text-xs">{String(row[attr] ?? "-")}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="hidden md:block overflow-x-auto -mx-6 px-6">
                    <table className="w-full text-sm table-auto">
                      <thead>
                        <tr className="border-b border-border">
                          {cols.map((col) => (
                            <th key={col} className="t-micro-label text-left py-2 pr-4 whitespace-nowrap" style={getColStyle(col)}>{renameCol(col)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row: Record<string, any>, ri: number) => (
                          <tr key={ri} className="border-b border-border/50 last:border-0">
                            {cols.map((col) => (
                              <td key={col} className={`py-2 pr-4 text-foreground ${LONG_COL_PATTERN.test(col) ? "break-words" : "whitespace-nowrap"}`}>{String(row[col] ?? "")}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            }

            const ROW_HEADER_PATTERN = /^(relation|name|label|role|title|child|member)/i;
            const renderMobileCards = cols.length >= 4;

            return (
              <div key={label || "table"} className="mt-4">
                {label && <p className="t-field-label mb-2">{label}</p>}
                {renderMobileCards && (
                  <div className="md:hidden space-y-3" data-testid={`table-mobile-cards-${label || ""}`}>
                    {rows.map((row: Record<string, any>, ri: number) => {
                      const headerCol = cols.find((c) => ROW_HEADER_PATTERN.test(c)) || cols[0];
                      const headerValue = String(row[headerCol] ?? "").trim() || `#${ri + 1}`;
                      const otherCols = cols.filter((c) => c !== headerCol);
                      return (
                        <div key={ri} className="rounded-[var(--radius)] border border-border/60 bg-secondary/30 p-3">
                          <p className="t-field-value font-heading mb-2">{headerValue}</p>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                            {otherCols.map((col) => {
                              const val = String(row[col] ?? "").trim();
                              if (!val || val === "-") return null;
                              return (
                                <div key={col} className="min-w-0">
                                  <p className="t-micro-label">{renameCol(col)}</p>
                                  <p className="t-micro-value break-words">{val}</p>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className={`${renderMobileCards ? "hidden md:block" : ""} overflow-x-auto -mx-6 px-6`}>
                  <table className={`w-full text-sm table-auto`}>
                    <thead>
                      <tr className="border-b border-border">
                        {cols.map((col) => (
                          <th key={col} className="t-micro-label text-left py-2 pr-4 whitespace-nowrap" style={getColStyle(col)}>{renameCol(col)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row: Record<string, any>, ri: number) => (
                        <tr key={ri} className="border-b border-border/50 last:border-0">
                          {cols.map((col) => (
                            <td key={col} className={`py-2 pr-4 text-foreground ${LONG_COL_PATTERN.test(col) ? "break-words" : "whitespace-nowrap"}`}>{String(row[col] ?? "")}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          };

          const displaySectionName = sectionName.endsWith(":") ? sectionName.slice(0, -1) : sectionName;
          const isPersonalitySection = PERSONALITY_SECTION_PATTERN.test(displaySectionName);
          return (
            <ProfileSection key={sectionName} title={displaySectionName} contentClassName="p-6 space-y-3" data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                {sectionLetterText && (
                  <div className="mb-4">
                    {sectionLetterTitle && <PromptEyebrow>{sectionLetterTitle}</PromptEyebrow>}
                    <PromptAnswer>{sectionLetterText}</PromptAnswer>
                  </div>
                )}
                {fieldEntries2.length > 0 && (() => {
                  const LONG_THRESHOLD = 200;
                  const renderFlat = (v: any): string => {
                    if (v == null) return "";
                    if (Array.isArray(v)) return v.map(renderFlat).join(", ");
                    if (typeof v === "object") return Object.entries(v).map(([k2, v2]) => `${k2}: ${renderFlat(v2)}`).join(", ");
                    return String(v);
                  };
                  const shortEntries = fieldEntries2.filter(([, v]) => {
                    if (typeof v === "object" && v !== null && !Array.isArray(v)) return true;
                    return renderFlat(v).length < LONG_THRESHOLD;
                  });
                  const longEntries = fieldEntries2.filter(([, v]) => {
                    if (typeof v === "object" && v !== null && !Array.isArray(v)) return false;
                    return renderFlat(v).length >= LONG_THRESHOLD;
                  });
                  // A section that is the donor talking renders every entry as
                  // a prompt block - eyebrow question, prose answer - however
                  // short the answer is. Data sections keep the label/value
                  // pair, where the value is what gets scanned for.
                  if (isPersonalitySection) {
                    return (
                      <PromptStack>
                        {fieldEntries2.map(([question, answer]) => (
                          <PromptBlock
                            key={question}
                            question={question}
                            answer={renderFlat(answer)}
                            data-testid={`prompt-${question.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`}
                          />
                        ))}
                      </PromptStack>
                    );
                  }
                  return (
                    <>
                      {longEntries.length > 0 && (
                        <div style={{ display: "grid", rowGap: "var(--field-pair-gap)", marginBottom: "var(--field-pair-gap)" }}>
                          {longEntries.map(([question, answer]) => (
                            <Field key={question} label={question} value={renderFlat(answer)} prose />
                          ))}
                        </div>
                      )}
                      {shortEntries.length > 0 && (
                        <FieldGrid columns={3}>
                          {shortEntries.map(([question, answer]) => {
                            if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
                              const subEntries = Object.entries(answer);
                              return (
                                <Field
                                  key={question}
                                  label={question}
                                  wide={shortEntries.length === 1 || subEntries.length > 4 || question.length > 70}
                                >
                                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                                    {subEntries.map(([subKey, subVal]) => (
                                      <MicroField key={subKey} label={subKey} value={renderFlat(subVal)} />
                                    ))}
                                  </div>
                                </Field>
                              );
                            }
                            const answerStr = renderFlat(answer);
                            const chips = toChipParts(answerStr);
                            // A single-field section, a long question or a long
                            // answer takes the whole row - in a third-width
                            // column those wrap into a cramped stack.
                            const wide = shortEntries.length === 1 || isWideField(question, answerStr);
                            return (
                              <Field key={question} label={question} wide={wide}>
                                {chips ? (
                                  <ChipRow>
                                    {chips.map((c) => (
                                      <AttributeChip key={c}>{c}</AttributeChip>
                                    ))}
                                  </ChipRow>
                                ) : (
                                  <FieldValue prose={answerStr.length > 90}>{answerStr}</FieldValue>
                                )}
                              </Field>
                            );
                          })}
                        </FieldGrid>
                      )}
                    </>
                  );
                })()}
                {tableEntries.map(([tableName, rows]) =>
                  renderTable(rows, tableEntries.length > 1 ? tableName : undefined, sectionName)
                )}
            </ProfileSection>
          );
        });
      })()}

      {longTextEntries.length > 0 && longTextEntries.map(([key, value]) => (
        <ProfileSection key={key} title={formatFieldLabel(key)} data-testid={`section-${key.toLowerCase().replace(/\s+/g, "-")}`}>
            <p className="t-prompt-answer whitespace-pre-line">{String(value)}</p>
        </ProfileSection>
      ))}

      {fieldEntries.length > 0 && (
        <ProfileSection title="Additional Details" data-testid="section-additional-details">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-12 gap-y-3">
              {fieldEntries.map(([key, value]) => {
                let display: string;
                if (typeof value === "boolean") display = value ? "Yes" : "No";
                else if (Array.isArray(value)) display = value.filter(Boolean).join(", ");
                else display = String(value);
                return (
                  <div key={key} data-testid={`field-extra-${key.toLowerCase().replace(/\s+/g, "-")}`}>
                    <p className="t-field-label">{formatFieldLabel(key)}</p>
                    <p className="t-field-value">{display}</p>
                  </div>
                );
              })}
            </div>
        </ProfileSection>
      )}

      {documentImageEntries.map(([key, value]) => (
        <ProfileSection key={key} title={formatFieldLabel(key)} data-testid={`section-${key.toLowerCase().replace(/\s+/g, "-")}`}>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {(value as string[]).map((url: string, idx: number) => (
                <a key={idx} href={`/api/uploads/proxy?url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">
                  <img
                    src={`/api/uploads/proxy?url=${encodeURIComponent(url)}`}
                    alt={`${formatFieldLabel(key)} ${idx + 1}`}
                    className="w-full aspect-square rounded-[var(--radius)] border border-border/30 object-cover hover:opacity-80 transition-opacity"
                    loading="lazy"
                    data-testid={`img-${key.toLowerCase().replace(/\s+/g, "-")}-${idx}`}
                  />
                </a>
              ))}
            </div>
        </ProfileSection>
      ))}
    </div>
  );
}

type DeckEntry = { id: string; providerId: string; photoUrl?: string | null };

/**
 * Tinder-style corner stamp shown on the departing card during a throw.
 * Like = heart pinned top-left, Pass = X pinned top-right. Subtle, tilted,
 * NOT a full-card-center watermark and NOT a full-bleed color tint.
 */
function ProfileThrowStamp({ dir }: { dir: "like" | "pass" }) {
  return (
    <div className="absolute inset-0 z-[60] pointer-events-none" data-testid={`throw-stamp-${dir}`}>
      {dir === "like" ? (
        <div
          className="absolute top-10 left-6 -rotate-[18deg] rounded-2xl border-4 p-2 bg-white/10 backdrop-blur-[1px]"
          style={{ borderColor: "var(--swipe-save)", color: "var(--swipe-save)" }}
        >
          <Heart className="w-12 h-12 drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]" fill="currentColor" strokeWidth={2.5} />
        </div>
      ) : (
        <div
          className="absolute top-10 right-6 rotate-[18deg] rounded-2xl border-4 p-2 bg-white/10 backdrop-blur-[1px]"
          style={{ borderColor: "var(--swipe-pass)", color: "var(--swipe-pass)" }}
        >
          <X className="w-12 h-12 drop-shadow-[0_2px_6px_rgba(0,0,0,0.45)]" strokeWidth={3.5} />
        </div>
      )}
    </div>
  );
}

/**
 * Fixed mobile close button.
 *
 * Lives OUTSIDE ProfileCard for the same reason the action bar does: inside the
 * card it sat in a `sticky` header nested in the deck's animated (transformed)
 * `motion.div`, and iOS Safari hit-tests a sticky element inside a transformed
 * ancestor at its *unstuck* position - so once you scrolled, the visible button
 * stopped receiving taps. As a fixed sibling of the card it is always tappable.
 */
function ProfileDetailCloseButton({ onBack }: { onBack: () => void }) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, delay: 0.08, ease: [0.25, 0.46, 0.45, 0.94] }}
      onClick={onBack}
      className="fixed top-3 right-4 z-[56] w-11 h-11 rounded-full bg-[hsl(var(--brand-success))] hover:brightness-110 shadow-lg flex items-center justify-center transition-all active:scale-95 touch-manipulation"
      data-testid="button-mobile-back-down"
      aria-label="Back to marketplace"
    >
      <ArrowDown className="w-5 h-5 text-white" strokeWidth={2.5} />
    </motion.button>
  );
}

/** Fixed mobile action bar - lifted out of ProfileCard so it stays put while the
 *  card is thrown. Identical styling to the deck's action buttons. */
function ProfileDetailActionBar({ isSaved, busy, onPass, onLike, onMessage }: {
  isSaved: boolean; busy: boolean; onPass: () => void; onLike: () => void; onMessage: () => void;
}) {
  const btn = "h-16 w-16 rounded-full bg-gradient-to-b from-zinc-700/80 to-black/90 backdrop-blur-xl border border-white/10 border-b-black/80 shadow-[0_10px_20px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.2)] active:scale-95 active:translate-y-0.5 transition-all duration-200 flex items-center justify-center pointer-events-auto disabled:opacity-100";
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, delay: 0.12, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="fixed bottom-6 left-0 right-0 z-[55] flex items-center justify-center gap-3 px-4 pointer-events-none"
      data-testid="mobile-detail-actions"
    >
      <Button variant="ghost" size="icon" onClick={onPass} disabled={busy} className={btn} data-testid="button-mobile-pass">
        <X className="!w-9 !h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-pass)" }} strokeWidth={3} />
      </Button>
      <Button variant="ghost" size="icon" onClick={onLike} disabled={busy} className={btn} data-testid="button-mobile-save">
        <Heart className="!w-9 !h-9 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-save)" }} strokeWidth={3} fill={isSaved ? "currentColor" : "none"} />
      </Button>
      <Button variant="ghost" size="icon" onClick={onMessage} className={btn} data-testid="button-mobile-message">
        <Send className="!w-8 !h-8 drop-shadow-[0_2px_2px_rgba(0,0,0,0.8)]" style={{ color: "var(--swipe-chat)" }} strokeWidth={3} />
      </Button>
    </motion.div>
  );
}

/**
 * Detail-page "deck": mirrors the Explorer's two-card stack
 * (marketplace-page.tsx) so pressing like/pass throws the current profile
 * off-screen Tinder-style and reveals the pre-mounted next profile underneath -
 * no spinner, no blank gap. Falls back to a single card when arrived without a
 * deck list (chat / saved / admin / cold refresh).
 */
export default function DonorProfilePage() {
  const { providerId, type: paramType, donorId } = useParams<{ providerId: string; type?: string; donorId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const dispatch = useAppDispatch();
  const favoritedIds = useAppSelector((s) => s.ui.favoritedDonorIds);
  const type = deriveTypeFromPath(location.pathname, paramType);

  const navState = location.state as {
    fromChat?: boolean; chatPath?: string; initialPhotoUrl?: string;
    deckList?: DeckEntry[]; deckIndex?: number;
  } | null;
  const fromChat = navState?.fromChat === true;
  const chatPath = navState?.chatPath || "/concierge";
  const deckList = navState?.deckList;

  // Seed the deck index from the donor we navigated to.
  const seedIdx = useMemo(() => {
    if (!deckList || !donorId) return 0;
    const i = deckList.findIndex((d) => d.id === donorId);
    return i >= 0 ? i : (navState?.deckIndex ?? 0);
  }, [deckList, donorId, navState?.deckIndex]);
  const [idx, setIdx] = useState(seedIdx);
  useEffect(() => { setIdx(seedIdx); }, [seedIdx]);

  const controls = useAnimation();
  const [throwDir, setThrowDir] = useState<null | "like" | "pass">(null);
  const [busy, setBusy] = useState(false);

  const syncPref = useCallback((prefType: "favorite" | "skip", id: string, action: "add" | "remove") => {
    const method = action === "add" ? "POST" : "DELETE";
    fetch(`/api/donor-preferences/${prefType}/${id}`, { method, credentials: "include" }).catch(() => {});
  }, []);

  const goBack = useCallback(() => {
    if (fromChat) navigate(chatPath);
    else if (window.location.pathname.startsWith("/admin/")) navigate(`/admin/providers/${providerId}?tab=${TYPE_ENDPOINTS[type || "egg-donor"]}`);
    else if (hasInAppHistory()) navigate(-1);
    // Deep link / hard refresh / shared URL: there is nothing behind us, so
    // navigate(-1) is a silent no-op. Send them to the marketplace instead.
    else navigate("/marketplace", { replace: true });
  }, [fromChat, chatPath, navigate, providerId, type]);

  const useDeck = isMobile && !!deckList && deckList.length > 0;
  const current: DeckEntry = useDeck
    ? deckList![Math.min(idx, deckList!.length - 1)]
    : { id: donorId || "", providerId: providerId || "", photoUrl: navState?.initialPhotoUrl };
  const next: DeckEntry | null = useDeck && idx + 1 < deckList!.length ? deckList![idx + 1] : null;

  // Opening a full profile is the strongest "impression" signal there is -
  // stronger than scrolling past a deck card. Record it on mount (and on
  // swipe-to in the mobile deck, when current.id changes). Idempotent and
  // deduped server-side, so this is safe alongside the like/pass/message
  // records below. Skipped for admin/provider routes, which have no parent
  // account and are rejected by the backend anyway.
  useEffect(() => {
    if (!type || !current.id) return;
    if (window.location.pathname.startsWith("/admin/")) return;
    recordProfileView(current.id, type);
    recordProfileOpen(current.id, type); // click-through (VIEW) event
  }, [type, current.id]);

  const commit = useCallback((dir: "like" | "pass", id: string) => {
    if (!type || !id) return;
    recordProfileView(id, type);
    if (dir === "like") {
      // Heart toggles. A saved profile now stays in the marketplace with a
      // filled heart instead of disappearing, so the button has to be able to
      // un-save too - otherwise the only way back is the Saved tab.
      const wasSaved = favoritedIds.includes(id);
      dispatch(toggleFavoriteDonor(id));
      syncPref("favorite", id, wasSaved ? "remove" : "add");
    } else {
      dispatch(passDonor(id)); syncPref("skip", id, "add");
    }
  }, [type, favoritedIds, dispatch, syncPref]);

  const handleAction = useCallback(async (dir: "like" | "pass") => {
    if (busy) return;
    const actedId = current.id;
    // Saving keeps you on the profile. It used to throw the card off and return
    // to the deck, which only made sense while a saved profile vanished from
    // the marketplace; now it stays with a filled heart, so being ejected from
    // the page you are reading would just be disorienting.
    if (dir === "like") { commit(dir, actedId); return; }
    // No deck context: commit and leave (keeps the single-card layout intact).
    if (!useDeck) { commit(dir, actedId); goBack(); return; }
    setBusy(true);
    setThrowDir(dir);
    await controls.start({
      // Only a pass reaches here now, so the throw is always leftward.
      x: -500,
      rotate: -20,
      transition: { duration: 0.2, ease: "easeOut" }, // opacity intentionally untouched - stays opaque
    });
    commit(dir, actedId);
    if (idx + 1 < deckList!.length) {
      const nextEntry = deckList![idx + 1];
      setIdx((i) => i + 1);
      setThrowDir(null);
      controls.set({ x: 0, rotate: 0 });
      // Keep the URL shareable without remounting the route.
      const slug = typeToUrlSlug((type || "egg-donor") as any);
      window.history.replaceState(window.history.state, "", `/${slug}/${nextEntry.providerId}/${nextEntry.id}`);
      setBusy(false);
    } else {
      goBack();
    }
  }, [busy, current.id, useDeck, commit, goBack, controls, idx, deckList, type]);

  const handleMessage = useCallback(() => {
    if (!type) return;
    recordProfileView(current.id, type);
    navigate(`/concierge?donorId=${current.id}&donorType=${type}&providerId=${current.providerId}`);
  }, [type, current, navigate]);

  const isSaved = favoritedIds.includes(current.id);

  // Non-mobile, or no deck context: single card (original layout + behavior).
  if (!useDeck) {
    return (
      <>
        <ProfileCard providerId={current.providerId} donorId={current.id} type={type} initialPhotoUrl={current.photoUrl || undefined} onBack={goBack} />
        {isMobile && (
          <>
            <ProfileDetailCloseButton onBack={goBack} />
            <ProfileDetailActionBar isSaved={isSaved} busy={busy} onPass={() => handleAction("pass")} onLike={() => handleAction("like")} onMessage={handleMessage} />
          </>
        )}
      </>
    );
  }

  // Mobile deck: two-card stack. Next card is mounted static underneath (z-0) so
  // its data + hero are prefetched and ready before the current card throws off.
  return (
    <div className="relative h-[100dvh] overflow-hidden" data-testid="profile-detail-deck">
      {next && (
        <div className="absolute inset-0 z-0 overflow-y-auto" data-testid={`profile-next-${next.id}`}>
          <ProfileCard key={`next-${next.id}`} providerId={next.providerId} donorId={next.id} type={type} initialPhotoUrl={next.photoUrl || undefined} />
        </div>
      )}
      <motion.div
        className="absolute inset-0 z-10 overflow-y-auto bg-background"
        animate={controls}
        data-testid={`profile-current-${current.id}`}
      >
        <ProfileCard key={`cur-${current.id}`} providerId={current.providerId} donorId={current.id} type={type} initialPhotoUrl={current.photoUrl || undefined} onBack={goBack} />
        {throwDir && <ProfileThrowStamp dir={throwDir} />}
      </motion.div>
      <ProfileDetailCloseButton onBack={goBack} />
      <ProfileDetailActionBar isSaved={isSaved} busy={busy} onPass={() => handleAction("pass")} onLike={() => handleAction("like")} onMessage={handleMessage} />
    </div>
  );
}
