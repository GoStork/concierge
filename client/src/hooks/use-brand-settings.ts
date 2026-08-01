import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { getPhotoSrc } from "@/lib/profile-utils";

export interface Matchmaker {
  id: string;
  name: string;
  title: string;
  description: string;
  avatarUrl: string | null;
  personalityPrompt: string;
  initialGreeting: string | null;
  isActive: boolean;
  sortOrder: number;
  // Voice mode: per-provider TTS voice ids ({"elevenlabs": "...", "openai": "shimmer"});
  // voiceId is the legacy single field (elevenlabs fallback)
  voiceIds?: Record<string, string> | null;
  voiceId?: string | null;
  // Phase 3 realtime video avatar identity (desktop + optional mobile portrait)
  avatarFaceId?: string | null;
  avatarFaceIdPortrait?: string | null;
  avatarProvider?: string | null;
}

export interface BrandSettings {
  id: string | null;
  companyName: string | null;
  logoUrl: string | null;
  logoWithNameUrl: string | null;
  darkLogoWithNameUrl: string | null;
  faviconUrl: string | null;
  darkLogoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  successColor: string;
  warningColor: string;
  errorColor: string;
  headingFont: string;
  bodyFont: string;
  nativeBodyFont: string | null;
  baseFontSize: number;
  lineHeight: number;
  typeScaleRatio: number;
  smallTextSize: number;
  baseBodyWeight: string;
  headingWeight: string;
  uiButtonWeight: string;
  bodyLineHeight: number;
  headingLineHeight: number;
  letterSpacing: string;
  buttonTextCase: string;
  linkDecoration: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  cardColor: string | null;
  cardForegroundColor: string | null;
  mutedColor: string | null;
  mutedForegroundColor: string | null;
  borderColor: string | null;
  inputColor: string | null;
  ringColor: string | null;
  popoverColor: string | null;
  popoverForegroundColor: string | null;
  primaryForegroundColor: string | null;
  secondaryForegroundColor: string | null;
  accentForegroundColor: string | null;
  destructiveForegroundColor: string | null;
  borderRadius: number;
  containerRadius: number;
  bottomNavRadius: number;
  bottomNavBgColor: string | null;
  bottomNavSafeAreaColor: string | null;
  bottomNavShadow: string | null;
  bottomNavOpacity: number;
  bottomNavBlur: string | null;
  bottomNavFgColor: string | null;
  bottomNavActiveFgColor: string | null;
  bottomNavStyle: string;
  tabColor: string | null;
  tabHoverColor: string | null;
  tabActiveColor: string | null;
  headerNavStyle: string;
  swipePassColor: string | null;
  swipeSaveColor: string | null;
  swipeUndoColor: string | null;
  swipeChatColor: string | null;
  swipeCompareColor: string | null;
  cardTitleSize: number;
  cardOverlaySize: number;
  filterLabelSize: number;
  badgeTextSize: number;
  drawerMinHeight: number;
  drawerTitleSize: number;
  drawerBodySize: number;
  drawerHandleWidth: number;
  sliderValueSize: number;
  sliderThumbSize: number;
  chatBubbleFontSize: number;
  chatBubbleFontSizeDesktop: number;
  chatBubbleLineHeight: number;
  chatBubblePaddingX: number;
  chatBubblePaddingY: number;
  chatBubbleMaxWidth: number;
  chatBubbleRadius: number;
  chatTimestampFontSize: number;
  chatTimestampOpacity: number;
  chatInputFontSize: number;
  chatInputFontSizeDesktop: number;
  chatInputHeight: number;
  quickReplyFontSize: number;
  quickReplyRadius: number;
  quickReplyPaddingX: number;
  quickReplyPaddingY: number;
  quickReplyColorStyle: string;
  quickReplyDeclineStyle: string;
  quickReplyMultiStyle: string;
  quickReplyShowBorder: boolean;
  chatBubbleOwnColor: string | null;
  chatBubbleAiColor: string | null;
  chatBubbleProviderColor: string | null;
  chatBubbleOwnTextColor: string | null;
  chatBubbleAiTextColor: string | null;
  chatBubbleProviderTextColor: string | null;
  chatBubbleOwnBorderColor: string | null;
  chatBubbleAiBorderColor: string | null;
  chatBubbleProviderBorderColor: string | null;
  chatBubbleParentColor: string | null;
  chatBubbleParentTextColor: string | null;
  chatBubbleParentBorderColor: string | null;
  onboardingClinicImageUrl: string | null;
  onboardingEggDonorImageUrl: string | null;
  onboardingSurrogateImageUrl: string | null;
  onboardingSpermDonorImageUrl: string | null;
  // Content typography - see applyBrandToDocument for the CSS vars these emit.
  fieldLabelSize: number;
  fieldLabelWeight: string;
  fieldLabelColor: string | null;
  fieldLabelCase: string;
  fieldLabelTracking: number;
  fieldValueSize: number;
  fieldValueWeight: string;
  fieldValueColor: string | null;
  fieldLabelGap: number;
  fieldPairGap: number;
  promptEyebrowSize: number;
  promptEyebrowWeight: string;
  promptEyebrowColor: string | null;
  promptEyebrowTracking: number;
  promptEyebrowCase: string;
  promptAnswerSize: number;
  promptAnswerWeight: string;
  promptAnswerColor: string | null;
  promptAnswerLineHeight: number;
  promptBlockGap: number;
  microLabelSize: number;
  microValueSize: number;
  microLabelWeight: string;
  microLabelColor: string | null;
  microLabelTracking: number;
  chipFontSize: number;
  chipFontWeight: string;
  chipRadius: number;
  chipPaddingX: number;
  chipPaddingY: number;
  chipBgColor: string | null;
  chipTextColor: string | null;
  sectionTitleSize: number;
  sectionTitleWeight: string;
  formLabelSize: number;
  formLabelSmallSize: number;
  formLabelWeight: string;
  formLabelColor: string | null;
  formLabelCase: string;
  formLabelTracking: number;
  helperTextSize: number;
  helperTextColor: string | null;
  cardHeadingSize: number;
  cardHeadingWeight: string;
  pageTitleSize: number;
  pageTitleWeight: string;
  enableAiConcierge?: boolean;
  parentExperienceMode?: string;
  // Voice mode (Eva live voice conversations)
  voiceModeEnabled?: boolean;
  voiceTtsProvider?: string;
  voiceSttProvider?: string;
  voiceDefaultVoiceIds?: Record<string, string> | null;
  voiceDefaultVoiceId?: string | null;
  voiceSessionCapMinutes?: number;
  voiceDailyCapMinutes?: number;
  voiceAvatarEnabled?: boolean;
  voiceAvatarProvider?: string;
  matchmakers?: Matchmaker[];
  // Billing identity for payment-receipt PDFs (agency-level)
  legalName?: string | null;
  taxId?: string | null;
}

