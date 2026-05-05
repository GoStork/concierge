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
  chatBubbleLineHeight: number;
  chatBubblePaddingX: number;
  chatBubblePaddingY: number;
  chatBubbleMaxWidth: number;
  chatBubbleRadius: number;
  chatTimestampFontSize: number;
  chatTimestampOpacity: number;
  chatInputFontSize: number;
  chatInputHeight: number;
  onboardingClinicImageUrl: string | null;
  onboardingEggDonorImageUrl: string | null;
  onboardingSurrogateImageUrl: string | null;
  onboardingSpermDonorImageUrl: string | null;
  enableAiConcierge?: boolean;
  parentExperienceMode?: string;
  matchmakers?: Matchmaker[];
}

export const BRAND_DEFAULTS: BrandSettings = {
  id: null,
  companyName: null,
  logoUrl: null,
  logoWithNameUrl: null,
  darkLogoWithNameUrl: null,
  faviconUrl: null,
  darkLogoUrl: null,
  primaryColor: "#004D4D",
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
  chatBubbleFontSize: 17,
  chatBubbleLineHeight: 1.3,
  chatBubblePaddingX: 14,
  chatBubblePaddingY: 10,
  chatBubbleMaxWidth: 75,
  chatBubbleRadius: 20,
  chatTimestampFontSize: 11,
  chatTimestampOpacity: 0.45,
  chatInputFontSize: 17,
  chatInputHeight: 36,
  onboardingClinicImageUrl: null,
  onboardingEggDonorImageUrl: null,
  onboardingSurrogateImageUrl: null,
  onboardingSpermDonorImageUrl: null,
};

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

  root.style.setProperty("--font-display", `'${settings.headingFont}'`);
  // Don't quote font stacks or system font keywords (they must not be wrapped in single quotes)
  const bodyFontCss = settings.bodyFont.includes(",") || settings.bodyFont.startsWith("-")
    ? settings.bodyFont
    : `'${settings.bodyFont}'`;
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
  root.style.setProperty("--chat-bubble-font-size", `${settings.chatBubbleFontSize ?? 17}px`);
  root.style.setProperty("--chat-bubble-line-height", String(settings.chatBubbleLineHeight ?? 1.35));
  root.style.setProperty("--chat-bubble-px", `${settings.chatBubblePaddingX ?? 14}px`);
  root.style.setProperty("--chat-bubble-py", `${settings.chatBubblePaddingY ?? 8}px`);
  root.style.setProperty("--chat-bubble-max-width", `${settings.chatBubbleMaxWidth ?? 80}%`);
  root.style.setProperty("--chat-bubble-radius", `${settings.chatBubbleRadius ?? 20}px`);
  root.style.setProperty("--chat-timestamp-font-size", `${settings.chatTimestampFontSize ?? 11}px`);
  root.style.setProperty("--chat-timestamp-opacity", String(settings.chatTimestampOpacity ?? 0.45));
  root.style.setProperty("--chat-input-font-size", `${settings.chatInputFontSize ?? 17}px`);
  root.style.setProperty("--chat-input-height", `${settings.chatInputHeight ?? 36}px`);

  const fonts = [settings.headingFont, settings.bodyFont];
  const uniqueFonts = [...new Set(fonts)];
  const existingLink = document.getElementById("brand-google-fonts");
  const families = uniqueFonts.map(f => `family=${f.replace(/ /g, "+")}:wght@400;500;600;700`).join("&");
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
