import { useMemo, useState, useEffect } from "react";
import { useParams, useNavigate, useSearchParams, useLocation, Link } from "react-router-dom";
import { recordProfileView, recordProfileOpen } from "@/lib/profile-views";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, Globe, Phone, MapPin, Building2, CheckCircle2, XCircle,
  Loader2, Check,
} from "lucide-react";
import { ProfileSection } from "@/components/ui/profile-section";
import { IvfSuccessRatesSection, useIvfFilterContext, ivfContextSearch } from "@/components/ivf-success-rates-section";
import { InsuranceSection } from "@/components/insurance-section";
import { ClinicCostProgramsSection } from "@/components/clinic-cost-programs-section";
import {
  ClinicServicesSection, ClinicExperienceSection, ClinicParentMatchingSection, ClinicPracticeSection,
  ClinicSurrogateMatchingSection,
} from "@/components/clinic-cdc-sections";
import { getPhotoSrc } from "@/lib/profile-utils";
import { DoctorAvatar } from "@/components/marketplace/doctor-monogram";
import { dedupeProviderLocations } from "@/lib/format-location";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCloseButton } from "@/components/mobile-profile-close-header";
import { ReviewsSection, RatingBadge, useHasReviewsContent } from "@/components/reviews/reviews-ui";
import { Field } from "@/components/ui/field";

