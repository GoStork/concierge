import { User } from "lucide-react";
import { getPhotoSrc } from "@/lib/profile-utils";
import { formatPhoneDisplay } from "@/lib/phone-countries";
import type { SessionUser } from "@/components/chat/chat-types";
import { ServiceTag } from "@/components/ui/service-tag";

interface ParentProfileCardProps {
  user: SessionUser;
  /** When true, renders an "Online" pill + green dot on the avatar. */
  isOnline?: boolean;
  /**
   * "rail" (default) is a narrow column: the 288px chat sidebar this card was
   * written for, and the ~320px contact column on the parent record.
   * "wide" is a full-width page, where a single column of attribute rows
   * reads as a ragged list and the email truncation is pointless.
   *
   * The record page's contact column asks for "rail" via useDense(): ~320px
   * on desktop, and a ~390px phone tab, both narrow enough that a multi-column
   * masonry would shred the labels. Same component, two contexts; do not fork
   * it.
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


/**
 * Onboarding stores what the parent picked, in the first person the question
 * was asked in - "I'm a man", "I'm a woman". That reads as an answer, not a
 * value, when it is sitting next to a GENDER IDENTITY label. Same idea for
 * the multi-select fields, which store a lowercase comma-joined string:
 * "married,single,partnered" is a serialization format, not a sentence.
 */
const ANSWER_LABELS: Record<string, string> = {
  "i'm a man": "Man",
  "i'm a woman": "Woman",
  "i'm non-binary": "Non-binary",
  "i'm transgender": "Transgender",
  "prefer not to say": "Prefer not to say",
};

function titleCase(word: string): string {
  return word.length ? word[0].toUpperCase() + word.slice(1) : word;
}

/** Display form for a stored answer: mapped label, or a title-cased list. */
function displayValue(raw: string): string {
  const mapped = ANSWER_LABELS[raw.trim().toLowerCase()];
  if (mapped) return mapped;
  if (!raw.includes(",")) return raw;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (ANSWER_LABELS[part.toLowerCase()] || titleCase(part)))
    .join(", ");
}

// `serviceTags` set means the value is a list of service names rendered as
// the shared ServiceTag pills instead of plain text ("Interested In").
interface ProfileRow { label: string; value: string; serviceTags?: string[] }
interface ProfileSection { title: string; rows: ProfileRow[] }

// "min,max" pair -> "min - max". Account-page range sliders store the pair as
// a comma-joined string; anything else renders as-is.
function fmtRange(val: string, fmt: (n: number) => string = String): string {
  const parts = val.split(",");
  if (parts.length === 2 && parts.every((x) => x.trim() !== "" && !isNaN(Number(x)))) {
    return `${fmt(Number(parts[0]))} - ${fmt(Number(parts[1]))}`;
  }
  return val;
}

const fmtMoney = (n: number) => `$${n.toLocaleString("en-US")}`;
const fmtHeight = (in_: number) => { const ft = Math.floor(in_ / 12); return `${ft}'${in_ % 12}"`; };

function pushText(rows: ProfileRow[], label: string, val: string | null | undefined) {
  if (nonEmpty(val)) rows.push({ label, value: displayValue(val!.trim()) });
}
function pushBool(rows: ProfileRow[], label: string, val: boolean | null | undefined) {
  const v = boolLabel(val);
  if (v) rows.push({ label, value: v });
}
function pushNum(rows: ProfileRow[], label: string, val: number | null | undefined, fmt: (n: number) => string = String) {
  if (val !== null && val !== undefined) rows.push({ label, value: fmt(val) });
}
function pushRange(rows: ProfileRow[], label: string, val: string | null | undefined, fmt?: (n: number) => string) {
  if (nonEmpty(val)) rows.push({ label, value: fmtRange(val!, fmt) });
}

interface BasicInfo {
  phone: string | null;
  age: string | null;
  gender: string | null;
  sexualOrientation: string | null;
  relationshipStatus: string | null;
  partnerName: string | null;
  partnerAge: string | null;
  partnerGender: string | null;
  lgbtqFamily: string | null;
}

