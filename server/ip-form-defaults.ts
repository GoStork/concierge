/**
 * Intended Parent Form - default template (10 sections, ~85 questions),
 * transcribed from the previous GoStork platform's generated PDFs.
 *
 * Seeding contract (same as ai-prompt-defaults): create-if-missing by stable
 * `key`, NEVER overwrite - the DB is the single source of truth and GoStork
 * admins edit the template at /admin/ip-form-template. To change a default
 * for NEW installs, edit here; to change the live template, use the admin UI.
 *
 * Widget vocabulary: "text" | "textarea" | "yes_no" | "dropdown" | "date" |
 * "address" | "phone" | "number" | "photos".
 *
 * perParent on a SECTION repeats the whole section per parent (Personal
 * Information, Acknowledgment). perParent on a QUESTION repeats that question
 * per parent inside a shared section (the IP1/IP2 blocks of section 1 and the
 * ID block of Private Information). excludeFromSurrogatePdf strips the
 * section/answer from the surrogate-facing PDF variant.
 */

import { prisma } from "./db";

export interface DefaultIpFormQuestion {
  key: string;
  label: string;
  helpText?: string;
  widget: string;
  options?: string[];
  required?: boolean;
  perParent?: boolean;
  excludeFromSurrogatePdf?: boolean;
  /** Resolved to conditionalOnQuestionId at seed time. */
  conditionalOnKey?: string;
  conditionalTriggerValue?: string;
}

export interface DefaultIpFormSection {
  key: string;
  title: string;
  description?: string;
  perParent?: boolean;
  excludeFromSurrogatePdf?: boolean;
  questions: DefaultIpFormQuestion[];
}

/**
 * Marital statuses (from the ip_marital_status question options) that imply a
 * second intended parent on the journey. Drives IpFormResponse.hasSecondParent
 * so parents don't answer a redundant "are there two of you?" question - IP1's
 * relationship status already tells us. A manual override always wins.
 */
export const TWO_PARENT_MARITAL_STATUSES = ["Partnered", "Married"];

export function maritalImpliesTwoParents(value: unknown): boolean {
  // Pre-answer default: show both parents. Safer than hiding a needed signer.
  if (typeof value !== "string" || !value.trim()) return true;
  return TWO_PARENT_MARITAL_STATUSES.includes(value.trim());
}

/** Legal text for the acknowledgment section. {{AGENCY_NAME}} is replaced with the downloading agency's name at PDF render time. */
export const IP_FORM_ACKNOWLEDGMENT_TEXT =
  "By submitting this questionnaire, I certify the information I provided on and in connection with this form is true and correct to the best of my knowledge. I am giving {{AGENCY_NAME}} permission to share this information with potential surrogates for the purpose of matching. I also understand that any false statements or deliberate omissions on this form may subject me to legal actions for fraudulent misrepresentation.";

