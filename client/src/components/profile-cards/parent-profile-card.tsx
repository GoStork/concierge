import { User } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import type { SessionUser } from "@/components/chat/chat-types";

interface ParentProfileCardProps {
  user: SessionUser;
  /** When true, renders an "Online" pill + green dot on the avatar. */
  isOnline?: boolean;
  /**
   * "rail" (default) is the 288px chat sidebar this card was written for.
   * "wide" is the ~1100px parent record page, where a single column of
   * attribute rows reads as a ragged list and the email truncation is
   * pointless. Same component, two contexts - do not fork it.
   */
  layout?: "rail" | "wide";
  /**
   * Drop the heading, the avatar-and-name row, and the email/phone lines when
   * the surrounding page already shows all four - the parent record does, right
   * above this card, and printing them twice made the page read as two separate
   * profile blocks. Everything unique to this card (location, relationship,
   * journey, biological baseline, clinic preferences) still renders.
   */
  hideIdentity?: boolean;
  testId?: string;
}

function computeAge(dateOfBirth: string | null | undefined): string | null {
  if (!dateOfBirth) return null;
  const birth = new Date(dateOfBirth);
  if (isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return String(age);
}

function boolLabel(val: boolean | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  return val ? "Yes" : "No";
}

function nonEmpty(val: string | null | undefined): string | null {
  if (!val || val.trim() === "") return null;
  return val.trim();
}

interface ProfileRow { label: string; value: string }
interface ProfileSection { title: string; rows: ProfileRow[] }

interface BasicInfo {
  phone: string | null;
  age: string | null;
  relationshipStatus: string | null;
  partnerName: string | null;
  partnerAge: string | null;
}

function buildBasics(user: SessionUser): BasicInfo {
  return {
    phone: nonEmpty(formatPhoneDisplay(user.mobileNumber)),
    age: computeAge(user.dateOfBirth),
    relationshipStatus: nonEmpty(user.relationshipStatus),
    partnerName: nonEmpty(user.partnerFirstName),
    partnerAge: user.partnerAge ? String(user.partnerAge) : null,
  };
}

function buildSections(user: SessionUser): ProfileSection[] {
  const p = user.parentAccount?.intendedParentProfile;
  const sections: ProfileSection[] = [];
  if (!p) return sections;

  const journey: ProfileRow[] = [];
  // journeyStage (Eva's AI-saved self-note) is deliberately NOT displayed -
  // the sidebar's Match Status chip shows the server-derived ladder, which
  // is always current; showing both confused people whenever they diverged.
  if (p.interestedServices?.length > 0) journey.push({ label: "Interested In", value: p.interestedServices.join(", ") });
  const firstIvf = boolLabel(p.isFirstIvf);
  if (firstIvf) journey.push({ label: "First IVF", value: firstIvf });
  if (journey.length > 0) sections.push({ title: "Journey", rows: journey });

  const bio: ProfileRow[] = [];
  if (nonEmpty(p.eggSource)) bio.push({ label: "Egg Source", value: p.eggSource! });
  if (nonEmpty(p.spermSource)) bio.push({ label: "Sperm Source", value: p.spermSource! });
  if (nonEmpty(p.carrier)) bio.push({ label: "Carrier", value: p.carrier! });
  if (p.hasEmbryos !== null && p.hasEmbryos !== undefined) {
    let embryoVal = p.hasEmbryos ? `Yes - ${p.embryoCount ?? "?"}` : "No";
    if (p.hasEmbryos && p.embryosTested !== null && p.embryosTested !== undefined) {
      embryoVal += p.embryosTested ? " (PGT-A tested)" : " (not PGT-A tested)";
    }
    bio.push({ label: "Embryos", value: embryoVal });
  }
  if (bio.length > 0) sections.push({ title: "Biological Baseline", rows: bio });

  const clinic: ProfileRow[] = [];
  if (p.needsClinic !== null && p.needsClinic !== undefined) {
    clinic.push({ label: "Needs Clinic", value: p.needsClinic ? "Yes" : "No - has one" });
  }
  if (nonEmpty(p.currentClinicName)) clinic.push({ label: "Current Clinic", value: p.currentClinicName! });
  if (nonEmpty(p.clinicPriority)) clinic.push({ label: "Clinic Priority", value: p.clinicPriority! });
  if (clinic.length > 0) sections.push({ title: "Clinic Preferences", rows: clinic });

  const surro: ProfileRow[] = [];
  if (nonEmpty(p.surrogateCountries)) surro.push({ label: "Countries Open To", value: p.surrogateCountries! });
  if (nonEmpty(p.surrogateTermination)) surro.push({ label: "Termination Pref", value: p.surrogateTermination! });
  if (nonEmpty(p.surrogateTwins)) surro.push({ label: "Twins", value: p.surrogateTwins! });
  if (nonEmpty(p.surrogateAgeRange)) surro.push({ label: "Surrogate Age Range", value: p.surrogateAgeRange! });
  if (nonEmpty(p.surrogateBudget)) surro.push({ label: "Budget", value: p.surrogateBudget! });
  if (nonEmpty(p.surrogateExperience)) surro.push({ label: "Experience Pref", value: p.surrogateExperience! });
  if (nonEmpty(p.surrogateMedPrefs)) surro.push({ label: "Medical Prefs", value: p.surrogateMedPrefs! });
  if (surro.length > 0) sections.push({ title: "Surrogate Preferences", rows: surro });

  const donor: ProfileRow[] = [];
  if (nonEmpty(p.donorPreferences)) donor.push({ label: "Preferences", value: p.donorPreferences! });
  if (nonEmpty(p.donorEyeColor)) donor.push({ label: "Eye Color", value: p.donorEyeColor! });
  if (nonEmpty(p.donorHairColor)) donor.push({ label: "Hair Color", value: p.donorHairColor! });
  if (nonEmpty(p.donorHeight)) {
    const fmtH = (in_: number) => { const ft = Math.floor(in_ / 12); return `${ft}'${in_ % 12}"`; };
    const hParts = p.donorHeight!.split(",");
    const hDisplay = hParts.length === 2
      ? `${fmtH(Number(hParts[0]))} - ${fmtH(Number(hParts[1]))}`
      : p.donorHeight!;
    donor.push({ label: "Height", value: hDisplay });
  }
  if (nonEmpty(p.donorEducation)) donor.push({ label: "Education", value: p.donorEducation! });
  if (nonEmpty(p.donorEthnicity)) donor.push({ label: "Ethnicity", value: p.donorEthnicity! });
  if (nonEmpty(p.spermDonorType)) donor.push({ label: "Sperm Donor Type", value: p.spermDonorType! });
  if (donor.length > 0) sections.push({ title: "Donor Preferences", rows: donor });

  const providers: ProfileRow[] = [];
  if (nonEmpty(p.currentAgencyName)) providers.push({ label: "Current Agency", value: p.currentAgencyName! });
  if (nonEmpty(p.currentAttorneyName)) providers.push({ label: "Current Attorney", value: p.currentAttorneyName! });
  if (providers.length > 0) sections.push({ title: "Current Providers", rows: providers });

  return sections;
}

/**
 * Renders the canonical parent profile block: heading, contact basics, and
 * the per-section rows (Journey, Biological Baseline, Clinic Preferences,
 * Surrogate Preferences, Donor Preferences, Current Providers).
 *
 * Single source of truth - any new parent profile field should be added here
 * (and to the SessionUser type / API payload).
 */
export function ParentProfileCard({ user, isOnline, layout = "rail", hideIdentity = false, testId = "parent-profile-card" }: ParentProfileCardProps) {
  const sections = buildSections(user);
  const basics = buildBasics(user);
  const photoSrc = user.photoUrl ? getPhotoSrc(user.photoUrl) : null;
  const wide = layout === "wide";

  return (
    <div data-testid={testId}>
      {!hideIdentity && (
        <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Parent Profile</h4>
      )}
      {/* Identity row - mirrors the "Interested Egg Donor" card style:
          avatar (with online dot) + name + online label. */}
      {!hideIdentity && (
      <div className="flex items-center gap-2.5 mb-3">
        <div className="relative w-10 h-10 shrink-0">
          {photoSrc ? (
            <div className="w-10 h-10 rounded-full overflow-hidden bg-muted">
              <img
                src={photoSrc}
                alt={user.name || "Parent"}
                className="w-full h-full object-cover object-top"
              />
            </div>
          ) : (
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <User className="w-5 h-5 text-muted-foreground" />
            </div>
          )}
          {isOnline && (
            <span
              className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background bg-[hsl(var(--brand-success))]"
              title="Online"
            />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">{user.name || "-"}</p>
          {isOnline && (
            <p className="text-[10px] text-[hsl(var(--brand-success))] font-medium">Online</p>
          )}
        </div>
      </div>
      )}
      <div className="space-y-1.5 mb-3">
        {/* Email and phone are Gate B: the server sends null until the parent
            releases them, and a bare "Email -" reads as broken data. Say what
            is actually true instead. */}
        {!hideIdentity && (user.email
          ? <div className={`t-micro-value${wide ? "" : " truncate"}`}><span className="t-micro-label">Email</span> {user.email}</div>
          : <div className="t-micro-value"><span className="t-micro-label">Contact</span> Shared after intake or invoice</div>)}
        {(user.city || user.state) && (
          <div className="t-micro-value"><span className="t-micro-label">Location</span> {[user.city, user.state].filter(Boolean).join(", ")}</div>
        )}
        {!hideIdentity && basics.phone && <div className="t-micro-value"><span className="t-micro-label">Phone</span> {basics.phone}</div>}
        {basics.age && <div className="t-micro-value"><span className="t-micro-label">Age</span> {basics.age}</div>}
        {basics.relationshipStatus && (
          <div className="t-micro-value"><span className="t-micro-label">Relationship status</span> {basics.relationshipStatus}</div>
        )}
        {basics.partnerName && <div className="t-micro-value"><span className="t-micro-label">Partner name</span> {basics.partnerName}</div>}
        {basics.partnerAge && <div className="t-micro-value"><span className="t-micro-label">Partner's age</span> {basics.partnerAge}</div>}
      </div>

      <div className={wide ? "columns-1 md:columns-2 lg:columns-3 gap-x-8 [&>div]:break-inside-avoid" : undefined}>
        {sections.map((section) => (
          <div key={section.title} className="border-t pt-3 mt-3">
            <p className="t-micro-label mb-2">{section.title}</p>
            <div className="space-y-1.5">
              {section.rows.map((row) => (
                <div key={row.label} className="t-micro-value">
                  <span className="t-micro-label">{row.label}</span>{" "}
                  <span>{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
