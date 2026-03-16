import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { typeToUrlSlug, deriveTypeFromPath, resolveSurrogateFields, resolveEggDonorFields, resolveSpermDonorFields } from "@/lib/profile-utils";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { hasProviderRole } from "@shared/roles";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  ArrowLeft,
  Loader2,
  User,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  X,
  Play,
  Pencil,
} from "lucide-react";

function isEmbedVideo(url: string): boolean {
  return /vimeo\.com|youtube\.com|youtu\.be/i.test(url);
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

function PhotoGalleryBar({ photos, videoUrl }: { photos: string[]; videoUrl?: string | null }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [showVideo, setShowVideo] = useState(false);
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

  if (photos.length === 0 && !videoUrl) return null;

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
              className="shrink-0 cursor-pointer overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40 relative"
              style={{ scrollSnapAlign: "start" }}
              data-testid="gallery-video-thumb"
            >
              {photos.length > 0 ? (
                <img
                  src={photos[0]}
                  alt="Video thumbnail"
                  className="h-[280px] w-[220px] object-cover brightness-75"
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
              className="shrink-0 cursor-pointer overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
              style={{ scrollSnapAlign: "start" }}
              data-testid={`gallery-photo-${idx}`}
            >
              <img
                src={url}
                alt={`Photo ${idx + 1}`}
                className="h-[280px] w-auto min-w-[180px] max-w-[260px] object-cover hover:scale-105 transition-transform duration-300"
                loading={idx < 5 ? "eager" : "lazy"}
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
                className="w-full h-full rounded-lg shadow-2xl"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                data-testid="video-player-iframe"
              />
            ) : isIframeVideo(videoUrl) ? (
              <iframe
                src={videoUrl}
                className="w-full h-full rounded-lg shadow-2xl"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                data-testid="video-player-iframe"
              />
            ) : (
              <video
                src={isDirectVideo(videoUrl) ? videoUrl : `/api/uploads/proxy?url=${encodeURIComponent(videoUrl)}`}
                controls
                autoPlay
                className="w-full h-full rounded-lg shadow-2xl bg-black"
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
            className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
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

function proxyImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("/")) return url;
  if (/storage\.googleapis\.com\/gostork/i.test(url)) return url;
  return `/api/uploads/proxy?url=${encodeURIComponent(url)}`;
}

function formatFieldLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const HIDDEN_PROFILE_KEYS = new Set([
  "photoUrl", "profileUrl", "externalId", "status", "Video URL", "Photos", "All Photos",
  "_sections", "_tables", "profileData", "Letter to Intended Parents", "Letter Title",
  "Original PDF", "Source", "Source File", "Agency ID", "Agency I D", "Surrogate ID",
  "Surrogate I D", "Donor ID", "Donor I D",
]);

const AGENCY_COMMENT_PATTERN = /^(agency\s*(comment|recommendation|note)s?|recommendation\s*points?|additional\s*information)$/i;

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
    MATCHED: "bg-accent/15 text-accent-foreground border-accent/30",
    ON_HOLD: "bg-[hsl(var(--brand-warning)/0.12)] text-[hsl(var(--brand-warning))] border-[hsl(var(--brand-warning)/0.3)]",
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

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="bg-primary px-4 py-2 rounded-t-lg">
      <h3 className="text-sm font-heading text-white" data-testid={`section-header-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {title}
      </h3>
    </div>
  );
}


function getMandatoryFields(donor: any, type: string): { label: string; value: string }[] {
  const V = (val: any) => (val != null && val !== "") ? String(val) : "-";
  const profileData = donor.profileData || {};

  const fmtUSD = (val: number | null | undefined) => val != null ? `$${Number(val).toLocaleString()}` : "-";
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
      { label: "Location", value: V(r.location) },
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
      { label: "Location", value: V(r.location) },
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
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCost(r.calculatedTotalCost) : (r.totalCompensationMin ? `${fmtUSD(r.totalCompensationMin)}${r.totalCompensationMax && r.totalCompensationMax !== r.totalCompensationMin ? ` – ${fmtUSD(r.totalCompensationMax)}` : ""}` : "-") },
    ];
  } else {
    const r = resolveSpermDonorFields(donor);
    return [
      { label: "Age", value: V(r.age) },
      { label: "Education", value: V(r.education) },
      { label: "Type", value: V(r.donorType) },
      { label: "Location", value: V(r.location) },
      { label: "Ethnicity", value: V(r.ethnicity) },
      { label: "Race", value: V(r.race) },
      { label: "Hair Color", value: V(r.hairColor) },
      { label: "Height", value: V(r.height) },
      { label: "Eye Color", value: V(r.eyeColor) },
      { label: "Weight", value: V(r.weight) },
      { label: "Religion", value: V(r.religion) },
      { label: "Occupation", value: V(r.occupation) },
      { label: "Price", value: fmtUSD(r.resolvedCompensation ?? r.compensation) },
      { label: "Total Cost", value: r.calculatedTotalCost ? fmtTotalCost(r.calculatedTotalCost) : (r.totalCost ? fmtUSD(r.totalCost) : "-") },
    ];
  }
}

export default function DonorProfilePage() {
  const { providerId, type: paramType, donorId } = useParams<{ providerId: string; type?: string; donorId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const type = deriveTypeFromPath(location.pathname, paramType);

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
    const isValidPhoto = (url: string) => {
      if (/\.(jpg|jpeg|png|gif|webp|heic|svg|bmp|tiff?|avif)/i.test(url)) return true;
      try {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith(".blob") && /s3[.\-].*amazonaws\.com/i.test(parsed.hostname)) return true;
        if (/storage\.googleapis\.com/i.test(parsed.hostname)) return true;
      } catch {}
      return false;
    };
    const addPhoto = (url: string) => {
      const proxied = proxyImageUrl(url);
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

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!donor) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => {
          const isAdmin = window.location.pathname.startsWith("/admin/");
          if (!isAdmin) {
            navigate(-1);
          } else {
            navigate(`/admin/providers/${providerId}?tab=${TYPE_ENDPOINTS[type || "egg-donor"]}`);
          }
        }} data-testid="link-back-provider">
          <ArrowLeft className="w-4 h-4 mr-2" /> {!window.location.pathname.startsWith("/admin/") ? "Back to Marketplace" : `Back to ${provider?.name || "Provider"}`}
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
  if (donor.location) headerMeta.push(donor.location);
  if (donor.calculatedTotalCost) {
    const tc = donor.calculatedTotalCost;
    if (tc.min === tc.max || tc.max === 0) {
      headerMeta.push(`Total Cost: $${Number(tc.min).toLocaleString()}`);
    } else {
      headerMeta.push(`Total Cost: $${Number(tc.min).toLocaleString()} – $${Number(tc.max).toLocaleString()}`);
    }
  } else if (donor.totalCost) {
    headerMeta.push(`Total Cost: $${Number(donor.totalCost).toLocaleString()}`);
  }
  if (donor.donationTypes) headerMeta.push(`Types of Donation: ${donor.donationTypes}`);

  return (
    <div className="space-y-6 w-full">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => {
          const isAdmin = window.location.pathname.startsWith("/admin/");
          if (!isAdmin) {
            navigate(-1);
          } else {
            navigate(`/admin/providers/${providerId}?tab=${TYPE_ENDPOINTS[type || "egg-donor"]}`);
          }
        }} data-testid="link-back-provider">
          <ArrowLeft className="w-4 h-4 mr-2" /> {!window.location.pathname.startsWith("/admin/") ? "Back to Marketplace" : `Back to ${provider?.name || "Provider"}`}
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

      {(allPhotos.length > 0 || donorVideoUrl) && <PhotoGalleryBar photos={allPhotos} videoUrl={donorVideoUrl} />}

      <div>
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
          <span className="text-sm text-muted-foreground">
            {headerMeta.slice(1).join(" | ")}
          </span>
          {donor.donorType && (
            <Badge variant="outline" className="text-xs">{donor.donorType}</Badge>
          )}
        </div>
        {donor.profileUrl && user && (
          !hasProviderRole(user.roles || []) || user.providerId === providerId
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

      <Card className="overflow-hidden" data-testid="section-summary">
        <SectionHeader title="Summary" />
        <div className="p-6">
          <div className="grid grid-cols-2 gap-x-12 gap-y-3">
            {mandatoryFields.map(({ label, value }) => (
              <div key={label} data-testid={`field-${label.toLowerCase().replace(/\s+/g, "-")}`}>
                <p className="text-xs font-ui text-foreground">{label}</p>
                <p className="text-sm text-muted-foreground">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {profileDetails && Object.keys(profileDetails).length > 0 && (() => {
        const pd = profileDetails as Record<string, any>;
        const merged = new Map<string, { fields: [string, any][]; tables: [string, any[]][] }>();
        const consumed = new Set<string>();

        const rawSectionNames = Object.keys(pd).filter((n) => n !== "Photos");
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
            if (secData._letterText) {
              letterParts.push(String(secData._letterText));
              if (secData._letterTitle) letterTitle = String(secData._letterTitle);
            }
            const remaining: Record<string, any> = {};
            let hasRemaining = false;
            for (const [k, v] of Object.entries(secData)) {
              if (k === "_letterText" || k === "_letterTitle") continue;
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
            } else if (typeof secData === "object" && secData !== null) {
              for (const [k, v] of Object.entries(secData)) {
                if (typeof v === "string" && v.trim()) {
                  agencyCommentParts.push(v.trim());
                } else if (Array.isArray(v)) {
                  const joined = v.filter((item: any) => typeof item === "string" && item.trim()).join("\n");
                  if (joined) agencyCommentParts.push(joined);
                }
              }
              consumed.add(secName);
            }
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
              <Card key="letter-to-intended-parents" className="overflow-hidden" data-testid="section-letter-to-intended-parents">
                <SectionHeader title="Letter to Intended Parents" />
                <div className="p-6">
                  {letterTitle && <p className="text-sm font-semibold text-foreground mb-2">{letterTitle}</p>}
                  <p className="text-sm leading-body text-foreground whitespace-pre-line">{letterContent}</p>
                </div>
              </Card>
            );
          }
          if (sectionName === "__AGENCY_COMMENTS__" && agencyCommentContent) {
            return (
              <Card key="agency-comments" className="overflow-hidden" data-testid="section-agency-comments">
                <SectionHeader title="Agency Comments" />
                <div className="p-6">
                  <p className="text-sm leading-body text-foreground whitespace-pre-line">{agencyCommentContent}</p>
                </div>
              </Card>
            );
          }
          const sectionData = pd[sectionName];
          const extra = merged.get(sectionName);

          if (Array.isArray(sectionData) && sectionData.length > 0 && typeof sectionData[0] === "object") {
            const colSet = new Set<string>();
            sectionData.forEach((row: Record<string, any>) => Object.keys(row).forEach((k) => colSet.add(k)));
            const columns = Array.from(colSet);
            const arrDisplayName = sectionName.endsWith(":") ? sectionName.slice(0, -1) : sectionName;
            return (
              <Card key={sectionName} className="overflow-hidden" data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                <SectionHeader title={arrDisplayName} />
                <div className="p-6">
                  <table className="w-full text-sm table-fixed">
                    <thead>
                      <tr className="border-b border-border">
                        {columns.map((col) => (
                          <th key={col} className="text-left py-2 pr-3 text-xs font-ui text-foreground">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sectionData.map((row: Record<string, any>, ri: number) => (
                        <tr key={ri} className="border-b border-border/50 last:border-0">
                          {columns.map((col) => (
                            <td key={col} className="py-2 pr-3 text-muted-foreground break-words">{String(row[col] ?? "")}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          }
          if (typeof sectionData === "string" && sectionData.trim()) {
            const displayName = sectionName.endsWith(":") ? sectionName.slice(0, -1) : sectionName;
            return (
              <Card key={sectionName} className="overflow-hidden" data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                <SectionHeader title={displayName} />
                <div className="p-6">
                  <p className="text-sm leading-body text-foreground whitespace-pre-line">{sectionData}</p>
                </div>
              </Card>
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
                <Card key={sectionName} className="overflow-hidden" data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
                  <SectionHeader title={displayName} />
                  <div className="p-6 space-y-3">
                    {metaKeys.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-3">
                        {metaKeys.map((k) => (
                          <div key={k}>
                            <p className="text-xs font-ui text-foreground">{k}</p>
                            <p className="text-sm text-muted-foreground">{String(kvData[k] ?? "")}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <table className="w-full text-sm table-fixed">
                      <thead>
                        <tr className="border-b border-border">
                          {rowKeys.map((col) => (
                            <th key={col} className="text-left py-2 pr-3 text-xs font-ui text-foreground">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-b border-border/50 last:border-0">
                          {rowKeys.map((col) => (
                            <td key={col} className="py-2 pr-3 text-muted-foreground break-words">{String(row[col] ?? "")}</td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </Card>
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

          const deliveryPattern = /^(First|Second|Third|Fourth|Fifth|Sixth|1st|2nd|3rd|4th|5th|6th|\d+(?:st|nd|rd|th))\s+Delivery\s*[-–—:]\s*/i;
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

          const childPattern = /^(\d+(?:st|nd|rd|th)\s+Child|(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth)\s+Child)\s*[-–—:]\s*/i;
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

          const renderTable = (rows: any[], label?: string) => {
            const colSet = new Set<string>();
            rows.forEach((row: Record<string, any>) => Object.keys(row).forEach((k) => colSet.add(k)));
            const COL_RENAME: Record<string, string> = {
              "Was this a surrogate delivery?": "Surrogacy delivery?",
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
            return (
              <div key={label || "table"} className="mt-4">
                {label && <p className="text-xs font-ui text-foreground mb-2">{label}</p>}
                <div>
                  <table className={`w-full text-sm ${hasLongCol ? "table-auto" : "table-fixed"}`}>
                    <thead>
                      <tr className="border-b border-border">
                        {cols.map((col) => (
                          <th key={col} className="text-left py-2 pr-3 text-xs font-ui text-foreground whitespace-nowrap" style={getColStyle(col)}>{COL_RENAME[col] || col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row: Record<string, any>, ri: number) => (
                        <tr key={ri} className="border-b border-border/50 last:border-0">
                          {cols.map((col) => (
                            <td key={col} className={`py-2 pr-3 text-muted-foreground break-words ${!LONG_COL_PATTERN.test(col) ? "whitespace-nowrap" : ""}`}>{String(row[col] ?? "")}</td>
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
          return (
            <Card key={sectionName} className="overflow-hidden" data-testid={`section-${sectionName.toLowerCase().replace(/\s+/g, "-")}`}>
              <SectionHeader title={displaySectionName} />
              <div className="p-6 space-y-3">
                {sectionLetterText && (
                  <div className="mb-4">
                    {sectionLetterTitle && <p className="text-sm font-semibold text-foreground mb-2">{sectionLetterTitle}</p>}
                    <p className="text-sm leading-body text-foreground whitespace-pre-line">{sectionLetterText}</p>
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
                  return (
                    <>
                      {longEntries.map(([question, answer]) => (
                        <div key={question} className="mb-3">
                          <p className="text-xs font-ui text-foreground mb-1">{question}</p>
                          <p className="text-sm text-muted-foreground whitespace-pre-line">{renderFlat(answer)}</p>
                        </div>
                      ))}
                      {shortEntries.length > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-3">
                          {shortEntries.map(([question, answer]) => {
                            if (typeof answer === "object" && answer !== null && !Array.isArray(answer)) {
                              const subEntries = Object.entries(answer);
                              return (
                                <div key={question}>
                                  <p className="text-xs font-ui text-foreground mb-1">{question}</p>
                                  <div className="grid grid-cols-2 gap-1 pl-2">
                                    {subEntries.map(([subKey, subVal]) => {
                                      const renderVal = (v: any): string => {
                                        if (v == null) return "";
                                        if (Array.isArray(v)) return v.map(renderVal).join(", ");
                                        if (typeof v === "object") return Object.entries(v).map(([k2, v2]) => `${k2}: ${renderVal(v2)}`).join(", ");
                                        return String(v);
                                      };
                                      return (
                                        <div key={subKey} className="text-sm">
                                          <span className="text-muted-foreground">{subKey}: </span>
                                          <span className="text-foreground">{renderVal(subVal)}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            }
                            const answerStr = renderFlat(answer);
                            return (
                              <div key={question}>
                                <p className="text-xs font-ui text-foreground">{question}</p>
                                <p className="text-sm text-muted-foreground">{answerStr}</p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  );
                })()}
                {tableEntries.map(([tableName, rows]) =>
                  renderTable(rows, tableEntries.length > 1 ? tableName : undefined)
                )}
              </div>
            </Card>
          );
        });
      })()}

      {longTextEntries.length > 0 && longTextEntries.map(([key, value]) => (
        <Card key={key} className="overflow-hidden" data-testid={`section-${key.toLowerCase().replace(/\s+/g, "-")}`}>
          <SectionHeader title={formatFieldLabel(key)} />
          <div className="p-6">
            <p className="text-sm leading-body text-foreground whitespace-pre-line">{String(value)}</p>
          </div>
        </Card>
      ))}

      {fieldEntries.length > 0 && (
        <Card className="overflow-hidden" data-testid="section-additional-details">
          <SectionHeader title="Additional Details" />
          <div className="p-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-12 gap-y-3">
              {fieldEntries.map(([key, value]) => {
                let display: string;
                if (typeof value === "boolean") display = value ? "Yes" : "No";
                else if (Array.isArray(value)) display = value.filter(Boolean).join(", ");
                else display = String(value);
                return (
                  <div key={key} data-testid={`field-extra-${key.toLowerCase().replace(/\s+/g, "-")}`}>
                    <p className="text-xs font-ui text-foreground">{formatFieldLabel(key)}</p>
                    <p className="text-sm text-muted-foreground">{display}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {documentImageEntries.map(([key, value]) => (
        <Card key={key} className="overflow-hidden" data-testid={`section-${key.toLowerCase().replace(/\s+/g, "-")}`}>
          <SectionHeader title={formatFieldLabel(key)} />
          <div className="p-6">
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {(value as string[]).map((url: string, idx: number) => (
                <a key={idx} href={`/api/uploads/proxy?url=${encodeURIComponent(url)}`} target="_blank" rel="noopener noreferrer">
                  <img
                    src={`/api/uploads/proxy?url=${encodeURIComponent(url)}`}
                    alt={`${formatFieldLabel(key)} ${idx + 1}`}
                    className="w-full aspect-square rounded-lg border border-border/30 object-cover hover:opacity-80 transition-opacity"
                    loading="lazy"
                    data-testid={`img-${key.toLowerCase().replace(/\s+/g, "-")}-${idx}`}
                  />
                </a>
              ))}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
