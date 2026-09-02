import { useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { recordProfileView, recordProfileOpen } from "@/lib/profile-views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProfileSection } from "@/components/ui/profile-section";
import { IvfSuccessRatesSection, useIvfFilterContext, ivfContextSearch, type IvfFilterContext } from "@/components/ivf-success-rates-section";
import { pickClinicRate } from "@/lib/clinic-rate";
import { ClinicCostProgramsSection } from "@/components/clinic-cost-programs-section";
import { InsuranceSection } from "@/components/insurance-section";
import {
  ArrowLeft, MapPin, Building2, Loader2, GraduationCap, Award, Globe,
  Stethoscope, Heart, Video, BadgeCheck, Star, Pencil,
} from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { DoctorAvatar } from "@/components/marketplace/doctor-monogram";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCloseButton } from "@/components/mobile-profile-close-header";
import { useAuth } from "@/hooks/use-auth";
import { ReviewsSection, useHasReviewsContent } from "@/components/reviews/reviews-ui";

const AGE_LABELS: Record<string, string> = {
  under_35: "under 35",
  "35_37": "35-37",
  "38_40": "38-40",
  over_40: "over 40",
};

/**
 * The headline rate for one clinic affiliation.
 *
 * Delegates to pickClinicRate - the same resolver the clinic card and the
 * comparison table use - so a doctor's affiliation chip and that clinic's own
 * profile quote the same figure. This was previously a local re-implementation
 * that picked the all-patients row regardless of the parent's context AND
 * rounded the raw value without scaling it: successRate is stored as a fraction,
 * so a 78% clinic rendered "1%" and anything under 50% rounded to 0 and was
 * dropped by the guard below. That chip could never show a correct number.
 */
function headlineRate(
  rates: any[] | undefined,
  ctx: IvfFilterContext | undefined,
): { value: number; label: string } | null {
  const { rate, isFallback } = pickClinicRate(rates || [], {
    eggSource: ctx?.eggSource,
    ageGroup: ctx?.ageGroup,
    isNewPatient: ctx?.isNewPatient !== undefined ? ctx.isNewPatient !== "false" : undefined,
  });
  if (!rate || rate.successRate == null) return null;
  const value = Math.round(Number(rate.successRate) * 100);
  if (!Number.isFinite(value) || value <= 0) return null;

  const isDonor = rate.profileType === "donor";
  const age = AGE_LABELS[rate.ageGroup] || rate.ageGroup;
  // pickClinicRate's contract: a fallback row describes a population this parent
  // may not be in, so it must never be presented bare.
  const label = isDonor
    ? "Live birth · donor eggs"
    : `Live birth · ${age}, own eggs${isFallback ? " (not your profile)" : ""}`;
  return { value, label };
}

function formatLocation(l: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }) {
  return [l.address, l.city, l.state, l.zip].filter(Boolean).join(", ");
}

