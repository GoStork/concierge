import { useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { recordProfileView, recordProfileOpen } from "@/lib/profile-views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProfileSection } from "@/components/ui/profile-section";
import {
  ArrowLeft, MapPin, Building2, Loader2, GraduationCap, Award, Globe,
  Stethoscope, Heart, Video, BadgeCheck, Star, ShieldCheck,
} from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { DoctorMonogram } from "@/components/marketplace/doctor-monogram";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCloseButton } from "@/components/mobile-profile-close-header";

// CDC metric codes (mirrors ivf-success-rates-section.tsx) used to pick a headline rate.
const OWN_METRIC = "pct_intended_retrievals_live_births";
const OWN_NEW_METRIC = "pct_new_patients_live_birth_after_1_retrieval";

// Pick a single "headline" success rate for a clinic affiliation: own-eggs, under-35 live birth.
function headlineRate(rates: any[] | undefined): { value: number; label: string } | null {
  if (!rates || rates.length === 0) return null;
  const own = rates.filter((r) => r.profileType === "own_eggs" && r.ageGroup === "under_35");
  const pick =
    own.find((r) => r.metricCode === OWN_METRIC) ||
    own.find((r) => r.metricCode === OWN_NEW_METRIC) ||
    own[0];
  if (!pick || pick.successRate == null) return null;
  const value = Math.round(Number(pick.successRate));
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, label: "Live birth · under 35, own eggs" };
}

function formatLocation(l: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }) {
  return [l.address, l.city, l.state, l.zip].filter(Boolean).join(", ");
}

