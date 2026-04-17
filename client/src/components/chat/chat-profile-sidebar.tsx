import { type ReactNode } from "react";
import type { SessionUser } from "./chat-types";

interface ChatProfileSidebarProps {
  user: SessionUser;
  brandColor: string;
  /** Extra sections rendered after the profile info (e.g. consultation status, agreement buttons) */
  extraSections?: ReactNode;
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

interface ProfileRow {
  label: string;
  value: string;
}

interface ProfileSection {
  title: string;
  rows: ProfileRow[];
}

interface BasicInfo {
  phone: string | null;
  age: string | null;
  relationshipStatus: string | null;
  partnerName: string | null;
  partnerAge: string | null;
}

function buildBasics(user: SessionUser): BasicInfo {
  return {
    phone: nonEmpty(user.mobileNumber),
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

  // JOURNEY
  const journey: ProfileRow[] = [];
  if (nonEmpty(p.journeyStage)) journey.push({ label: "Stage", value: p.journeyStage! });
  if (p.interestedServices?.length > 0) journey.push({ label: "Interested In", value: p.interestedServices.join(", ") });
  const firstIvf = boolLabel(p.isFirstIvf);
  if (firstIvf) journey.push({ label: "First IVF", value: firstIvf });
  if (journey.length > 0) sections.push({ title: "Journey", rows: journey });

  // BIOLOGICAL BASELINE
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

  // CLINIC PREFERENCES
  const clinic: ProfileRow[] = [];
  if (p.needsClinic !== null && p.needsClinic !== undefined) {
    clinic.push({ label: "Needs Clinic", value: p.needsClinic ? "Yes" : "No - has one" });
  }
  if (nonEmpty(p.currentClinicName)) clinic.push({ label: "Current Clinic", value: p.currentClinicName! });
  if (nonEmpty(p.clinicPriority)) clinic.push({ label: "Clinic Priority", value: p.clinicPriority! });
  if (clinic.length > 0) sections.push({ title: "Clinic Preferences", rows: clinic });

  // SURROGATE PREFERENCES
  const surro: ProfileRow[] = [];
  if (nonEmpty(p.surrogateCountries)) surro.push({ label: "Countries Open To", value: p.surrogateCountries! });
  if (nonEmpty(p.surrogateTermination)) surro.push({ label: "Termination Pref", value: p.surrogateTermination! });
  if (nonEmpty(p.surrogateTwins)) surro.push({ label: "Twins", value: p.surrogateTwins! });
  if (nonEmpty(p.surrogateAgeRange)) surro.push({ label: "Surrogate Age Range", value: p.surrogateAgeRange! });
  if (nonEmpty(p.surrogateBudget)) surro.push({ label: "Budget", value: p.surrogateBudget! });
  if (nonEmpty(p.surrogateExperience)) surro.push({ label: "Experience Pref", value: p.surrogateExperience! });
  if (nonEmpty(p.surrogateMedPrefs)) surro.push({ label: "Medical Prefs", value: p.surrogateMedPrefs! });
  if (surro.length > 0) sections.push({ title: "Surrogate Preferences", rows: surro });

  // DONOR PREFERENCES
  const donor: ProfileRow[] = [];
  if (nonEmpty(p.donorPreferences)) donor.push({ label: "Preferences", value: p.donorPreferences! });
  if (nonEmpty(p.donorEyeColor)) donor.push({ label: "Eye Color", value: p.donorEyeColor! });
  if (nonEmpty(p.donorHairColor)) donor.push({ label: "Hair Color", value: p.donorHairColor! });
  if (nonEmpty(p.donorHeight)) donor.push({ label: "Height", value: p.donorHeight! });
  if (nonEmpty(p.donorEducation)) donor.push({ label: "Education", value: p.donorEducation! });
  if (nonEmpty(p.donorEthnicity)) donor.push({ label: "Ethnicity", value: p.donorEthnicity! });
  if (nonEmpty(p.spermDonorType)) donor.push({ label: "Sperm Donor Type", value: p.spermDonorType! });
  if (donor.length > 0) sections.push({ title: "Donor Preferences", rows: donor });

  // CURRENT PROVIDERS
  const providers: ProfileRow[] = [];
  if (nonEmpty(p.currentAgencyName)) providers.push({ label: "Current Agency", value: p.currentAgencyName! });
  if (nonEmpty(p.currentAttorneyName)) providers.push({ label: "Current Attorney", value: p.currentAttorneyName! });
  if (providers.length > 0) sections.push({ title: "Current Providers", rows: providers });

  return sections;
}

/**
 * Shared right-sidebar profile panel showing parent info and journey details.
 * Used by both provider chat and admin concierge monitor.
 */
export function ChatProfileSidebar({ user, brandColor, extraSections, testId = "chat-profile-sidebar" }: ChatProfileSidebarProps) {
  const sections = buildSections(user);
  const basics = buildBasics(user);

  return (
    <div className="w-72 border-l overflow-y-auto p-4 bg-muted/30 hidden md:block" data-testid={testId}>
      <h4 className="font-semibold text-sm mb-3" style={{ fontFamily: "var(--font-display)" }}>Parent Profile</h4>
      <div className="space-y-1.5 mb-3">
        <div className="text-sm"><span className="text-muted-foreground">Name:</span> {user.name || "-"}</div>
        <div className="text-sm truncate"><span className="text-muted-foreground">Email:</span> {user.email}</div>
        {(user.city || user.state) && (
          <div className="text-sm"><span className="text-muted-foreground">Location:</span> {[user.city, user.state].filter(Boolean).join(", ")}</div>
        )}
        {basics.phone && (
          <div className="text-sm"><span className="text-muted-foreground">Phone:</span> {basics.phone}</div>
        )}
        {basics.age && (
          <div className="text-sm"><span className="text-muted-foreground">Age:</span> {basics.age}</div>
        )}
        {basics.relationshipStatus && (
          <div className="text-sm"><span className="text-muted-foreground">Relationship Status:</span> {basics.relationshipStatus}</div>
        )}
        {basics.partnerName && (
          <div className="text-sm"><span className="text-muted-foreground">Partner Name:</span> {basics.partnerName}</div>
        )}
        {basics.partnerAge && (
          <div className="text-sm"><span className="text-muted-foreground">Partner's Age:</span> {basics.partnerAge}</div>
        )}
      </div>

      {sections.map((section) => (
        <div key={section.title} className="border-t pt-3 mt-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{section.title}</p>
          <div className="space-y-1.5">
            {section.rows.map((row) => (
              <div key={row.label} className="text-sm">
                <span className="text-muted-foreground">{row.label}:</span>{" "}
                <span>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {extraSections}
    </div>
  );
}