export function getDefaultIpFormTemplate(): DefaultIpFormSection[] {
  return [
    {
      key: "profile",
      title: "Intended Parent Profile",
      questions: [
        // Per-parent block (rendered as "Intended Parent (1)" / "(2)")
        { key: "ip_full_legal_name", label: "Full Legal Name", widget: "text", required: true, perParent: true },
        { key: "ip_pronouns", label: "Pronouns", widget: "text", perParent: true },
        { key: "ip_dob", label: "Date of Birth", widget: "date", required: true, perParent: true, excludeFromSurrogatePdf: true },
        { key: "ip_residential_address", label: "Residential Address", widget: "address", required: true, perParent: true, excludeFromSurrogatePdf: true },
        { key: "ip_mailing_address", label: "Mailing Address", widget: "address", perParent: true, excludeFromSurrogatePdf: true },
        { key: "ip_email", label: "Email", widget: "text", required: true, perParent: true, excludeFromSurrogatePdf: true },
        { key: "ip_phone", label: "Phone Number", widget: "phone", required: true, perParent: true, excludeFromSurrogatePdf: true },
        {
          key: "ip_preferred_communication",
          label: "Preferred method of communication",
          widget: "dropdown",
          options: ["Email", "Phone", "Text"],
          perParent: true,
        },
        // Marital status is SHARED (not per-parent): it describes the couple's
        // relationship, so both parents would give the same answer. It also
        // drives the two-vs-solo split, so the client renders it once at the
        // top of the profile section, ahead of the per-parent blocks.
        {
          key: "ip_marital_status",
          label: "Marital Status",
          widget: "dropdown",
          options: ["Single", "Partnered", "Married", "Separated", "Divorced", "Widowed"],
          required: true,
        },
        // Emergency contact (shared)
        { key: "emergency_name", label: "Emergency Contact Name", widget: "text", required: true, excludeFromSurrogatePdf: true },
        { key: "emergency_relationship", label: "Emergency Contact Relationship", widget: "text", required: true, excludeFromSurrogatePdf: true },
        { key: "emergency_phone", label: "Emergency Contact Phone Number", widget: "phone", required: true, excludeFromSurrogatePdf: true },
        { key: "emergency_email", label: "Emergency Contact Email", widget: "text", required: true, excludeFromSurrogatePdf: true },
      ],
    },
    {
      key: "clinic",
      title: "Fertility Clinic Information",
      questions: [
        { key: "clinic_name", label: "Clinic Name", widget: "text", required: true },
        { key: "clinic_re_name", label: "Reproductive Endocrinologist Name", widget: "text" },
        { key: "clinic_address", label: "Address", widget: "address" },
        { key: "clinic_coordinator_name", label: "Coordinator Name", widget: "text" },
        { key: "clinic_coordinator_email", label: "Coordinator Email", widget: "text", excludeFromSurrogatePdf: true },
        { key: "clinic_phone", label: "Phone Number", widget: "phone", excludeFromSurrogatePdf: true },
      ],
    },
    {
      key: "embryo",
      title: "Embryo Information",
      questions: [
        { key: "embryo_gc_reason", label: "What is the reason for using a gestational carrier?", widget: "textarea", required: true },
        { key: "embryo_count", label: "How many embryos do you have?", widget: "number", required: true },
        { key: "embryo_genetically_tested", label: "Have your embryos been genetically tested?", widget: "yes_no" },
        { key: "embryo_storage_location", label: "Where are your embryos being stored?", widget: "text" },
        { key: "embryo_used_egg_donor", label: "Did you use an egg donor?", widget: "yes_no" },
        {
          key: "embryo_donor_age_at_retrieval",
          label: "If yes, how old was the donor at retrieval?",
          widget: "number",
          conditionalOnKey: "embryo_used_egg_donor",
          conditionalTriggerValue: "yes",
        },
        {
          key: "embryo_mother_age_at_retrieval",
          label: "If no, how old was Intended Mother at the time of retrieval?",
          widget: "number",
          conditionalOnKey: "embryo_used_egg_donor",
          conditionalTriggerValue: "no",
        },
        {
          key: "embryo_consider_egg_donor",
          label:
            "Would you consider using an egg donor and/or undergo another egg retrieval should your current embryos not lead to a successful pregnancy?",
          widget: "dropdown",
          options: ["Yes", "No", "Not Sure"],
        },
        { key: "embryo_used_sperm_donor", label: "Did you use a sperm donor?", widget: "yes_no" },
        {
          key: "embryo_sperm_bank_name",
          label: "If yes, please provide the name of the sperm bank",
          widget: "text",
          conditionalOnKey: "embryo_used_sperm_donor",
          conditionalTriggerValue: "yes",
        },
        { key: "embryo_transfer_count", label: "How many embryos do you plan to transfer?", widget: "number" },
        {
          key: "embryo_twin_feeling",
          label: "How do you feel about the surrogate carrying a twin pregnancy?",
          widget: "dropdown",
          options: ["Interested", "Not Interested", "Open to discussion"],
        },
        { key: "embryo_retry_transfer", label: "If the initial transfer is not successful, will you attempt another transfer?", widget: "yes_no" },
        { key: "embryo_up_to_three", label: "Are you willing to transfer up to three times?", widget: "yes_no" },
        {
          key: "embryo_simultaneous_surrogate",
          label: "Are you currently working with/plan to work with another surrogate simultaneously?",
          widget: "yes_no",
        },
      ],
    },
    {
      key: "personal_info",
      title: "Personal Information",
      perParent: true,
      questions: [
        { key: "personal_first_name", label: "First Name (ONLY)", widget: "text", required: true },
        { key: "personal_pronouns", label: "Pronouns", widget: "text" },
        { key: "personal_age", label: "Age", widget: "number" },
        { key: "personal_occupation", label: "Occupation", widget: "text" },
        { key: "personal_grew_up", label: "Where did you grow up?", widget: "text" },
        { key: "personal_free_time", label: "What do you enjoy doing in your free time?", widget: "textarea" },
        {
          key: "personal_education",
          label: "What is your educational background?",
          widget: "dropdown",
          options: ["High school diploma", "Associate's degree", "Bachelor's degree", "Master's degree", "Doctorate", "Other"],
        },
        { key: "personal_languages", label: "What languages do you speak?", widget: "text" },
        { key: "personal_favorite_food", label: "What is your favorite food?", widget: "text" },
        { key: "personal_religion", label: "What are your current religious beliefs, if any?", widget: "textarea" },
        { key: "personal_family_support", label: "Please tell us about your family and current support system.", widget: "textarea" },
        { key: "personal_children_ages", label: "Do you have any children? Age(s)?", widget: "text" },
        {
          key: "personal_communicable_disease",
          label: "Do you have Hep B, HIV, CMV, or any communicable disease requiring a surrogate to sign a consent form?",
          widget: "textarea",
        },
        { key: "personal_parenting_qualities", label: "What do you see as important qualities in parenting?", widget: "textarea" },
        { key: "personal_best_quality", label: "What would your partner/best friend/parents say is your best quality?", widget: "textarea" },
      ],
    },
    {
      key: "expectations",
      title: "Surrogate Expectations",
      questions: [
        {
          key: "exp_important_selecting",
          label: "Please describe what is important to you in selecting a surrogate.",
          widget: "textarea",
          required: true,
        },
        { key: "exp_communication_cadence", label: "What type of communication cadence would you prefer?", widget: "text" },
        { key: "exp_ideal_relationship", label: "Please describe your ideal surrogate relationship.", widget: "textarea" },
        { key: "exp_relationship_after_delivery", label: "What type of relationship would you like after the delivery?", widget: "text" },
        {
          key: "exp_birthday_photos",
          label: "Would you be open to providing annual birthday photos of the child to the surrogate?",
          widget: "yes_no",
        },
        { key: "exp_know_gender", label: "Will you want to know the gender of the baby?", widget: "yes_no" },
        { key: "exp_attend_obgyn", label: "Will you want to attend OBGYN appointments?", widget: "yes_no" },
        {
          key: "exp_termination",
          label: "What are your thoughts on termination? Under what circumstances would you consider a termination?",
          widget: "textarea",
        },
        {
          key: "exp_reduction",
          label: "What are your thoughts on reduction? Under what circumstances would you consider a reduction?",
          widget: "textarea",
        },
        { key: "exp_amniocentesis", label: "What are your thoughts on amniocentesis?", widget: "textarea" },
        { key: "exp_covid_vaccine", label: "Will you want your surrogate to get the COVID-19 Vaccination?", widget: "yes_no" },
        { key: "exp_flu_shot", label: "Will you want your surrogate to get the flu shot?", widget: "yes_no" },
        { key: "exp_acupuncture", label: "What are your thoughts on acupuncture?", widget: "textarea" },
        { key: "exp_pregnancy_massage", label: "What are your thoughts on pregnancy massages?", widget: "textarea" },
        {
          key: "exp_special_restrictions",
          label: "Do you have any special restrictions or requests regarding your surrogate's pregnancy?",
          widget: "textarea",
        },
        {
          key: "exp_meet_surrogate_children",
          label:
            "It may be important for the surrogate's children to know where the baby is going after the birth. Are you willing to meet and develop a relationship with the surrogate's children?",
          widget: "textarea",
        },
        { key: "exp_tell_child", label: "Do you intend to tell your child(ren) about the surrogate one day?", widget: "textarea" },
      ],
    },
    {
      key: "delivery",
      title: "Delivery Expectations",
      questions: [
        { key: "del_at_delivery", label: "Do you plan to be at the delivery?", widget: "yes_no" },
        { key: "del_cord_blood", label: "Do you plan to bank the cord blood?", widget: "yes_no" },
        { key: "del_tissue", label: "Do you want to bank the tissue?", widget: "yes_no" },
        {
          key: "del_cord_clamping",
          label: "Do you have a preference on delayed cord clamping?",
          widget: "dropdown",
          options: ["Yes", "No", "I have no preference"],
        },
        { key: "del_doula", label: "How would you feel if the surrogate wanted to work with a doula?", widget: "textarea" },
        { key: "del_breast_milk", label: "How do you feel about having the surrogate pump breast milk for you?", widget: "textarea" },
        { key: "del_goodbye_private", label: "Will you give the surrogate time to say goodbye in private?", widget: "textarea" },
      ],
    },
    {
      key: "letter",
      title: "Letter to the Surrogate",
      description:
        "Please provide a letter addressed to the surrogate. In this letter, please explain why you have decided to seek the assistance of a surrogate. Explain what your journey has been like up to this point. Any additional information you would like to provide about yourself is appreciated.",
      questions: [{ key: "letter_text", label: "Your letter", widget: "textarea", required: true }],
    },
    {
      key: "photos",
      title: "Photos",
      description: "Upload photos of you and your family. These photos will be shared with potential surrogates.",
      questions: [{ key: "photos_upload", label: "Your photos", widget: "photos", required: true }],
    },
    {
      key: "private",
      title: "Private Information",
      description: "This information will NOT be shared with the surrogate.",
      excludeFromSurrogatePdf: true,
      questions: [
        // Per-parent ID block
        { key: "priv_id_document_title", label: "Identification Document Title", widget: "text", perParent: true, excludeFromSurrogatePdf: true },
        { key: "priv_id_issuing_authority", label: "Issuing Authority", widget: "text", perParent: true, excludeFromSurrogatePdf: true },
        { key: "priv_id_number", label: "ID Number", widget: "text", perParent: true, excludeFromSurrogatePdf: true },
        { key: "priv_id_expiration", label: "Expiration Date", widget: "date", perParent: true, excludeFromSurrogatePdf: true },
        // Shared yes/no + explain
        {
          key: "priv_cps",
          label: "Have you/your partner ever had child protective services inquire about child abuse/neglect?",
          widget: "yes_no",
        },
        {
          key: "priv_cps_explain",
          label: "If yes, please explain",
          widget: "textarea",
          conditionalOnKey: "priv_cps",
          conditionalTriggerValue: "yes",
        },
        { key: "priv_felony", label: "Have you/your partner ever been convicted of a felony?", widget: "yes_no" },
        {
          key: "priv_felony_explain",
          label: "If yes, please explain",
          widget: "textarea",
          conditionalOnKey: "priv_felony",
          conditionalTriggerValue: "yes",
        },
        { key: "priv_litigation", label: "Are you/your partner currently involved in any legal litigation?", widget: "yes_no" },
        {
          key: "priv_litigation_explain",
          label: "If yes, please explain",
          widget: "textarea",
          conditionalOnKey: "priv_litigation",
          conditionalTriggerValue: "yes",
        },
        { key: "priv_healthy", label: "Are you/your partner physically healthy?", widget: "yes_no" },
        {
          key: "priv_healthy_explain",
          label: "If no, please explain",
          widget: "textarea",
          conditionalOnKey: "priv_healthy",
          conditionalTriggerValue: "no",
        },
        { key: "priv_psychiatrist", label: "Have you/your partner ever been under the care of a psychiatrist?", widget: "yes_no" },
        {
          key: "priv_psychiatrist_explain",
          label: "If yes, please explain",
          widget: "textarea",
          conditionalOnKey: "priv_psychiatrist",
          conditionalTriggerValue: "yes",
        },
        { key: "priv_surgeries", label: "Have you/your partner ever undergone any major surgeries?", widget: "yes_no" },
        {
          key: "priv_surgeries_explain",
          label: "If yes, please explain",
          widget: "textarea",
          conditionalOnKey: "priv_surgeries",
          conditionalTriggerValue: "yes",
        },
        { key: "priv_will", label: "Do you have a Will that addresses the disposition of embryos and unborn child(ren)?", widget: "yes_no" },
      ],
    },
    {
      key: "acknowledgment",
      title: "Acknowledgment and Understanding",
      description: IP_FORM_ACKNOWLEDGMENT_TEXT,
      perParent: true,
      // No questions - the client renders the signature widget for this
      // section (full legal name + drawn/typed signature + date), stored in
      // IpFormSignature. The PDF renders the legal text with the downloading
      // agency's name substituted for {{AGENCY_NAME}}.
      questions: [],
    },
  ];
}

