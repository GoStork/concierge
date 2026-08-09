import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { prisma } from "../../../db";

@Injectable()
export class PrismaService implements OnModuleDestroy {
  get client() {
    return prisma;
  }

  get user() {
    return prisma.user;
  }

  get provider() {
    return prisma.provider;
  }

  get providerType() {
    return prisma.providerType;
  }

  get providerService() {
    return prisma.providerService;
  }

  get providerLocation() {
    return prisma.providerLocation;
  }

  get userLocation() {
    return prisma.userLocation;
  }

  get providerMember() {
    return prisma.providerMember;
  }

  get providerMemberLocation() {
    return prisma.providerMemberLocation;
  }

  get providerBankAccount() {
    return prisma.providerBankAccount;
  }

  get providerLegalIdentity() {
    return prisma.providerLegalIdentity;
  }

  get providerReview() {
    return prisma.providerReview;
  }

  get eggDonor() {
    return prisma.eggDonor;
  }

  get eggDonorSyncConfig() {
    return prisma.eggDonorSyncConfig;
  }

  get surrogate() {
    return prisma.surrogate;
  }

  get surrogateSyncConfig() {
    return prisma.surrogateSyncConfig;
  }

  // This wrapper exposes one getter per model - a missing getter makes
  // this.prisma.<model> silently undefined and every call a 500.
  get surrogateVerification() {
    return prisma.surrogateVerification;
  }

  get spermDonor() {
    return prisma.spermDonor;
  }

  get spermDonorSyncConfig() {
    return prisma.spermDonorSyncConfig;
  }

  get syncLog() {
    return prisma.syncLog;
  }

  get surrogacyAgencyProfile() {
    return prisma.surrogacyAgencyProfile;
  }

  get surrogateScreening() {
    return prisma.surrogateScreening;
  }

  get costTemplate() {
    return prisma.costTemplate;
  }

  get costProgram() {
    return prisma.costProgram;
  }

  get providerCostSheet() {
    return prisma.providerCostSheet;
  }

  get costItem() {
    return prisma.costItem;
  }

  get costTranche() {
    return prisma.costTranche;
  }

  get costItemPayment() {
    return prisma.costItemPayment;
  }

  get scheduleConfig() {
    return prisma.scheduleConfig;
  }

  get availabilitySlot() {
    return prisma.availabilitySlot;
  }

  get booking() {
    return prisma.booking;
  }

  get calendarBlock() {
    return prisma.calendarBlock;
  }

  get notification() {
    return prisma.notification;
  }

  get availabilityOverride() {
    return prisma.availabilityOverride;
  }

  get eventFreeOverride() {
    return prisma.eventFreeOverride;
  }

  get calendarConnection() {
    return prisma.calendarConnection;
  }

  get parentAccount() {
    return prisma.parentAccount;
  }

  get recording() {
    return prisma.recording;
  }

  get siteSettings() {
    return prisma.siteSettings;
  }

  get providerBrandSettings() {
    return prisma.providerBrandSettings;
  }

  get brandTemplate() {
    return prisma.brandTemplate;
  }

  get intendedParentProfile() {
    return prisma.intendedParentProfile;
  }

  get matchmaker() {
    return prisma.matchmaker;
  }

  get ivfSuccessRate() {
    return prisma.ivfSuccessRate;
  }

  get cdcDatasetMap() {
    return prisma.cdcDatasetMap;
  }

  get cdcSyncJob() {
    return prisma.cdcSyncJob;
  }

  get rawCdcData() {
    return prisma.rawCdcData;
  }

  get passwordResetToken() {
    return prisma.passwordResetToken;
  }

  get userDonorPreference() {
    return prisma.userDonorPreference;
  }

  get userProfilePreference() {
    return prisma.userProfilePreference;
  }

  get inAppNotification() {
    return prisma.inAppNotification;
  }

  get knowledgeChunk() {
    return prisma.knowledgeChunk;
  }