export const BRAND_DEFAULTS: BrandSettings = {
  id: null,
  companyName: null,
  logoUrl: null,
  logoWithNameUrl: null,
  darkLogoWithNameUrl: null,
  faviconUrl: null,
  darkLogoUrl: null,
  primaryColor: "#08726F",
  secondaryColor: "#F0FAF5",
  accentColor: "#8F51A3",
  successColor: "#16a34a",
  warningColor: "#f59e0b",
  errorColor: "#ef4444",
  headingFont: "Playfair Display",
  bodyFont: "DM Sans",
  nativeBodyFont: null,
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
  bottomNavShadow: 'shadow-lg',
  bottomNavOpacity: 100,
  bottomNavBlur: 'none',
  bottomNavFgColor: null,
  bottomNavActiveFgColor: null,
  bottomNavStyle: "icon-label",
  tabColor: null,
  tabHoverColor: null,
  tabActiveColor: null,
  headerNavStyle: "pill",
  swipePassColor: "#FF4B4B",
  swipeSaveColor: "#2DE182",
  swipeUndoColor: "#FFB300",
  swipeChatColor: "#9B51E0",
  swipeCompareColor: "#2D9CDB",
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
  onboardingClinicImageUrl: null,
  onboardingEggDonorImageUrl: null,
  onboardingSurrogateImageUrl: null,
  onboardingSpermDonorImageUrl: null,
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
  legalName: null,
  taxId: null,
};

