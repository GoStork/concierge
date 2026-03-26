import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { getProfileUrlSlug } from "./chat-utils";
import { SwipeDeckCard, type TabSection } from "@/components/marketplace/swipe-deck-card";
import {
  mapDatabaseDonorToSwipeProfile,
  mapDatabaseSurrogateToSwipeProfile,
  mapDatabaseSpermDonorToSwipeProfile,
  buildTitle,
  buildStatusLabel,
  getPhotoList,
  getSurrogateTabs,
  getDonorTabs,
} from "@/components/marketplace/swipe-mappers";

interface WhisperProfileCardProps {
  card: any;
  brandColor: string;
}

export function WhisperProfileCard({ card, brandColor }: WhisperProfileCardProps) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!card?.ownerProviderId || !card?.providerId) { setLoading(false); return; }
    const t = (card.type || "").toLowerCase();
    const endpoint = t === "surrogate" ? "surrogates" : t === "egg donor" ? "egg-donors" : t === "sperm donor" ? "sperm-donors" : "surrogates";
    fetch(`/api/providers/${card.ownerProviderId}/${endpoint}/${card.providerId}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setProfile(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [card?.ownerProviderId, card?.providerId, card?.type]);

  if (loading) {
    return (
      <div className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted animate-pulse flex items-center justify-center mb-2">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (profile) {
    const t = (card.type || "").toLowerCase();
    const isSurrogate = t === "surrogate";
    const swipeProfile = isSurrogate
      ? mapDatabaseSurrogateToSwipeProfile(profile)
      : t === "sperm donor"
        ? mapDatabaseSpermDonorToSwipeProfile(profile)
        : mapDatabaseDonorToSwipeProfile(profile);
    const photos = getPhotoList(swipeProfile);
    const title = buildTitle(swipeProfile);
    const statusLabel = buildStatusLabel(swipeProfile);
    const baseTabs = isSurrogate ? getSurrogateTabs(swipeProfile, []) : getDonorTabs(swipeProfile, []);
    const reasons = card.reasons || [];
    const tabs: TabSection[] = reasons.length > 0
      ? [{ layoutType: "matched_bubbles" as const, title: `Matched ${reasons.length} Preference${reasons.length !== 1 ? "s" : ""}`, items: reasons.map((r: string) => ({ label: r, value: "" })) }, ...baseTabs]
      : baseTabs;

    return (
      <div className="w-full max-w-sm aspect-[3/4] mb-2" data-testid={`whisper-profile-card-${card.providerId}`}>
        <SwipeDeckCard
          id={card.providerId}
          photos={photos}
          title={title}
          statusLabel={statusLabel}
          isExperienced={swipeProfile.isExperienced}
          isPremium={swipeProfile.isPremium}
          tabs={tabs}
          disableSwipe
          chatMode
          readOnly
          onPass={() => {}}
          onSave={() => {}}
          onViewFullProfile={() => {
            if (card.ownerProviderId) {
              const slug = getProfileUrlSlug(card.type);
              navigate(`/${slug}/${card.ownerProviderId}/${card.providerId}`, {
                state: {
                  fromChat: true,
                  matchReasons: card.reasons || [],
                  chatPath: window.location.pathname + window.location.search,
                },
              });
            }
          }}
        />
      </div>
    );
  }

  if (card?.photo) {
    return (
      <div className="w-full max-w-sm aspect-[3/4] rounded-[var(--container-radius)] overflow-hidden bg-muted relative mb-2" data-testid={`whisper-profile-card-${card.providerId}`}>
        <img src={getPhotoSrc(card.photo) || undefined} alt={card.name} className="w-full h-full object-cover" />
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-24 pb-6 px-4">
          <h3 className="text-white font-heading text-xl leading-tight">{card.name}</h3>
          {card.location && <p className="text-white/70 text-sm mt-1">{card.location}</p>}
        </div>
      </div>
    );
  }

  return null;
}