/**
 * Seed the template into the DB, create-if-missing by key. Safe to run on
 * every boot; never touches existing rows (admin edits win forever).
 */
export async function ensureIpFormTemplateSeeded(): Promise<void> {
  try {
    const sections = getDefaultIpFormTemplate();
    // key -> question id, for resolving conditional follow-ups (parents may
    // live in earlier sections, so resolve after all inserts).
    const idByKey = new Map<string, string>();
    const pendingConditionals: { key: string; onKey: string; trigger: string }[] = [];

    for (let s = 0; s < sections.length; s++) {
      const def = sections[s];
      let section = await prisma.ipFormSection.findUnique({ where: { key: def.key } });
      if (!section) {
        section = await prisma.ipFormSection.create({
          data: {
            key: def.key,
            title: def.title,
            description: def.description || null,
            sortOrder: (s + 1) * 10,
            perParent: !!def.perParent,
            excludeFromSurrogatePdf: !!def.excludeFromSurrogatePdf,
          },
        });
        console.log(`[ip-form] Seeded section "${def.key}"`);
      }
      for (let q = 0; q < def.questions.length; q++) {
        const qd = def.questions[q];
        let question = await prisma.ipFormQuestion.findUnique({ where: { key: qd.key } });
        if (!question) {
          question = await prisma.ipFormQuestion.create({
            data: {
              sectionId: section.id,
              key: qd.key,
              label: qd.label,
              helpText: qd.helpText || null,
              widget: qd.widget,
              options: qd.options || undefined,
              required: !!qd.required,
              perParent: !!qd.perParent,
              excludeFromSurrogatePdf: !!qd.excludeFromSurrogatePdf,
              sortOrder: (q + 1) * 10,
            },
          });
        }
        idByKey.set(qd.key, question.id);
        if (qd.conditionalOnKey && !question.conditionalOnQuestionId) {
          pendingConditionals.push({ key: qd.key, onKey: qd.conditionalOnKey, trigger: qd.conditionalTriggerValue || "yes" });
        }
      }
    }

    for (const c of pendingConditionals) {
      const parentId = idByKey.get(c.onKey);
      if (!parentId) continue;
      await prisma.ipFormQuestion.update({
        where: { key: c.key },
        data: { conditionalOnQuestionId: parentId, conditionalTriggerValue: c.trigger },
      });
    }
  } catch (e: any) {
    console.error(`[ip-form] Template seed failed: ${e?.message}`);
  }
}
