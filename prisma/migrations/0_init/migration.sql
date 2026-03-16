-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "about" TEXT,
    "logoUrl" TEXT,
    "websiteUrl" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "yearFounded" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "brandingEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "ProviderType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderService" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerTypeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',

    CONSTRAINT "ProviderService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderLocation" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParentAccount" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "name" TEXT,
    "photoUrl" TEXT,
    "mobileNumber" TEXT,
    "roles" TEXT[] DEFAULT ARRAY['PARENT']::TEXT[],
    "providerId" TEXT,
    "allLocations" BOOLEAN NOT NULL DEFAULT false,
    "mustCompleteProfile" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dailyRoomUrl" TEXT,
    "isDisabled" BOOLEAN NOT NULL DEFAULT false,
    "parentAccountId" TEXT,
    "parentAccountRole" TEXT,
    "city" TEXT,
    "country" TEXT,
    "state" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserLocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,

    CONSTRAINT "UserLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurrogacyAgencyProfile" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "numberOfBabiesBorn" INTEGER,
    "timeToMatch" TEXT,
    "familiesPerCoordinator" INTEGER,

    CONSTRAINT "SurrogacyAgencyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurrogateScreening" (
    "id" TEXT NOT NULL,
    "surrogacyProfileId" TEXT NOT NULL,
    "criminalBackgroundCheck" BOOLEAN NOT NULL DEFAULT false,
    "homeVisits" BOOLEAN NOT NULL DEFAULT false,
    "financialsReview" BOOLEAN NOT NULL DEFAULT false,
    "socialWorkerScreening" BOOLEAN NOT NULL DEFAULT false,
    "medicalRecordsReview" BOOLEAN NOT NULL DEFAULT false,
    "surrogateInsuranceReview" BOOLEAN NOT NULL DEFAULT false,
    "psychologicalScreening" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SurrogateScreening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderMember" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "bio" TEXT,
    "photoUrl" TEXT,
    "isMedicalDirector" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderMemberLocation" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,

    CONSTRAINT "ProviderMemberLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostTemplate" (
    "id" TEXT NOT NULL,
    "providerTypeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "CostTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostTemplateItem" (
    "id" TEXT NOT NULL,
    "costTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CostTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCostEntry" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "costTemplateItemId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "notes" TEXT,

    CONSTRAINT "ProviderCostEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "meetingDuration" INTEGER NOT NULL DEFAULT 30,
    "minBookingNotice" INTEGER NOT NULL DEFAULT 15,
    "bufferTime" INTEGER NOT NULL DEFAULT 0,
    "meetingLink" TEXT,
    "bookingPageSlug" TEXT,
    "calendarProvider" TEXT,
    "calendarConnected" BOOLEAN NOT NULL DEFAULT false,
    "calendarAccessToken" TEXT,
    "calendarRefreshToken" TEXT,
    "colorExternal" TEXT NOT NULL DEFAULT '#8b5cf6',
    "colorBlocks" TEXT NOT NULL DEFAULT '#f59e0b',
    "defaultSubject" TEXT,
    "autoConsentRecording" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ScheduleConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilitySlot" (
    "id" TEXT NOT NULL,
    "scheduleConfigId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AvailabilitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "publicToken" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "parentUserId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "meetingType" TEXT NOT NULL DEFAULT 'video',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "meetingUrl" TEXT,
    "notes" TEXT,
    "subject" TEXT,
    "attendeeEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attendeeName" TEXT,
    "invitedByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "rescheduledFromId" TEXT,
    "bookerTimezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "googleEventId" TEXT,
    "confirmToken" TEXT,
    "parentConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "providerConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "actualEndedAt" TIMESTAMP(3),
    "actualStartedAt" TIMESTAMP(3),
    "consentGiven" BOOLEAN NOT NULL DEFAULT false,
    "parentGoogleEventId" TEXT,
    "attendeeDetails" JSONB,
    "outlookEventId" TEXT,
    "parentOutlookEventId" TEXT,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "gcsObjectPath" TEXT NOT NULL,
    "dailyRecordingId" TEXT,
    "duration" INTEGER,
    "fileSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "transcriptText" TEXT,
    "transcriptStatus" TEXT DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarBlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Busy',
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockType" TEXT NOT NULL DEFAULT 'busy',
    "recurrence" TEXT,
    "recurrenceEnd" TIMESTAMP(3),

    CONSTRAINT "CalendarBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "recipient" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EggDonor" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalId" TEXT,
    "donorType" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "age" INTEGER,
    "dateOfBirth" TIMESTAMP(3),
    "race" TEXT,
    "ethnicity" TEXT,
    "religion" TEXT,
    "height" TEXT,
    "weight" TEXT,
    "eyeColor" TEXT,
    "hairColor" TEXT,
    "education" TEXT,
    "location" TEXT,
    "donationTypes" TEXT,
    "relationshipStatus" TEXT,
    "occupation" TEXT,
    "bloodType" TEXT,
    "donorCompensation" DECIMAL(65,30),
    "eggLotCost" DECIMAL(65,30),
    "totalCost" DECIMAL(65,30),
    "photoUrl" TEXT,
    "photoCount" INTEGER,
    "hasVideo" BOOLEAN,
    "profileUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "profileData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoUrl" TEXT,
    "cardHash" TEXT,
    "lastEditedAt" TIMESTAMP(3),
    "lastEditedBy" TEXT,
    "manuallyEditedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hiddenFromSearch" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EggDonor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EggDonorSyncConfig" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "databaseUrl" TEXT NOT NULL,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncFrequency" TEXT NOT NULL DEFAULT 'manual',
    "lastSyncEndedAt" TIMESTAMP(3),
    "lastSyncStartedAt" TIMESTAMP(3),

    CONSTRAINT "EggDonorSyncConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Surrogate" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "age" INTEGER,
    "bmi" DECIMAL(65,30),
    "baseCompensation" DECIMAL(65,30),
    "totalCompensationMin" DECIMAL(65,30),
    "totalCompensationMax" DECIMAL(65,30),
    "location" TEXT,
    "agreesToAbortion" BOOLEAN,
    "agreesToTwins" BOOLEAN,
    "covidVaccinated" BOOLEAN,
    "liveBirths" INTEGER,
    "miscarriages" INTEGER,
    "cSections" INTEGER,
    "relationshipStatus" TEXT,
    "openToSameSexCouple" BOOLEAN,
    "photoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "profileData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoUrl" TEXT,
    "cardHash" TEXT,
    "lastEditedAt" TIMESTAMP(3),
    "lastEditedBy" TEXT,
    "manuallyEditedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hiddenFromSearch" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Surrogate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurrogateSyncConfig" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "databaseUrl" TEXT NOT NULL,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncFrequency" TEXT NOT NULL DEFAULT 'manual',
    "lastSyncEndedAt" TIMESTAMP(3),
    "lastSyncStartedAt" TIMESTAMP(3),

    CONSTRAINT "SurrogateSyncConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpermDonor" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalId" TEXT,
    "donorType" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "age" INTEGER,
    "race" TEXT,
    "ethnicity" TEXT,
    "height" TEXT,
    "weight" TEXT,
    "eyeColor" TEXT,
    "hairColor" TEXT,
    "education" TEXT,
    "location" TEXT,
    "relationshipStatus" TEXT,
    "occupation" TEXT,
    "compensation" DECIMAL(65,30),
    "photoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "profileData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoUrl" TEXT,
    "cardHash" TEXT,
    "lastEditedAt" TIMESTAMP(3),
    "lastEditedBy" TEXT,
    "manuallyEditedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hiddenFromSearch" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SpermDonor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpermDonorSyncConfig" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "databaseUrl" TEXT NOT NULL,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "syncFrequency" TEXT NOT NULL DEFAULT 'manual',
    "lastSyncEndedAt" TIMESTAMP(3),
    "lastSyncStartedAt" TIMESTAMP(3),

    CONSTRAINT "SpermDonorSyncConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "slots" JSONB,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventFreeOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "calendarId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventFreeOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT,
    "email" TEXT,
    "calendarId" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiry" TIMESTAMP(3),
    "isConflictCalendar" BOOLEAN NOT NULL DEFAULT true,
    "isBookingCalendar" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "connected" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tokenValid" BOOLEAN NOT NULL DEFAULT true,
    "encryptedPassword" TEXT,
    "passwordIv" TEXT,

    CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteSettings" (
    "id" TEXT NOT NULL,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "darkLogoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#004D4D',
    "secondaryColor" TEXT NOT NULL DEFAULT '#F0FAF5',
    "accentColor" TEXT NOT NULL DEFAULT '#0DA4EA',
    "successColor" TEXT NOT NULL DEFAULT '#16a34a',
    "warningColor" TEXT NOT NULL DEFAULT '#f59e0b',
    "errorColor" TEXT NOT NULL DEFAULT '#ef4444',
    "headingFont" TEXT NOT NULL DEFAULT 'Playfair Display',
    "bodyFont" TEXT NOT NULL DEFAULT 'DM Sans',
    "baseFontSize" INTEGER NOT NULL DEFAULT 16,
    "lineHeight" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "companyName" TEXT,
    "logoWithNameUrl" TEXT,
    "darkLogoWithNameUrl" TEXT,

    CONSTRAINT "SiteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderBrandSettings" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "darkLogoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#004D4D',
    "secondaryColor" TEXT NOT NULL DEFAULT '#F0FAF5',
    "accentColor" TEXT NOT NULL DEFAULT '#0DA4EA',
    "successColor" TEXT NOT NULL DEFAULT '#16a34a',
    "warningColor" TEXT NOT NULL DEFAULT '#f59e0b',
    "errorColor" TEXT NOT NULL DEFAULT '#ef4444',
    "headingFont" TEXT NOT NULL DEFAULT 'Playfair Display',
    "bodyFont" TEXT NOT NULL DEFAULT 'DM Sans',
    "baseFontSize" INTEGER NOT NULL DEFAULT 16,
    "lineHeight" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "companyName" TEXT,
    "logoWithNameUrl" TEXT,
    "darkLogoWithNameUrl" TEXT,

    CONSTRAINT "ProviderBrandSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderType_name_key" ON "ProviderType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderService_providerId_providerTypeId_key" ON "ProviderService"("providerId", "providerTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserLocation_userId_locationId_key" ON "UserLocation"("userId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "SurrogacyAgencyProfile_providerId_key" ON "SurrogacyAgencyProfile"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "SurrogateScreening_surrogacyProfileId_key" ON "SurrogateScreening"("surrogacyProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderMemberLocation_memberId_locationId_key" ON "ProviderMemberLocation"("memberId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCostEntry_providerId_costTemplateItemId_key" ON "ProviderCostEntry"("providerId", "costTemplateItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleConfig_userId_key" ON "ScheduleConfig"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleConfig_bookingPageSlug_key" ON "ScheduleConfig"("bookingPageSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_publicToken_key" ON "Booking"("publicToken");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_confirmToken_key" ON "Booking"("confirmToken");

-- CreateIndex
CREATE UNIQUE INDEX "EggDonor_providerId_externalId_key" ON "EggDonor"("providerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "EggDonorSyncConfig_providerId_key" ON "EggDonorSyncConfig"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "Surrogate_providerId_externalId_key" ON "Surrogate"("providerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SurrogateSyncConfig_providerId_key" ON "SurrogateSyncConfig"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "SpermDonor_providerId_externalId_key" ON "SpermDonor"("providerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SpermDonorSyncConfig_providerId_key" ON "SpermDonorSyncConfig"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilityOverride_userId_date_key" ON "AvailabilityOverride"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "EventFreeOverride_userId_externalEventId_provider_key" ON "EventFreeOverride"("userId", "externalEventId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderBrandSettings_providerId_key" ON "ProviderBrandSettings"("providerId");

-- AddForeignKey
ALTER TABLE "ProviderService" ADD CONSTRAINT "ProviderService_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderService" ADD CONSTRAINT "ProviderService_providerTypeId_fkey" FOREIGN KEY ("providerTypeId") REFERENCES "ProviderType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLocation" ADD CONSTRAINT "ProviderLocation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_parentAccountId_fkey" FOREIGN KEY ("parentAccountId") REFERENCES "ParentAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocation" ADD CONSTRAINT "UserLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ProviderLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserLocation" ADD CONSTRAINT "UserLocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurrogacyAgencyProfile" ADD CONSTRAINT "SurrogacyAgencyProfile_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurrogateScreening" ADD CONSTRAINT "SurrogateScreening_surrogacyProfileId_fkey" FOREIGN KEY ("surrogacyProfileId") REFERENCES "SurrogacyAgencyProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderMember" ADD CONSTRAINT "ProviderMember_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderMemberLocation" ADD CONSTRAINT "ProviderMemberLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "ProviderLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderMemberLocation" ADD CONSTRAINT "ProviderMemberLocation_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "ProviderMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostTemplate" ADD CONSTRAINT "CostTemplate_providerTypeId_fkey" FOREIGN KEY ("providerTypeId") REFERENCES "ProviderType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostTemplateItem" ADD CONSTRAINT "CostTemplateItem_costTemplateId_fkey" FOREIGN KEY ("costTemplateId") REFERENCES "CostTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCostEntry" ADD CONSTRAINT "ProviderCostEntry_costTemplateItemId_fkey" FOREIGN KEY ("costTemplateItemId") REFERENCES "CostTemplateItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCostEntry" ADD CONSTRAINT "ProviderCostEntry_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleConfig" ADD CONSTRAINT "ScheduleConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_scheduleConfigId_fkey" FOREIGN KEY ("scheduleConfigId") REFERENCES "ScheduleConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_parentUserId_fkey" FOREIGN KEY ("parentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_providerUserId_fkey" FOREIGN KEY ("providerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_rescheduledFromId_fkey" FOREIGN KEY ("rescheduledFromId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarBlock" ADD CONSTRAINT "CalendarBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EggDonor" ADD CONSTRAINT "EggDonor_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EggDonorSyncConfig" ADD CONSTRAINT "EggDonorSyncConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Surrogate" ADD CONSTRAINT "Surrogate_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurrogateSyncConfig" ADD CONSTRAINT "SurrogateSyncConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpermDonor" ADD CONSTRAINT "SpermDonor_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpermDonorSyncConfig" ADD CONSTRAINT "SpermDonorSyncConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityOverride" ADD CONSTRAINT "AvailabilityOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventFreeOverride" ADD CONSTRAINT "EventFreeOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderBrandSettings" ADD CONSTRAINT "ProviderBrandSettings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

