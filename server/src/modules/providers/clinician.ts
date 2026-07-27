/**
 * Who counts as a doctor.
 *
 * A clinic's team record holds everyone the scraper found on their site -
 * physicians, but also practice directors, lab directors, coordinators and
 * office staff. Parent-facing surfaces (the marketplace "Doctors" tab and the
 * clinic profile's team list) must show only clinicians; the admin team editor
 * still shows everyone, because someone has to manage those rows.
 *
 * Deliberately NOT "has an NPI": only 656 of 1,584 public members have one
 * (NPPES name matching fails often), and requiring it would hide 205 medical
 * directors and 423 doctors whose lookup missed. Instead: degree evidence
 * first, then a staff-title exclusion, then weaker clinical signals.
 *
 * There is ONE implementation. Callers filter in memory rather than in SQL -
 * a parallel Prisma `where` would drift from this the first time the rule is
 * tuned, and the member table is small enough that it does not pay for itself.
 */

/** Titles that are staff roles, however senior. Checked case-insensitively. */
const NON_CLINICAL_TITLE = new RegExp(
  [
    "lab(oratory)?\\s+(director|manager|supervisor|technician)",
    "embryolog", // embryologist / embryology director
    "practice\\s+(director|manager|administrator)",
    "office\\s+(director|manager|administrator)",
    "executive\\s+director",
    "director\\s+of\\s+(operations|finance|marketing|nursing|business)",
    "administrator",
    "coordinator",
    "financial|billing|marketing|business\\s+development",
    "chief\\s+(executive|operating|financial|technology|marketing)\\s+officer",
    "\\bceo\\b|\\bcoo\\b|\\bcfo\\b|\\bcto\\b",
    "receptionist|scheduler|assistant\\b(?!\\s+professor)",
    "counselor|therapist|psycholog|nutritionist|dietitian",
    "genetic\\s+counselor",
  ].join("|"),
  "i",
);

/** Titles that state the person practises medicine. */
const CLINICAL_TITLE = new RegExp(
  [
    "physician|doctor\\b",
    "endocrinolog", // reproductive endocrinologist
    "obstetric|gynecolog|\\bob\\s*/?\\s*gyn\\b",
    "urolog|androlog",
    "surgeon",
    "fertility\\s+specialist|infertility\\s+specialist",
    "medical\\s+director|chief\\s+medical\\s+officer",
    "\\bm\\.?d\\.?\\b|\\bd\\.?o\\.?\\b",
  ].join("|"),
  "i",
);

/**
 * A physician's degree, wherever it appears - the credential column, or trailing
 * a scraped name ("Jeffrey Deaton M.D."). PhD alone does not qualify. "DO" is
 * matched case-sensitively so the English word "do" in a title can't trigger it.
 */
const PHYSICIAN_DEGREE = /\b(M\.?\s?D\.?|MBBS|MBBCh)\b/i;
const PHYSICIAN_DEGREE_DO = /\bD\.?\s?O\.?\b/;

export interface ClinicianCandidate {
  name?: string | null;
  title?: string | null;
  credential?: string | null;
  npiNumber?: string | null;
  isMedicalDirector?: boolean | null;
}

/**
 * True when this team member should appear as a doctor.
 *
 * A non-clinical title wins outright: "Dr." in the name is not enough for a
 * PhD lab director, which is exactly how an Executive Lab Director ended up in
 * the Doctors tab.
 */
export function isClinicianMember(m: ClinicianCandidate): boolean {
  const title = (m.title || "").trim();
  const name = (m.name || "").trim();

  // Hard evidence of a physician outranks any job title. Plenty of REIs hold an
  // administrative role - "Jeffrey Deaton M.D., Practice Director" is a doctor
  // who also runs the practice, and must not be filtered out as staff.
  if (m.npiNumber) return true;
  if (m.credential && (PHYSICIAN_DEGREE.test(m.credential) || PHYSICIAN_DEGREE_DO.test(m.credential))) return true;
  if (PHYSICIAN_DEGREE.test(name) || PHYSICIAN_DEGREE_DO.test(name)) return true;

  // No degree evidence: a staff title now settles it. This is where an
  // Executive Lab Director or Practice Director drops out, including one whose
  // name carries a "Dr." from a PhD.
  if (title && NON_CLINICAL_TITLE.test(title) && !CLINICAL_TITLE.test(title)) return false;

  // isMedicalDirector comes from CDC data and is sometimes stamped on a lab
  // director, so it is only trusted once a staff title has been ruled out.
  if (m.isMedicalDirector) return true;
  if (title && CLINICAL_TITLE.test(title)) return true;
  if (/^\s*dr\.?\s/i.test(name)) return true;
  return false;
}
