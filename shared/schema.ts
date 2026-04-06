import { z } from "zod";

export type Provider = {
  id: string;
  name: string;
  about: string | null;
  logoUrl: string | null;
  websiteUrl: string | null;
  email: string | null;
  phone: string | null;
  yearFounded: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProviderType = {
  id: string;
  name: string;
};

export type ProviderService = {
  id: string;
  providerId: string;
  providerTypeId: string;
  status: string;
};

export type ProviderLocation = {
  id: string;
  providerId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
};

export type UserLocation = {
  id: string;
  userId: string;
  locationId: string;
};

export type User = {
  id: string;
  email: string;
  password: string | null;
  name: string | null;
  photoUrl: string | null;
  mobileNumber: string | null;
  roles: string[];
  providerId: string | null;
  mustCompleteProfile: boolean;
  allLocations: boolean;
  dailyRoomUrl?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  identification?: string | null;
  assignedLocations?: (UserLocation & { location?: ProviderLocation })[];
};

export type ProviderMember = {
  id: string;
  providerId: string;
  name: string;
  title: string | null;
  bio: string | null;
  photoUrl: string | null;
  isMedicalDirector: boolean;
  locations?: ProviderMemberLocation[];
};

export type ProviderMemberLocation = {
  id: string;
  memberId: string;
  locationId: string;
  location?: ProviderLocation;
};

export type SurrogacyAgencyProfile = {
  id: string;
  providerId: string;
  numberOfBabiesBorn: number | null;
  timeToMatch: string | null;
  familiesPerCoordinator: number | null;
};

export type SurrogateScreening = {
  id: string;
  surrogacyProfileId: string;
  criminalBackgroundCheck: boolean;
  homeVisits: boolean;
  financialsReview: boolean;
  socialWorkerScreening: boolean;
  medicalRecordsReview: boolean;
  surrogateInsuranceReview: boolean;
  psychologicalScreening: boolean;
};

export type CostTemplate = {
  id: string;
  providerTypeId: string;
  name: string;
  description: string | null;
};

export type CostTemplate = {
  id: string;
  providerTypeId: string;
  category: string;
  fieldName: string;
  fieldDescription: string | null;
  isMandatory: boolean;
  isBaseCompensation: boolean;
  allowMultiple: boolean;
  sortOrder: number;
};

export type CostProgram = {
  id: string;
  providerId: string;
  providerTypeId: string | null;
  subType: string | null;
  name: string;
  country: string;
  createdAt: string;
};

export type ProviderCostSheet = {
  id: string;
  providerId: string;
  parentClientId: string | null;
  programId: string | null;
  fileUrl: string | null;
  filePath: string | null;
  originalFileName: string | null;
  status: string;
  adminFeedback: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CostItem = {
  id: string;
  providerCostSheetId: string;
  category: string;
  key: string;
  minValue: number | null;
  maxValue: number | null;
  isCustom: boolean;
  comment: string | null;
  isIncluded: boolean;
  sortOrder: number;
};

export type ScheduleConfig = {
  id: string;
  userId: string;
  timezone: string;
  meetingDuration: number;
  minBookingNotice: number;
  bufferTime: number;
  meetingLink: string | null;
  bookingPageSlug: string | null;
  calendarProvider: string | null;
  calendarConnected: boolean;
  availabilitySlots?: AvailabilitySlot[];
};

export type AvailabilitySlot = {
  id: string;
  scheduleConfigId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isActive: boolean;
};

export type Booking = {
  id: string;
  providerUserId: string;
  parentUserId: string | null;
  scheduledAt: Date;
  duration: number;
  meetingType: string;
  status: string;
  meetingUrl: string | null;
  notes: string | null;
  subject: string | null;
  attendeeEmails: string[];
  attendeeName: string | null;
  invitedByUserId: string | null;
  cancelledAt: Date | null;
  rescheduledFromId: string | null;
  bookerTimezone: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CalendarBlock = {
  id: string;
  userId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  allDay: boolean;
  createdAt: Date;
};

export type Notification = {
  id: string;
  userId: string;
  bookingId: string | null;
  type: string;
  channel: string;
  sentAt: Date | null;
  scheduledFor: Date | null;
  status: string;
  recipient: string;
  createdAt: Date;
};

export type EggDonor = {
  id: string;
  providerId: string;
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  ethnicity: string | null;
  height: string | null;
  weight: string | null;
  eyeColor: string | null;
  hairColor: string | null;
  education: string | null;
  photoUrl: string | null;
  status: string;
  profileData: any;
  createdAt: Date;
  updatedAt: Date;
};

export type ProviderWithRelations = Provider & {
  services?: (ProviderService & { providerType?: ProviderType })[];
  locations?: ProviderLocation[];
  users?: User[];
  surrogacyProfile?: (SurrogacyAgencyProfile & { screening?: SurrogateScreening }) | null;
  members?: ProviderMember[];
};

export type UserWithProvider = User & {
  provider?: (Provider & {
    services?: (ProviderService & { providerType?: ProviderType })[];
  }) | null;
};

export const insertProviderSchema = z.object({
  name: z.string().min(1, "Provider name is required"),
  about: z.string().nullable().optional(),
  logoUrl: z.string().nullable().optional(),
  websiteUrl: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  yearFounded: z.number().int().nullable().optional(),
  consultationBookingUrl: z.string().url().nullable().optional().or(z.literal("").transform(() => null)),
  consultationIframeEnabled: z.boolean().optional(),
  pandaDocTemplateId: z.string().nullable().optional(),
  // IVF Clinic matching requirements
  ivfTwinsAllowed: z.boolean().optional(),
  ivfTransferFromOtherClinics: z.boolean().optional(),
  ivfMaxAgeIp1: z.number().int().nullable().optional(),
  ivfMaxAgeIp2: z.number().int().nullable().optional(),
  ivfBiologicalConnection: z.string().nullable().optional(),
  ivfAcceptingPatients: z.array(z.string()).nullable().optional(),
  ivfEggDonorType: z.string().nullable().optional(),
  // IVF Clinic surrogate matching requirements
  ivfSurrogateMinAge: z.number().int().nullable().optional(),
  ivfSurrogateMaxAge: z.number().int().nullable().optional(),
  ivfSurrogateMinBmi: z.number().nullable().optional(),
  ivfSurrogateMaxBmi: z.number().nullable().optional(),
  ivfSurrogateMaxDeliveries: z.number().int().nullable().optional(),
  ivfSurrogateMaxCSections: z.number().int().nullable().optional(),
  ivfSurrogateMaxMiscarriages: z.number().int().nullable().optional(),
  ivfSurrogateMaxAbortions: z.number().int().nullable().optional(),
  ivfSurrogateMaxYearsFromLastPregnancy: z.number().int().nullable().optional(),
  ivfSurrogateMonthsPostVaginal: z.number().int().nullable().optional(),
  ivfSurrogateCovidVaccination: z.boolean().nullable().optional(),
  ivfSurrogateGdDiet: z.boolean().nullable().optional(),
  ivfSurrogateGdMedication: z.boolean().nullable().optional(),
  ivfSurrogateHighBloodPressure: z.boolean().nullable().optional(),
  ivfSurrogatePlacentaPrevia: z.boolean().nullable().optional(),
  ivfSurrogatePreeclampsia: z.boolean().nullable().optional(),
  ivfSurrogateMentalHealthHistory: z.string().nullable().optional(),
  // Surrogacy Agency matching requirements
  surrogacyCitizensNotAllowed: z.array(z.string()).nullable().optional(),
  surrogacyTwinsAllowed: z.boolean().optional(),
  surrogacyStayAfterBirthMonths: z.number().int().nullable().optional(),
  surrogacyBirthCertificateListing: z.array(z.string()).nullable().optional(),
  surrogacySurrogateRemovableFromCert: z.boolean().nullable().optional(),
});

export const insertProviderTypeSchema = z.object({
  name: z.string().min(1, "Provider type name is required"),
});

export const insertProviderServiceSchema = z.object({
  providerId: z.string().optional(),
  providerTypeId: z.string().min(1, "Provider type is required"),
  status: z.string().default("NEW"),
});

export const insertProviderLocationSchema = z.object({
  providerId: z.string().optional(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  zip: z.string().nullish(),
  sortOrder: z.number().int().optional(),
});

export const insertUserSchema = z.object({
  email: z.string().email("Valid email is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  name: z.string().optional(),
  photoUrl: z.string().nullable().optional(),
  mobileNumber: z.string().nullable().optional(),
  role: z.string().optional(),
  roles: z.array(z.string()).optional(),
  providerId: z.string().nullable().optional(),
  allLocations: z.boolean().optional(),
  mustCompleteProfile: z.boolean().optional(),
  locationIds: z.array(z.string()).optional(),
});

export const insertProviderMemberSchema = z.object({
  providerId: z.string(),
  name: z.string().min(1, "Name is required"),
  title: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  photoUrl: z.string().nullable().optional(),
  isMedicalDirector: z.boolean().default(false),
  sortOrder: z.number().int().optional(),
  locationIds: z.array(z.string()).optional(),
});

export type InsertProvider = z.infer<typeof insertProviderSchema>;
export type InsertProviderType = z.infer<typeof insertProviderTypeSchema>;
export type InsertProviderService = z.infer<typeof insertProviderServiceSchema>;
export type InsertProviderLocation = z.infer<typeof insertProviderLocationSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertProviderMember = z.infer<typeof insertProviderMemberSchema>;

export type UpdateProviderRequest = Partial<InsertProvider>;
export type UpdateProviderServiceRequest = Partial<Omit<InsertProviderService, "providerId">>;
export type UpdateProviderLocationRequest = Partial<Omit<InsertProviderLocation, "providerId">>;
