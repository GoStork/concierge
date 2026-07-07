import { useMemo, useState, useEffect } from "react";
import { useParams, useNavigate, useSearchParams, useLocation, Link } from "react-router-dom";
import { recordProfileView, recordProfileOpen } from "@/lib/profile-views";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, Globe, Phone, MapPin, Calendar, Building2, User, CheckCircle2, XCircle,
  Loader2, Check,
} from "lucide-react";
import { ProfileSection } from "@/components/ui/profile-section";
import { IvfSuccessRatesSection } from "@/components/ivf-success-rates-section";
import { ClinicCostProgramsSection } from "@/components/clinic-cost-programs-section";
import { getPhotoSrc } from "@/lib/profile-utils";
import { getCountryFlag } from "@/lib/country-flag";
import { dedupeProviderLocations } from "@/lib/format-location";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCloseButton } from "@/components/mobile-profile-close-header";

function FieldItem({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div data-testid={`field-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className="text-base font-ui text-foreground">{label}</p>
      <p className="text-base text-foreground">{value}</p>
    </div>
  );
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

  const filterContext = useMemo(() => {
    const eggSource = searchParams.get("eggSource");
    const ageGroup = searchParams.get("ageGroup");
    const isNewPatient = searchParams.get("isNewPatient");
    if (!eggSource && !ageGroup) return undefined;
    return {
      ...(eggSource ? { eggSource } : {}),
      ...(ageGroup ? { ageGroup } : {}),
      ...(isNewPatient ? { isNewPatient } : {}),
    };
  }, [searchParams]);

  const { data: provider, isLoading } = useQuery<any>({
    queryKey: ["/api/providers", id],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Provider not found");
      return res.json();
    },
    enabled: !!id,
  });

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
              <p className="text-base font-ui text-foreground">About</p>
              <p className="text-base text-foreground whitespace-pre-line leading-body mt-1">{provider.about}</p>
            </div>
          )}
      </ProfileSection>

      {provider.ivfSuccessRates && provider.ivfSuccessRates.length > 0 && (
        <IvfSuccessRatesSection rates={provider.ivfSuccessRates} filterContext={filterContext} />
      )}

      {(() => {
        // The cost-programs section now serves every fertility-tier provider
        // (IVF, Surrogacy, Egg Donor, Sperm Bank). Server-side matching
        // filters to whatever applies to this parent's journey state.
        const svcNames = (provider.services || []).map((s: any) => s.providerType?.name?.toLowerCase() || "");
        const hasFertilityTierService = svcNames.some((n: string) =>
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

      {(() => {
        const svcNames = (provider.services || []).map((s: any) => s.providerType?.name?.toLowerCase() || "");
        const isIvfClinic = svcNames.some((n: string) => n.includes("ivf") || n.includes("in vitro"));
        const isSurrogacyAgency = svcNames.some((n: string) => n.includes("surrogacy"));
        const ivfOffersEggDonors = svcNames.some((n: string) => n.includes("egg donor") || n.includes("egg bank"));

        const bioConnectionLabel: Record<string, string> = {
          none: "No connection required",
          at_least_one: "At least one biological parent",
          at_least_two: "At least two biological parents",
        };
        const birthCertLabel: Record<string, string> = {
          surrogate: "Surrogate",
          biological_father: "Biological father",
          biological_mother: "Biological mother",
          both_biological_parents: "Both biological parents",
        };
        const patientLabels: Record<string, string> = {
          single_woman: "Single woman",
          single_man: "Single man",
          gay_couple: "Gay couple",
          straight_couple: "Straight couple",
          straight_married_couple: "Straight married couple",
        };
        const eggDonorTypeLabel: Record<string, string> = {
          anonymous: "Anonymous",
          known: "Known",
          both: "Both",
        };

        const hasIvfData = isIvfClinic && (
          provider.ivfTwinsAllowed ||
          provider.ivfTransferFromOtherClinics ||
          provider.ivfMaxAgeIp1 != null ||
          provider.ivfMaxAgeIp2 != null ||
          provider.ivfBiologicalConnection ||
          (provider.ivfAcceptingPatients && provider.ivfAcceptingPatients.length > 0) ||
          provider.ivfEggDonorType
        );
        const hasSurrogacyData = isSurrogacyAgency && (
          (provider.surrogacyCitizensNotAllowed && provider.surrogacyCitizensNotAllowed.length > 0) ||
          provider.surrogacyTwinsAllowed ||
          provider.surrogacyStayAfterBirthMonths != null ||
          (Array.isArray(provider.surrogacyBirthCertificateListing) && provider.surrogacyBirthCertificateListing.length > 0) ||
          provider.surrogacySurrogateRemovableFromCert != null
        );

        if (!hasIvfData && !hasSurrogacyData) return null;

        return (
          <ProfileSection title="Parents Matching Requirements" contentClassName="p-6 space-y-6" data-testid="section-matching-requirements">
              {hasIvfData && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    {[
                      { label: "Twins allowed", value: provider.ivfTwinsAllowed },
                      { label: "Transferring embryos from other clinics allowed", value: provider.ivfTransferFromOtherClinics },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex items-center gap-2">
                        {value ? (
                          <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                        )}
                        <span className="text-base text-foreground">{label}</span>
                      </div>
                    ))}
                  </div>
                  {(provider.ivfMaxAgeIp1 != null || provider.ivfMaxAgeIp2 != null) && (
                    <div className="flex gap-8">
                      {provider.ivfMaxAgeIp1 != null && (
                        <div>
                          <p className="text-base font-ui text-foreground">Max Age of IP 1</p>
                          <p className="text-base text-foreground">{provider.ivfMaxAgeIp1}</p>
                        </div>
                      )}
                      {provider.ivfMaxAgeIp2 != null && (
                        <div>
                          <p className="text-base font-ui text-foreground">Max Age of IP 2</p>
                          <p className="text-base text-foreground">{provider.ivfMaxAgeIp2}</p>
                        </div>
                      )}
                    </div>
                  )}
                  {provider.ivfBiologicalConnection && (
                    <div>
                      <p className="text-base font-ui text-foreground">Biological connection to embryos</p>
                      <p className="text-base text-foreground">{bioConnectionLabel[provider.ivfBiologicalConnection] || provider.ivfBiologicalConnection}</p>
                    </div>
                  )}
                  {provider.ivfAcceptingPatients && provider.ivfAcceptingPatients.length > 0 && (
                    <div>
                      <p className="text-base font-ui text-foreground mb-2">Accepting patients that are</p>
                      <div className="flex flex-col gap-2">
                        {provider.ivfAcceptingPatients.map((p: string) => (
                          <div key={p} className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />
                            <span className="text-base text-foreground">{patientLabels[p] || p}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {ivfOffersEggDonors && provider.ivfEggDonorType && (
                    <div>
                      <p className="text-base font-ui text-foreground">Egg donor type</p>
                      <p className="text-base text-foreground">{eggDonorTypeLabel[provider.ivfEggDonorType] || provider.ivfEggDonorType}</p>
                    </div>
                  )}
                </div>
              )}

              {hasSurrogacyData && (
                <div className="space-y-4">
                  {hasIvfData && <div className="border-t border-border" />}
                  {provider.surrogacyCitizensNotAllowed && provider.surrogacyCitizensNotAllowed.length > 0 && (
                    <div>
                      <p className="text-base font-ui text-foreground mb-2">Citizens not allowed</p>
                      <div className="flex flex-wrap gap-2">
                        {provider.surrogacyCitizensNotAllowed.map((c: string) => (
                          <Badge key={c} variant="outline" className="text-xs flex items-center gap-1">
                            {getCountryFlag(c) && <span>{getCountryFlag(c)}</span>}
                            {c}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {provider.surrogacyTwinsAllowed ? (
                      <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                    )}
                    <span className="text-base text-foreground">Twins allowed</span>
                  </div>
                  {provider.surrogacyStayAfterBirthMonths != null && (
                    <div>
                      <p className="text-base font-ui text-foreground">IPs must stay after birth (months)</p>
                      <p className="text-base text-foreground">{provider.surrogacyStayAfterBirthMonths}</p>
                    </div>
                  )}
                  {Array.isArray(provider.surrogacyBirthCertificateListing) && provider.surrogacyBirthCertificateListing.length > 0 && (
                    <div>
                      <p className="text-base font-ui text-foreground">Listed on birth certificate</p>
                      <p className="text-base text-foreground">{provider.surrogacyBirthCertificateListing.map((v: string) => birthCertLabel[v] || v).join(", ")}</p>
                    </div>
                  )}
                  {provider.surrogacySurrogateRemovableFromCert != null && (
                    <div>
                      <p className="text-base font-ui text-foreground">Surrogate removable from birth certificate</p>
                      <p className="text-base text-foreground">{provider.surrogacySurrogateRemovableFromCert ? "Yes" : "No"}</p>
                    </div>
                  )}
                </div>
              )}
          </ProfileSection>
        );
      })()}

      {(() => {
        const svcNames = (provider.services || []).map((s: any) => s.providerType?.name?.toLowerCase() || "");
        const isIvfClinic = svcNames.some((n: string) => n.includes("ivf") || n.includes("in vitro"));
        if (!isIvfClinic) return null;

        const hasData =
          provider.ivfSurrogateMinAge != null ||
          provider.ivfSurrogateMaxAge != null ||
          provider.ivfSurrogateMinBmi != null ||
          provider.ivfSurrogateMaxBmi != null ||
          provider.ivfSurrogateMaxDeliveries != null ||
          provider.ivfSurrogateMaxCSections != null ||
          provider.ivfSurrogateMaxMiscarriages != null ||
          provider.ivfSurrogateMaxAbortions != null ||
          provider.ivfSurrogateMaxYearsFromLastPregnancy != null ||
          provider.ivfSurrogateMonthsPostVaginal != null ||
          provider.ivfSurrogateCovidVaccination != null ||
          provider.ivfSurrogateGdDiet != null ||
          provider.ivfSurrogateGdMedication != null ||
          provider.ivfSurrogateHighBloodPressure != null ||
          provider.ivfSurrogatePlacentaPrevia != null ||
          provider.ivfSurrogatePreeclampsia != null ||
          provider.ivfSurrogateMentalHealthHistory;

        if (!hasData) return null;

        return (
          <ProfileSection title="Surrogate Matching Requirements" contentClassName="p-6 space-y-4" data-testid="section-surrogate-matching-requirements">
              {(provider.ivfSurrogateMinAge != null || provider.ivfSurrogateMaxAge != null) && (
                <div>
                  <p className="text-base font-ui text-foreground">Age Range of Surrogate</p>
                  <p className="text-base text-foreground">{provider.ivfSurrogateMinAge ?? 18} - {provider.ivfSurrogateMaxAge ?? 45} years</p>
                </div>
              )}
              {(provider.ivfSurrogateMinBmi != null || provider.ivfSurrogateMaxBmi != null) && (
                <div>
                  <p className="text-base font-ui text-foreground">BMI Range of Surrogate</p>
                  <p className="text-base text-foreground">{provider.ivfSurrogateMinBmi ?? 18} - {provider.ivfSurrogateMaxBmi ?? 35}</p>
                </div>
              )}
              {[
                { label: "Max Number of Deliveries", value: provider.ivfSurrogateMaxDeliveries },
                { label: "Max Number of C-Sections", value: provider.ivfSurrogateMaxCSections },
                { label: "Max Number of Miscarriages", value: provider.ivfSurrogateMaxMiscarriages },
                { label: "Max Number of Abortions", value: provider.ivfSurrogateMaxAbortions },
                { label: "Max Years from Last Pregnancy", value: provider.ivfSurrogateMaxYearsFromLastPregnancy },
                { label: "Months Post Vaginal Delivery", value: provider.ivfSurrogateMonthsPostVaginal },
              ].filter(({ value }) => value != null).map(({ label, value }) => (
                <div key={label}>
                  <p className="text-base font-ui text-foreground">{label}</p>
                  <p className="text-base text-foreground">{value}</p>
                </div>
              ))}
              {[
                { label: "Covid Vaccination Required", value: provider.ivfSurrogateCovidVaccination },
                { label: "Gestational Diabetes (controlled by diet)", value: provider.ivfSurrogateGdDiet },
                { label: "Gestational Diabetes (controlled with medication)", value: provider.ivfSurrogateGdMedication },
                { label: "High Blood Pressure / Gestational Hypertension", value: provider.ivfSurrogateHighBloodPressure },
                { label: "Placenta Previa", value: provider.ivfSurrogatePlacentaPrevia },
                { label: "Preeclampsia in Most Recent Pregnancy", value: provider.ivfSurrogatePreeclampsia },
              ].filter(({ value }) => value != null).map(({ label, value }) => (
                <div key={label} className="flex items-center gap-2">
                  {value ? (
                    <CheckCircle2 className="w-4 h-4 text-[hsl(var(--brand-success))] shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                  )}
                  <span className="text-base text-foreground">{label}</span>
                </div>
              ))}
              {provider.ivfSurrogateMentalHealthHistory && (
                <div>
                  <p className="text-base font-ui text-foreground mb-1">Health History Notes</p>
                  <p className="text-base text-foreground whitespace-pre-wrap">{provider.ivfSurrogateMentalHealthHistory}</p>
                </div>
              )}
          </ProfileSection>
        );
      })()}

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
                  <p className="text-base text-foreground">{parts.join(", ")}</p>
                </div>
              );
            })}
        </ProfileSection>
        );
      })()}

      {provider.members && provider.members.length > 0 && (
        <ProfileSection title="Team Members" data-testid="section-team">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {provider.members.map((member: any) => {
                const memberPhoto = getPhotoSrc(member.photoUrl);
                const memberLocations = member.locations
                  ?.map((ml: any) => {
                    const l = ml.location;
                    return [l?.city, l?.state].filter(Boolean).join(", ");
                  })
                  .filter(Boolean);

                const inner = (
                  <>
                    {memberPhoto ? (
                      <img
                        src={memberPhoto}
                        alt={member.name}
                        className="w-14 h-14 rounded-full object-cover border border-border/30 shrink-0"
                      />
                    ) : (
                      <div className="w-14 h-14 rounded-full bg-secondary/40 flex items-center justify-center border border-border/30 shrink-0">
                        <User className="w-6 h-6 text-muted-foreground/40" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="font-ui text-sm text-foreground group-hover:text-primary transition-colors">{member.name}</p>
                      {member.title && (
                        <p className="text-xs text-primary font-ui">{member.title}</p>
                      )}
                      {member.bio && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-3">{member.bio}</p>
                      )}
                      {memberLocations && memberLocations.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
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
                    to={`/doctors/${member.slug}`}
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
                  <span className="text-base text-foreground">{label}</span>
                </div>
              ))}
            </div>
        </ProfileSection>
      )}
    </div>
  );
}
