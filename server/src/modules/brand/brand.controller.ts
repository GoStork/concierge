import { Prisma } from "@prisma/client";
import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  UseGuards,
  Inject,
  ForbiddenException,
  BadRequestException,
  Req,
  Param,
  NotFoundException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { SessionOrJwtGuard } from "../auth/guards/auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { BRAND_PRIMARY_FALLBACK } from "../../../../shared/brand-fallback";

const DEFAULTS = {
  companyName: null,
  primaryColor: BRAND_PRIMARY_FALLBACK,
  secondaryColor: "#F0FAF5",
  accentColor: "#0DA4EA",
  successColor: "#16a34a",
  warningColor: "#f59e0b",
  errorColor: "#ef4444",
  headingFont: "Playfair Display",
  bodyFont: "DM Sans",
  baseFontSize: 16,
  lineHeight: 1.5,
  typeScaleRatio: 1.25,
  smallTextSize: 14,
  baseBodyWeight: "400",
  headingWeight: "700",
  uiButtonWeight: "500",
  bodyLineHeight: 1.6,
  headingLineHeight: 1.2,
  letterSpacing: "normal",
  buttonTextCase: "normal",
  linkDecoration: "hover",
  logoUrl: null,
  logoWithNameUrl: null,
  darkLogoWithNameUrl: null,
  faviconUrl: null,
  darkLogoUrl: null,
  backgroundColor: null,
  foregroundColor: null,
  cardColor: null,
  cardForegroundColor: null,
  mutedColor: null,
  mutedForegroundColor: null,
  borderColor: null,
  inputColor: null,
  ringColor: null,
  popoverColor: null,
  popoverForegroundColor: null,
  primaryForegroundColor: null,
  secondaryForegroundColor: null,
  accentForegroundColor: null,
  destructiveForegroundColor: null,
  borderRadius: 0.5,
  containerRadius: 0.5,
  bottomNavRadius: 0,
  bottomNavBgColor: null,
  bottomNavSafeAreaColor: null,
  bottomNavShadow: null,
  bottomNavOpacity: 100,
  bottomNavBlur: null,
  bottomNavFgColor: null,
  bottomNavActiveFgColor: null,
  bottomNavStyle: "icon-label",
  tabColor: null,
  tabHoverColor: null,
  tabActiveColor: null,
  headerNavStyle: "pill",
  swipePassColor: null,
  swipeSaveColor: null,
  swipeUndoColor: null,
  swipeChatColor: null,
  swipeCompareColor: null,
  cardTitleSize: 24,
  cardOverlaySize: 16,
  filterLabelSize: 18,
  badgeTextSize: 13,
  drawerMinHeight: 50,
  drawerTitleSize: 24,
  drawerBodySize: 16,
  drawerHandleWidth: 60,
  sliderValueSize: 22,
  sliderThumbSize: 24,
  enableAiConcierge: false,
  parentExperienceMode: "MARKETPLACE_ONLY",
  chatBubbleFontSize: 21,
  chatBubbleFontSizeDesktop: 15,
  chatBubbleLineHeight: 1.35,
  chatBubblePaddingX: 16,
  chatBubblePaddingY: 11,
  chatBubbleMaxWidth: 85,
  chatBubbleRadius: 20,
  chatTimestampFontSize: 11,
  chatTimestampOpacity: 0.45,
  chatInputFontSize: 17,
  chatInputFontSizeDesktop: 15,
  chatInputHeight: 36,
  quickReplyFontSize: 13,
  quickReplyRadius: 999,
  quickReplyPaddingX: 14,
  quickReplyPaddingY: 6,
  quickReplyColorStyle: "primary",
  quickReplyDeclineStyle: "secondary",
  quickReplyMultiStyle: "outline",
  quickReplyShowBorder: true,
  // Chat bubble background colors. null means "fall back to brand defaults":
  // own = primaryColor, ai = accentColor, provider = secondaryColor.
  chatBubbleOwnColor: null,
  chatBubbleAiColor: null,
  chatBubbleProviderColor: null,
  chatBubbleOwnTextColor: null,
  chatBubbleAiTextColor: null,
  chatBubbleProviderTextColor: null,
  chatBubbleOwnBorderColor: null,
  chatBubbleAiBorderColor: null,
  chatBubbleProviderBorderColor: null,
  chatBubbleParentColor: null,
  chatBubbleParentTextColor: null,
  chatBubbleParentBorderColor: null,

  // Content typography. Every label/value pair, prompt block, dense-card key,
  // attribute chip and section header in the product reads these through the
  // shared primitives in client/src/components/ui/field.tsx. Color nulls mean
  // "inherit the theme role" (label -> muted-foreground, value -> foreground,
  // eyebrow -> accent, chip -> secondary).
  fieldLabelSize: 14,
  fieldLabelWeight: "500",
  fieldLabelColor: "#475569",
  fieldLabelCase: "none",
  fieldLabelTracking: 0,
  fieldValueSize: 17,
  fieldValueWeight: "400",
  fieldValueColor: null,
  fieldLabelGap: 3,
  fieldPairGap: 22,
  promptEyebrowSize: 12,
  promptEyebrowWeight: "600",
  promptEyebrowColor: null,
  promptEyebrowTracking: 0.055,
  promptEyebrowCase: "uppercase",
  promptAnswerSize: 17,
  promptAnswerWeight: "400",
  promptAnswerColor: null,
  promptAnswerLineHeight: 1.6,
  promptBlockGap: 22,
  microLabelSize: 12,
  microValueSize: 15,
  microLabelWeight: "500",
  microLabelColor: null,
  microLabelTracking: 0.03,
  chipFontSize: 13,
  chipFontWeight: "500",
  chipRadius: 999,
  chipPaddingX: 11,
  chipPaddingY: 5,
  chipBgColor: null,
  chipTextColor: null,
  sectionTitleSize: 18,
  sectionTitleWeight: "600",
  formLabelSize: 14,
  formLabelSmallSize: 12,
  formLabelWeight: "500",
  formLabelColor: null,
  formLabelCase: "none",
  formLabelTracking: 0,
  helperTextSize: 13,
  helperTextColor: null,
  cardHeadingSize: 24,
  cardHeadingWeight: "700",
  pageTitleSize: 30,
  pageTitleWeight: "700",
};

