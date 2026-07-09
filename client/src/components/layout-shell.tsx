import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useBrandSettings } from "@/hooks/use-brand-settings";
import { queryClient } from "@/lib/queryClient";
import { getPhotoSrc } from "@/lib/profile-utils";
import { parentVisibleTypeIds } from "@/lib/parent-marketplace-types";
import {
  LogOut,
  Baby,
  User,
  LayoutDashboard,
  BarChart3,
  Home,
  Search,
  Building2,
  Users,
  ChevronDown,
  Calendar,
  RefreshCw,
  MessageCircle,
  Headphones,
  DollarSign,
  FlaskConical,
  AlertTriangle,
  X,
  Heart,
  Flame,
  Loader2,
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
import { MeetingReminderPopup } from "@/components/meeting-reminder-popup";

import { EggDonorIcon, SurrogateIcon, IvfClinicIcon, AgencyIcon, SpermIcon, DoctorIcon } from "@/components/icons/marketplace-icons";
import { GoStorkSymbol } from "@/components/icons/gostork-symbol";
import { ExploreProviderPicker } from "@/components/marketplace/explore-provider-picker";
import { useAppDispatch, useAppSelector } from "@/store";
import { setMarketplaceTab } from "@/store/uiSlice";

import {
  GoogleIcon as GoogleCalendarIcon,
  MicrosoftIcon as MicrosoftCalendarIcon,
  AppleIcon as AppleCalendarIcon,
} from "@/components/calendar/calendar-provider-icons";

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

  const isEmbedded = new URLSearchParams(location.search).get("embedded") === "1";
  if (isEmbedded) {
    return <>{children}</>;
  }

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
        // Bookings born CONFIRMED (propose-accept, scheduler-booked, instant
        // video) are not requests - nothing needs confirming.
        title = data.booking?.status === "CONFIRMED"
          ? `New meeting booked with ${attendeeName}`
          : `New meeting request from ${attendeeName}`;
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

  const handleParentReadyEvent = useCallback((data: any) => {
    if (data.type !== "parent_ready_to_proceed") return;
    playNotificationChime();
    const { id: toastId } = toast({
      title: `${data.parentName || "A parent"} is ready to proceed`,
      description: `${data.providerName || "Provider"} - create their invoice now`,
      variant: "success",
      action: (
        <Button
          size="sm"
          variant="default"
          className="gap-1 shrink-0"
          onClick={() => { dismiss(toastId); navigate("/admin/billing"); }}
        >
          Create Invoice
        </Button>
      ),
      duration: 30000,
    });
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(`${data.parentName || "A parent"} is ready to proceed`, {
          body: `${data.providerName || "Provider"} - create their invoice`,
          icon: "/favicon.ico",
          tag: `parent-ready-${data.sessionId}`,
        });
      } catch {}
    }
  }, [toast, dismiss, navigate]);

  const handleChatSessionUpdatedEvent = useCallback((data: any) => {
    if (data.type !== "chat_session_updated") return;
    // A new chat message was posted server-side (e.g. post-call readiness prompt).
    // Immediately invalidate the sessions list so the unread counter updates without
    // waiting for the next poll cycle.
    queryClient.invalidateQueries({ queryKey: ["/api/my/chat-sessions"] });
  }, [queryClient]);

  const handleHumanConcludedEvent = useCallback((data: any) => {
    if (data.type !== "human_concluded") return;
    // Dispatch a browser event so conversations-page can immediately refetch sessions
    window.dispatchEvent(new CustomEvent("human-concluded", { detail: { sessionId: data.sessionId } }));
  }, []);

  const handleProfileUpdatedEvent = useCallback((data: any) => {
    if (data.type !== "user_profile_updated") return;
    // Invalidate all session list and detail queries so open chat views refresh with the new profile
    queryClient.invalidateQueries({ queryKey: ["/api/admin/concierge-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["/api/provider/concierge-sessions"] });
    queryClient.invalidateQueries({ queryKey: ["/api/users", data.userId] });
  }, []);

  const handleHumanEscalationEvent = useCallback((data: any) => {
    if (data.type !== "human_escalation") return;

    const parentName = data.parentName || "A parent";

    playNotificationChime();

    const { id: toastId } = toast({
      title: `${parentName} needs human assistance`,
      description: data.message || "A parent has requested to speak with a human concierge",
      variant: "warning",
      action: (
        <Button
          size="sm"
          variant="default"
          className="gap-1 shrink-0"
          onClick={() => { dismiss(toastId); navigate("/admin/concierge-monitor"); }}
          data-testid="button-join-escalation-from-toast"
        >
          Join Chat
        </Button>
      ),
      duration: 30000,
    });

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(`${parentName} needs human assistance`, {
          body: data.message || "Parent requesting human concierge",
          icon: "/favicon.ico",
          tag: `human-escalation-${data.sessionId}`,
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
        handleHumanEscalationEvent(data);
        handleHumanConcludedEvent(data);
        handleProfileUpdatedEvent(data);
        handleChatSessionUpdatedEvent(data);
        handleParentReadyEvent(data);
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
  }, [user, handleVideoJoinedEvent, handleBookingEvent, handleCostSheetEvent, handleHumanEscalationEvent, handleHumanConcludedEvent, handleProfileUpdatedEvent, handleChatSessionUpdatedEvent, handleParentReadyEvent]);

  const dispatch = useAppDispatch();
  const marketplaceTab = useAppSelector((state) => state.ui.marketplaceTab);
  const hideBottomNav = useAppSelector((state) => state.ui.hideBottomNav);

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
        // AppEventsService (costs/events) also carries these notification types
        handleHumanEscalationEvent(data);
        handleHumanConcludedEvent(data);
        handleProfileUpdatedEvent(data);
        handleParentReadyEvent(data);
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

  // A parent's "Services You're Looking For" drives which marketplace provider
  // tabs appear in the nav, so deselecting e.g. Fertility Clinic hides IVF
  // Clinics + Doctors. Same source the marketplace Explore picker uses.
  const { data: parentProfile } = useQuery<{ interestedServices?: string[] }>({
    queryKey: ["/api/parent-profile"],
    queryFn: async () => {
      const res = await fetch("/api/parent-profile", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: isParentOnly,
    staleTime: 60_000,
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
    return tabs;
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

  // Total unread chat messages badge (must be before early returns to preserve hook order)
  const { data: chatSessions } = useQuery<{ unreadCount: number }[]>({
    queryKey: ["/api/my/chat-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/my/chat-sessions", { credentials: "include" });
      // Throw on error so React Query keeps the last successful data instead of
      // overwriting the shared cache with [] (which would trigger matchmaker redirect
      // in ConversationsPage on transient server errors).
      if (!res.ok) throw new Error("Failed to fetch chat sessions");
      return res.json();
    },
    enabled: !!user,
    refetchInterval: 30000,
  });
  const { data: providerChatSessions } = useQuery<{ unreadCount: number; pendingQuestions?: number; status?: string }[]>({
    queryKey: ["/api/provider/concierge-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/provider/concierge-sessions", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && isProvider,
    refetchInterval: 30000,
  });
  const { data: providerPendingBookings } = useQuery<{ count: number }>({
    queryKey: ["/api/calendar/bookings/pending-count"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/bookings/pending-count", { credentials: "include" });
      if (!res.ok) return { count: 0 };
      return res.json();
    },
    enabled: !!user && isProvider,
    refetchInterval: 30000,
  });
  const totalUnread = useMemo(() => {
    const parentUnread = (chatSessions || []).reduce((sum, s) => sum + (s.unreadCount || 0), 0);
    // For providers: count unread messages + pending whisper questions in any
    // session state. Whispers remain answerable from the right-side Q&A panel
    // even after the consultation is booked, so they always belong in the badge.
    const providerUnread = (providerChatSessions || []).reduce((sum, s) => {
      return sum + (s.unreadCount || 0) + (s.pendingQuestions || 0);
    }, 0);
    // The /chat page renders exactly ONE inbox per role: a provider sees their
    // provider inbox (providerChatSessions), everyone else sees their own
    // concierge chats (chatSessions). Count the badge from the inbox that is
    // actually reachable from /chat, otherwise a provider who also used the
    // concierge as a user carries a phantom unread they have no way to clear.
    return isProvider ? providerUnread : parentUnread;
  }, [chatSessions, providerChatSessions, isProvider]);
  const pendingMeetings = providerPendingBookings?.count || 0;

  // Admin: fetch concierge sessions to compute badge count
  const { data: adminConciergeSessions } = useQuery<{ unreadCount: number; humanRequested: boolean; humanJoinedAt: string | null; humanConcludedAt: string | null }[]>({
    queryKey: ["/api/admin/concierge-sessions"],
    queryFn: async () => {
      const res = await fetch("/api/admin/concierge-sessions", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user && isAdmin,
    refetchInterval: 30000,
  });
  const conciergeUnread = useMemo(() => {
    return (adminConciergeSessions || []).reduce((sum, s) => {
      // "Ready to Join": humanRequested AND (never joined OR previously concluded)
      // Matches the same condition as the "Ready to Join" badge in the monitor sidebar.
      const needsJoin = s.humanRequested && (!s.humanJoinedAt || !!s.humanConcludedAt);
      if (needsJoin) {
        return sum + Math.max(1, s.unreadCount || 0);
      }
      return sum + (s.unreadCount || 0);
    }, 0);
  }, [adminConciergeSessions]);

  const { data: calendarConnections } = useQuery<any[]>({
    queryKey: ["/api/calendar/connections"],
    queryFn: async () => {
      const res = await fetch("/api/calendar/connections", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });
  const [exploreOpen, setExploreOpen] = useState(false);
  const [calendarBannerDismissed, setCalendarBannerDismissed] = useState(false);
  const [bannerGoogleReconnecting, setBannerGoogleReconnecting] = useState(false);
  const [bannerMicrosoftReconnecting, setBannerMicrosoftReconnecting] = useState(false);
  const expiredCalendarConnections = (calendarConnections || []).filter(
    (c: any) => c.tokenValid === false && (c.provider === "google" || c.provider === "microsoft" || c.provider === "apple")
  );
  const showCalendarBanner = !calendarBannerDismissed && expiredCalendarConnections.length > 0;

  // Build the banner headline so the user always sees WHICH account was
  // disconnected (matches the email notification's behavior). Apple CalDAV
  // connections may not have an email - fall back to the user's label, then
  // the provider name, so the parenthetical is never empty.
  const providerDisplayName = (p: string) => p === "microsoft" ? "Microsoft" : p === "apple" ? "Apple" : "Google";
  const connLabel = (c: any) => c.email || c.label || providerDisplayName(c.provider);
  const calendarBannerHeadline = expiredCalendarConnections.length === 1
    ? `Your ${providerDisplayName(expiredCalendarConnections[0].provider)} Calendar (${connLabel(expiredCalendarConnections[0])}) has been disconnected.`
    : `${expiredCalendarConnections.length} calendar connections have expired (${expiredCalendarConnections.map(connLabel).join(", ")}).`;

  async function handleBannerReconnect(conn: any) {
    const isMs = conn.provider === "microsoft";
    if (isMs) setBannerMicrosoftReconnecting(true); else setBannerGoogleReconnecting(true);
    try {
      const hint = conn.email ? `?login_hint=${encodeURIComponent(conn.email)}` : "";
      const res = await fetch(`/api/calendar/${conn.provider}/auth-url${hint}`, { credentials: "include" });
      const data = await res.json();
      if (data.url) { window.location.href = data.url; return; }
    } catch {}
    if (isMs) setBannerMicrosoftReconnecting(false); else setBannerGoogleReconnecting(false);
  }

  useEffect(() => {
    const onDeck = location.pathname === '/marketplace';
    const body = document.body;
    const html = document.documentElement;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const prevBody = body.style.backgroundColor;
    const prevHtml = html.style.backgroundColor;
    const prevTheme = themeMeta?.getAttribute('content') ?? null;

    if (onDeck) {
      const deckBg = `hsl(${getComputedStyle(html).getPropertyValue('--deck-bg').trim()})`;
      body.style.backgroundColor = deckBg;
      html.style.backgroundColor = deckBg;
      themeMeta?.setAttribute('content', deckBg);
    } else {
      body.style.backgroundColor = '';
      html.style.backgroundColor = '';
    }

    return () => {
      body.style.backgroundColor = prevBody;
      html.style.backgroundColor = prevHtml;
      if (prevTheme !== null) themeMeta?.setAttribute('content', prevTheme);
    };
  }, [location.pathname]);

  if (!user) return <>{children}</>;

  const reminderPopup = <MeetingReminderPopup />;

  const fullScreenRoutes = ["/onboarding", "/complete-profile", "/matchmaker-selection", "/concierge", "/w9"];
  if (fullScreenRoutes.some(r => location.pathname.startsWith(r))) return <>{reminderPopup}{children}</>;

  const ALL_MARKETPLACE_TABS: { id: string; label: string; mobileLabel: string; icon: any }[] = [
    { id: "egg-donors", label: "Egg Donors", mobileLabel: "Donors", icon: EggDonorIcon },
    { id: "surrogates", label: "Surrogates", mobileLabel: "Surrogates", icon: SurrogateIcon },
    // Agency providers see their own profile as "Agency"; GoStork admins browse
    // all of them, labeled "Surrogacy Agencies" to match the desktop tab.
    { id: "surrogacy-agencies", label: isAdmin ? "Surrogacy Agencies" : "Agency", mobileLabel: isAdmin ? "Surrogacy Agencies" : "Agency", icon: AgencyIcon },
    { id: "ivf-clinics", label: "IVF Clinics", mobileLabel: "IVF", icon: IvfClinicIcon },
    { id: "doctors", label: "Doctors", mobileLabel: "Doctors", icon: DoctorIcon },
    { id: "sperm-donors", label: "Sperm Donors", mobileLabel: "Sperm", icon: SpermIcon },
  ];
  // For parents, show only the provider types matching their "Services You're
  // Looking For" (deselecting Fertility Clinic hides IVF Clinics + Doctors).
  // Admins/providers keep the full set. Falls back to all when services are unset.
  // Type ids each role may browse: parents -> their interested services;
  // providers -> their approved-service tabs (incl. their own "Agency" tab);
  // admins -> all. This single list drives the nav, the mobile submenu, and the
  // stork Explore picker, so every surface agrees on what a role can see.
  const providerTypeIds = (isProvider && !isAdmin) ? providerMarketplaceTabs.map(t => t.id) : null;
  const visibleTypeIds = isParentOnly
    ? parentVisibleTypeIds(parentProfile?.interestedServices)
    : providerTypeIds;
  const MARKETPLACE_TABS = visibleTypeIds
    ? ALL_MARKETPLACE_TABS.filter(t => visibleTypeIds.includes(t.id))
    : ALL_MARKETPLACE_TABS;

  const navigation: { show: boolean; to: string; icon: any; label: string; mobileLabel: string; tabId?: string; mobileOnly?: boolean; desktopOnly?: boolean; submenuItems?: typeof MARKETPLACE_TABS; badge?: number; fillOnActive?: boolean; isExplore?: boolean }[] = [
    { show: false /* hidden for now */, to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', mobileLabel: 'Dashboard' },
    // Desktop keeps the Marketplace dropdown; on mobile providers/admins get the
    // Home dashboards lead the bar: action queue + meetings + billing/
    // agreements summaries. Billing (both roles) and Performance (provider)
    // left the top bar - their pages stay routable via Home's View-all links.
    // Chat remains the parent's default landing; Home is the overview.
    { show: isParentOnly, to: '/home', icon: Home, label: 'Home', mobileLabel: 'Home', fillOnActive: false },
    { show: isProvider && !isAdmin, to: '/provider/home', icon: Home, label: 'Home', mobileLabel: 'Home', fillOnActive: false },
    { show: isAdmin, to: '/admin/home', icon: Home, label: 'Home', mobileLabel: 'Home', fillOnActive: false },
    // same centered stork Explore button as parents (added below).
    { show: isAdmin, to: '/marketplace', icon: Search, label: 'Marketplace', mobileLabel: 'Marketplace', submenuItems: MARKETPLACE_TABS, desktopOnly: true },
    { show: isProvider && !isAdmin, to: '/marketplace', icon: Search, label: 'Marketplace', mobileLabel: 'Marketplace', submenuItems: MARKETPLACE_TABS, desktopOnly: true },
    // Mobile bottom nav: centered stork Explore button for providers + admins,
    // matching parents. Opens the explode picker fanned to the role's own types.
    { show: (isAdmin || (isProvider && !isAdmin)), to: '/marketplace', icon: Flame, label: 'Explore', mobileLabel: 'Explore', fillOnActive: true, mobileOnly: true, isExplore: true },
    ...(isParentOnly && !(brandSettings?.enableAiConcierge && brandSettings?.parentExperienceMode !== 'MARKETPLACE_ONLY')
      ? [
          // Mobile bottom nav: a centered Explore button that opens the explode
          // picker (provider pills now live in that fan, not a top bar).
          { show: true, to: '/marketplace', icon: Flame, label: 'Explore', mobileLabel: 'Explore', fillOnActive: true, mobileOnly: true, isExplore: true },
          // Desktop top nav: each marketplace type as its own primary tab (no secondary pill row)
          ...MARKETPLACE_TABS.map((tab) => ({
            show: true,
            to: '/marketplace',
            icon: tab.icon,
            label: tab.label,
            mobileLabel: tab.mobileLabel,
            tabId: tab.id,
            desktopOnly: true,
          })),
          // Saved is universal: mobile bottom and desktop top
          { show: true, to: '/marketplace?view=saved', icon: Heart, label: 'Saved', mobileLabel: 'Saved', fillOnActive: false },
        ]
      : []),
    { show: isParentOnly, to: '/chat', icon: MessageCircle, label: 'Chats', mobileLabel: 'Chats', badge: totalUnread, fillOnActive: false },
    { show: !isParentOnly && !isAdmin, to: '/chat', icon: MessageCircle, label: 'Chats', mobileLabel: 'Chats', badge: totalUnread, fillOnActive: false },
    { show: isAdmin, to: '/admin/providers', icon: Building2, label: 'Providers', mobileLabel: 'Providers', fillOnActive: false },
    { show: isAdmin, to: '/admin/concierge-monitor', icon: Headphones, label: 'Concierge', mobileLabel: 'Concierge', badge: conciergeUnread, fillOnActive: false },
    { show: isAdmin, to: '/admin/test-runner', icon: FlaskConical, label: 'Test Runner', mobileLabel: 'Tests', fillOnActive: false },
    { show: isAdmin || isProvider, to: '/parents', icon: Users, label: 'Parents', mobileLabel: 'Parents', fillOnActive: false },
    { show: !((user as any).parentAccountRole === 'VIEWER'), to: '/calendar', icon: Calendar, label: 'Calendar', mobileLabel: 'Calendar', badge: isProvider ? pendingMeetings : undefined, fillOnActive: false },
    { show: true, to: '/account', icon: User, label: 'Profile', mobileLabel: 'Profile', mobileOnly: true, fillOnActive: false },
  ];

  const visibleNav = navigation.filter(item => item.show);

  const maxBottomTabs = 7;
  // Mobile bottom bar shows up to `maxBottomTabs` items, with Profile pinned
  // to the last slot when present so admins / providers don't lose access to
  // /account on mobile if their other tabs would otherwise fill the bar. No
  // overflow "More" dropdown - if there are more items than slots, the lower-
  // priority ones simply don't appear on mobile (they're still on desktop).
  const mobileNav = visibleNav.filter(item => !item.desktopOnly);
  const profileItem = mobileNav.find(item => item.to === '/account');
  let nonProfileMobile = mobileNav.filter(item => item.to !== '/account');
  // When the Explore button is present (parent marketplace mode), center it in the
  // bar: Chat, Saved (Heart), Explore, Calendar, then anything else; Profile stays
  // pinned last by the assembly below. Only reorders mobile - desktop is untouched.
  if (nonProfileMobile.some(item => item.isExplore)) {
    if (isParentOnly) {
      const rank = (it: typeof nonProfileMobile[number]) =>
        it.to === '/chat' ? 0
        : it.to.includes('view=saved') ? 1
        : it.isExplore ? 2
        : it.to === '/calendar' ? 3
        : 99;
      nonProfileMobile = [...nonProfileMobile].sort((a, b) => rank(a) - rank(b));
    } else {
      // Providers / admins: center the stork Explore button in the FULL bar.
      // Profile is pinned last by the assembly below, so account for it when
      // computing the middle slot (otherwise the stork lands left-of-center).
      const explore = nonProfileMobile.find(i => i.isExplore)!;
      const others = nonProfileMobile.filter(i => !i.isExplore);
      const totalSlots = Math.min(others.length + 1 + (profileItem ? 1 : 0), maxBottomTabs);
      const centerIdx = Math.min(Math.floor((totalSlots - 1) / 2), others.length);
      nonProfileMobile = [...others.slice(0, centerIdx), explore, ...others.slice(centerIdx)];
    }
  }
  const bottomTabs = profileItem
    ? [...nonProfileMobile.slice(0, maxBottomTabs - 1), profileItem]
    : nonProfileMobile.slice(0, maxBottomTabs);

  // When on /marketplace?view=saved, only the Saved item should be highlighted.
  // Type tabs (egg-donors / sperm-donors / etc.) should NOT show as active even
  // though Redux's activeTab matches one of them.
  const onSavedView = location.pathname === '/marketplace' && new URLSearchParams(location.search).get('view') === 'saved';

  const isActive = (to: string) => {
    const params = new URLSearchParams(location.search);
    const onUserRoute = location.pathname === '/parents' || location.pathname === '/users' || location.pathname.startsWith('/users/');
    if (onUserRoute && params.has('provider')) {
      return to === '/admin/providers';
    }
    if (onUserRoute && params.get('team') === 'gostork') {
      return false;
    }
    if (location.pathname === '/marketplace') {
      const savedView = params.get('view') === 'saved';
      if (to === '/marketplace?view=saved') return savedView;
      if (to === '/marketplace') return !savedView;
    }
    return location.pathname === to || location.pathname.startsWith(to + '/');
  };

  const onMarketplaceDeck = location.pathname === '/marketplace';

  const displayName = user.name || user.email || 'User';
  const userPhoto = (user as any).photoUrl as string | null;
  const userPhotoSrc = getPhotoSrc(userPhoto);

  return (
    <div className="min-h-screen bg-background">
      <header className="fixed top-0 left-0 right-0 h-16 bg-card border-b border-border/40 z-50 shadow-sm hidden md:block">
        <div className="h-full px-4 md:px-6 grid grid-cols-[auto_1fr_auto] items-center gap-4">
          <Link to={isParentOnly && brandSettings?.enableAiConcierge && brandSettings?.parentExperienceMode !== 'MARKETPLACE_ONLY' ? '/chat' : '/marketplace'} className="flex items-center gap-2.5 shrink-0" data-testid="link-logo">
            {brandSettings?.logoWithNameUrl ? (
              <img
                src={getPhotoSrc(brandSettings.logoWithNameUrl) || brandSettings.logoWithNameUrl}
                alt={brandSettings?.companyName || "GoStork"}
                className="h-14 sm:h-14 w-auto max-w-[200px] sm:max-w-[260px] object-contain"
                data-testid="img-logo-with-name"
              />
            ) : (
              <>
                {brandSettings?.logoUrl ? (
                  <img src={getPhotoSrc(brandSettings.logoUrl) || brandSettings.logoUrl} alt="" className="w-11 h-11 rounded-[var(--radius)] object-contain" data-testid="img-logo-icon" />
                ) : (
                  <div className="w-11 h-11 rounded-[var(--radius)] bg-primary flex items-center justify-center text-primary-foreground shadow-md shadow-primary/20">
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
                ? (!onSavedView && location.pathname === '/marketplace' && marketplaceTab === item.tabId)
                : isActive(item.to);
              const handleClick = item.tabId
                ? (e: React.MouseEvent) => {
                    e.preventDefault();
                    dispatch(setMarketplaceTab(item.tabId!));
                    // Always navigate to a clean /marketplace so clicking a type
                    // tab from Saved drops you back into Discover for that type.
                    navigate('/marketplace');
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
                  <div className="relative">
                    <Icon className="w-5 h-5 shrink-0" />
                    {!!item.badge && item.badge > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full flex items-center justify-center text-[8px] font-bold text-primary-foreground px-0.5" style={{ backgroundColor: 'hsl(var(--primary))' }}>
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </div>
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
        className={`fixed bottom-0 left-0 right-0 z-50 md:hidden safe-area-bottom px-3 transition-all duration-200 ${exploreOpen ? 'opacity-0 translate-y-6 pointer-events-none' : 'opacity-100'} ${onMarketplaceDeck ? 'pt-5 pb-0' : 'pb-2'} ${hideBottomNav || /^\/(surrogate|eggdonor|spermdonor)\//.test(location.pathname) || location.pathname === "/concierge" || location.pathname.startsWith("/agreements/") ? "hidden" : ""}`}
        style={{
          backgroundColor: onMarketplaceDeck ? 'hsl(var(--deck-bg))' : 'var(--bottom-nav-safe-area-bg, transparent)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
      <nav
        className="transition-all duration-300"
        style={onMarketplaceDeck
          ? {
              ...navGlassStyle,
              backgroundColor: 'hsl(var(--deck-bg-elevated))',
              border: '1px solid rgba(255,255,255,0.08)',
            }
          : navGlassStyle}
        data-testid="nav-bottom-tabs"
      >
        <div className="flex items-stretch justify-around h-[68px] px-2">
          {bottomTabs.map((item) => {
            const Icon = item.icon;

            // Centered Explore button: opens the explode picker overlay instead of
            // Explore opens the explode picker (or jumps straight to the single
            // available type). Rendered as a FLAT tab like the others - the stork
            // is just the 3rd icon, following the same outline rule (gray ->
            // teal-on-active), no special raised circle.
            if (item.isExplore) {
              const navStyleE = brandSettings?.bottomNavStyle || 'icon-label';
              const iconOnlyE = navStyleE === 'icon-only';
              const exploreActive = onMarketplaceDeck && !onSavedView;
              const exploreActiveColor = onMarketplaceDeck ? 'hsl(var(--deck-fg))' : 'var(--bottom-nav-active-fg, hsl(var(--primary)))';
              const exploreInactiveColor = onMarketplaceDeck ? 'hsl(var(--deck-fg-muted))' : 'var(--bottom-nav-fg, hsl(var(--muted-foreground)))';
              return (
                <button
                  key="explore"
                  type="button"
                  onClick={() => {
                    // With a single available provider type, the fan would hold one
                    // card - skip it and jump straight to that marketplace tab.
                    if (visibleTypeIds && visibleTypeIds.length === 1) {
                      dispatch(setMarketplaceTab(visibleTypeIds[0]));
                      navigate('/marketplace');
                    } else {
                      setExploreOpen(true);
                    }
                  }}
                  aria-label="Explore providers"
                  data-testid="tab-explore"
                  className={`flex flex-col items-center justify-center flex-1 gap-0.5 font-medium font-ui transition-colors duration-200 focus:outline-none ${iconOnlyE ? 'text-[0px]' : 'text-[13px]'}`}
                  style={{ color: exploreActive ? exploreActiveColor : exploreInactiveColor }}
                >
                  <div className="p-1.5 flex items-center justify-center">
                    <GoStorkSymbol outline strokeWidth={exploreActive ? 150 : 120} className={iconOnlyE ? 'w-9 h-auto shrink-0' : 'w-8 h-auto shrink-0'} />
                  </div>
                  {!iconOnlyE && <span>{item.mobileLabel}</span>}
                </button>
              );
            }

            const active = item.tabId
              ? (!onSavedView && location.pathname === '/marketplace' && marketplaceTab === item.tabId)
              : isActive(item.to);
            const navStyle = brandSettings?.bottomNavStyle || 'icon-label';
            const iconOnly = navStyle === 'icon-only';
            const activeColor = onMarketplaceDeck
              ? 'hsl(var(--deck-fg))'
              : 'var(--bottom-nav-active-fg, hsl(var(--primary)))';
            const inactiveColor = onMarketplaceDeck
              ? 'hsl(var(--deck-fg-muted))'
              : 'var(--bottom-nav-fg, hsl(var(--muted-foreground)))';

            if (item.submenuItems && item.submenuItems.length > 0) {
              const submenuActive = isActive(item.to);
              return (
                <DropdownMenu key={`submenu-${item.to}`}>
                  <DropdownMenuTrigger asChild>
                    <button
                      data-testid={`tab-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                      className={`flex flex-col items-center justify-center flex-1 gap-0.5 font-medium font-ui transition-colors duration-200 focus:outline-none ${iconOnly ? 'text-[0px]' : 'text-[13px]'}`}
                      style={{ color: submenuActive ? activeColor : inactiveColor }}
                    >
                      <div className="p-1.5 transition-colors duration-200 flex items-center justify-center">
                        <Icon
                          className={iconOnly ? "w-7 h-7 shrink-0" : "w-6 h-6 shrink-0"}
                          fill={submenuActive && (item.fillOnActive ?? true) ? 'currentColor' : 'none'}
                          strokeWidth={submenuActive && !(item.fillOnActive ?? true) ? 2.5 : 2}
                        />
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
                            navigate('/marketplace');
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
                  navigate('/marketplace');
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
                style={{ color: active ? activeColor : inactiveColor }}
              >
                <div className="p-1.5 transition-colors duration-200 flex items-center justify-center relative">
                  <Icon
                    className={iconOnly ? "w-7 h-7 shrink-0" : "w-6 h-6 shrink-0"}
                    fill={active && (item.fillOnActive ?? true) ? 'currentColor' : 'none'}
                    strokeWidth={active && !(item.fillOnActive ?? true) ? 2.5 : 2}
                  />
                  {!!item.badge && item.badge > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] rounded-full flex items-center justify-center text-[9px] font-bold text-primary-foreground px-0.5" style={{ backgroundColor: 'hsl(var(--primary))' }}>
                      {item.badge > 99 ? "99+" : item.badge}
                    </span>
                  )}
                </div>
                {!iconOnly && <span>{item.mobileLabel}</span>}
              </Link>
            );
          })}
        </div>
      </nav>
      </div>

      <ExploreProviderPicker open={exploreOpen} onClose={() => setExploreOpen(false)} allowedTypeIds={visibleTypeIds} labelOverrides={{ "surrogacy-agencies": isAdmin ? "Surrogacy Agencies" : "Agency" }} />

      {showCalendarBanner && (
        <div className="fixed top-16 left-0 right-0 z-40 hidden md:block">
          <div className="border-b border-[hsl(var(--brand-warning)/0.4)] bg-[hsl(var(--brand-warning)/0.1)] px-4 py-2.5">
            <div className="max-w-[1800px] mx-auto flex items-center gap-3 flex-wrap">
              <AlertTriangle className="w-4 h-4 text-[hsl(var(--brand-warning))] shrink-0" />
              <p className="text-sm font-ui text-foreground flex-1 min-w-0">
                <span className="font-medium">{calendarBannerHeadline}</span>
                {" "}New bookings won't sync until you reconnect.
              </p>
              <div className="flex items-center gap-2 shrink-0">
                {expiredCalendarConnections.map((conn: any) => {
                  const isMs = conn.provider === "microsoft";
                  const isApple = conn.provider === "apple";
                  const isReconnecting = isMs ? bannerMicrosoftReconnecting : bannerGoogleReconnecting;
                  const label = conn.label || conn.email || (isMs ? "Microsoft" : isApple ? "Apple" : "Gmail");
                  if (isApple) {
                    return (
                      <Link
                        key={conn.id}
                        to="/account/calendar"
                        className="inline-flex items-center h-7 px-3 text-xs font-ui font-medium rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.5)] text-foreground hover:bg-[hsl(var(--brand-warning)/0.1)] transition-colors"
                      >
                        <AppleCalendarIcon className="w-3.5 h-3.5 mr-1.5" />
                        Fix {label} in Settings
                      </Link>
                    );
                  }
                  return (
                    <Button
                      key={conn.id}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs font-ui border-[hsl(var(--brand-warning)/0.5)] text-foreground hover:bg-[hsl(var(--brand-warning)/0.1)]"
                      disabled={bannerGoogleReconnecting || bannerMicrosoftReconnecting}
                      onClick={() => handleBannerReconnect(conn)}
                    >
                      {isReconnecting ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : isMs ? <MicrosoftCalendarIcon className="w-3.5 h-3.5 mr-1.5" /> : <GoogleCalendarIcon className="w-3.5 h-3.5 mr-1.5" />}
                      Reconnect {label}
                    </Button>
                  );
                })}
                <button
                  onClick={() => setCalendarBannerDismissed(true)}
                  className="text-muted-foreground hover:text-foreground transition-colors ml-1"
                  aria-label="Dismiss"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCalendarBanner && (
        <div className="md:hidden mx-4 mt-3 rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.4)] bg-[hsl(var(--brand-warning)/0.08)] p-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-[hsl(var(--brand-warning))] shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-ui font-medium text-foreground">
                {calendarBannerHeadline}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">New bookings won't sync until you reconnect.</p>
              <div className="flex flex-wrap gap-2 mt-2">
                {expiredCalendarConnections.map((conn: any) => {
                  const isMs = conn.provider === "microsoft";
                  const isApple = conn.provider === "apple";
                  const isReconnecting = isMs ? bannerMicrosoftReconnecting : bannerGoogleReconnecting;
                  const label = conn.label || conn.email || (isMs ? "Microsoft" : isApple ? "Apple" : "Gmail");
                  if (isApple) {
                    return (
                      <Link
                        key={conn.id}
                        to="/account/calendar"
                        className="inline-flex items-center h-7 px-3 text-xs font-ui font-medium rounded-[var(--radius)] border border-[hsl(var(--brand-warning)/0.5)] text-foreground hover:bg-[hsl(var(--brand-warning)/0.1)] transition-colors"
                      >
                        <AppleCalendarIcon className="w-3.5 h-3.5 mr-1.5" />
                        Fix {label} in Settings
                      </Link>
                    );
                  }
                  return (
                    <Button
                      key={conn.id}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs font-ui border-[hsl(var(--brand-warning)/0.5)] text-foreground hover:bg-[hsl(var(--brand-warning)/0.1)]"
                      disabled={bannerGoogleReconnecting || bannerMicrosoftReconnecting}
                      onClick={() => handleBannerReconnect(conn)}
                    >
                      {isReconnecting ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : isMs ? <MicrosoftCalendarIcon className="w-3.5 h-3.5 mr-1.5" /> : <GoogleCalendarIcon className="w-3.5 h-3.5 mr-1.5" />}
                      Reconnect {label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <button
              onClick={() => setCalendarBannerDismissed(true)}
              className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <main className={`pt-0 ${showCalendarBanner ? 'md:pt-[88px]' : 'md:pt-16'} ${location.pathname === '/marketplace' || /^\/(surrogate|eggdonor|spermdonor)\//.test(location.pathname) ? 'pb-0' : location.pathname.startsWith('/chat') || location.pathname.startsWith('/admin/concierge-monitor') ? 'pb-0' : 'pb-28'} md:pb-0 min-h-screen transition-all duration-300`}>
        <div className={`${location.pathname.startsWith('/chat') || location.pathname.startsWith('/admin/concierge-monitor') ? '' : `max-w-[1800px] mx-auto pt-4 px-4 ${location.pathname === '/marketplace' ? 'pb-0' : 'pb-4'} md:p-6 lg:p-8`} animate-in fade-in slide-in-from-bottom-4 duration-500`}>
          {children}
        </div>
      </main>
      {reminderPopup}
    </div>
  );
}