function FieldItem({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return <Field label={label} value={value} data-testid={`field-${label.toLowerCase().replace(/\s+/g, "-")}`} />;
}

export default function ProviderProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const chatState = location.state as { fromChat?: boolean; chatPath?: string } | null;
  const fromChat = chatState?.fromChat === true;
  const chatPath = chatState?.chatPath || "/chat";
  const isParentViewer = !!(user as any)?.parentAccountId && !(user as any)?.providerId;
  // Shares ReviewsSection's query keys, so this costs no extra requests.
  const hasReviewsContent = useHasReviewsContent({ providerId: id, isParent: isParentViewer });

  const filterContext = useIvfFilterContext();

  const { data: provider, isLoading } = useQuery<any>({
    queryKey: ["/api/providers", id],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Provider not found");
      return res.json();
    },
    enabled: !!id,
  });

  // Doctors only for the parent-facing team list. isClinician is computed
  // server-side (clinician.ts) so this page and the marketplace agree.
  const doctorMembers: any[] = useMemo(
    () => ((provider as any)?.members || []).filter((m: any) => m.isClinician !== false),
    [provider],
  );

  const approvedServices = useMemo(() => {
    if (!provider?.services) return [];
    return provider.services.filter((s: any) => s.status === "APPROVED");
  }, [provider]);

  // Opening a provider's full profile is an impression. Surrogacy agencies
  // and IVF clinics share this page, so key the view by the right type
  // (analytics matches by profileId, but the type keeps the record honest).
  // Idempotent + deduped server-side; admin views have no parent account.
  useEffect(() => {
    if (!id || !provider) return;
    if (window.location.pathname.startsWith("/admin/")) return;
    const svcNames = (provider.services || []).map((s: any) => s.providerType?.name?.toLowerCase() || "");
    const viewType = svcNames.some((n: string) => n.includes("surrogacy")) ? "agency" : "clinic";
    recordProfileView(id, viewType as any);
    recordProfileOpen(id, viewType); // click-through (VIEW) event
  }, [id, provider]);

  const surrogacyProfile = provider?.surrogacyProfile;
  const screening = surrogacyProfile?.screening;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => fromChat ? navigate(chatPath) : navigate(-1)} data-testid="link-back-marketplace">
          <ArrowLeft className="w-4 h-4 mr-2" /> {fromChat ? "Back to Chat" : "Back to Marketplace"}
        </Button>
        <p className="text-muted-foreground text-center py-8" data-testid="text-not-found">Provider not found.</p>
      </div>
    );
  }

  const logoSrc = getPhotoSrc(provider.logoUrl);
  const serviceNames: string[] = (provider.services || []).map((s: any) => s.providerType?.name?.toLowerCase() || "");
  const isIvfClinic = serviceNames.some((n: string) => n.includes("ivf") || n.includes("in vitro"));

  return (
    <div className="space-y-6 w-full">
      {/* Desktop: the "Back to Marketplace" text link (hidden on mobile). */}
      <div className={`flex items-center justify-between ${isMobile ? "hidden" : ""}`}>
        <Button variant="ghost" onClick={() => fromChat ? navigate(chatPath) : navigate(-1)} data-testid="link-back-marketplace">
          <ArrowLeft className="w-4 h-4 mr-2" /> {fromChat ? "Back to Chat" : "Back to Marketplace"}
        </Button>
      </div>

      <div className="flex items-start gap-5">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={provider.name}
            className="w-20 h-20 rounded-[var(--radius)] object-contain border border-border/30 shrink-0 bg-background p-1"
            data-testid="img-provider-logo"
          />
        ) : (
          <div className="w-20 h-20 rounded-[var(--radius)] bg-secondary/30 flex items-center justify-center border border-border/30 shrink-0">
            <Building2 className="w-10 h-10 text-muted-foreground/30" />
          </div>
        )}
        <div>
          <h1 className="font-display text-2xl font-heading text-foreground" data-testid="text-provider-name">
            {provider.name}
          </h1>
          {/* Clickable: jumps to the Parent Reviews section below. */}
          <button
            type="button"
            onClick={() => document.getElementById("parent-reviews-section")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="block hover:opacity-75 transition-opacity"
            aria-label="Jump to reviews"
            data-testid="hero-rating-jump"
          >
            <RatingBadge avg={provider.avgOverallScore} count={provider.reviewCount} />
          </button>
          <div className="flex flex-wrap gap-1 mt-1">
            {approvedServices.map((s: any) => (
              <Badge key={s.id} variant="secondary" className="text-xs" data-testid={`badge-service-${s.id}`}>
                {s.providerType?.name || "Service"}
              </Badge>
            ))}
          </div>
          {provider.websiteUrl && (
            <a
              href={provider.websiteUrl.startsWith("http") ? provider.websiteUrl : `https://${provider.websiteUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1 mt-1"
              data-testid="link-website"
            >
              <Globe className="h-3.5 w-3.5" /> {provider.websiteUrl}
            </a>
          )}
        </div>
        {isMobile && (
          <div className="ml-auto self-start">
            <MobileCloseButton onClose={() => fromChat ? navigate(chatPath) : navigate(-1)} />
          </div>
        )}
      </div>

      <ProfileSection title="Company Information" data-testid="section-company-info">
          <div className="grid grid-cols-2 gap-x-12 gap-y-3">
            <FieldItem label="Provider Name" value={provider.name} />
            <FieldItem label="Year Founded" value={provider.yearFounded ? String(provider.yearFounded) : null} />
            <FieldItem label="Phone" value={provider.phone ? formatPhoneDisplay(provider.phone) : null} />
            <FieldItem label="Email" value={provider.email} />
            {provider.websiteUrl && <FieldItem label="Website" value={provider.websiteUrl} />}
          </div>
          {provider.about && (
            <div className="mt-4" data-testid="field-about">
              <p className="t-field-label">About</p>
              <p className="t-prompt-answer whitespace-pre-line mt-1">{provider.about}</p>
            </div>
          )}
      </ProfileSection>

      {/* The clinic facts a parent already sees on the swipe card, in full.
          Each self-gates on its CDC data, and all of them share lib/clinic-cdc
          with the card so the two surfaces can never diverge. */}
      <ClinicServicesSection cdcServices={provider.cdcServices} />

      {provider.ivfSuccessRates && provider.ivfSuccessRates.length > 0 && (
        <IvfSuccessRatesSection rates={provider.ivfSuccessRates} filterContext={filterContext} />
      )}

      <ClinicExperienceSection cdcExperience={provider.cdcExperience} />

      <ClinicPracticeSection cdcCycleStats={provider.cdcCycleStats} />

      {/* In-network insurance. The field lives on the clinic and already powers
          the marketplace insurance filter and the clinic card, but the clinic's
          own profile never rendered it - a parent could see it on a doctor's
          page and not on the clinic it actually belongs to. */}
      <InsuranceSection insurance={provider.acceptedInsurance} />

      {(() => {
        // The cost-programs section now serves every fertility-tier provider
        // (IVF, Surrogacy, Egg Donor, Sperm Bank). Server-side matching
        // filters to whatever applies to this parent's journey state.
        const hasFertilityTierService = serviceNames.some((n: string) =>
          n.includes("ivf") ||
          n.includes("clinic") ||
          n.includes("surrogacy") ||
          n.includes("egg donor") ||
          n.includes("egg bank") ||
          n.includes("sperm bank") ||
          n.includes("sperm donor")
        );
        return (
          <ClinicCostProgramsSection
            providerId={provider.id}
            parentAccountId={(user as any)?.parentAccountId ?? null}
            hasIvfClinicService={hasFertilityTierService}
          />
        );
      })()}

      {isIvfClinic && <ClinicParentMatchingSection provider={provider} />}

      {isIvfClinic && <ClinicSurrogateMatchingSection provider={provider} />}

      {(() => {
        const locations = dedupeProviderLocations(provider.locations || []);
        return locations.length > 0 && (
        <ProfileSection title="Locations" contentClassName="p-6 space-y-3" data-testid="section-locations">
            {locations.map((loc: any, idx: number) => {
              const parts = [loc.address, loc.city, loc.state, loc.zip].filter(Boolean);
              if (parts.length === 0) return null;
              return (
                <div key={loc.id || idx} className="flex items-start gap-2" data-testid={`location-${idx}`}>
                  <MapPin className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <p className="t-field-value">{parts.join(", ")}</p>
                </div>
              );
            })}
        </ProfileSection>
        );
      })()}

      {/* Doctors only, matching the marketplace Doctors directory. The server
          flags each member via isClinicianMember; practice directors, lab
          directors and office staff are managed in the admin team editor but
          are not what a parent is choosing between here. */}
      {doctorMembers.length > 0 && (
        <ProfileSection title={doctorMembers.length > 1 ? "Doctors" : "Doctor"} data-testid="section-team">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {doctorMembers.map((member: any) => {
                const memberLocations = member.locations
                  ?.map((ml: any) => {
                    const l = ml.location;
                    return [l?.city, l?.state].filter(Boolean).join(", ");
                  })
                  .filter(Boolean);

                const inner = (
                  <>
                    {/* Shared avatar: initials when there is no photo, and when a
                        stored (scraped) photo URL has since gone dead. */}
                    <DoctorAvatar
                      name={member.name}
                      photoUrl={member.photoUrl}
                      size={56}
                      className="border border-border/30"
                    />
                    <div className="min-w-0">
                      <p className="font-ui text-sm text-foreground group-hover:text-primary transition-colors">{member.name}</p>
                      {member.title && (
                        <p className="text-xs text-primary font-ui">{member.title}</p>
                      )}
                      {member.bio && (
                        <p className="t-helper mt-1 line-clamp-3">{member.bio}</p>
                      )}
                      {memberLocations && memberLocations.length > 0 && (
                        <p className="t-helper mt-1 flex items-center gap-1">
                          <MapPin className="w-3 h-3 shrink-0" />
                          {memberLocations.join(" · ")}
                        </p>
                      )}
                    </div>
                  </>
                );

                return member.slug ? (
                  <Link
                    key={member.id}
                    to={`/doctors/${member.slug}${ivfContextSearch(filterContext)}`}
                    className="group no-underline flex gap-3 p-3 rounded-[var(--radius)] border border-transparent hover:border-border/50 hover:bg-secondary/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
                    data-testid={`member-${member.id}`}
                  >
                    {inner}
                  </Link>
                ) : (
                  <div key={member.id} className="flex gap-3 p-3 rounded-[var(--radius)] border border-transparent" data-testid={`member-${member.id}`}>
                    {inner}
                  </div>
                );
              })}
            </div>
        </ProfileSection>
      )}

      {surrogacyProfile && (
        <ProfileSection title="Surrogacy Agency Details" data-testid="section-surrogacy-details">
            <div className="grid grid-cols-2 gap-x-12 gap-y-3">
              <FieldItem
                label="Number of Babies Born"
                value={surrogacyProfile.numberOfBabiesBorn != null ? String(surrogacyProfile.numberOfBabiesBorn) : null}
              />
              <FieldItem label="Time to Match" value={surrogacyProfile.timeToMatch} />
              <FieldItem
                label="Families per Coordinator"
                value={surrogacyProfile.familiesPerCoordinator != null ? String(surrogacyProfile.familiesPerCoordinator) : null}
              />
            </div>
        </ProfileSection>
      )}

      {screening && (
        <ProfileSection title="Surrogate Screening Process" data-testid="section-screening">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { label: "Criminal Background Check", value: screening.criminalBackgroundCheck },
                { label: "Home Visits", value: screening.homeVisits },
                { label: "Financials Review", value: screening.financialsReview },
                { label: "Social Worker Screening", value: screening.socialWorkerScreening },
                { label: "Medical Records Review", value: screening.medicalRecordsReview },
                { label: "Surrogate Insurance Review", value: screening.surrogateInsuranceReview },
                { label: "Psychological Screening", value: screening.psychologicalScreening },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center gap-2" data-testid={`screening-${label.toLowerCase().replace(/\s+/g, "-")}`}>
                  {value ? (
                    <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                  )}
                  <span className="t-field-value">{label}</span>
                </div>
              ))}
            </div>
        </ProfileSection>
      )}

      {/* Phase 8: verified-parent reviews (display-only; self-serve write when
          eligible). Hidden entirely when there is nothing to read and nothing
          to do - an empty "Reviews / No reviews yet" card is noise on a
          provider's profile. An eligible parent still sees it so the first
          review can be written. */}
      {!window.location.pathname.startsWith("/admin/") && hasReviewsContent && (
        <div id="parent-reviews-section" className="scroll-mt-24">
        <ProfileSection title="Parent Reviews" data-testid="section-reviews">
          <ReviewsSection
            providerId={provider.id}
            targetLabel={provider.name}
            isParent={isParentViewer}
          />
        </ProfileSection>
        </div>
      )}
    </div>
  );
}