const CONTENT_TYPOGRAPHY_FIELDS = [
  "fieldLabelSize", "fieldLabelWeight", "fieldLabelColor", "fieldLabelCase", "fieldLabelTracking",
  "fieldValueSize", "fieldValueWeight", "fieldValueColor", "fieldLabelGap", "fieldPairGap",
  "promptEyebrowSize", "promptEyebrowWeight", "promptEyebrowColor", "promptEyebrowTracking", "promptEyebrowCase",
  "promptAnswerSize", "promptAnswerWeight", "promptAnswerColor", "promptAnswerLineHeight", "promptBlockGap",
  "microLabelSize", "microValueSize", "microLabelWeight", "microLabelColor", "microLabelTracking",
  "chipFontSize", "chipFontWeight", "chipRadius", "chipPaddingX", "chipPaddingY", "chipBgColor", "chipTextColor",
  "sectionTitleSize", "sectionTitleWeight",
  "formLabelSize", "formLabelSmallSize", "formLabelWeight", "formLabelColor", "formLabelCase", "formLabelTracking",
  "helperTextSize", "helperTextColor",
  "cardHeadingSize", "cardHeadingWeight", "pageTitleSize", "pageTitleWeight",
];

/** Content-typography fields that hold a hex color and may be null. */
const CONTENT_TYPOGRAPHY_COLOR_FIELDS = [
  "fieldLabelColor", "fieldValueColor", "promptEyebrowColor", "promptAnswerColor",
  "microLabelColor", "chipBgColor", "chipTextColor",
  "formLabelColor", "helperTextColor",
];

const ADVANCED_COLOR_FIELDS = [
  "backgroundColor", "foregroundColor",
  "cardColor", "cardForegroundColor",
  "mutedColor", "mutedForegroundColor",
  "borderColor", "inputColor", "ringColor",
  "popoverColor", "popoverForegroundColor",
  "primaryForegroundColor", "secondaryForegroundColor",
  "accentForegroundColor", "destructiveForegroundColor",
];

const ALLOWED_FIELDS = [
  "companyName", "logoUrl", "logoWithNameUrl", "darkLogoWithNameUrl", "faviconUrl", "darkLogoUrl",
  "primaryColor", "secondaryColor", "accentColor",
  "successColor", "warningColor", "errorColor",
  "headingFont", "bodyFont", "baseFontSize", "lineHeight",
  "typeScaleRatio", "smallTextSize", "baseBodyWeight", "headingWeight", "uiButtonWeight",
  "bodyLineHeight", "headingLineHeight", "letterSpacing", "buttonTextCase", "linkDecoration",
  "borderRadius", "containerRadius",
  "bottomNavRadius", "bottomNavBgColor", "bottomNavSafeAreaColor", "bottomNavShadow", "bottomNavOpacity", "bottomNavBlur", "bottomNavFgColor", "bottomNavActiveFgColor", "bottomNavStyle",
  "tabColor", "tabHoverColor", "tabActiveColor", "headerNavStyle",
  "swipePassColor", "swipeSaveColor", "swipeUndoColor", "swipeChatColor", "swipeCompareColor",
  "cardTitleSize", "cardOverlaySize", "filterLabelSize", "badgeTextSize", "drawerMinHeight",
  "drawerTitleSize", "drawerBodySize", "drawerHandleWidth", "sliderValueSize", "sliderThumbSize",
  "enableAiConcierge", "parentExperienceMode",
  // Voice mode (Eva live voice conversations) - admin Voice settings section
  "voiceModeEnabled", "voiceTtsProvider", "voiceSttProvider", "voiceDefaultVoiceId", "voiceDefaultVoiceIds",
  "voiceSessionCapMinutes", "voiceDailyCapMinutes", "voiceAvatarEnabled", "voiceAvatarProvider",
  "voiceDefaultAvatarId",
  "onboardingClinicImageUrl", "onboardingEggDonorImageUrl", "onboardingSurrogateImageUrl", "onboardingSpermDonorImageUrl",
  "chatBubbleFontSize", "chatBubbleFontSizeDesktop", "chatBubbleLineHeight",
  "chatBubblePaddingX", "chatBubblePaddingY", "chatBubbleMaxWidth", "chatBubbleRadius",
  "chatTimestampFontSize", "chatTimestampOpacity", "chatInputFontSize", "chatInputFontSizeDesktop", "chatInputHeight",
  "quickReplyFontSize", "quickReplyRadius", "quickReplyPaddingX", "quickReplyPaddingY",
  "quickReplyColorStyle", "quickReplyDeclineStyle", "quickReplyMultiStyle", "quickReplyShowBorder",
  "chatBubbleOwnColor", "chatBubbleAiColor", "chatBubbleProviderColor", "chatBubbleParentColor",
  "chatBubbleOwnTextColor", "chatBubbleAiTextColor", "chatBubbleProviderTextColor", "chatBubbleParentTextColor",
  "chatBubbleOwnBorderColor", "chatBubbleAiBorderColor", "chatBubbleProviderBorderColor", "chatBubbleParentBorderColor",
  // Billing identity (legalName + taxId) moved to ProviderLegalIdentity.
  // See /api/provider/legal-identity and /api/admin/providers/:id/legal-identity.
  ...ADVANCED_COLOR_FIELDS,
  ...CONTENT_TYPOGRAPHY_FIELDS,
];

