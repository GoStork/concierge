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
  dateOfBirth?: string | null;
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
      donorPreferences: string | null;
      donorEyeColor: string | null;
      donorHairColor: string | null;
      donorHeight: string | null;
      donorEducation: string | null;
      donorEthnicity: string | null;
      spermDonorType: string | null;
      currentAgencyName: string | null;
      currentAttorneyName: string | null;
    } | null;
  } | null;
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
  user: SessionUser;
  title?: string | null;
  messages: SessionMessage[];
}

export type ViewerRole = "provider" | "admin" | "parent";