  get expertGuidanceRule() {
    return prisma.expertGuidanceRule;
  }

  get silentQuery() {
    return prisma.silentQuery;
  }

  get aiChatSession() {
    return prisma.aiChatSession;
  }

  get aiChatMessage() {
    return prisma.aiChatMessage;
  }

  get conciergeMemory() {
    return prisma.conciergeMemory;
  }

  get conciergePromptSection() {
    return prisma.conciergePromptSection;
  }

  get providerQuote() {
    return prisma.providerQuote;
  }

  get providerAutoReply() {
    return prisma.providerAutoReply;
  }

  get providerAutoReplySend() {
    return prisma.providerAutoReplySend;
  }

  get providerParentBriefing() {
    return prisma.providerParentBriefing;
  }

  get parentContactRelease() {
    return prisma.parentContactRelease;
  }

  // Parent CRM (notes / next steps / lead owners / tags on a parent account).
  get parentNote() {
    return prisma.parentNote;
  }

  get parentFollowUp() {
    return prisma.parentFollowUp;
  }

  get parentOwner() {
    return prisma.parentOwner;
  }

  get parentTagDefinition() {
    return prisma.parentTagDefinition;
  }

  get parentTagAssignment() {
    return prisma.parentTagAssignment;
  }

  get journeyPreferences() {
    return prisma.journeyPreferences;
  }

  get agreement() {
    return prisma.agreement;
  }

  get providerAgreementTemplate() {
    return prisma.providerAgreementTemplate;
  }

  get invoice() {
    return prisma.invoice;
  }

  get adminTaskDismissal() {
    return prisma.adminTaskDismissal;
  }

  get journeyEvent() {
    return prisma.journeyEvent;
  }

  get invoiceReminder() {
    return prisma.invoiceReminder;
  }

  get costSheetReminder() {
    return prisma.costSheetReminder;
  }

  get referralFeeConfig() {
    return prisma.referralFeeConfig;
  }

  get sponsorshipPlan() {
    return prisma.sponsorshipPlan;
  }

  get sponsorship() {
    return prisma.sponsorship;
  }

  get sponsorshipItem() {
    return prisma.sponsorshipItem;
  }

  get conciergeAsset() {
    return prisma.conciergeAsset;
  }

  get sponsoredRankSnapshot() {
    return prisma.sponsoredRankSnapshot;
  }

  get profileInquiry() {
    return prisma.profileInquiry;
  }

  get profileEvent() {
    return prisma.profileEvent;
  }

  get parentProfileView() {
    return prisma.parentProfileView;
  }

  get nightlySyncLock() {
    return prisma.nightlySyncLock;
  }

  get ipFormSection() {
    return prisma.ipFormSection;
  }

  get ipFormQuestion() {
    return prisma.ipFormQuestion;
  }

  get ipFormResponse() {
    return prisma.ipFormResponse;
  }

  get ipFormAnswer() {
    return prisma.ipFormAnswer;
  }

  get ipFormSignature() {
    return prisma.ipFormSignature;
  }

  get ipFormGuestToken() {
    return prisma.ipFormGuestToken;
  }

  get ipFormReminder() {
    return prisma.ipFormReminder;
  }

  get photoFingerprint() {
    return prisma.photoFingerprint;
  }

  get $transaction() {
    return prisma.$transaction.bind(prisma);
  }

  get $executeRawUnsafe() {
    return prisma.$executeRawUnsafe.bind(prisma);
  }

  get $queryRawUnsafe() {
    return prisma.$queryRawUnsafe.bind(prisma);
  }

  // Tagged-template form. Must stay bound: a tag function is invoked without a
  // receiver, so an unbound reference loses `this` and throws at call time.
  get $queryRaw() {
    return prisma.$queryRaw.bind(prisma);
  }

  async onModuleDestroy() {
    await prisma.$disconnect();
  }
}