export default function DoctorProfilePage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const { data: doctor, isLoading, isError } = useQuery<any>({
    queryKey: ["/api/providers/doctors", slug],
    queryFn: async () => {
      const res = await fetch(`/api/providers/doctors/${slug}`, { credentials: "include" });
      if (!res.ok) throw new Error("Doctor not found");
      return res.json();
    },
    enabled: !!slug,
  });

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

  const photo = getPhotoSrc(doctor.photoUrl);
  const affiliations: any[] = doctor.affiliations || [];
  const acceptedInsurance: string[] = Array.from(
    new Set(affiliations.flatMap((a) => a.acceptedInsurance || [])),
  ).sort();
  const reviews: any[] = doctor.reviews || [];
  const hasReviews = (doctor.reviewCount ?? 0) > 0 && reviews.length > 0;

  return (
    <div className="space-y-6 w-full">
      {/* Desktop: the "Back" text link (hidden on mobile). */}
      <div className={`flex items-center justify-between ${isMobile ? "hidden" : ""}`}>
        <Button variant="ghost" onClick={() => navigate(-1)} data-testid="link-back">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
      </div>

      {/* Header */}
      <div className="flex items-start gap-5">
        {photo ? (
          <img
            src={photo}
            alt={doctor.name}
            className="w-24 h-24 rounded-full object-cover border border-border/30 shrink-0"
            data-testid="img-doctor-photo"
          />
        ) : (
          <DoctorMonogram name={doctor.name} size={96} className="border border-border/30" />
        )}
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-heading text-foreground" data-testid="text-doctor-name">
            {doctor.name}{doctor.credential ? `, ${doctor.credential}` : ""}
          </h1>
          {doctor.title && <p className="text-sm text-primary font-ui mt-0.5">{doctor.title}</p>}
          {doctor.npiTaxonomy && (
            <p className="text-xs text-muted-foreground mt-0.5">{doctor.npiTaxonomy}</p>
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
            <p className="text-base text-foreground whitespace-pre-line leading-relaxed">{doctor.bio}</p>
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
                <p className="text-base font-ui text-foreground mb-2 flex items-center gap-1.5">
                  <Award className="w-3.5 h-3.5 text-primary" /> Board Certifications
                </p>
                <ul className="space-y-1">
                  {doctor.boardCertifications.map((c: string) => (
                    <li key={c} className="text-base text-foreground">{c}</li>
                  ))}
                </ul>
              </div>
            )}
            {doctor.education?.length > 0 && (
              <div>
                <p className="text-base font-ui text-foreground mb-2 flex items-center gap-1.5">
                  <GraduationCap className="w-3.5 h-3.5 text-primary" /> Education & Training
                </p>
                <ul className="space-y-1">
                  {doctor.education.map((e: string) => (
                    <li key={e} className="text-base text-foreground">{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {doctor.professionalMemberships?.length > 0 && (
              <div>
                <p className="text-base font-ui text-foreground mb-2">Professional Memberships</p>
                <ul className="space-y-1">
                  {doctor.professionalMemberships.map((m: string) => (
                    <li key={m} className="text-base text-foreground">{m}</li>
                  ))}
                </ul>
              </div>
            )}
            {doctor.languagesSpoken?.length > 0 && (
              <div>
                <p className="text-base font-ui text-foreground mb-2 flex items-center gap-1.5">
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
                <p className="text-base font-ui text-foreground">Medical School</p>
                <p className="text-base text-foreground">
                  {doctor.medicalSchool}{doctor.graduationYear ? ` (${doctor.graduationYear})` : ""}
                </p>
              </div>
            )}
            {doctor.yearsExperience != null && (
              <div>
                <p className="text-base font-ui text-foreground">Years of Experience</p>
                <p className="text-base text-foreground">{doctor.yearsExperience}</p>
              </div>
            )}
            {doctor.providerGender && (
              <div>
                <p className="text-base font-ui text-foreground">Provider's Gender</p>
                <p className="text-base text-foreground">{doctor.providerGender}</p>
              </div>
            )}
            {doctor.npiNumber && (
              <div>
                <p className="text-base font-ui text-foreground">NPI Number</p>
                <p className="text-base text-foreground">{doctor.npiNumber}</p>
              </div>
            )}
        </ProfileSection>
      )}

      {/* Insurances accepted (clinic-level, unioned across affiliations) */}
      {acceptedInsurance.length > 0 && (
        <ProfileSection title="In-Network Insurances" data-testid="section-insurance">
            <div className="flex flex-wrap gap-2">
              {acceptedInsurance.map((ins) => (
                <Badge key={ins} variant="secondary" className="gap-1">
                  <ShieldCheck className="w-3 h-3 text-[hsl(var(--brand-success))]" /> {ins}
                </Badge>
              ))}
            </div>
        </ProfileSection>
      )}

      {/* Works at - clinic affiliations */}
      <ProfileSection title={affiliations.length > 1 ? `Practices At ${affiliations.length} Clinics` : "Practices At"} contentClassName="p-6 grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="section-affiliations">
          {affiliations.map((a) => {
            const logo = getPhotoSrc(a.logoUrl);
            const rate = headlineRate(a.successRates);
            const locs = (a.memberLocations?.length ? a.memberLocations : a.clinicLocations) || [];
            return (
              <Link
                key={a.memberId}
                to={`/providers/${a.providerId}`}
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
                      <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                        <MapPin className="w-3 h-3 shrink-0 mt-0.5" />
                        <span>{locs.map((l: any) => [l.city, l.state].filter(Boolean).join(", ")).filter(Boolean).join(" · ")}</span>
                      </p>
                    )}
                  </div>
                </div>

                {rate && (
                  <div className="bg-secondary/40 rounded-[var(--radius)] px-3 py-2">
                    <p className="text-lg font-heading text-foreground leading-none">{rate.value}%</p>
                    <p className="text-[11px] text-muted-foreground mt-1">{rate.label} (CDC)</p>
                  </div>
                )}
              </Link>
            );
          })}
      </ProfileSection>

      {/* Reviews */}
      <ProfileSection title="Patient Reviews" data-testid="section-reviews">
          {hasReviews ? (
            <div className="space-y-4">
              {reviews.map((r) => (
                <div key={r.id} className="border-b border-border/30 pb-3 last:border-0">
                  <div className="flex flex-wrap gap-1.5 mb-1">
                    {r.ageRangeLabel && <Badge variant="secondary" className="text-[10px]">Age {r.ageRangeLabel}</Badge>}
                    {r.ivfCycles != null && <Badge variant="secondary" className="text-[10px]">{r.ivfCycles} IVF</Badge>}
                    {(r.diagnoses || []).map((d: string) => (
                      <Badge key={d} variant="outline" className="text-[10px]">{d}</Badge>
                    ))}
                  </div>
                  {r.bodyText && <p className="text-base text-foreground">{r.bodyText}</p>}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center text-center py-6 gap-2">
              <Star className="w-7 h-7 text-muted-foreground/30" />
              <p className="text-base text-foreground">No verified reviews yet.</p>
              <p className="text-xs text-muted-foreground/70 max-w-sm">
                GoStork reviews come from intended parents after a verified consultation, so every review is from someone who actually met with this doctor.
              </p>
            </div>
          )}
      </ProfileSection>
    </div>
  );
}
