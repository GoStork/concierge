/**
 * Shared chat types used by conversations-page (provider chat),
 * admin-concierge-monitor, and extracted sub-components.
 */

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  senderType: string;
  senderName: string | null;
  createdAt: string;
  uiCardType?: string;
  uiCardData?: any;
  deliveredAt?: string | null;
  readAt?: string | null;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  photoUrl: string | null;
  city: string | null;
  state: string | null;
  mobileNumber?: string | null;
  relationshipStatus?: string | null;
  partnerFirstName?: string | null;
  partnerAge?: number | string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  partnerGender?: string | null;
  sexualOrientation?: string | null;
  parentAccountId?: string | null;
  parentAccount?: {
    intendedParentProfile?: {
      journeyStage: string | null;
      interestedServices: string[];
      isFirstIvf: boolean | null;
      eggSource: string | null;
      spermSource: string | null;
      carrier: string | null;
      hasEmbryos: boolean | null;
      embryoCount: number | null;
      embryosTested: boolean | null;
      needsClinic: boolean | null;
      currentClinicName: string | null;
      clinicPriority: string | null;
      needsEggDonor: boolean | null;
      needsSurrogate: boolean | null;
      surrogateCountries: string | null;
      surrogateTermination: string | null;
      surrogateTwins: string | null;
      surrogateAgeRange: string | null;
      surrogateBudget: string | null;
      surrogateExperience: string | null;
      surrogateMedPrefs: string | null;
      surrogateRace: string | null;
      surrogateEthnicity: string | null;
      surrogateRelationship: string | null;
      surrogateBmiRange: string | null;
      surrogateTotalCostRange: string | null;
      surrogateLiveBirthsRange: string | null;
      surrogateMaxCSections: number | null;
      surrogateMaxMiscarriages: number | null;
      surrogateMaxAbortions: number | null;
      surrogateLastDeliveryYear: number | null;
      surrogateCovidVaccinated: boolean | null;
      surrogateSelectiveReduction: boolean | null;
      surrogateInternationalParents: boolean | null;
      donorPreferences: string | null;
      donorEyeColor: string | null;
      donorHairColor: string | null;
      donorHeight: string | null;
      donorEducation: string | null;
      donorEthnicity: string | null;
      eggDonorAgeRange: string | null;
      eggDonorCompensationRange: string | null;
      eggDonorTotalCostRange: string | null;
      eggDonorLotCostRange: string | null;
      eggDonorEggType: string | null;
      eggDonorDonationType: string | null;
      spermDonorType: string | null;
      spermDonorPreferences: string | null;
      spermDonorAgeRange: string | null;
      spermDonorEyeColor: string | null;
      spermDonorHairColor: string | null;
      spermDonorHeightRange: string | null;
      spermDonorRace: string | null;
      spermDonorEthnicity: string | null;
      spermDonorEducation: string | null;
      spermDonorMaxPrice: number | null;
      spermDonorVialType: string | null;
      spermDonorCovidVaccinated: boolean | null;
      clinicAgeGroup: string | null;
      clinicPriorityTags: string | null;
      clinicReason: string | null;
      diagnoses: string[];
      insurance: string | null;
      sameSexCouple: boolean | null;
      isLGBTQ: boolean | null;
      currentAgencyName: string | null;
      currentAttorneyName: string | null;
    } | null;
  } | null;
}

export interface AgreementSignerEntry {
  completed: boolean;
  completedAt: string | null;
  viewed: boolean;
  viewedAt: string | null;
  role: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface SessionAgreement {
  id: string;
  status: string;
  signerStatus: Record<string, AgreementSignerEntry> | null;
  signedAt: string | null;
  pandaDocViewUrl: string | null;
  pandaDocDocumentId: string | null;
  createdAt: string;
}

export interface SessionDetail {
  id: string;
  userId: string;
  status: string;
  providerId?: string | null;
  providerJoinedAt?: string | null;
  humanRequested?: boolean;
  humanJoinedAt?: string | null;
  humanAgentId?: string | null;
  matchmakerId?: string | null;
  matchmakerName?: string | null;
  matchmakerAvatar?: string | null;
  user: SessionUser;
  title?: string | null;
  messages: SessionMessage[];
  agreements?: SessionAgreement[];
  /** Rolling lifetime summary Eva carries into every turn (chat-memory system). */
  historySummary?: string | null;
  summarizedThrough?: number | null;
  /** Intended Parent Form status for the right rail (identity-revealed sessions only). */
  ipForm?: {
    responseId: string;
    status: string;
    submittedAt?: string | null;
    promptedAt?: string | null;
    hasSecondParent?: boolean;
    /** Surrogacy agencies only - nobody else has a surrogate to share it with. */
    surrogateAvailable?: boolean;
  } | null;
}

export type ViewerRole = "provider" | "admin" | "parent";