export default function DoctorProfilePage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { user } = useAuth();

  const { data: doctor, isLoading, isError } = useQuery<any>({
    queryKey: ["/api/providers/doctors", slug],
    queryFn: async () => {
      const res = await fetch(`/api/providers/doctors/${slug}`, { credentials: "include" });
      if (!res.ok) throw new Error("Doctor not found");
      return res.json();
    },
    enabled: !!slug,
  });

  const isParentViewer = !!(user as any)?.parentAccountId && !(user as any)?.providerId;
  const filterContext = useIvfFilterContext();
  // Above the early returns below so hook order stays stable. The queries
  // no-op until the doctor resolves, and share ReviewsSection's cache.
  const hasReviewsContent = useHasReviewsContent({ memberId: doctor?.id ?? null, isParent: isParentViewer });

  // Opening a doctor's full profile is an impression (doctors are keyed by
  // slug in the marketplace/analytics). Idempotent + deduped server-side.
  useEffect(() => {
    if (!slug) return;
    if (window.location.pathname.startsWith("/admin/")) return;
    recordProfileView(slug, "doctor" as any);
    recordProfileOpen(slug, "doctor"); // click-through (VIEW) event
  }, [slug]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isError || !doctor) {
    return (
      <div className="space-y-4 p-6">
        <Button variant="ghost" onClick={() => navigate(-1)} data-testid="link-back">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        <p className="text-muted-foreground text-center py-8" data-testid="text-not-found">Doctor not found.</p>
      </div>
    );
  }

  const affiliations: any[] = doctor.affiliations || [];
  const acceptedInsurance: string[] = Array.from(
    new Set(affiliations.flatMap((a) => a.acceptedInsurance || [])),
  ).sort();
  // Same clinic the swipe card uses for its success-rate and cost tabs.
  const primaryClinic: any = affiliations[0] || null;
  const reviews: any[] = doctor.reviews || [];
  const hasReviews = (doctor.reviewCount ?? 0) > 0 && reviews.length > 0;

  return (
    <div className="space-y-6 w-full">
      {/* Desktop: the "Back" text link (hidden on mobile). */}
      <div className={`flex items-center justify-between ${isMobile ? "hidden" : ""}`}>
        <Button variant="ghost" onClick={() => navigate(-1)} data-testid="link-back">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        {/* The owning clinic (or a GoStork admin) edits the doctor via their
            Team Member card - same pattern as the surrogate profile's Edit. */}
        {(() => {
          const roles: string[] = (user as any)?.roles || [];
          const isGostorkAdmin = roles.includes("GOSTORK_ADMIN");
          const ownsDoctor = !!(user as any)?.providerId && (user as any).providerId === doctor.providerId;
          if (!isGostorkAdmin && !ownsDoctor) return null;
          const target = ownsDoctor
            ? `/account/company?editMember=${doctor.id}`
            : `/admin/providers/${doctor.providerId}?tab=profile`;
          return (
            <Button variant="outline" onClick={() => navigate(target)} data-testid="btn-edit-doctor-profile">
              <Pencil className="w-4 h-4 mr-2" /> Edit Profile
            </Button>
          );
        })()}
      </div>

      {/* Header */}
      <div className="flex items-start gap-5">
        {/* Falls back to the monogram when the stored photo URL is dead - a
            scraped clinic headshot can 404 long after we saved it. */}
        <DoctorAvatar
          name={doctor.name}
          photoUrl={doctor.photoUrl}
          size={96}
          className="border border-border/30"
          data-testid="img-doctor-photo"
        />
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-heading text-foreground" data-testid="text-doctor-name">
            {doctor.name}{doctor.credential ? `, ${doctor.credential}` : ""}
          </h1>
          {doctor.title && <p className="text-sm text-primary font-ui mt-0.5">{doctor.title}</p>}
          {doctor.npiTaxonomy && (
            <p className="t-helper mt-0.5">{doctor.npiTaxonomy}</p>
          )}

          <div className="flex flex-wrap gap-2 mt-3">
            {doctor.isMedicalDirector && (
              <Badge className="bg-accent text-accent-foreground gap-1"><BadgeCheck className="w-3 h-3" /> Medical Director</Badge>
            )}
            {doctor.acceptingNewPatients && (
              <Badge className="bg-[hsl(var(--brand-success))]/15 text-[hsl(var(--brand-success))] gap-1 border-0">
                <Heart className="w-3 h-3" /> Accepting new patients
              </Badge>
            )}
            {doctor.offersVideoVisits && (
              <Badge variant="secondary" className="gap-1"><Video className="w-3 h-3" /> Video visits</Badge>
            )}
            {affiliations.some((a) => a.lgbtqCare) && (
              <Badge className="bg-accent/60 text-accent-foreground gap-1">LGBTQ+ care</Badge>
            )}
          </div>
        </div>
        {isMobile && (
          <div className="ml-auto self-start">
            <MobileCloseButton onClose={() => navigate(-1)} />
          </div>
        )}
      </div>

      {/* About */}
      {doctor.bio && (
        <ProfileSection title="About" data-testid="section-about">
            <p className="t-prompt-answer whitespace-pre-line">{doctor.bio}</p>
        </ProfileSection>
      )}

      {/* Specialties */}
      {doctor.specialties?.length > 0 && (
        <ProfileSection title="Specialties" contentClassName="p-6" data-testid="section-specialties">
            <div className="flex flex-wrap gap-2">
              {doctor.specialties.map((s: string) => (
                <Badge key={s} variant="secondary">{s}</Badge>
              ))}
            </div>
        </ProfileSection>
      )}

      {/* Education & background */}
      {(doctor.boardCertifications?.length > 0 ||
        doctor.education?.length > 0 ||
        doctor.professionalMemberships?.length > 0 ||
        doctor.languagesSpoken?.length > 0 ||
        doctor.medicalSchool ||
        doctor.npiNumber ||
        doctor.providerGender ||
        doctor.yearsExperience != null) && (
        <ProfileSection title="Education & Background" contentClassName="p-6 grid grid-cols-1 sm:grid-cols-2 gap-6" data-testid="section-education">
            {doctor.boardCertifications?.length > 0 && (
              <div>
                <p className="t-field-label mb-2 flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5 text-primary" /> Board Certifications
                </p>
                <ul className="space-y-1">
                  {doctor.boardCertifications.map((c: string) => (
                    <li key={c} className="t-field-value">{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {doctor.education?.length > 0 && (
              <div>
                <p className="t-field-label mb-2 flex items-center gap-1.5">
                  <GraduationCap className="w-3.5 h-3.5 text-primary" /> Education & Training
                </p>
                <ul className="space-y-1">
                  {doctor.education.map((e: string) => (
                    <li key={e} className="t-field-value">{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {doctor.professionalMemberships?.length > 0 && (
              <div>
                <p className="t-field-label mb-2">Professional Memberships</p>
                <ul className="space-y-1">
                  {doctor.professionalMemberships.map((m: string) => (
                    <li key={m} className="t-field-value">{m}</li>
                  ))}
                </ul>
              </div>
            )}
            {doctor.languagesSpoken?.length > 0 && (
              <div>
                <p className="t-field-label mb-2 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-primary" /> Languages Spoken
                </p>
                <div className="flex flex-wrap gap-2">
                  {doctor.languagesSpoken.map((l: string) => (
                    <Badge key={l} variant="outline">{l}</Badge>
                  ))}
                </div>
              </div>
            )}
            {doctor.medicalSchool && (
              <div>
                <p className="t-field-label">Medical School</p>
                <p className="t-field-value">
                  {doctor.medicalSchool}{doctor.graduationYear ? ` (${doctor.graduationYear})` : ""}
                </p>
              </div>
            )}
            {doctor.yearsExperience != null && (
              <div>
                <p className="t-field-label">Years of Experience</p>
                <p className="t-field-value">{doctor.yearsExperience}</p>
              </div>
            )}
            {doctor.providerGender && (
              <div>
                <p className="t-field-label">Provider's Gender</p>
                <p className="t-field-value">{doctor.providerGender}</p>
              </div>
            )}
            {doctor.npiNumber && (
              <div>
                <p className="t-field-label">NPI Number</p>
                <p className="t-field-value">{doctor.npiNumber}</p>
              </div>
            )}
        </ProfileSection>
      )}

      {/* Where this doctor practices. Sits directly under the credentials:
          which clinic they are in, and where, is part of choosing a doctor, so
          it comes before the clinic-level detail (insurance, rates, costs)
          below rather than after it. */}
      <ProfileSection title={affiliations.length > 1 ? `Practices At ${affiliations.length} Clinics` : "Practices At"} contentClassName="p-6 grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="section-affiliations">
          {affiliations.map((a) => {
            const logo = getPhotoSrc(a.logoUrl);
            const rate = headlineRate(a.successRates, filterContext);
            const locs = (a.memberLocations?.length ? a.memberLocations : a.clinicLocations) || [];
            return (
              <Link
                key={a.memberId}
                to={`/providers/${a.providerId}${ivfContextSearch(filterContext)}`}
                className="group no-underline border border-border/40 rounded-[var(--radius)] p-4 flex flex-col gap-3 hover:border-primary hover:bg-secondary/30 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
                data-testid={`affiliation-${a.providerId}`}
              >
                <div className="flex items-start gap-3">
                  {logo ? (
                    <img src={logo} alt={a.providerName} className="w-12 h-12 rounded-[var(--radius)] object-contain border border-border/30 bg-background p-0.5 shrink-0" />
                  ) : (
                    <div className="w-12 h-12 rounded-[var(--radius)] bg-secondary/30 flex items-center justify-center border border-border/30 shrink-0">
                      <Building2 className="w-6 h-6 text-muted-foreground/40" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-ui text-sm text-foreground group-hover:text-primary transition-colors">{a.providerName}</p>
                    {a.title && <p className="text-xs text-primary">{a.title}</p>}
                    {locs.length > 0 && (
                      <p className="t-helper mt-1 flex items-start gap-1">
                        <MapPin className="w-3 h-3 shrink-0 mt-0.5" />
                        <span>{locs.map((l: any) => [l.city, l.state].filter(Boolean).join(", ")).filter(Boolean).join(" · ")}</span>
                      </p>
                    )}
                  </div>
                </div>

                {rate && (
                  <div className="bg-secondary/40 rounded-[var(--radius)] px-3 py-2">
                    <p className="text-lg font-heading text-foreground leading-none">{rate.value}%</p>
                    <p className="t-helper mt-1">{rate.label} (CDC)</p>
                  </div>
                )}
              </Link>
            );
          })}
      </ProfileSection>

      {/* Insurances accepted (clinic-level, unioned across affiliations). */}
      <InsuranceSection insurance={acceptedInsurance} />

      {/* Success rates and costs belong to the doctor's primary clinic, not to
          the doctor - but the doctor's swipe card shows both, so the profile
          has to as well or opening a card loses information. Attributed to the
          clinic so nobody reads a clinic's rates as this doctor's own. */}
      {primaryClinic?.successRates?.length > 0 && (
        <IvfSuccessRatesSection rates={primaryClinic.successRates} filterContext={filterContext} />
      )}
      {primaryClinic?.providerId && (
        <ClinicCostProgramsSection
          providerId={primaryClinic.providerId}
          parentAccountId={(user as any)?.parentAccountId ?? null}
          hasIvfClinicService={true}
        />
      )}

      {/* Reviews - shared Phase 8 component (list + eligible-parent self-serve
          form). Hidden when there is nothing to read and nothing to do, same
          rule as provider profiles. The explainer below therefore only appears
          for an eligible parent looking at a doctor with no reviews yet, which
          is exactly when it earns its place. */}
      {hasReviewsContent && (
      <ProfileSection title="Patient Reviews" data-testid="section-reviews">
          <ReviewsSection
            memberId={doctor.id}
            targetLabel={doctor.name}
            isParent={isParentViewer}
          />
          {!hasReviews && (
            <p className="t-helper max-w-sm mt-2">
              GoStork reviews come from intended parents after a verified consultation, so every review is from someone who actually met with this doctor.
            </p>
          )}
      </ProfileSection>
      )}
    </div>
  );
}
