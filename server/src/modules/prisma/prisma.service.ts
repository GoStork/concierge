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

  get spermDonor() {
    return prisma.spermDonor;
  }

  get spermDonorSyncConfig() {
    return prisma.spermDonorSyncConfig;
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

  get providerCostSheet() {
    return prisma.providerCostSheet;
  }

  get costItem() {
    return prisma.costItem;
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

  get $transaction() {
    return prisma.$transaction.bind(prisma);
  }

  get $executeRawUnsafe() {
    return prisma.$executeRawUnsafe.bind(prisma);
  }

  get $queryRawUnsafe() {
    return prisma.$queryRawUnsafe.bind(prisma);
  }

  async onModuleDestroy() {
    await prisma.$disconnect();
  }
}
