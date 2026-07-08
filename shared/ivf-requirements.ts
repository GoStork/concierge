// Phase 4: IVF clinic matching requirements - single shared evaluator used by
// the AI clinic search (server), the marketplace clinic cards (client), and
// the booking-time check (server endpoint). Clinics define the requirements
// in Settings -> Company ("Parents Matching Requirements"); this module
// decides whether a given parent meets them and why not.
//
// Rules are conservative: a rule only fails when we POSITIVELY know the
// parent violates it. Unknown parent data always passes (clinics make
// exceptions; wrongly hiding a clinic is worse than a heads-up later).

export interface IvfClinicRequirements {
  twinsAllowed?: boolean | null;
  genderSelectionAllowed?: boolean | null;
  transferFromOtherClinics?: boolean | null;
  maxAgeIp1?: number | null;
  maxAgeIp2?: number | null;
  biologicalConnection?: string | null; // "none" | "at_least_one" | "at_least_two"
  acceptingPatients?: string[] | null;  // ["single_woman","single_man","gay_couple","straight_couple","straight_married_couple"]
}

export interface IvfParentContext {
  age1?: number | null;
  age2?: number | null;
  patientType?: string | null;
  wantsTwins?: boolean | null;
  wantsGenderSelection?: boolean | null;
  hasEmbryosElsewhere?: boolean | null;
  /** How many intended parents are biologically connected to the embryos (0-2), null when unknown. */
  bioParentCount?: number | null;
}

const PATIENT_TYPE_LABELS: Record<string, string> = {
  single_woman: "single women",
  single_man: "single men",
  gay_couple: "same-sex couples",
  straight_couple: "unmarried straight couples",
  straight_married_couple: "married straight couples",
};

/** Derive the parent's context from their User row + IntendedParentProfile.
 *  Accepts loose shapes so both the server (DB rows) and the client (API
 *  payloads) can feed it. Every field is optional - unknowns skip rules. */
export function deriveIvfParentContext(
  user: {
    dateOfBirth?: string | Date | null;
    age?: number | null;
    partnerAge?: number | null;
    gender?: string | null;
    partnerGender?: string | null;
    relationshipStatus?: string | null;
    sexualOrientation?: string | null;
  } | null | undefined,
  profile: {
    hasEmbryos?: boolean | null;
    eggSource?: string | null;
    spermSource?: string | null;
    surrogateTwins?: string | null;
  } | null | undefined,
): IvfParentContext {
  const u = user || {};
  const p = profile || {};

  let age1: number | null = typeof u.age === "number" ? u.age : null;
  if (age1 == null && u.dateOfBirth) {
    const dob = new Date(u.dateOfBirth);
    if (!isNaN(dob.getTime())) {
      age1 = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    }
  }
  const age2 = typeof u.partnerAge === "number" ? u.partnerAge : null;

  const rel = (u.relationshipStatus || "").toLowerCase();
  const gender = (u.gender || "").toLowerCase();
  const partnerGender = (u.partnerGender || "").toLowerCase();
  const orientation = (u.sexualOrientation || "").toLowerCase();
  const isMan = (g: string) => g === "man" || g === "male";
  const isWoman = (g: string) => g === "woman" || g === "female";

  let patientType: string | null = null;
  if (rel.includes("single")) {
    if (isMan(gender)) patientType = "single_man";
    else if (isWoman(gender)) patientType = "single_woman";
  } else if (rel.includes("married") || rel.includes("partner")) {
    const sameSex = (gender && partnerGender && gender === partnerGender)
      || orientation.includes("gay") || orientation.includes("lesbian");
    if (sameSex) patientType = "gay_couple";
    else if (gender && (partnerGender || orientation.includes("straight"))) {
      patientType = rel.includes("married") ? "straight_married_couple" : "straight_couple";
    }
  }

  const twinsRaw = (p.surrogateTwins || "").toLowerCase();
  const wantsTwins = twinsRaw ? twinsRaw.includes("yes") : null;

  const eggKnown = !!p.eggSource;
  const spermKnown = !!p.spermSource;
  let bioParentCount: number | null = null;
  if (eggKnown && spermKnown) {
    const eggDonor = /donor/i.test(p.eggSource!);
    const spermDonor = /donor/i.test(p.spermSource!);
    bioParentCount = (eggDonor ? 0 : 1) + (spermDonor ? 0 : 1);
  }

  return {
    age1,
    age2,
    patientType,
    wantsTwins,
    hasEmbryosElsewhere: p.hasEmbryos === true ? true : null,
    bioParentCount,
  };
}

/** All rules AND together; returns every failed rule as a human sentence. */
export function evaluateIvfRequirements(
  req: IvfClinicRequirements | null | undefined,
  ctx: IvfParentContext | null | undefined,
): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!req) return { pass: true, failed };
  const c = ctx || {};

  if (c.wantsTwins === true && req.twinsAllowed === false) {
    failed.push("does not allow twin pregnancies");
  }
  if (c.wantsGenderSelection === true && req.genderSelectionAllowed === false) {
    failed.push("does not allow selecting the gender of the embryo to transfer");
  }
  if (c.hasEmbryosElsewhere === true && req.transferFromOtherClinics === false) {
    failed.push("does not accept embryo transfers from other clinics");
  }
  if (c.age1 != null && req.maxAgeIp1 != null && c.age1 > req.maxAgeIp1) {
    failed.push(`maximum intended parent age is ${req.maxAgeIp1}`);
  }
  if (c.age2 != null && req.maxAgeIp2 != null && c.age2 > req.maxAgeIp2) {
    failed.push(`maximum age for the second intended parent is ${req.maxAgeIp2}`);
  }
  if (c.patientType && Array.isArray(req.acceptingPatients) && req.acceptingPatients.length > 0
      && !req.acceptingPatients.includes(c.patientType)) {
    failed.push(`does not serve ${PATIENT_TYPE_LABELS[c.patientType] || c.patientType.replace(/_/g, " ")}`);
  }
  if (c.bioParentCount != null && req.biologicalConnection && req.biologicalConnection !== "none") {
    const needed = req.biologicalConnection === "at_least_two" ? 2 : 1;
    if (c.bioParentCount < needed) {
      failed.push(needed === 2
        ? "requires both intended parents to be biologically connected to the embryos"
        : "requires at least one intended parent to be biologically connected to the embryos");
    }
  }

  return { pass: failed.length === 0, failed };
}

/** Convenience: build the requirements object from a Provider row's ivf* fields. */
export function ivfRequirementsFromProvider(p: any): IvfClinicRequirements {
  return {
    twinsAllowed: p?.ivfTwinsAllowed ?? null,
    genderSelectionAllowed: p?.ivfGenderSelectionAllowed ?? null,
    transferFromOtherClinics: p?.ivfTransferFromOtherClinics ?? null,
    maxAgeIp1: p?.ivfMaxAgeIp1 ?? null,
    maxAgeIp2: p?.ivfMaxAgeIp2 ?? null,
    biologicalConnection: p?.ivfBiologicalConnection ?? null,
    acceptingPatients: Array.isArray(p?.ivfAcceptingPatients) ? p.ivfAcceptingPatients : null,
  };
}