function buildBasics(user: SessionUser): BasicInfo {
  return {
    phone: nonEmpty(formatPhoneDisplay(user.mobileNumber)),
    age: computeAge(user.dateOfBirth),
    gender: nonEmpty(user.gender),
    sexualOrientation: nonEmpty(user.sexualOrientation),
    relationshipStatus: nonEmpty(user.relationshipStatus),
    partnerName: nonEmpty(user.partnerFirstName),
    partnerAge: user.partnerAge ? String(user.partnerAge) : null,
    partnerGender: nonEmpty(user.partnerGender),
    lgbtqFamily: boolLabel(user.parentAccount?.intendedParentProfile?.isLGBTQ),
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
  if (p.interestedServices?.length > 0) {
    journey.push({ label: "Interested In", value: p.interestedServices.join(", "), serviceTags: p.interestedServices });
  }
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

  // Section field lists and labels mirror the parent's own /account page
  // (account-page.tsx ProfileSection blocks) - keep the two in sync.
  const clinic: ProfileRow[] = [];
  if (p.needsClinic !== null && p.needsClinic !== undefined) {
    clinic.push({ label: "Needs Clinic", value: p.needsClinic ? "Yes" : "No - has one" });
  }
  pushText(clinic, "Current Clinic", p.currentClinicName);
  pushText(clinic, "Patient Age Group", p.clinicAgeGroup);
  pushText(clinic, "What Matters Most", p.clinicPriorityTags);
  if (p.diagnoses?.length > 0) clinic.push({ label: "Diagnoses", value: p.diagnoses.join(", ") });
  pushText(clinic, "Reason", p.clinicReason);
  pushText(clinic, "Insurance", p.insurance);
  pushText(clinic, "Additional Notes", p.clinicPriority);
  if (clinic.length > 0) sections.push({ title: "Clinic Preferences", rows: clinic });

  const surro: ProfileRow[] = [];
  pushText(surro, "Countries Open To", p.surrogateCountries);
  pushText(surro, "Termination Pref", p.surrogateTermination);
  pushText(surro, "Twins", p.surrogateTwins);
  pushRange(surro, "Age Range", p.surrogateAgeRange);
  pushRange(surro, "BMI Range", p.surrogateBmiRange);
  pushRange(surro, "Base Compensation", p.surrogateBudget, fmtMoney);
  pushRange(surro, "Total Cost", p.surrogateTotalCostRange, fmtMoney);
  pushText(surro, "Race", p.surrogateRace);
  pushText(surro, "Ethnicity", p.surrogateEthnicity);
  pushText(surro, "Relationship Status", p.surrogateRelationship);
  pushRange(surro, "Live Births", p.surrogateLiveBirthsRange);
  pushNum(surro, "Max C-Sections", p.surrogateMaxCSections);
  pushNum(surro, "Max Miscarriages", p.surrogateMaxMiscarriages);
  pushNum(surro, "Max Abortions", p.surrogateMaxAbortions);
  pushNum(surro, "Last Delivery Since", p.surrogateLastDeliveryYear);
  pushBool(surro, "Selective Reduction", p.surrogateSelectiveReduction);
  pushBool(surro, "Open to International Parents", p.surrogateInternationalParents);
  pushBool(surro, "Open to Same-Sex Couple", p.sameSexCouple);
  pushBool(surro, "COVID Vaccinated Required", p.surrogateCovidVaccinated);
  pushText(surro, "Experience Pref", p.surrogateExperience);
  pushText(surro, "Medical Prefs", p.surrogateMedPrefs);
  if (surro.length > 0) sections.push({ title: "Surrogate Preferences", rows: surro });

  // Titled "Egg Donor Preferences" to match /account - the generic donor*
  // fields ARE that page's egg-donor section.
  const donor: ProfileRow[] = [];
  pushText(donor, "Eye Color", p.donorEyeColor);
  pushText(donor, "Hair Color", p.donorHairColor);
  pushRange(donor, "Height", p.donorHeight, fmtHeight);
  pushText(donor, "Ethnicity", p.donorEthnicity);
  pushText(donor, "Education", p.donorEducation);
  pushText(donor, "Donation Type", p.eggDonorDonationType);
  pushRange(donor, "Donor Age Range", p.eggDonorAgeRange);
  pushText(donor, "Egg Type", p.eggDonorEggType);
  pushRange(donor, "Compensation", p.eggDonorCompensationRange, fmtMoney);
  pushRange(donor, "Total Cost", p.eggDonorTotalCostRange, fmtMoney);
  pushRange(donor, "Egg Lot Cost", p.eggDonorLotCostRange, fmtMoney);
  pushText(donor, "Preferences Summary", p.donorPreferences);
  if (donor.length > 0) sections.push({ title: "Egg Donor Preferences", rows: donor });

  const sperm: ProfileRow[] = [];
  pushText(sperm, "Eye Color", p.spermDonorEyeColor);
  pushText(sperm, "Hair Color", p.spermDonorHairColor);
  pushText(sperm, "Race", p.spermDonorRace);
  pushText(sperm, "Ethnicity", p.spermDonorEthnicity);
  pushText(sperm, "Education", p.spermDonorEducation);
  pushRange(sperm, "Donor Age Range", p.spermDonorAgeRange);
  pushRange(sperm, "Height Range", p.spermDonorHeightRange, fmtHeight);
  pushText(sperm, "Donor Type", p.spermDonorType);
  pushNum(sperm, "Max Cost", p.spermDonorMaxPrice, fmtMoney);
  pushText(sperm, "Vial Type", p.spermDonorVialType);
  pushBool(sperm, "COVID Vaccinated Required", p.spermDonorCovidVaccinated);
  pushText(sperm, "Additional Preferences", p.spermDonorPreferences);
  if (sperm.length > 0) sections.push({ title: "Sperm Donor Preferences", rows: sperm });

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
        {basics.gender && <div className="t-micro-value"><span className="t-micro-label">Gender identity</span> {displayValue(basics.gender)}</div>}
        {basics.sexualOrientation && (
          <div className="t-micro-value"><span className="t-micro-label">Sexual orientation</span> {basics.sexualOrientation}</div>
        )}
        {basics.lgbtqFamily && <div className="t-micro-value"><span className="t-micro-label">LGBTQ+ family</span> {basics.lgbtqFamily}</div>}
        {basics.relationshipStatus && (
          <div className="t-micro-value"><span className="t-micro-label">Relationship status</span> {displayValue(basics.relationshipStatus)}</div>
        )}
        {basics.partnerName && <div className="t-micro-value"><span className="t-micro-label">Partner name</span> {basics.partnerName}</div>}
        {basics.partnerAge && <div className="t-micro-value"><span className="t-micro-label">Partner's age</span> {basics.partnerAge}</div>}
        {basics.partnerGender && <div className="t-micro-value"><span className="t-micro-label">Partner's gender</span> {basics.partnerGender}</div>}
      </div>

      <div className={wide ? "columns-1 md:columns-2 lg:columns-3 gap-x-8 [&>div]:break-inside-avoid" : undefined}>
        {sections.map((section) => (
          <div key={section.title} className="border-t pt-3 mt-3">
            {/* Not t-micro-label: that is the token every LABEL below uses, so
              the heading disappeared into the list it was heading. */}
          <p className="text-xs font-semibold uppercase tracking-wide text-foreground mb-2 font-ui">{section.title}</p>
            <div className="space-y-1.5">
              {section.rows.map((row) => (
                <div key={row.label} className="t-micro-value">
                  <span className="t-micro-label">{row.label}</span>{" "}
                  {row.serviceTags?.length ? (
                    <span className="inline-flex flex-wrap gap-1 align-middle">
                      {row.serviceTags.map((svc) => <ServiceTag key={svc} service={svc} />)}
                    </span>
                  ) : (
                    <span>{row.value}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
