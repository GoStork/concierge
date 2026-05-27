import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Loader2 } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { getProfileUrlSlug } from "./chat-utils";
import {
  mapDatabaseDonorToSwipeProfile,
  mapDatabaseSurrogateToSwipeProfile,
  mapDatabaseSpermDonorToSwipeProfile,
  buildSidebarSections,
  buildTitle,
} from "@/components/marketplace/swipe-mappers";

interface SubjectProfileSectionProps {
  providerId: string | null | undefined;
  subjectProfileId: string | null | undefined;
  subjectType: string | null | undefined;
  fallbackPhotoUrl?: string | null;
  fallbackLabel?: string | null;
  brandColor: string;
  testId?: string;
}

/**
 * Shows the donor/surrogate profile the parent is interested in, as a sidebar
 * section. Used by provider chat and admin concierge monitor right panels.
 * Mirrors the parent-side ParentChatSidePanel subject block.
 */
export function SubjectProfileSection({
  providerId,
  subjectProfileId,
  subjectType,
  fallbackPhotoUrl,
  fallbackLabel,
  brandColor,
  testId = "subject-profile-section",
}: SubjectProfileSectionProps) {
  const navigate = useNavigate();

  const t = (subjectType || "").toLowerCase();
  const endpoint = t === "surrogate" ? "surrogates" : t.includes("sperm") ? "sperm-donors" : "egg-donors";
  const apiPath = providerId && subjectProfileId && subjectType
    ? `/api/providers/${providerId}/${endpoint}/${subjectProfileId}`
    : null;

  const { data: profileData, isLoading } = useQuery<any>({
    queryKey: ["subject-profile-sidebar", providerId, subjectProfileId],
    queryFn: async () => {
      const res = await fetch(apiPath!, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!apiPath,
    staleTime: 300000,
  });

  if (!providerId || !subjectProfileId || !subjectType) return null;

  const isSurrogate = t === "surrogate";
  const isSperm = t.includes("sperm");
  const title = isSurrogate ? "Interested Surrogate" : isSperm ? "Interested Sperm Donor" : "Interested Egg Donor";

  const swipeProfile = profileData
    ? isSurrogate
      ? mapDatabaseSurrogateToSwipeProfile(profileData)
      : isSperm
        ? mapDatabaseSpermDonorToSwipeProfile(profileData)
        : mapDatabaseDonorToSwipeProfile(profileData)
    : null;

  const photo = swipeProfile?.photos?.[0] || swipeProfile?.photoUrl || fallbackPhotoUrl || null;
  const sections = swipeProfile ? buildSidebarSections(swipeProfile, isSperm) : [];
  const label = swipeProfile ? buildTitle(swipeProfile) : (fallbackLabel || null);
  const slug = getProfileUrlSlug(subjectType);
  const fullProfileUrl = `/${slug}/${providerId}/${subjectProfileId}`;

  return (
    <div className="border-t pt-4 mt-4" data-testid={testId}>
      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>{title}</h4>
      {isLoading && !profileData ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading profile...
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5 mb-2">
            {photo ? (
              <div className="w-10 h-10 rounded-full overflow-hidden bg-muted shrink-0">
                <img
                  src={getPhotoSrc(photo) || undefined}
                  alt={label || "Profile"}
                  className="w-full h-full object-cover object-top"
                />
              </div>
            ) : (
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0"
                style={{ backgroundColor: brandColor }}
              >
                {(label || "?").charAt(0)}
              </div>
            )}
            <p className="text-sm font-semibold leading-tight">{label || "-"}</p>
          </div>
          <button
            type="button"
            className="text-xs flex items-center gap-1 mb-3"
            style={{ color: brandColor }}
            onClick={() => navigate(fullProfileUrl)}
            data-testid={`${testId}-view-full`}
          >
            <ExternalLink className="w-3 h-3" />
            View Full Profile
          </button>
          {sections.map((section, i) => (
            <div key={i} className={i > 0 ? "border-t pt-2 mt-2" : "mt-1"}>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                {section.title}
              </p>
              <div className="space-y-1">
                {section.rows.map((row, j) => (
                  <div key={j} className="flex items-center gap-1.5 text-xs">
                    {row.icon && <row.icon className="w-3 h-3 text-muted-foreground shrink-0" />}
                    <span className="text-muted-foreground shrink-0">{row.label}:</span>
                    <span className="text-foreground">{row.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