export const SYSTEM_FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

// Pick black or white text for a given background hex via WCAG luminance.
// Returns "#ffffff" for dark backgrounds and a deep neutral for light ones.
export function pickReadableFg(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return "#1f2937";
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? "#1f2937" : "#ffffff";
}

export function hexToHsl(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return `0 0% ${Math.round(l * 100)}%`;

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

const ADVANCED_COLOR_MAP: Array<[keyof BrandSettings, string]> = [
  ["backgroundColor", "--background"],
  ["foregroundColor", "--foreground"],
  ["cardColor", "--card"],
  ["cardForegroundColor", "--card-foreground"],
  ["mutedColor", "--muted"],
  ["mutedForegroundColor", "--muted-foreground"],
  ["borderColor", "--border"],
  ["inputColor", "--input"],
  ["ringColor", "--ring"],
  ["popoverColor", "--popover"],
  ["popoverForegroundColor", "--popover-foreground"],
  ["primaryForegroundColor", "--primary-foreground"],
  ["secondaryForegroundColor", "--secondary-foreground"],
  ["accentForegroundColor", "--accent-foreground"],
  ["destructiveForegroundColor", "--destructive-foreground"],
];

export function applyBrandToDocument(settings: BrandSettings) {
  const root = document.documentElement;

  root.style.setProperty("--primary", hexToHsl(settings.primaryColor));
  root.style.setProperty("--accent", hexToHsl(settings.accentColor));
  root.style.setProperty("--secondary", hexToHsl(settings.secondaryColor));
  root.style.setProperty("--brand-success", hexToHsl(settings.successColor));
  root.style.setProperty("--brand-warning", hexToHsl(settings.warningColor));
  root.style.setProperty("--brand-error", hexToHsl(settings.errorColor));
  root.style.setProperty("--destructive", hexToHsl(settings.errorColor));

  for (const [field, cssVar] of ADVANCED_COLOR_MAP) {
    const value = settings[field] as string | null;
    if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
      root.style.setProperty(cssVar, hexToHsl(value));
    } else {
      root.style.removeProperty(cssVar);
    }
  }

  if (!settings.borderColor && settings.primaryColor) {
    const hsl = hexToHsl(settings.primaryColor);
    const parts = hsl.split(" ");
    if (parts.length === 3) {
      const h = parts[0];
      const s = parseInt(parts[1]);
      root.style.setProperty("--border", `${h} ${Math.round(s * 0.3)}% 85%`);
    }
  }

  const isSystemFont = (f: string) => f.includes(",") || f.startsWith("-");
  const headingFontCss = isSystemFont(settings.headingFont) ? settings.headingFont : `'${settings.headingFont}'`;
  const bodyFontCss = isSystemFont(settings.bodyFont) ? settings.bodyFont : `'${settings.bodyFont}'`;
  root.style.setProperty("--font-display", headingFontCss);
  root.style.setProperty("--font-body", bodyFontCss);

  root.style.fontSize = `${settings.baseFontSize}px`;
  root.style.setProperty("--line-height-base", String(settings.lineHeight));
  document.body.style.lineHeight = String(settings.lineHeight);

  root.style.setProperty("--type-scale-ratio", String(settings.typeScaleRatio));
  root.style.setProperty("--font-size-small", `${settings.smallTextSize}px`);
  root.style.setProperty("--font-weight-body", settings.baseBodyWeight);
  root.style.setProperty("--font-weight-heading", settings.headingWeight);
  root.style.setProperty("--font-weight-ui", settings.uiButtonWeight);
  root.style.setProperty("--line-height-body", String(settings.bodyLineHeight));
  root.style.setProperty("--line-height-heading", String(settings.headingLineHeight));

  const spacingMap: Record<string, string> = { tight: "-0.025em", normal: "0em", wide: "0.025em" };
  root.style.setProperty("--letter-spacing-heading", spacingMap[settings.letterSpacing] || "0em");

  const caseMap: Record<string, string> = { normal: "none", uppercase: "uppercase", capitalize: "capitalize" };
  root.style.setProperty("--button-text-case", caseMap[settings.buttonTextCase] || "none");

  root.style.setProperty("--link-decoration", settings.linkDecoration === "always" ? "underline" : "none");
  root.style.setProperty("--link-decoration-hover", "underline");

  root.style.setProperty("--radius", `${settings.borderRadius ?? 0.5}rem`);
  root.style.setProperty("--container-radius", `${settings.containerRadius ?? 0.5}rem`);
  root.style.setProperty("--bottom-nav-radius", `${settings.bottomNavRadius ?? 0}rem`);
  root.style.setProperty("--bottom-nav-style", settings.bottomNavStyle || "icon-label");
  root.style.setProperty("--header-nav-style", settings.headerNavStyle || "pill");
  root.dataset.headerNavStyle = settings.headerNavStyle || "pill";

  const bottomNavColorMap: Array<[keyof BrandSettings, string]> = [
    ["bottomNavBgColor", "--bottom-nav-bg"],
    ["bottomNavSafeAreaColor", "--bottom-nav-safe-area-bg"],
    ["bottomNavFgColor", "--bottom-nav-fg"],
    ["bottomNavActiveFgColor", "--bottom-nav-active-fg"],
    ["tabColor", "--tab-color"],
    ["tabHoverColor", "--tab-hover-color"],
    ["tabActiveColor", "--tab-active-color"],
  ];
  for (const [field, cssVar] of bottomNavColorMap) {
    const value = settings[field] as string | null;
    if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
      root.style.setProperty(cssVar, value);
    } else {
      root.style.removeProperty(cssVar);
    }
  }

  const opacity = settings.bottomNavOpacity ?? 100;
  const bgHex = settings.bottomNavBgColor || null;
  if (bgHex && /^#[0-9a-fA-F]{6}$/.test(bgHex)) {
    const r = parseInt(bgHex.slice(1, 3), 16);
    const g = parseInt(bgHex.slice(3, 5), 16);
    const b = parseInt(bgHex.slice(5, 7), 16);
    root.style.setProperty("--bottom-nav-bg-rgba", `rgba(${r}, ${g}, ${b}, ${opacity / 100})`);
  } else {
    root.style.setProperty("--bottom-nav-bg-rgba", `rgba(255, 255, 255, ${opacity / 100})`);
  }

  const blurMap: Record<string, string> = { sm: '4px', DEFAULT: '8px', md: '12px', lg: '16px', xl: '24px', '2xl': '40px', '3xl': '64px' };
  const blurVal = settings.bottomNavBlur && settings.bottomNavBlur !== 'none' ? blurMap[settings.bottomNavBlur] || '0px' : '0px';
  root.style.setProperty("--bottom-nav-blur-val", `blur(${blurVal})`);

  const shadowMap: Record<string, string> = {
    'shadow-sm': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    'shadow': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
    'shadow-md': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    'shadow-lg': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    'shadow-xl': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  };
  const shadowVal = settings.bottomNavShadow && settings.bottomNavShadow !== 'none' ? shadowMap[settings.bottomNavShadow] || 'none' : 'none';
  root.style.setProperty("--bottom-nav-shadow", shadowVal);

  const swipeColorMap: Array<[keyof BrandSettings, string, string]> = [
    ["swipePassColor", "--swipe-pass", "#FF4B4B"],
    ["swipeSaveColor", "--swipe-save", "#2DE182"],
    ["swipeUndoColor", "--swipe-undo", "#FFB300"],
    ["swipeChatColor", "--swipe-chat", "#9B51E0"],
    ["swipeCompareColor", "--swipe-compare", "#2D9CDB"],
  ];
  for (const [field, cssVar, fallback] of swipeColorMap) {
    const value = settings[field] as string | null;
    root.style.setProperty(cssVar, value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback);
  }

  root.style.setProperty("--card-title-size", `${settings.cardTitleSize ?? 24}px`);
  root.style.setProperty("--card-overlay-size", `${settings.cardOverlaySize ?? 16}px`);
  root.style.setProperty("--filter-label-size", `${settings.filterLabelSize ?? 18}px`);
  root.style.setProperty("--badge-text-size", `${settings.badgeTextSize ?? 13}px`);
  root.style.setProperty("--drawer-min-height", `${settings.drawerMinHeight ?? 50}vh`);
  root.style.setProperty("--drawer-title-size", `${settings.drawerTitleSize ?? 24}px`);
  root.style.setProperty("--drawer-body-size", `${settings.drawerBodySize ?? 16}px`);
  root.style.setProperty("--drawer-handle-width", `${settings.drawerHandleWidth ?? 60}px`);
  root.style.setProperty("--slider-value-size", `${settings.sliderValueSize ?? 22}px`);
  root.style.setProperty("--slider-thumb-size", `${settings.sliderThumbSize ?? 24}px`);
  // Detect phone/tablet vs desktop via UA string.
  // iPadOS 13+ reports itself as "Macintosh" in the UA, so maxTouchPoints > 1
  // is the only reliable way to identify it as a touch device.
  const ua = navigator.userAgent;
  const isMobileOrTablet =
    /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    /iPad/i.test(ua) ||
    (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const chatBubbleSize = isMobileOrTablet
    ? (settings.chatBubbleFontSize ?? 21)
    : (settings.chatBubbleFontSizeDesktop ?? 15);
  const chatInputSize = isMobileOrTablet
    ? (settings.chatInputFontSize ?? 17)
    : (settings.chatInputFontSizeDesktop ?? 15);

  root.style.setProperty("--chat-bubble-font-size", `${chatBubbleSize}px`);
  root.style.setProperty("--chat-bubble-line-height", String(settings.chatBubbleLineHeight ?? 1.35));
  root.style.setProperty("--chat-bubble-px", `${settings.chatBubblePaddingX ?? 16}px`);
  root.style.setProperty("--chat-bubble-py", `${settings.chatBubblePaddingY ?? 11}px`);
  root.style.setProperty("--chat-bubble-max-width", `${settings.chatBubbleMaxWidth ?? 85}%`);
  root.style.setProperty("--chat-bubble-radius", `${settings.chatBubbleRadius ?? 20}px`);
  root.style.setProperty("--chat-timestamp-font-size", `${settings.chatTimestampFontSize ?? 11}px`);
  root.style.setProperty("--chat-timestamp-opacity", String(settings.chatTimestampOpacity ?? 0.45));
  root.style.setProperty("--chat-input-font-size", `${chatInputSize}px`);
  root.style.setProperty("--chat-input-height", `${settings.chatInputHeight ?? 36}px`);
  root.style.setProperty("--quick-reply-font-size", `${settings.quickReplyFontSize ?? 13}px`);
  root.style.setProperty("--quick-reply-radius", `${settings.quickReplyRadius ?? 999}px`);
  root.style.setProperty("--quick-reply-px", `${settings.quickReplyPaddingX ?? 14}px`);
  root.style.setProperty("--quick-reply-py", `${settings.quickReplyPaddingY ?? 6}px`);
  root.style.setProperty("--quick-reply-color-style", settings.quickReplyColorStyle ?? "primary");
  root.style.setProperty("--quick-reply-decline-style", settings.quickReplyDeclineStyle ?? "secondary");
  root.style.setProperty("--quick-reply-multi-style", settings.quickReplyMultiStyle ?? "outline");
  root.style.setProperty("--quick-reply-border-width", (settings.quickReplyShowBorder ?? true) ? "1px" : "0px");

  // Chat bubble background + text colors. Background defaults: own = primary,
  // ai = accent, provider = secondary. Text color defaults to auto-pick from
  // luminance when the admin hasn't set an explicit override.
  const hex = (v: string | null | undefined) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
  const bubbleOwnBg = hex(settings.chatBubbleOwnColor) ?? settings.primaryColor;
  const bubbleAiBg = hex(settings.chatBubbleAiColor) ?? settings.accentColor;
  const bubbleProviderBg = hex(settings.chatBubbleProviderColor) ?? settings.secondaryColor;
  const bubbleParentBg = hex(settings.chatBubbleParentColor) ?? settings.accentColor;
  const bubbleOwnFg = hex(settings.chatBubbleOwnTextColor) ?? pickReadableFg(bubbleOwnBg);
  const bubbleAiFg = hex(settings.chatBubbleAiTextColor) ?? pickReadableFg(bubbleAiBg);
  const bubbleProviderFg = hex(settings.chatBubbleProviderTextColor) ?? pickReadableFg(bubbleProviderBg);
  const bubbleParentFg = hex(settings.chatBubbleParentTextColor) ?? pickReadableFg(bubbleParentBg);
  // Outline (border) color. null = no visible outline. We emit "transparent"
  // in that case so the consuming `border: 1px solid var(--...)` stays valid
  // CSS - it just renders invisibly.
  const bubbleOwnBorder = hex(settings.chatBubbleOwnBorderColor) ?? "transparent";
  const bubbleAiBorder = hex(settings.chatBubbleAiBorderColor) ?? "transparent";
  const bubbleProviderBorder = hex(settings.chatBubbleProviderBorderColor) ?? "transparent";
  const bubbleParentBorder = hex(settings.chatBubbleParentBorderColor) ?? "transparent";
  root.style.setProperty("--chat-bubble-own-bg", bubbleOwnBg);
  root.style.setProperty("--chat-bubble-own-fg", bubbleOwnFg);
  root.style.setProperty("--chat-bubble-own-border", bubbleOwnBorder);
  root.style.setProperty("--chat-bubble-ai-bg", bubbleAiBg);
  root.style.setProperty("--chat-bubble-ai-fg", bubbleAiFg);
  root.style.setProperty("--chat-bubble-ai-border", bubbleAiBorder);
  root.style.setProperty("--chat-bubble-provider-bg", bubbleProviderBg);
  root.style.setProperty("--chat-bubble-provider-fg", bubbleProviderFg);
  root.style.setProperty("--chat-bubble-provider-border", bubbleProviderBorder);
  root.style.setProperty("--chat-bubble-parent-bg", bubbleParentBg);
  root.style.setProperty("--chat-bubble-parent-fg", bubbleParentFg);
  root.style.setProperty("--chat-bubble-parent-border", bubbleParentBorder);

  // ---------------------------------------------------------------------
  // Content typography. Consumed by the shared primitives in
  // client/src/components/ui/field.tsx (Field, FieldLabel, FieldValue,
  // PromptBlock, MicroField, AttributeChip) and by ProfileSection. Every
  // label/value pair in the product renders through those, so these vars are
  // the single place a brand admin changes content type.
  //
  // Colors emit a COMPLETE css color value, not an HSL triplet, so consumers
  // can write `color: var(--field-label-color)` with no wrapper. A null
  // override falls back to the matching theme role.
  // ---------------------------------------------------------------------
  const contentColor = (override: string | null | undefined, themeRole: string) =>
    override && /^#[0-9a-fA-F]{6}$/.test(override) ? override : `hsl(var(${themeRole}))`;
  const caseValue = (v: string | null | undefined) =>
    v === "uppercase" || v === "capitalize" || v === "lowercase" ? v : "none";

  root.style.setProperty("--field-label-size", `${settings.fieldLabelSize ?? 14}px`);
  root.style.setProperty("--field-label-weight", settings.fieldLabelWeight ?? "500");
  root.style.setProperty("--field-label-color", settings.fieldLabelColor && /^#[0-9a-fA-F]{6}$/.test(settings.fieldLabelColor) ? settings.fieldLabelColor : "#475569");
  root.style.setProperty("--field-label-case", caseValue(settings.fieldLabelCase));
  root.style.setProperty("--field-label-tracking", `${settings.fieldLabelTracking ?? 0}em`);
  root.style.setProperty("--field-value-size", `${settings.fieldValueSize ?? 17}px`);
  root.style.setProperty("--field-value-weight", settings.fieldValueWeight ?? "400");
  root.style.setProperty("--field-value-color", contentColor(settings.fieldValueColor, "--foreground"));
  root.style.setProperty("--field-label-gap", `${settings.fieldLabelGap ?? 3}px`);
  root.style.setProperty("--field-pair-gap", `${settings.fieldPairGap ?? 22}px`);

  root.style.setProperty("--prompt-eyebrow-size", `${settings.promptEyebrowSize ?? 12}px`);
  root.style.setProperty("--prompt-eyebrow-weight", settings.promptEyebrowWeight ?? "600");
  root.style.setProperty("--prompt-eyebrow-color", contentColor(settings.promptEyebrowColor, "--accent"));
  root.style.setProperty("--prompt-eyebrow-tracking", `${settings.promptEyebrowTracking ?? 0.055}em`);
  root.style.setProperty("--prompt-eyebrow-case", caseValue(settings.promptEyebrowCase ?? "uppercase"));
  root.style.setProperty("--prompt-answer-size", `${settings.promptAnswerSize ?? 17}px`);
  root.style.setProperty("--prompt-answer-weight", settings.promptAnswerWeight ?? "400");
  root.style.setProperty("--prompt-answer-color", contentColor(settings.promptAnswerColor, "--foreground"));
  root.style.setProperty("--prompt-answer-line-height", String(settings.promptAnswerLineHeight ?? 1.6));
  root.style.setProperty("--prompt-block-gap", `${settings.promptBlockGap ?? 22}px`);

  root.style.setProperty("--micro-label-size", `${settings.microLabelSize ?? 12}px`);
  root.style.setProperty("--micro-value-size", `${settings.microValueSize ?? 15}px`);
  root.style.setProperty("--micro-label-weight", settings.microLabelWeight ?? "500");
  root.style.setProperty("--micro-label-color", contentColor(settings.microLabelColor, "--muted-foreground"));
  root.style.setProperty("--micro-label-tracking", `${settings.microLabelTracking ?? 0.03}em`);

  root.style.setProperty("--chip-font-size", `${settings.chipFontSize ?? 13}px`);
  root.style.setProperty("--chip-font-weight", settings.chipFontWeight ?? "500");
  root.style.setProperty("--chip-radius", `${settings.chipRadius ?? 999}px`);
  root.style.setProperty("--chip-px", `${settings.chipPaddingX ?? 11}px`);
  root.style.setProperty("--chip-py", `${settings.chipPaddingY ?? 5}px`);
  root.style.setProperty("--chip-bg", contentColor(settings.chipBgColor, "--secondary"));
  root.style.setProperty("--chip-fg", contentColor(settings.chipTextColor, "--secondary-foreground"));

  root.style.setProperty("--section-title-size", `${settings.sectionTitleSize ?? 18}px`);
  root.style.setProperty("--section-title-weight", settings.sectionTitleWeight ?? "600");

  // Interface typography - consumed by ui/label.tsx, ui/card.tsx, ui/table.tsx
  // and the .t-form-label / .t-helper / .t-card-heading / .t-page-title classes.
  root.style.setProperty("--form-label-size", `${settings.formLabelSize ?? 14}px`);
  root.style.setProperty("--form-label-small-size", `${settings.formLabelSmallSize ?? 12}px`);
  root.style.setProperty("--form-label-weight", settings.formLabelWeight ?? "500");
  root.style.setProperty("--form-label-color", contentColor(settings.formLabelColor, "--foreground"));
  root.style.setProperty("--form-label-case", caseValue(settings.formLabelCase));
  root.style.setProperty("--form-label-tracking", `${settings.formLabelTracking ?? 0}em`);
  root.style.setProperty("--helper-text-size", `${settings.helperTextSize ?? 13}px`);
  root.style.setProperty("--helper-text-color", contentColor(settings.helperTextColor, "--muted-foreground"));
  root.style.setProperty("--card-heading-size", `${settings.cardHeadingSize ?? 24}px`);
  root.style.setProperty("--card-heading-weight", settings.cardHeadingWeight ?? "700");
  root.style.setProperty("--page-title-size", `${settings.pageTitleSize ?? 30}px`);
  root.style.setProperty("--page-title-weight", settings.pageTitleWeight ?? "700");

  // Remove any previously injected media query style (no longer needed).
  document.getElementById("brand-chat-responsive")?.remove();

  // Only load Google Fonts for non-system fonts
  const googleFonts = [...new Set([settings.headingFont, settings.bodyFont])].filter(f => !isSystemFont(f));
  const existingLink = document.getElementById("brand-google-fonts");
  if (googleFonts.length > 0) {
    const families = googleFonts.map(f => `family=${f.replace(/ /g, "+")}:wght@400;500;600;700`).join("&");
    const href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    if (existingLink) {
      (existingLink as HTMLLinkElement).href = href;
    } else {
      const link = document.createElement("link");
      link.id = "brand-google-fonts";
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  } else {
    existingLink?.remove();
  }

  if (settings.faviconUrl) {
    let faviconEl = document.querySelector("link[rel='icon']") as HTMLLinkElement;
    if (!faviconEl) {
      faviconEl = document.createElement("link");
      faviconEl.rel = "icon";
      document.head.appendChild(faviconEl);
    }
    const pathname = settings.faviconUrl.split("?")[0].toLowerCase();
    const mimeMap: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    const ext = pathname.substring(pathname.lastIndexOf("."));
    faviconEl.type = mimeMap[ext] || "";
    const separator = settings.faviconUrl.includes("?") ? "&" : "?";
    const resolvedFavicon = getPhotoSrc(settings.faviconUrl) || settings.faviconUrl;
    faviconEl.href = `${resolvedFavicon}${resolvedFavicon.includes("?") ? "&" : "?"}v=${Date.now()}`;
  }
}

const BRAND_CACHE_KEY = "gostork_brand_settings";

function loadCachedBrand(): BrandSettings | undefined {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_KEY);
    if (raw) return JSON.parse(raw) as BrandSettings;
  } catch {}
  return undefined;
}