// Columns that actually exist on the ProviderBrandSettings model. The
// provider PUT must never pass other ALLOWED_FIELDS (enableAiConcierge,
// voice, content typography, ...) to Prisma - those are platform-global
// and live only on SiteSettings.
const PROVIDER_BRAND_COLUMNS = new Set([
  "logoUrl", "faviconUrl", "darkLogoUrl", "logoWithNameUrl", "darkLogoWithNameUrl", "companyName",
  "primaryColor", "secondaryColor", "accentColor", "successColor", "warningColor", "errorColor",
  "headingFont", "bodyFont", "nativeBodyFont", "baseFontSize", "lineHeight",
  "typeScaleRatio", "smallTextSize", "baseBodyWeight", "headingWeight", "uiButtonWeight",
  "bodyLineHeight", "headingLineHeight", "letterSpacing", "buttonTextCase", "linkDecoration",
  "backgroundColor", "foregroundColor", "cardColor", "cardForegroundColor",
  "mutedColor", "mutedForegroundColor", "borderColor", "inputColor", "ringColor",
  "popoverColor", "popoverForegroundColor", "primaryForegroundColor", "secondaryForegroundColor",
  "accentForegroundColor", "destructiveForegroundColor",
  "borderRadius", "containerRadius",
  "bottomNavRadius", "bottomNavBgColor", "bottomNavSafeAreaColor", "bottomNavFgColor", "bottomNavActiveFgColor", "bottomNavStyle",
  "tabColor", "tabHoverColor", "tabActiveColor", "headerNavStyle",
  "swipePassColor", "swipeSaveColor", "swipeUndoColor", "swipeChatColor", "swipeCompareColor",
  "cardTitleSize", "cardOverlaySize", "filterLabelSize", "badgeTextSize", "drawerMinHeight",
  "drawerTitleSize", "drawerBodySize", "drawerHandleWidth", "sliderValueSize", "sliderThumbSize",
  "chatBubbleFontSize", "chatBubbleFontSizeDesktop", "chatBubbleLineHeight",
  "chatBubblePaddingX", "chatBubblePaddingY", "chatBubbleMaxWidth", "chatBubbleRadius",
  "chatTimestampFontSize", "chatTimestampOpacity", "chatInputFontSize", "chatInputFontSizeDesktop", "chatInputHeight",
  "chatBubbleOwnColor", "chatBubbleAiColor", "chatBubbleProviderColor", "chatBubbleParentColor",
  "chatBubbleOwnTextColor", "chatBubbleAiTextColor", "chatBubbleProviderTextColor", "chatBubbleParentTextColor",
  "chatBubbleOwnBorderColor", "chatBubbleAiBorderColor", "chatBubbleProviderBorderColor", "chatBubbleParentBorderColor",
  "quickReplyFontSize", "quickReplyRadius", "quickReplyPaddingX", "quickReplyPaddingY",
  "quickReplyColorStyle", "quickReplyDeclineStyle", "quickReplyMultiStyle", "quickReplyShowBorder",
]);

