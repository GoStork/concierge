import { ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getPhotoSrc } from "@/lib/profile-utils";
import { InlineBookingCalendar } from "@/pages/concierge-chat-page";
import { RatingBadge } from "@/components/reviews/reviews-ui";

// Provider-type chip under the name. The card serves EVERY provider type
// (agency, clinic, law firm, banks, wellness) - the label derives from the
// provider's approved services instead of the old hardcoded "Agency".
function providerTypeLabel(serviceNames: string[]): string {
  const svc = serviceNames.map((n) => n.toLowerCase());
  if (svc.some((n) => n.includes("legal"))) return "Law Firm";
  if (svc.some((n) => n.includes("ivf") || n.includes("clinic"))) return "Clinic";
  if (svc.some((n) => n.includes("surrogacy") || n.includes("egg donor"))) return "Agency";
  if (svc.some((n) => n.includes("egg bank") || n.includes("sperm bank"))) return "Donor Bank";
  if (svc.some((n) => n.includes("therapist"))) return "Therapy";
  if (svc.some((n) => n.includes("genetic"))) return "Genetic Counseling";
  if (svc.some((n) => n.includes("nutrition"))) return "Nutrition";
  if (svc.some((n) => n.includes("coach"))) return "Coaching";
  if (svc.some((n) => n.includes("doula"))) return "Doula";
  return "Provider";
}

export interface ProviderProfileCardCalendar {
  slug: string;
  memberName: string | null | undefined;
  existingBooking?: any;
  consultationMeta?: {
    aiSessionId?: string;
    matchmakerId?: string | null;
    profileLabel?: string | null;
    profilePhotoUrl?: string | null;
    providerId?: string;
    subjectProfileId?: string | null;
    subjectType?: string | null;
  };
  onBookingConfirmed?: (meta: { providerId?: string; subjectProfileId?: string | null }) => void;
  /** When set, prefills the booking form with this parent's contact info and shows a banner. Used by admin to book on behalf. */
  onBehalfOf?: { name: string; email: string; phone?: string | null } | null;
}

export interface ProviderProfileCardProps {
  providerId: string | null | undefined;
  providerName: string | null | undefined;
  providerLogo?: string | null;
  brandColor: string;
  calendar?: ProviderProfileCardCalendar | null;
  /** Hide the "View Provider" drill-in link (e.g. on the provider's own profile page). */
  hideViewLink?: boolean;
  testId?: string;
}

/**
 * Shared provider widget rendered in the parent chat sidebar (desktop) and
 * the mobile chat context drawer. Renders the agency (logo + name), the
 * coordinator + booking calendar (when calendar is provided), and a
 * "View Provider" drill-in link to /providers/:id.
 */
export function ProviderProfileCard({
  providerId,
  providerName,
  providerLogo,
  brandColor,
  calendar,
  hideViewLink,
  testId = "provider-profile-card",
}: ProviderProfileCardProps) {
  const navigate = useNavigate();

  const providerQuery = useQuery({
    queryKey: ["provider-card-type", providerId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${providerId}`, { credentials: "include" });
      if (!res.ok) throw new Error("provider fetch failed");
      return res.json();
    },
    enabled: !!providerId,
    staleTime: 5 * 60_000,
  });
  const serviceNames: string[] = (providerQuery.data?.services || [])
    .map((sv: any) => sv?.providerType?.name)
    .filter(Boolean);
  const typeLabel = serviceNames.length > 0 ? providerTypeLabel(serviceNames) : null;
  const isLawFirm = typeLabel === "Law Firm";

  if (!providerId && !providerName) return null;

  const initial = (providerName || "P").charAt(0);

  return (
    <div className="space-y-3" data-testid={testId}>
      <div className="flex items-center gap-2.5">
        {providerLogo ? (
          <img
            src={getPhotoSrc(providerLogo) || undefined}
            alt={providerName || "Provider"}
            className="w-9 h-9 rounded-full object-contain p-0.5 border bg-background"
          />
        ) : (
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-primary-foreground text-sm font-bold shrink-0"
            style={{ backgroundColor: brandColor }}
          >
            {initial}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{providerName || "Provider"}</p>
          {/* The GoStork house profile is the concierge team, not a provider */}
          {(providerName || "").trim().toLowerCase() !== "gostork" && typeLabel && (
            <p className="t-micro-label">{typeLabel}</p>
          )}
          {/* Verified-parent rating - hidden while the agency identity is masked
              pre-booking (a rating on an anonymous card is just noise). */}
          {!/^the (surrogate|egg donor|sperm donor)'s agency$/i.test(providerName || "") && (
            <RatingBadge avg={providerQuery.data?.avgOverallScore} count={providerQuery.data?.reviewCount} size={11} />
          )}
        </div>
      </div>

      {!hideViewLink && providerId && (
        <button
          type="button"
          onClick={() => navigate(`/providers/${providerId}`)}
          className="inline-flex items-center gap-1 text-xs"
          style={{ color: brandColor }}
          data-testid={`${testId}-view-link`}
        >
          <ExternalLink className="w-3 h-3" />
          View Provider
        </button>
      )}

      {calendar?.slug && (
        <div className="border-t pt-3">
          <p className="t-micro-label mb-1">{isLawFirm ? "Attorney" : "Coordinator"}</p>
          {calendar.memberName && (
            <p className="text-sm font-medium mb-3">{calendar.memberName}</p>
          )}
          {calendar.onBehalfOf && (
            <div
              className="mb-3 text-xs rounded-[var(--radius)] px-3 py-2 bg-accent/30 border"
              data-testid={`${testId}-on-behalf-banner`}
            >
              Booking on behalf of <span className="font-semibold">{calendar.onBehalfOf.name}</span>
            </div>
          )}
          <InlineBookingCalendar
            slug={calendar.slug}
            memberName={calendar.memberName || "Coordinator"}
            brandColor={brandColor}
            existingBooking={calendar.existingBooking}
            consultationMeta={calendar.consultationMeta}
            autoResetOnCancel
            showCalendarOnExpiry
            onBookingConfirmed={calendar.onBookingConfirmed}
            prefill={calendar.onBehalfOf ? {
              name: calendar.onBehalfOf.name,
              email: calendar.onBehalfOf.email,
              phone: calendar.onBehalfOf.phone || "",
            } : undefined}
          />
        </div>
      )}
    </div>
  );
}