function saveCachedBrand(settings: BrandSettings) {
  try {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(settings));
  } catch {}
}

export function useBrandSettings() {
  const query = useQuery<BrandSettings>({
    queryKey: ["/api/brand/settings"],
    queryFn: async () => {
      const res = await fetch("/api/brand/settings");
      if (!res.ok) return BRAND_DEFAULTS;
      return res.json();
    },
    // Serve from localStorage on first render so avatars/colors are instant
    initialData: loadCachedBrand,
    initialDataUpdatedAt: 0, // always treat cached data as stale so a fresh fetch still runs
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (query.data) {
      applyBrandToDocument(query.data);
      saveCachedBrand(query.data);
      // Preload all matchmaker avatars into browser cache as soon as brand loads
      (query.data.matchmakers || []).forEach((m: any) => {
        if (!m.avatarUrl) return;
        const src = getPhotoSrc(m.avatarUrl) || m.avatarUrl;
        if (src) { const img = new Image(); img.src = src; }
      });
    }
  }, [query.data]);

  return query;
}

export function applyBrandPreview(settings: Partial<BrandSettings>) {
  const merged = { ...BRAND_DEFAULTS, ...settings };
  applyBrandToDocument(merged);
}

export function useCompanyName(): string {
  const query = useQuery<BrandSettings>({
    queryKey: ["/api/brand/settings"],
    queryFn: async () => {
      const res = await fetch("/api/brand/settings");
      if (!res.ok) return BRAND_DEFAULTS;
      return res.json();
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  return query.data?.companyName || "GoStork";
}