function validateBrandBody(body: any) {
  const hexRegex = /^#[0-9a-fA-F]{6}$/;
  const requiredColorFields = ["primaryColor", "secondaryColor", "accentColor", "successColor", "warningColor", "errorColor"];
  for (const field of requiredColorFields) {
    if (body[field] && !hexRegex.test(body[field])) {
      throw new ForbiddenException(`Invalid hex color for ${field}`);
    }
  }

  const NAV_COLOR_FIELDS = ["bottomNavBgColor", "bottomNavSafeAreaColor", "bottomNavFgColor", "bottomNavActiveFgColor", "tabColor", "tabHoverColor", "tabActiveColor"];
  const SWIPE_COLOR_FIELDS = ["swipePassColor", "swipeSaveColor", "swipeUndoColor", "swipeChatColor", "swipeCompareColor"];
  const CHAT_BUBBLE_COLOR_FIELDS = [
    "chatBubbleOwnColor", "chatBubbleAiColor", "chatBubbleProviderColor", "chatBubbleParentColor",
    "chatBubbleOwnTextColor", "chatBubbleAiTextColor", "chatBubbleProviderTextColor", "chatBubbleParentTextColor",
    "chatBubbleOwnBorderColor", "chatBubbleAiBorderColor", "chatBubbleProviderBorderColor", "chatBubbleParentBorderColor",
  ];
  for (const field of [...ADVANCED_COLOR_FIELDS, ...SWIPE_COLOR_FIELDS, ...NAV_COLOR_FIELDS, ...CHAT_BUBBLE_COLOR_FIELDS, ...CONTENT_TYPOGRAPHY_COLOR_FIELDS]) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") {
      const trimmed = typeof body[field] === "string" ? body[field].trim() : body[field];
      if (!hexRegex.test(trimmed)) {
        body[field] = null;
      } else {
        body[field] = trimmed;
      }
    }
  }

  // Not a brand field, but it rides this row and this endpoint. Whitelisted
  // rather than passed through: the sweep switches behaviour on the exact
  // string, so an unrecognised value would silently mean "no alerts at all".
  if (body.commitmentAlertCadence !== undefined) {
    const v = String(body.commitmentAlertCadence);
    if (!["immediate", "daily", "weekly"].includes(v)) {
      throw new ForbiddenException("commitmentAlertCadence must be immediate, daily or weekly");
    }
    body.commitmentAlertCadence = v;
  }

  if (body.baseFontSize !== undefined) {
    const size = Number(body.baseFontSize);
    if (isNaN(size) || size < 10 || size > 24) {
      throw new ForbiddenException("baseFontSize must be between 10 and 24");
    }
    body.baseFontSize = size;
  }

  if (body.lineHeight !== undefined) {
    const lh = Number(body.lineHeight);
    if (isNaN(lh) || lh < 1 || lh > 3) {
      throw new ForbiddenException("lineHeight must be between 1 and 3");
    }
    body.lineHeight = lh;
  }

  if (body.typeScaleRatio !== undefined) {
    const v = Number(body.typeScaleRatio);
    if (isNaN(v) || v < 1 || v > 2) {
      throw new ForbiddenException("typeScaleRatio must be between 1 and 2");
    }
    body.typeScaleRatio = v;
  }

  if (body.smallTextSize !== undefined) {
    const v = Number(body.smallTextSize);
    if (isNaN(v) || v < 10 || v > 16) {
      throw new ForbiddenException("smallTextSize must be between 10 and 16");
    }
    body.smallTextSize = v;
  }

  if (body.borderRadius !== undefined) {
    const v = Number(body.borderRadius);
    if (isNaN(v) || v < 0 || v > 3) {
      throw new ForbiddenException("borderRadius must be between 0 and 3");
    }
    body.borderRadius = v;
  }

  if (body.containerRadius !== undefined) {
    const v = Number(body.containerRadius);
    if (isNaN(v) || v < 0 || v > 3) {
      throw new ForbiddenException("containerRadius must be between 0 and 3");
    }
    body.containerRadius = v;
  }

  if (body.bottomNavRadius !== undefined) {
    const v = Number(body.bottomNavRadius);
    if (isNaN(v) || v < 0 || v > 3) {
      throw new ForbiddenException("bottomNavRadius must be between 0 and 3");
    }
    body.bottomNavRadius = v;
  }

  if (body.bottomNavStyle !== undefined) {
    if (!["icon-label", "icon-only"].includes(body.bottomNavStyle)) {
      body.bottomNavStyle = "icon-label";
    }
  }

  if (body.headerNavStyle !== undefined) {
    if (!["pill", "underline"].includes(body.headerNavStyle)) {
      body.headerNavStyle = "pill";
    }
  }

  const validWeights = ["300", "400", "500", "600", "700", "800", "900"];
  for (const field of ["baseBodyWeight", "headingWeight", "uiButtonWeight"]) {
    if (body[field] !== undefined && !validWeights.includes(body[field])) {
      throw new ForbiddenException(`${field} must be a valid font weight (300-900)`);
    }
  }

  if (body.bodyLineHeight !== undefined) {
    const v = Number(body.bodyLineHeight);
    if (isNaN(v) || v < 1 || v > 2.5) {
      throw new ForbiddenException("bodyLineHeight must be between 1 and 2.5");
    }
    body.bodyLineHeight = v;
  }

  if (body.headingLineHeight !== undefined) {
    const v = Number(body.headingLineHeight);
    if (isNaN(v) || v < 0.9 || v > 2) {
      throw new ForbiddenException("headingLineHeight must be between 0.9 and 2");
    }
    body.headingLineHeight = v;
  }

  const validSpacings = ["tight", "normal", "wide"];
  if (body.letterSpacing !== undefined && !validSpacings.includes(body.letterSpacing)) {
    throw new ForbiddenException("letterSpacing must be tight, normal, or wide");
  }

  const validTextCases = ["normal", "uppercase", "capitalize"];
  if (body.buttonTextCase !== undefined && !validTextCases.includes(body.buttonTextCase)) {
    throw new ForbiddenException("buttonTextCase must be normal, uppercase, or capitalize");
  }

  const validLinkDeco = ["always", "hover"];
  if (body.linkDecoration !== undefined && !validLinkDeco.includes(body.linkDecoration)) {
    throw new ForbiddenException("linkDecoration must be always or hover");
  }

  const intFields: Record<string, [number, number]> = {
    chatBubbleFontSize: [13, 28],
    chatBubbleFontSizeDesktop: [13, 24],
    chatBubblePaddingX: [8, 28],
    chatBubblePaddingY: [4, 20],
    chatBubbleMaxWidth: [50, 95],
    chatBubbleRadius: [4, 32],
    chatTimestampFontSize: [8, 16],
    chatInputFontSize: [13, 22],
    chatInputFontSizeDesktop: [13, 20],
    chatInputHeight: [28, 56],
    quickReplyFontSize: [10, 18],
    quickReplyRadius: [0, 999],
    quickReplyPaddingX: [6, 28],
    quickReplyPaddingY: [2, 16],
  };
  for (const [field, [min, max]] of Object.entries(intFields)) {
    if (body[field] !== undefined && body[field] !== null) {
      const v = Number(body[field]);
      if (isNaN(v) || v < min || v > max) {
        throw new ForbiddenException(`${field} must be between ${min} and ${max}`);
      }
      body[field] = Math.round(v);
    }
  }

  if (body.quickReplyColorStyle !== undefined && body.quickReplyColorStyle !== null) {
    if (!["primary", "accent", "secondary", "outline"].includes(body.quickReplyColorStyle)) {
      body.quickReplyColorStyle = "primary";
    }
  }

  if (body.quickReplyDeclineStyle !== undefined && body.quickReplyDeclineStyle !== null) {
    if (!["primary", "accent", "secondary", "outline"].includes(body.quickReplyDeclineStyle)) {
      body.quickReplyDeclineStyle = "secondary";
    }
  }

  if (body.quickReplyMultiStyle !== undefined && body.quickReplyMultiStyle !== null) {
    if (!["primary", "accent", "secondary", "outline"].includes(body.quickReplyMultiStyle)) {
      body.quickReplyMultiStyle = "outline";
    }
  }

  if (body.quickReplyShowBorder !== undefined && body.quickReplyShowBorder !== null) {
    body.quickReplyShowBorder = body.quickReplyShowBorder === true || body.quickReplyShowBorder === "true";
  }

  if (body.chatBubbleLineHeight !== undefined && body.chatBubbleLineHeight !== null) {
    const v = Number(body.chatBubbleLineHeight);
    if (isNaN(v) || v < 1.0 || v > 2.0) {
      throw new ForbiddenException("chatBubbleLineHeight must be between 1.0 and 2.0");
    }
    body.chatBubbleLineHeight = v;
  }

  if (body.chatTimestampOpacity !== undefined && body.chatTimestampOpacity !== null) {
    const v = Number(body.chatTimestampOpacity);
    if (isNaN(v) || v < 0.1 || v > 1.0) {
      throw new ForbiddenException("chatTimestampOpacity must be between 0.1 and 1.0");
    }
    body.chatTimestampOpacity = v;
  }

  // Voice mode settings
  if (body.voiceTtsProvider !== undefined && !["elevenlabs", "openai", "cartesia"].includes(body.voiceTtsProvider)) {
    throw new ForbiddenException("voiceTtsProvider must be elevenlabs, openai, or cartesia");
  }
  if (body.voiceSttProvider !== undefined && !["google", "deepgram"].includes(body.voiceSttProvider)) {
    throw new ForbiddenException("voiceSttProvider must be google or deepgram");
  }
  if (body.voiceAvatarProvider !== undefined && !["heygen", "simli"].includes(body.voiceAvatarProvider)) {
    throw new ForbiddenException("voiceAvatarProvider must be heygen or simli");
  }
  if (body.voiceDefaultVoiceIds !== undefined && body.voiceDefaultVoiceIds !== null) {
    if (typeof body.voiceDefaultVoiceIds !== "object" || Array.isArray(body.voiceDefaultVoiceIds)) {
      throw new ForbiddenException("voiceDefaultVoiceIds must be an object of provider -> voice id");
    }
    const clean: Record<string, string> = {};
    for (const [prov, vid] of Object.entries(body.voiceDefaultVoiceIds)) {
      if (["elevenlabs", "openai", "cartesia"].includes(prov) && typeof vid === "string" && vid.trim()) {
        clean[prov] = vid.trim();
      }
    }
    body.voiceDefaultVoiceIds = clean;
  }
  for (const field of ["voiceModeEnabled", "voiceAvatarEnabled"]) {
    if (body[field] !== undefined && body[field] !== null) {
      body[field] = body[field] === true || body[field] === "true";
    }
  }
  const voiceIntFields: Record<string, [number, number]> = {
    voiceSessionCapMinutes: [1, 120],
    voiceDailyCapMinutes: [1, 600],
  };
  for (const [field, [min, max]] of Object.entries(voiceIntFields)) {
    if (body[field] !== undefined && body[field] !== null) {
      const v = Number(body[field]);
      if (isNaN(v) || v < min || v > max) {
        throw new ForbiddenException(`${field} must be between ${min} and ${max}`);
      }
      body[field] = Math.round(v);
    }
  }

  const data: Record<string, any> = {};
  for (const field of ALLOWED_FIELDS) {
    if (body[field] !== undefined) {
      data[field] = body[field] === "" ? null : body[field];
    }
  }
  return data;
}

