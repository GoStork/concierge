import { useEffect, useRef, useCallback, useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { queryClient } from "@/lib/queryClient";
import { 
  LogOut, 
  Baby, 
  User, 
  LayoutDashboard,
  Search,
  Building2,
  Users,
  ChevronDown,
  MoreHorizontal,
  Calendar,
  RefreshCw,
  MessageCircle,
  Headphones
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { hasProviderRole } from "@shared/roles";

import { EggDonorIcon, SurrogateIcon, IvfClinicIcon, AgencyIcon, SpermIcon } from "@/components/icons/marketplace-icons";
import { useAppDispatch, useAppSelector } from "@/store";
import { setMarketplaceTab } from "@/store/uiSlice";

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new AudioContext();
  }
  return sharedAudioCtx;
}

function unlockAudio() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume();
    }
  } catch {}
}

if (typeof window !== "undefined") {
  const events = ["click", "touchstart", "keydown"];
  const handler = () => {
    unlockAudio();
    events.forEach((e) => document.removeEventListener(e, handler));
  };
  events.forEach((e) => document.addEventListener(e, handler, { once: false, passive: true }));
}

function playNotificationChime() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      ctx.resume();
    }
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.3, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.8);

    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.setValueAtTime(587.33, now);
    o1.connect(g);
    o1.start(now);
    o1.stop(now + 0.3);

    const o2 = ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.setValueAtTime(880, now + 0.15);
    o2.connect(g);
    o2.start(now + 0.15);
    o2.stop(now + 0.6);
  } catch {}
}

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const { user, logoutMutation } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { toast, dismiss } = useToast();
  const { data: brandSettings } = useBrandSettings();
  const sseRef = useRef<EventSource | null>(null);
  const costsSseRef = useRef<EventSource | null>(null);

  const handleVideoJoinedEvent = useCallback((data: any) => {
    if (data.type !== "video_participant_joined") return;
    const joinerName = data.joinerName || "Someone";
    const subject = data.booking?.subject || "a meeting";
    const bookingId = data.booking?.id;

    if (bookingId && window.location.pathname === `/room/${bookingId}`) return;

    const isHost = user?.id === data.booking?.providerUserId;
    const buttonLabel = isHost ? "Start Meeting" : "Join Meeting";

    playNotificationChime();

    const { id: toastId } = toast({
      title: `${joinerName} has joined your meeting`,
      description: subject,
      variant: "success",
      action: bookingId ? (
        <Button
          size="sm"
          variant="default"
          className="gap-1 shrink-0"
          onClick={() => { dismiss(toastId); navigate(`/room/${bookingId}`); }}
          data-testid="button-join-from-toast"
        >
          {buttonLabel}
        </Button>
      ) : undefined,
      duration: 15000,
    });

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(`${joinerName} has joined your meeting`, {
          body: subject,
          icon: "/favicon.ico",
          tag: `video-join-${bookingId}`,
        });
      } catch {}
    }
  }, [toast, dismiss, navigate, user]);

  const handleBookingEvent = useCallback((data: any) => {
    const type = data.type;
    if (type !== "booking_created" && type !== "booking_confirmed" && type !== "booking_declined" && type !== "booking_cancelled" && type !== "booking_rescheduled" && type !== "booking_new_time") return;
    if (data.isOwnAction) return;

    queryClient.invalidateQueries({ queryKey: ["/api/calendar/bookings"] });
    if (data.booking?.id) {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/booking"] });
    }

    const attendeeName = data.booking?.attendeeName || "Someone";
    const subject = data.booking?.subject || "a meeting";

    let title = "";
    let description = subject;
    switch (type) {
      case "booking_created":
        title = `New meeting request from ${attendeeName}`;
        break;
      case "booking_confirmed":
        title = "Meeting confirmed";
        description = subject;
        break;
      case "booking_declined":
        title = "Meeting declined";
        description = subject;
        break;
      case "booking_cancelled":
        title = "Meeting cancelled";
        description = subject;
        break;
      case "booking_rescheduled":
        title = "Meeting rescheduled";
        description = subject;
        break;
      case "booking_new_time":
        title = "New time suggested";
        description = subject;
        break;
    }

    playNotificationChime();

    const { id: toastId } = toast({
      title,
      description,
      variant: "success",
      action: (
        <Button
          size="sm"
          variant="default"
          className="gap-1 shrink-0"
          onClick={() => { dismiss(toastId); navigate(`/calendar?bookingId=${data.booking?.id}`); }}
          data-testid="button-view-meeting-from-toast"
        >
          View
        </Button>
      ),
      duration: 15000,
    });

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, {
          body: description,
          icon: "/favicon.ico",
          tag: `booking-${type}-${data.booking?.id}`,
        });
      } catch {}
    }
  }, [toast, dismiss, navigate, user]);

  const handleCostSheetEvent = useCallback((data: any) => {
    if (data.isOwnAction) return;

    let title = "";
    let description = "";
    let actionLabel = "";
    let actionPath = "";
    let toastVariant: "success" | "destructive" = "success";

    if (data.type === "cost_sheet_submitted") {
      title = `Cost Sheet Submitted by ${data.providerName || "A provider"}`;
      description = `Version ${data.version || 1} is ready for review`;
      actionLabel = "Review";
      actionPath = `/admin/providers/${data.providerId}?tab=costs`;
    } else if (data.type === "cost_sheet_approved") {
      title = "Your Cost Sheet Has Been Approved";
      description = `Version ${data.version || 1} has been approved by GoStork`;
      actionLabel = "View";
      actionPath = "/account/costs";
    } else if (data.type === "cost_sheet_rejected") {
      title = "Your Cost Sheet Has Been Rejected";
      description = data.feedback ? `Feedback: ${data.feedback}` : `Version ${data.version || 1} needs changes`;
      actionLabel = "View";
      actionPath = "/account/costs";
      toastVariant = "destructive";
    } else if (data.type === "cost_sheet_deleted") {
      title = `Cost Sheet Deleted by ${data.providerName || "A provider"}`;
      description = "The provider has removed their cost sheet";
      actionLabel = "View";
      actionPath = `/admin/providers/${data.providerId}?tab=costs`;
      toastVariant = "destructive";
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", data.providerId] });
      queryClient.invalidateQueries({ queryKey: ["/api/costs/provider", data.providerId, "approved"] });
    } else {
      return;
    }

    playNotificationChime();

    const { id: toastId } = toast({
      title,
      description,
      variant: toastVariant,
      action: actionPath ? (
        <Button
          size="sm"
          variant="default"
          className="gap-1 shrink-0"
          onClick={() => { dismiss(toastId); navigate(actionPath); }}
          data-testid="button-view-cost-sheet-from-toast"
        >
          {actionLabel}
        </Button>
      ) : undefined,
      duration: 15000,
    });

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(title, {
          body: description,
          icon: "/favicon.ico",
          tag: `cost-sheet-${data.sheetId}`,
        });
      } catch {}
    }
  }, [toast, dismiss, navigate]);

  useEffect(() => {
    if (!user) return;
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (sseRef.current) return;

    const es = new EventSource("/api/calendar/events", { withCredentials: true });
    sseRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleVideoJoinedEvent(data);
        handleBookingEvent(data);
        handleCostSheetEvent(data);
      } catch {}
    };

    es.onerror = () => {
      es.close();
      sseRef.current = null;
      setTimeout(() => {
        if (sseRef.current) return;
        const retry = new EventSource("/api/calendar/events", { withCredentials: true });
        sseRef.current = retry;
        retry.onmessage = es.onmessage;
        retry.onerror = () => { retry.close(); sseRef.current = null; };
      }, 5000);
    };

    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [user, handleVideoJoinedEvent, handleBookingEvent, handleCostSheetEvent]);

  const dispatch = useAppDispatch();
  const marketplaceTab = useAppSelector((state) => state.ui.marketplaceTab);

  const roles = (user as any)?.roles || [];
  const isAdmin = roles.includes('GOSTORK_ADMIN');

  useEffect(() => {
    if (!user) return;
    if (costsSseRef.current) return;

    const es = new EventSource("/api/costs/events", { withCredentials: true });
    costsSseRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleVideoJoinedEvent(data);
        handleBookingEvent(data);
        handleCostSheetEvent(data);
      } catch {}
    };

    es.onerror = () => {
      es.close();
      costsSseRef.current = null;
      setTimeout(() => {
        if (costsSseRef.current) return;
        const retry = new EventSource("/api/costs/events", { withCredentials: true });
        costsSseRef.current = retry;
        retry.onmessage = es.onmessage;
        retry.onerror = () => { retry.close(); costsSseRef.current = null; };
      }, 5000);
    };

    return () => {
      es.close();
      costsSseRef.current = null;
    };
  }, [user, handleVideoJoinedEvent, handleBookingEvent, handleCostSheetEvent]);
  const isProvider = hasProviderRole(roles);
  const isParent = roles.includes('PARENT');
  const isParentOnly = isParent && !isAdmin && !isProvider;

  const { data: providerData } = useQuery<any>({
    queryKey: ["/api/providers", (user as any)?.providerId],
    queryFn: async () => {
      const res = await fetch(`/api/providers/${(user as any).providerId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: isProvider && !!(user as any)?.providerId,
  });

  const SERVICE_TO_TABS: Record<string, { id: string; label: string; mobileLabel: string; icon: any }[]> = {
    "Egg Donor Agency": [{ id: "egg-donors", label: "Egg Donors", mobileLabel: "Donors", icon: EggDonorIcon }],
    "Surrogacy Agency": [
      { id: "surrogates", label: "Surrogates", mobileLabel: "Surrogates", icon: SurrogateIcon },
      { id: "surrogacy-agencies", label: "Agencies", mobileLabel: "Agencies", icon: AgencyIcon },
    ],
    "IVF Clinic": [{ id: "ivf-clinics", label: "IVF Clinics", mobileLabel: "IVF", icon: IvfClinicIcon }],
    "Sperm Bank": [{ id: "sperm-donors", label: "Sperm Donors", mobileLabel: "Sperm", icon: SpermIcon }],
  };

  const providerMarketplaceTabs = useMemo(() => {
    if (!isProvider || !providerData?.services) return [];
    const approvedServices = providerData.services.filter((s: any) => s.status === "APPROVED");
    const tabs: { id: string; label: string; mobileLabel: string; icon: any }[] = [];
    const seen = new Set<string>();
    for (const svc of approvedServices) {
      const typeName = svc.providerType?.name;
      const mapped = typeName ? SERVICE_TO_TABS[typeName] : undefined;
      if (mapped) {
        for (const tab of mapped) {
          if (!seen.has(tab.id)) {
            seen.add(tab.id);
            tabs.push(tab);
          }
        }
      }
    }
    return tabs.filter(tab => tab.id !== "surrogacy-agencies");
  }, [isProvider, providerData]);

  const navGlassStyle = useMemo(() => {
    const opacity = brandSettings?.bottomNavOpacity ?? 100;
    const bgHex = brandSettings?.bottomNavBgColor;
    let bgColor: string;
    if (bgHex && /^#[0-9a-fA-F]{6}$/.test(bgHex)) {
      const r = parseInt(bgHex.slice(1, 3), 16);
      const g = parseInt(bgHex.slice(3, 5), 16);
      const b = parseInt(bgHex.slice(5, 7), 16);
      bgColor = `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
    } else {
      bgColor = `rgba(255, 255, 255, ${opacity / 100})`;
    }
    const blurMap: Record<string, string> = { sm: '4px', DEFAULT: '8px', md: '12px', lg: '16px', xl: '24px', '2xl': '40px', '3xl': '64px' };
    const blurVal = brandSettings?.bottomNavBlur && brandSettings.bottomNavBlur !== 'none' ? (blurMap[brandSettings.bottomNavBlur] || '0px') : '0px';
    const shadowMap: Record<string, string> = {
      'shadow-sm': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      'shadow': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
      'shadow-md': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
      'shadow-lg': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
      'shadow-xl': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    };
    const sv = brandSettings?.bottomNavShadow;
    return {
      backgroundColor: bgColor,
      borderRadius: 'var(--bottom-nav-radius, 1.5rem)',
      border: '1px solid hsl(var(--border) / 0.4)',
      backdropFilter: `blur(${blurVal})`,
      WebkitBackdropFilter: `blur(${blurVal})`,
      boxShadow: (sv && sv !== 'none' && shadowMap[sv]) || 'none',
    };
  }, [brandSettings?.bottomNavOpacity, brandSettings?.bottomNavBgColor, brandSettings?.bottomNavBlur, brandSettings?.bottomNavShadow]);

  if (!user) return <>{children}</>;

  const fullScreenRoutes = ["/onboarding", "/complete-profile", "/matchmaker-selection", "/concierge"];
  if (fullScreenRoutes.some(r => location.pathname.startsWith(r))) return <>{children}</>;

  const MARKETPLACE_TABS: { id: string; label: string; mobileLabel: string; icon: any }[] = [
    { id: "egg-donors", label: "Egg Donors", mobileLabel: "Donors", icon: EggDonorIcon },
    { id: "surrogates", label: "Surrogates", mobileLabel: "Surrogates", icon: SurrogateIcon },
    { id: "ivf-clinics", label: "IVF Clinics", mobileLabel: "IVF", icon: IvfClinicIcon },
    { id: "sperm-donors", label: "Sperm Donors", mobileLabel: "Sperm", icon: SpermIcon },
  ];

  const navigation: { show: boolean; to: string; icon: any; label: string; mobileLabel: string; tabId?: string; mobileOnly?: boolean; submenuItems?: typeof MARKETPLACE_TABS }[] = [
    { show: false /* hidden for now */, to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', mobileLabel: 'Dashboard' },
    { show: isAdmin, to: '/marketplace', icon: Search, label: 'Marketplace', mobileLabel: 'Marketplace', submenuItems: MARKETPLACE_TABS },
    { show: isProvider && !isAdmin, to: '/marketplace', icon: Search, label: 'Marketplace', mobileLabel: 'Marketplace', submenuItems: MARKETPLACE_TABS },
    { show: isParentOnly, to: '/chat', icon: MessageCircle, label: 'Chats', mobileLabel: 'Chats' },
    ...(isParentOnly && !(brandSettings?.enableAiConcierge && brandSettings?.parentExperienceMode !== 'MARKETPLACE_ONLY')
      ? MARKETPLACE_TABS.map((tab) => ({
          show: true,
          to: '/marketplace',
          icon: tab.icon,
          label: tab.label,
          mobileLabel: tab.mobileLabel,
          tabId: tab.id,
        })) : []),
    { show: !isParentOnly, to: '/chat', icon: MessageCircle, label: 'Chats', mobileLabel: 'Chats' },
    { show: isAdmin, to: '/admin/providers', icon: Building2, label: 'Providers', mobileLabel: 'Providers' },
    { show: isAdmin, to: '/admin/concierge-monitor', icon: Headphones, label: 'Concierge', mobileLabel: 'Concierge' },
    { show: isAdmin || isProvider, to: '/users', icon: Users, label: 'Parents', mobileLabel: 'Parents' },
    { show: !((user as any).parentAccountRole === 'VIEWER'), to: '/calendar', icon: Calendar, label: 'Meetings', mobileLabel: 'Meetings' },
    { show: true, to: '/account', icon: User, label: 'Profile', mobileLabel: 'Profile', mobileOnly: true },
  ];

  const visibleNav = navigation.filter(item => item.show);

  const maxBottomTabs = 7;
  const bottomTabs = visibleNav.slice(0, maxBottomTabs);
  const overflowTabs = visibleNav.slice(maxBottomTabs);

  const isActive = (to: string) => {
    const params = new URLSearchParams(location.search);
    const onUserRoute = location.pathname === '/users' || location.pathname.startsWith('/users/');
    if (onUserRoute && params.has('provider')) {
      return to === '/admin/providers';
    }
    if (onUserRoute && params.get('team') === 'gostork') {
      return false;
    }
    return location.pathname === to || location.pathname.startsWith(to + '/');
  };

  const displayName = user.name || user.email || 'User';
  const userPhoto = (user as any).photoUrl as string | null;
  const userPhotoSrc = userPhoto
    ? (userPhoto.startsWith("/uploads") ? userPhoto : `/api/uploads/proxy?url=${encodeURIComponent(userPhoto)}`)
    : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="fixed top-0 left-0 right-0 h-16 bg-card border-b border-border/40 z-50 shadow-sm hidden md:block">
        <div className="h-full px-4 md:px-6 grid grid-cols-[auto_1fr_auto] items-center gap-4">
          <Link to={isParentOnly && brandSettings?.enableAiConcierge && brandSettings?.parentExperienceMode !== 'MARKETPLACE_ONLY' ? '/chat' : '/marketplace'} className="flex items-center gap-2.5 shrink-0" data-testid="link-logo">
            {brandSettings?.logoWithNameUrl ? (
              <img
                src={brandSettings.logoWithNameUrl}
                alt={brandSettings?.companyName || "GoStork"}
                className="h-14 sm:h-14 w-auto max-w-[200px] sm:max-w-[260px] object-contain"
                data-testid="img-logo-with-name"
              />
            ) : (
              <>
                {brandSettings?.logoUrl ? (
                  <img src={brandSettings.logoUrl} alt="" className="w-11 h-11 rounded-lg object-contain" data-testid="img-logo-icon" />
                ) : (
                  <div className="w-11 h-11 rounded-lg bg-primary flex items-center justify-center text-white shadow-md shadow-primary/20">
                    <Baby className="w-6 h-6" />
                  </div>
                )}
                <h1 className="hidden sm:block font-display font-heading text-lg text-primary leading-none" data-testid="text-company-name">
                  {brandSettings?.companyName || "GoStork"}
                </h1>
              </>
            )}
          </Link>

          <nav className="hidden md:flex items-center justify-center gap-1 overflow-x-auto scrollbar-hide min-w-0" data-testid="nav-desktop">
            {visibleNav.filter(item => !item.mobileOnly).map((item) => {
              const Icon = item.icon;
              const active = item.tabId
                ? location.pathname === '/marketplace' && marketplaceTab === item.tabId
                : isActive(item.to);
              const handleClick = item.tabId
                ? (e: React.MouseEvent) => {
                    e.preventDefault();
                    dispatch(setMarketplaceTab(item.tabId!));
                    if (location.pathname !== '/marketplace') navigate('/marketplace');
                  }
                : undefined;
              return (
                <Link
                  key={item.tabId || item.to}
                  to={item.to}
                  onClick={handleClick}
                  data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                  className={`desktop-nav-link flex items-center gap-2 px-3 py-2 text-sm font-ui transition-all duration-200 shrink-0 whitespace-nowrap ${
                    active
                      ? 'desktop-nav-active-pill'
                      : 'desktop-nav-inactive'
                  }`}
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="flex items-center gap-2 px-3 py-2 h-auto"
                  data-testid="button-user-menu"
                >
                  {userPhotoSrc ? (
                    <img src={userPhotoSrc} alt="" className="w-8 h-8 rounded-full object-cover" data-testid="img-nav-avatar" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                  <span className="hidden md:inline text-sm font-ui max-w-[150px] truncate" data-testid="text-user-name">{displayName}</span>
                  <ChevronDown className="hidden md:block w-4 h-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="md:hidden px-2 py-1.5 text-sm font-ui text-foreground">{displayName}</div>
                <DropdownMenuSeparator className="md:hidden" />
                <DropdownMenuItem asChild>
                  <Link to="/account" className="flex items-center gap-2 cursor-pointer" data-testid="menu-my-account">
                    <User className="w-4 h-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="flex items-center gap-2 text-destructive focus:text-destructive cursor-pointer"
                  onClick={() => logoutMutation.mutate()}
                  data-testid="menu-sign-out"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div
        className={`fixed bottom-0 left-0 right-0 z-50 md:hidden safe-area-bottom px-3 pb-2 ${/^\/(surrogate|eggdonor|spermdonor)\//.test(location.pathname) ? "hidden" : ""}`}
        style={{ backgroundColor: 'var(--bottom-nav-safe-area-bg, transparent)' }}
      >
      <nav
        className="transition-all duration-300"
        style={navGlassStyle}
        data-testid="nav-bottom-tabs"
      >
        <div className="flex items-stretch justify-around h-[68px] px-2">
          {bottomTabs.map((item) => {
            const Icon = item.icon;
            const active = item.tabId
              ? location.pathname === '/marketplace' && marketplaceTab === item.tabId
              : isActive(item.to);
            const navStyle = brandSettings?.bottomNavStyle || 'icon-label';
            const iconOnly = navStyle === 'icon-only';

            if (item.submenuItems && item.submenuItems.length > 0) {
              const submenuActive = isActive(item.to);
              return (
                <DropdownMenu key={`submenu-${item.to}`}>
                  <DropdownMenuTrigger asChild>
                    <button
                      data-testid={`tab-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                      className={`flex flex-col items-center justify-center flex-1 gap-0.5 font-medium font-ui transition-colors duration-200 focus:outline-none ${iconOnly ? 'text-[0px]' : 'text-[13px]'}`}
                      style={{
                        color: submenuActive
                          ? 'var(--bottom-nav-active-fg, hsl(var(--primary)))'
                          : 'var(--bottom-nav-fg, hsl(var(--primary)))',
                      }}
                    >
                      <div
                        className="p-1.5 rounded-lg transition-colors duration-200 flex items-center justify-center"
                        style={submenuActive ? { backgroundColor: `color-mix(in srgb, var(--bottom-nav-active-fg, hsl(var(--primary))) 10%, transparent)` } : undefined}
                      >
                        <Icon className={iconOnly ? "w-7 h-7 shrink-0" : "w-6 h-6 shrink-0"} />
                      </div>
                      {!iconOnly && <span>{item.mobileLabel}</span>}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-48 mb-2 z-[80]">
                    {item.submenuItems.map((sub) => {
                      const SubIcon = sub.icon;
                      const subActive = location.pathname === '/marketplace' && marketplaceTab === sub.id;
                      return (
                        <DropdownMenuItem
                          key={sub.id}
                          className={`flex items-center gap-2 cursor-pointer ${subActive ? 'text-primary font-ui' : ''}`}
                          onClick={() => {
                            dispatch(setMarketplaceTab(sub.id));
                            if (location.pathname !== '/marketplace') navigate('/marketplace');
                          }}
                          data-testid={`tab-marketplace-${sub.id}`}
                        >
                          <SubIcon className="w-5 h-5" />
                          {sub.label}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            }

            const handleClick = item.tabId
              ? (e: React.MouseEvent) => {
                  e.preventDefault();
                  dispatch(setMarketplaceTab(item.tabId!));
                  if (location.pathname !== '/marketplace') navigate('/marketplace');
                }
              : undefined;
            return (
              <Link
                key={item.tabId || item.to}
                to={item.to}
                onClick={handleClick}
                aria-current={active ? 'page' : undefined}
                data-testid={`tab-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                className={`flex flex-col items-center justify-center flex-1 gap-0.5 font-medium font-ui transition-colors duration-200 ${iconOnly ? 'text-[0px]' : 'text-[13px]'}`}
                style={{
                  color: active
                    ? 'var(--bottom-nav-active-fg, hsl(var(--primary)))'
                    : 'var(--bottom-nav-fg, hsl(var(--primary)))',
                }}
              >
                <div
                  className="p-1.5 rounded-lg transition-colors duration-200 flex items-center justify-center"
                  style={active ? { backgroundColor: `color-mix(in srgb, var(--bottom-nav-active-fg, hsl(var(--primary))) 10%, transparent)` } : undefined}
                >
                  <Icon className={iconOnly ? "w-7 h-7 shrink-0" : "w-6 h-6 shrink-0"} />
                </div>
                {!iconOnly && <span>{item.mobileLabel}</span>}
              </Link>
            );
          })}
          {overflowTabs.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  data-testid="tab-more"
                  aria-label="More navigation options"
                  className="flex flex-col items-center justify-center flex-1 gap-0.5 text-[11px] font-ui transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-lg"
                  style={{
                    color: overflowTabs.some(item => isActive(item.to))
                      ? 'var(--bottom-nav-active-fg, hsl(var(--primary)))'
                      : 'var(--bottom-nav-fg, hsl(var(--primary)))',
                  }}
                >
                  <div
                    className="p-1.5 rounded-lg transition-colors duration-200"
                    style={overflowTabs.some(item => isActive(item.to)) ? { backgroundColor: `color-mix(in srgb, var(--bottom-nav-active-fg, hsl(var(--primary))) 10%, transparent)` } : undefined}
                  >
                    <MoreHorizontal className="w-5 h-5" />
                  </div>
                  <span>More</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-48 mb-2">
                {overflowTabs.map((item) => {
                  const Icon = item.icon;
                  const active = item.tabId
                    ? location.pathname === '/marketplace' && marketplaceTab === item.tabId
                    : isActive(item.to);
                  return (
                    <DropdownMenuItem key={item.tabId || item.to} asChild>
                      <Link
                        to={item.to}
                        onClick={item.tabId ? (e: any) => {
                          e.preventDefault();
                          dispatch(setMarketplaceTab(item.tabId!));
                          if (location.pathname !== '/marketplace') navigate('/marketplace');
                        } : undefined}
                        data-testid={`tab-more-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                        className={`flex items-center gap-2 cursor-pointer ${active ? 'text-primary font-ui' : ''}`}
                      >
                        <Icon className="w-5 h-5" />
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </nav>
      </div>

      <main className={`pt-0 md:pt-16 ${location.pathname === '/marketplace' || /^\/(surrogate|eggdonor|spermdonor)\//.test(location.pathname) ? 'pb-0' : location.pathname === '/chat' ? 'pb-0' : 'pb-28'} md:pb-0 min-h-screen transition-all duration-300`}>
        <div className={`${location.pathname === '/chat' ? '' : `max-w-[1800px] mx-auto pt-4 px-4 ${location.pathname === '/marketplace' ? 'pb-0' : 'pb-4'} md:p-6 lg:p-8`} animate-in fade-in slide-in-from-bottom-4 duration-500`}>
          {children}
        </div>
      </main>
    </div>
  );
}