@ApiTags("Brand")
@Controller("api/brand")
export class BrandController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get("settings")
  @ApiOperation({ summary: "Get effective brand settings (public, user-aware)" })
  async getSettings(@Req() req: any) {
    const user = req.user;
    const roles: string[] = user?.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");
    let matchmakers = await this.prisma.matchmaker.findMany({ orderBy: { sortOrder: "asc" } });
    if (matchmakers.length === 0) {
      await this.seedDefaultMatchmakers();
      matchmakers = await this.prisma.matchmaker.findMany({ orderBy: { sortOrder: "asc" } });
    }
    if (!isAdmin && user?.providerId) {
      const provider = await this.prisma.provider.findUnique({
        where: { id: user.providerId },
        select: { brandingEnabled: true },
      });
      if (provider?.brandingEnabled) {
        const providerSettings = await this.prisma.providerBrandSettings.findUnique({
          where: { providerId: user.providerId },
        });
        if (providerSettings) {
          const global = await this.prisma.siteSettings.findFirst();
          const base = global || DEFAULTS;
          const merged: Record<string, any> = { ...base };
          for (const field of ALLOWED_FIELDS) {
            if ((providerSettings as any)[field] != null) {
              merged[field] = (providerSettings as any)[field];
            }
          }
          merged.id = providerSettings.id;
          merged.matchmakers = matchmakers;
          return merged;
        }
      }
    }
    const settings = await this.prisma.siteSettings.findFirst();
    if (!settings) {
      return { ...DEFAULTS, id: null, matchmakers };
    }
    return { ...settings, matchmakers };
  }

  @Get("global")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get raw global brand settings without provider merge (admin only)" })
  async getGlobalSettings(@Req() req: any) {
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Admin access required");
    }
    const settings = await this.prisma.siteSettings.findFirst();
    if (!settings) {
      return { ...DEFAULTS, id: null };
    }
    return settings;
  }

  @Put("settings")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update brand settings (admin only)" })
  async updateSettings(@Req() req: any, @Body() body: any) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }

    const data = validateBrandBody(body);

    const existing = await this.prisma.siteSettings.findFirst();
    if (existing) {
      return this.prisma.siteSettings.update({
        where: { id: existing.id },
        data,
      });
    } else {
      return this.prisma.siteSettings.create({ data });
    }
  }

  @Post("reset")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Reset brand settings to defaults (admin only)" })
  async resetSettings(@Req() req: any) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }

    const existing = await this.prisma.siteSettings.findFirst();
    if (existing) {
      return this.prisma.siteSettings.update({
        where: { id: existing.id },
        data: DEFAULTS,
      });
    }
    return { ...DEFAULTS, id: null };
  }

  private async assertProviderAccess(req: any, providerId: string) {
    const roles: string[] = req.user.roles || [];
    const isAdmin = roles.includes("GOSTORK_ADMIN");

    if (isAdmin) return { isAdmin: true };

    if (!roles.includes("PROVIDER_ADMIN")) {
      throw new ForbiddenException("Only Provider Admins can manage brand settings");
    }

    if (req.user.providerId !== providerId) {
      throw new ForbiddenException("You do not belong to this provider");
    }

    const provider = await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { brandingEnabled: true },
    });
    if (!provider) throw new NotFoundException("Provider not found");
    if (!provider.brandingEnabled) {
      throw new ForbiddenException("Branding is not enabled for this provider");
    }

    return { isAdmin: false };
  }

  @Get("provider/:providerId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get provider brand settings" })
  async getProviderSettings(@Req() req: any, @Param("providerId") providerId: string) {
    await this.assertProviderAccess(req, providerId);

    const [settings, provider, global] = await Promise.all([
      this.prisma.providerBrandSettings.findUnique({ where: { providerId } }),
      this.prisma.provider.findUnique({
        where: { id: providerId },
        select: { brandingEnabled: true },
      }),
      this.prisma.siteSettings.findFirst(),
    ]);

    // A provider inherits the live global brand; only non-null fields on the
    // provider row are overrides. Return the merged effective view so the
    // branding form always shows what parents actually see.
    const merged: Record<string, any> = { ...DEFAULTS };
    for (const field of ALLOWED_FIELDS) {
      if (global && (global as any)[field] != null) {
        merged[field] = (global as any)[field];
      }
      if (settings && (settings as any)[field] != null) {
        merged[field] = (settings as any)[field];
      }
    }
    merged.id = settings?.id ?? null;
    merged.providerId = providerId;
    merged.brandingEnabled = provider?.brandingEnabled ?? false;
    return merged;
  }

  @Put("provider/:providerId")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update provider brand settings" })
  async updateProviderSettings(
    @Req() req: any,
    @Param("providerId") providerId: string,
    @Body() body: any,
  ) {
    await this.assertProviderAccess(req, providerId);

    const data = validateBrandBody(body);

    // Only fields that exist on ProviderBrandSettings can be stored; the
    // form posts the full merged brand object, which includes global-only
    // fields that would make Prisma throw.
    for (const key of Object.keys(data)) {
      if (!PROVIDER_BRAND_COLUMNS.has(key)) delete data[key];
    }

    // Inheritance rule: a submitted value equal to the effective global
    // value is not an override - store null so the provider keeps tracking
    // future platform rebrands. Only true deviations are persisted.
    const global = await this.prisma.siteSettings.findFirst();
    for (const key of Object.keys(data)) {
      const globalVal = global && (global as any)[key] != null ? (global as any)[key] : (DEFAULTS as any)[key];
      if (data[key] != null && globalVal != null && data[key] === globalVal) {
        data[key] = null;
      }
    }

    const existing = await this.prisma.providerBrandSettings.findUnique({
      where: { providerId },
    });
    if (existing) {
      await this.prisma.providerBrandSettings.update({
        where: { providerId },
        data,
      });
    } else {
      await this.prisma.providerBrandSettings.create({
        data: { ...data, providerId },
      });
    }
    // Return the merged effective view, same shape as GET.
    return this.getProviderSettings(req, providerId);
  }

  @Post("provider/:providerId/reset")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Reset provider brand settings to defaults" })
  async resetProviderSettings(@Req() req: any, @Param("providerId") providerId: string) {
    await this.assertProviderAccess(req, providerId);

    // Reset = remove every override (including logos) so the provider fully
    // re-inherits the live global brand. Deleting the row is the cleanest
    // "no overrides" state; effective settings fall back to SiteSettings.
    const existing = await this.prisma.providerBrandSettings.findUnique({
      where: { providerId },
    });
    if (existing) {
      await this.prisma.providerBrandSettings.delete({ where: { providerId } });
    }
    return this.getProviderSettings(req, providerId);
  }

  @Put("provider/:providerId/toggle")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Toggle provider branding (admin only)" })
  async toggleProviderBranding(
    @Req() req: any,
    @Param("providerId") providerId: string,
    @Body() body: { enabled: boolean },
  ) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }

    const provider = await this.prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundException("Provider not found");

    const updated = await this.prisma.provider.update({
      where: { id: providerId },
      data: { brandingEnabled: !!body.enabled },
      select: { id: true, brandingEnabled: true },
    });

    if (body.enabled) {
      const existing = await this.prisma.providerBrandSettings.findUnique({
        where: { providerId },
      });
      if (!existing) {
        const data: Prisma.ProviderBrandSettingsUncheckedCreateInput = { providerId };
        if (provider.logoUrl) data.logoUrl = provider.logoUrl;
        if (provider.name) data.companyName = provider.name;
        await this.prisma.providerBrandSettings.create({ data });
      } else {
        const hasAnyLogo = !!(existing.logoUrl || existing.logoWithNameUrl || existing.faviconUrl || existing.darkLogoUrl || existing.darkLogoWithNameUrl);
        const updates: Record<string, any> = {};
        if (!hasAnyLogo && provider.logoUrl) updates.logoUrl = provider.logoUrl;
        if (!existing.companyName && provider.name) updates.companyName = provider.name;
        if (Object.keys(updates).length > 0) {
          await this.prisma.providerBrandSettings.update({
            where: { providerId },
            data: updates,
          });
        }
      }
    }

    return updated;
  }

  @Get("templates")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List all brand templates (admin only)" })
  async listTemplates(@Req() req: any) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN") && !roles.includes("GOSTORK_DEVELOPER")) {
      throw new ForbiddenException("Admin access required");
    }
    return this.prisma.brandTemplate.findMany({ orderBy: { name: "asc" } });
  }

  @Post("templates")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a new brand template (admin only)" })
  async createTemplate(@Req() req: any, @Body() body: { name: string; config: any }) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      throw new BadRequestException("Template name is required");
    }
    if (!body.config || typeof body.config !== "object") {
      throw new BadRequestException("Template config is required");
    }
    validateBrandBody(body.config);
    return this.prisma.brandTemplate.create({
      data: { name: body.name.trim(), config: body.config },
    });
  }

  @Put("templates/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update a brand template (admin only)" })
  async updateTemplate(
    @Req() req: any,
    @Param("id") id: string,
    @Body() body: { name?: string; config?: any },
  ) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }
    const template = await this.prisma.brandTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException("Template not found");

    const data: Record<string, any> = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.config !== undefined) {
      validateBrandBody(body.config);
      data.config = body.config;
    }
    return this.prisma.brandTemplate.update({ where: { id }, data });
  }

  @Delete("templates/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete a brand template (admin only)" })
  async deleteTemplate(@Req() req: any, @Param("id") id: string) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }
    const template = await this.prisma.brandTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException("Template not found");
    if (template.isActive) {
      throw new BadRequestException("Cannot delete the active template");
    }
    await this.prisma.brandTemplate.delete({ where: { id } });
    return { success: true };
  }

  @Post("templates/:id/activate")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Activate a brand template (admin only)" })
  async activateTemplate(@Req() req: any, @Param("id") id: string) {
    const roles: string[] = req.user.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }
    const template = await this.prisma.brandTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException("Template not found");

    const config = template.config as Record<string, any>;
    const settingsData = validateBrandBody(config);

    await this.prisma.$transaction(async (tx) => {
      await tx.brandTemplate.updateMany({ data: { isActive: false } });
      await tx.brandTemplate.update({ where: { id }, data: { isActive: true } });

      const existing = await tx.siteSettings.findFirst();
      if (existing) {
        await tx.siteSettings.update({ where: { id: existing.id }, data: settingsData });
      } else {
        await tx.siteSettings.create({ data: settingsData });
      }
    });

    return this.prisma.brandTemplate.findUnique({ where: { id } });
  }

  @Get("matchmakers")
  @ApiOperation({ summary: "List all AI matchmakers (public)" })
  async listMatchmakers() {
    const matchmakers = await this.prisma.matchmaker.findMany({
      orderBy: { sortOrder: "asc" },
    });
    if (matchmakers.length === 0) {
      await this.seedDefaultMatchmakers();
      return this.prisma.matchmaker.findMany({ orderBy: { sortOrder: "asc" } });
    }
    return matchmakers;
  }

  @Post("matchmakers")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create an AI matchmaker (admin only)" })
  async createMatchmaker(@Req() req: any, @Body() body: any) {
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }
    if (!body.name || !body.title || !body.description || !body.personalityPrompt) {
      throw new BadRequestException("name, title, description, and personalityPrompt are required");
    }
    const count = await this.prisma.matchmaker.count();
    return this.prisma.matchmaker.create({
      data: {
        name: body.name,
        title: body.title,
        description: body.description,
        avatarUrl: body.avatarUrl || null,
        personalityPrompt: body.personalityPrompt,
        initialGreeting: body.initialGreeting || null,
        isActive: body.isActive !== undefined ? !!body.isActive : true,
        sortOrder: body.sortOrder ?? count,
        voiceId: body.voiceId || null,
        voiceIds: body.voiceIds && typeof body.voiceIds === "object" ? body.voiceIds : undefined,
        avatarFaceId: body.avatarFaceId || null,
        avatarFaceIdPortrait: body.avatarFaceIdPortrait || null,
      },
    });
  }

  @Put("matchmakers/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update an AI matchmaker (admin only)" })
  async updateMatchmaker(@Req() req: any, @Param("id") id: string, @Body() body: any) {
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }
    const existing = await this.prisma.matchmaker.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Matchmaker not found");

    const data: Record<string, any> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.avatarUrl !== undefined) data.avatarUrl = body.avatarUrl || null;
    if (body.personalityPrompt !== undefined) data.personalityPrompt = body.personalityPrompt;
    if (body.initialGreeting !== undefined) data.initialGreeting = body.initialGreeting || null;
    if (body.isActive !== undefined) data.isActive = !!body.isActive;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    if (body.voiceId !== undefined) data.voiceId = body.voiceId || null;
    if (body.voiceIds !== undefined && (body.voiceIds === null || typeof body.voiceIds === "object")) {
      data.voiceIds = body.voiceIds;
    }
    if (body.avatarFaceId !== undefined) data.avatarFaceId = body.avatarFaceId || null;
    if (body.avatarFaceIdPortrait !== undefined) data.avatarFaceIdPortrait = body.avatarFaceIdPortrait || null;

    return this.prisma.matchmaker.update({ where: { id }, data });
  }

  @Delete("matchmakers/:id")
  @UseGuards(SessionOrJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete an AI matchmaker (admin only)" })
  async deleteMatchmaker(@Req() req: any, @Param("id") id: string) {
    const roles: string[] = req.user?.roles || [];
    if (!roles.includes("GOSTORK_ADMIN")) {
      throw new ForbiddenException("Admin access required");
    }
    const existing = await this.prisma.matchmaker.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Matchmaker not found");
    await this.prisma.matchmaker.delete({ where: { id } });
    return { success: true };
  }

  private async seedDefaultMatchmakers() {
    const defaults = [
      {
        name: "Ariel",
        title: "The Warm Guide",
        description: "Empathetic and nurturing, Ariel walks you through every step with patience and care.",
        personalityPrompt: "You are Ariel, a warm and empathetic fertility concierge. You speak with kindness, patience, and emotional intelligence. You make intended parents feel heard and supported throughout their journey.",
        initialGreeting: "Hi there! I'm Ariel, your warm guide on this journey. I'm here to walk you through every step with patience and care. What's on your mind today?",
        sortOrder: 0,
      },
      {
        name: "Yael",
        title: "The Strategic Advisor",
        description: "Data-driven and precise, Yael helps you make informed decisions with clarity.",
        personalityPrompt: "You are Yael, a strategic and data-driven fertility advisor. You focus on providing clear, factual information and help intended parents make well-informed decisions based on success rates, costs, and clinical data.",
        initialGreeting: "Hello! I'm Yael, your strategic advisor. I focus on data and facts to help you make the most informed decisions. What would you like to explore?",
        sortOrder: 1,
      },
      {
        name: "Maya",
        title: "The Holistic Companion",
        description: "Blending medical knowledge with holistic wellness, Maya supports your whole journey.",
        personalityPrompt: "You are Maya, a holistic fertility companion. You blend medical expertise with wellness perspectives, considering the emotional, physical, and spiritual dimensions of the fertility journey.",
        initialGreeting: "Welcome! I'm Maya, and I believe in supporting your whole self through this journey - mind, body, and spirit. How can I help you today?",
        sortOrder: 2,
      },
      {
        name: "Adam",
        title: "The Straight Talker",
        description: "Direct and honest, Adam gives you the real picture without sugarcoating.",
        personalityPrompt: "You are Adam, a direct and honest fertility concierge. You give straightforward answers, avoid unnecessary fluff, and help intended parents understand exactly what to expect. You're supportive but always honest.",
        initialGreeting: "Hey! I'm Adam. I'll give you the real picture - no sugarcoating. What do you want to know?",
        sortOrder: 3,
      },
      {
        name: "Julian",
        title: "The Experience Expert",
        description: "With deep industry knowledge, Julian connects you to the best-fit providers.",
        personalityPrompt: "You are Julian, an experienced fertility industry expert. You have deep knowledge of providers, agencies, and clinics. You focus on matching intended parents with the perfect providers based on their unique needs.",
        initialGreeting: "Hi! I'm Julian. With years of industry experience, I can help connect you with the perfect providers for your unique situation. What are you looking for?",
        sortOrder: 4,
      },
      {
        name: "Gabriel",
        title: "The Encouraging Coach",
        description: "Positive and motivating, Gabriel keeps your spirits high through the process.",
        personalityPrompt: "You are Gabriel, an encouraging fertility coach. You maintain a positive, uplifting tone and help intended parents stay motivated and hopeful. You celebrate milestones and provide reassurance during challenging moments.",
        initialGreeting: "Hello! I'm Gabriel, your personal cheerleader on this journey. Every step forward is a victory, and I'm here to keep you motivated. How can I support you today?",
        sortOrder: 5,
      },
    ];
    for (const m of defaults) {
      await this.prisma.matchmaker.create({ data: m });
    }
  }
}
